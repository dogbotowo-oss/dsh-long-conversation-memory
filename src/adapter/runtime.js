/**
 * Runtime wiring: connect the deterministic core modules to the DSH lifecycle.
 *
 * The runtime owns exactly one SQLite store for the whole profile (all sessions
 * live in that file, isolated by `session_id`), observes committed events
 * through `session/event`, and contributes one evidence-labelled context
 * message per model step through the `agent/pre-step` waterfall.
 *
 * Failure policy: memory is an enhancement, never a reason a turn fails. Every
 * hook catches its own errors, logs them through the host logger, and returns
 * the unmodified decision / continues the host pipeline. The single exception
 * is a configured, program-decidable *file precondition* in
 * `tools/pre-execute`, which is allowed to deny the tool call by configuration.
 *
 * @module dsh-session-memory/adapter/runtime
 */

import fs from 'node:fs'
import path from 'node:path'

import * as host from './host.js'
import { openDatabase } from '../core/db.js'
import { COMPACTION_EVENT_TYPES, MEMORY_SOURCE_KIND, PLUGIN_VERSION } from '../core/constants.js'
import { normalizeText, sha256 } from '../core/util.js'
import { MemoryStore } from '../memory/store.js'
import { CaptureService, GENERATED_SOURCE_KINDS } from '../capture.js'
import { SessionExtractor } from '../memory/extraction.js'
import { SkillManager } from '../skills.js'
import { Retriever } from '../retrieval.js'
import { Assembler } from '../assembly.js'
import { Validator } from '../validation.js'
import { Diagnostics } from '../diagnostics.js'

const SKILL_SYNC_INTERVAL_MS = 30_000

/**
 * @typedef {object} SessionRuntimeState
 * @property {number} observedCompactionEvents
 * @property {number | null} lastCompactionSeq
 * @property {string | null} lastCompactionAt
 * @property {number} lastSkillSyncAt
 * @property {string} lastUserText
 * @property {boolean} skillsDirty
 * @property {number} lastValidatedSeq
 * @property {number} repairAttempts
 * @property {{ text: string, signature: string, violations: number } | null} pendingRepair
 */

export class MemoryRuntime {
  /**
   * @param {{ ctx: any, config: any, logger?: any, version?: string }} options
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.logger = options.logger ?? null
    this.version = options.version ?? PLUGIN_VERSION

    /** @type {MemoryStore | null} */
    this.store = null
    this.dbFile = null
    /** @type {CaptureService | null} */
    this.capture = null
    /** @type {SessionExtractor | null} */
    this.extractor = null
    /** @type {SkillManager | null} */
    this.skills = null
    /** @type {Retriever | null} */
    this.retriever = null
    /** @type {Assembler | null} */
    this.assembler = null
    /** @type {Validator | null} */
    this.validator = null
    /** @type {Diagnostics | null} */
    this.diagnostics = null

    /** @type {Map<string, SessionRuntimeState>} */
    this.sessions = new Map()
    /** @type {Map<string, number>} assembly log id by injected content hash */
    this.pendingAssemblies = new Map()
    /** @type {(() => void)[]} */
    this.disposers = []
    this.started = false
    this.disposed = false
  }

  /**
   * Open the store and register host hooks. Idempotent.
   *
   * @returns {void}
   */
  start() {
    if (this.started || this.disposed) return
    this.started = true
    try {
      this.ensureStore()
    } catch (error) {
      this.warn('failed to open the memory store; memory is disabled for this process', error)
      return
    }

    this.disposers.push(
      host.onHostEvent(this.ctx, 'session/event', (session, event) => {
        this.guard('session/event', () => this.onSessionEvent(session, event))
      }),
    )
    this.disposers.push(
      host.onHostEvent(this.ctx, 'agent/pre-step', (payload, next) => this.onPreStep(payload, next)),
    )
    this.disposers.push(
      host.onHostEvent(this.ctx, 'skills/change', () => {
        for (const state of this.sessions.values()) state.skillsDirty = true
      }),
    )
    if ((this.config.validation?.preconditions ?? []).length > 0) {
      this.disposers.push(host.onHostEvent(this.ctx, 'tools/pre-execute', (exec, next) => this.onPreToolExecute(exec, next)))
    }
    this.registerCommands()
  }

  /**
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Late host shutdown: nothing useful to do.
      }
    }
    try {
      this.store?.close()
    } catch (error) {
      this.warn('failed to close the memory store cleanly', error)
    }
    this.store = null
  }

  // ------------------------------------------------------------------ storage

  /**
   * @returns {MemoryStore}
   */
  ensureStore() {
    if (this.store !== null) return this.store
    const dataDir = host.resolveDataDir(this.config.dataDir)
    fs.mkdirSync(dataDir, { recursive: true })
    const fileName = typeof this.config.dbFile === 'string' && this.config.dbFile.length > 0 ? this.config.dbFile : 'memory.sqlite'
    this.dbFile = path.join(dataDir, fileName)
    const db = openDatabase(this.dbFile, { migrate: true })
    const store = new MemoryStore(db, { config: this.config })
    this.store = store
    this.capture = new CaptureService(store, { config: this.config, logger: this.logger })
    this.extractor = new SessionExtractor(store, { config: this.config, logger: this.logger })
    this.skills = new SkillManager(store, { config: this.config, logger: this.logger, version: this.version })
    this.retriever = new Retriever(store, { config: this.config })
    this.assembler = new Assembler(store, {
      config: this.config,
      skills: this.skills,
      retriever: this.retriever,
      logger: this.logger,
    })
    this.validator = new Validator(store, { config: this.config, logger: this.logger })
    this.diagnostics = new Diagnostics(store, {
      config: this.config,
      skills: this.skills,
      retriever: this.retriever,
      version: this.version,
      dbFile: this.dbFile,
      sessionId: null,
      compatibility: host.compactionCompatibility(this.ctx, {
        configured: String(this.config.compatibility?.compactionPolicy ?? 'auto'),
      }),
    })
    return store
  }

  /**
   * @param {string} sessionId
   * @returns {SessionRuntimeState}
   */
  stateFor(sessionId) {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        observedCompactionEvents: 0,
        lastCompactionSeq: null,
        lastCompactionAt: null,
        lastSkillSyncAt: 0,
        lastUserText: '',
        skillsDirty: true,
        lastValidatedSeq: -1,
        repairAttempts: 0,
        pendingRepair: null,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  // -------------------------------------------------------------- host hooks

  /**
   * Capture one committed session event and keep derived bookkeeping current.
   *
   * The listener signature is `(session, event)` — `session/event` is an emit,
   * not a waterfall.
   *
   * @param {any} session
   * @param {any} event
   * @returns {void}
   */
  onSessionEvent(session, event) {
    if (this.store === null || event === null || typeof event !== 'object') return
    if (host.isSubagentSession(session) && this.config.includeSubagents !== true) return
    const { sessionId } = host.describeSession(session)
    if (sessionId.length === 0) return
    this.store.ensureSession({ sessionId })
    const type = String(event.type ?? '')
    if (type.startsWith('compaction/')) {
      const state = this.stateFor(sessionId)
      state.observedCompactionEvents += 1
      if (Number.isInteger(event.seq)) state.lastCompactionSeq = event.seq
      state.lastCompactionAt = typeof event.time === 'string' ? event.time : new Date().toISOString()
    }
    const result = this.capture.captureEvent(sessionId, event)
    if (result.inserted && type === 'user/message') {
      // Generated context (our memory block, runtime-context snapshots, ...) is
      // stored for audit but must never become the "last user text" the next
      // step assembles against.
      const sourceKind = event.data?.source?.kind
      const generated = typeof sourceKind === 'string' && GENERATED_SOURCE_KINDS.has(sourceKind)
      if (!generated) {
        const text = host.messagesText([event.data])
        if (text.length > 0) this.stateFor(sessionId).lastUserText = text
      }
    }
    // Fill in the committed `seq` of the message this plugin injected, so
    // `memory explain` can point at the exact log position.
    if (type === 'user/message') {
      const source = event.data?.source
      if (source?.kind === MEMORY_SOURCE_KIND && typeof source.contentHash === 'string') {
        const assemblyId = this.pendingAssemblies.get(source.contentHash)
        if (assemblyId !== undefined) {
          this.store.setAssemblyMessageSeq(assemblyId, Number.isInteger(event.seq) ? event.seq : null)
          this.pendingAssemblies.delete(source.contentHash)
        }
      }
    }
  }

  /**
   * `agent/pre-step` waterfall.
   *
   * Runs after earlier listeners (e.g. a pressure compactor registered before
   * this plugin) have called `next()`, so compaction-triggered surface
   * replacements are already visible when the memory block is assembled. This
   * ordering is exactly what post-compaction re-injection needs.
   *
   * @param {{ agent?: any, messages?: any[], turn?: number, step?: number, signal?: AbortSignal }} payload
   * @param {() => Promise<any>} next
   * @returns {Promise<any>}
   */
  async onPreStep(payload, next) {
    if (this.disposed || this.store === null) return next()
    const { agent, messages, turn, step } = payload ?? {}
    /** @type {{ sessionId: string, session: any, result: any, contentHash: string, text: string } | null} */
    let prepared = null
    try {
      prepared = await this.prepare(payload)
    } catch (error) {
      this.warn('memory preparation failed; step continues without memory context', error)
    }
    const decision = await next()
    if (prepared === null) return decision
    if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision
    if (this.disposed || this.store === null) return decision
    try {
      return this.applyDecision(prepared, decision, messages, turn, step)
    } catch (error) {
      this.warn('memory injection failed; step continues without memory context', error)
      return decision
    }
  }

  /**
   * Assemble the memory block for this step (no host mutation).
   *
   * @param {any} payload
   * @returns {Promise<{ sessionId: string, session: any, result: any, contentHash: string, text: string, state: SessionRuntimeState } | null>}
   */
  async prepare(payload) {
    const { agent, messages } = payload ?? {}
    const session = agent?.session ?? null
    if (session === null || session === undefined) return null
    if (host.isSubagentSession(session) && this.config.includeSubagents !== true) return null
    const { sessionId, cwd, origin } = host.describeSession(session)
    if (sessionId.length === 0) return null
    const store = this.ensureStore()
    store.ensureSession({ sessionId, cwd, origin, dshVersion: this.version })
    if (!store.isMemoryEnabled(sessionId)) return null
    const state = this.stateFor(sessionId)

    // 1. Incremental memory extraction (only new events, deterministic, no model call).
    if (this.config.extraction?.enabled !== false) {
      try {
        this.extractor.extractPending(sessionId)
      } catch (error) {
        this.warn(`memory extraction failed for session ${sessionId}`, error)
      }
    }

    // 2. Skill index sync (throttled; refreshed on skills/change).
    if (this.config.skills?.enabled !== false) this.syncSkills(agent, state)

    // 3. Deterministic validation of already-committed assistant output. Runs
    //    only when checks are configured; a failure schedules a bounded repair
    //    reminder for this step (never a model call, never a silent rewrite).
    await this.validateNewOutput(sessionId, state)

    // 3. Task text for retrieval: the newest user input of this step, falling
    //    back to the last captured user message in this session.
    let taskText = host.messagesText(messages)
    if (taskText.length === 0) taskText = this.lastUserText(sessionId, state)

    // User messages that enter this request are already visible to the model
    // (the claimed step input plus everything still present in the surface);
    // do not repeat their derived items or raw quotes in the memory block,
    // otherwise every step would accumulate redundant context. Matching happens
    // on the exact stored text, so a compacted-away message drops out of the
    // visible set and its facts are re-injected again.
    const visibleUserTexts = new Set(
      [
        ...host.visibleMessages(session).map((message) => host.messagesText([message])),
        ...(Array.isArray(messages) ? messages : []).map((message) => host.messagesText([message])),
      ]
        .map((text) => normalizeText(text))
        .filter((text) => text.length > 0),
    )
    const excludeSeqs = this.store
      .listEvents(sessionId, { types: ['user/message'], limit: 200 })
      .filter((event) => {
        const text = normalizeText(event.text ?? '')
        return text.length > 0 && visibleUserTexts.has(text)
      })
      .map((event) => event.seq)

    // 4. Deterministic assembly under the configured soft budget.
    const result = this.assembler.assemble({
      sessionId,
      taskText,
      turn: Number.isInteger(payload?.turn) ? payload.turn : undefined,
      step: Number.isInteger(payload?.step) ? payload.step : undefined,
      trigger: 'pre-step',
      excludeSeqs,
      measureTokens: (text) => host.measureTextTokens(this.ctx, session, text),
    })
    if (result === null || result.injected !== true || typeof result.text !== 'string' || result.text.trim().length === 0) return null

    // 5. Dedupe against what the model can already see. A compacted-away
    //    message is no longer visible, so it is injected again; identical
    //    visible content is not appended again.
    if (host.hasVisibleMemoryMessage(session, result.contentHash) && !this.refreshDue(sessionId, payload?.turn)) {
      return null
    }
    return { sessionId, session, result, contentHash: String(result.contentHash), text: result.text, state }
  }

  /**
   * Validate assistant messages committed since the last check. Deterministic
   * checks only; failures are persisted in `validation_logs` and may schedule a
   * bounded repair reminder. Errors never propagate to the host.
   *
   * @param {string} sessionId
   * @param {SessionRuntimeState} state
   * @returns {Promise<void>}
   */
  async validateNewOutput(sessionId, state) {
    const validation = this.config.validation ?? {}
    if (validation.enabled === false) return
    if (!Array.isArray(validation.checks) || validation.checks.length === 0) return
    if (this.validator === null || this.store === null) return
    const events = this.store.listEventsAfter(sessionId, state.lastValidatedSeq, {
      types: ['assistant/message'],
      limit: 8,
    })
    const maxRepairAttempts = Number(validation.maxRepairAttempts ?? 2)
    for (const event of events) {
      state.lastValidatedSeq = Math.max(state.lastValidatedSeq, Number(event.seq))
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.trim().length === 0) continue
      const run = await this.validator.runTextChecks({
        sessionId,
        text,
        target: 'body',
        attempts: state.repairAttempts,
        context: { turn: event.turn ?? null, step: event.step ?? null },
      })
      this.validator.record(sessionId, run, {
        seq: Number(event.seq),
        turn: event.turn ?? undefined,
        step: event.step ?? undefined,
      })
      if (run.ok) {
        state.repairAttempts = 0
        state.pendingRepair = null
        continue
      }
      const violationErrors = (run.violations ?? []).filter((violation) => violation.severity === 'error')
      if (violationErrors.length === 0) continue
      const note = this.buildRepairNote(run)
      state.pendingRepair = {
        text: note,
        signature: sha256(note),
        violations: violationErrors.length,
      }
      if (state.repairAttempts >= maxRepairAttempts) {
        this.warn(
          `session-memory: validation failed ${violationErrors.length} time(s) for session ${sessionId}; ` +
            `repair budget (${maxRepairAttempts}) is exhausted, reporting only`,
        )
      }
    }
  }

  /**
   * Turn a failed validation run into a bounded, clearly-labelled repair
   * reminder. It is derived plugin state (not a user decision, not a system
   * instruction) and says so in its own header.
   *
   * @param {any} run
   * @returns {string}
   */
  buildRepairNote(run) {
    /** @type {string[]} */
    const lines = [
      '## 记忆: 校验提醒（派生检查结果，不是用户指令，也不是系统指令）',
      '以下为插件为当前会话配置的确定性检查在最近一次输出中发现的未通过项；请核对并修正，不确定时如实说明。',
    ]
    for (const violation of run.violations ?? []) {
      if (violation.severity !== 'error') continue
      const excerpt = typeof violation.excerpt === 'string' && violation.excerpt.length > 0
        ? `；片段: ${String(violation.excerpt).slice(0, 160)}`
        : ''
      lines.push(`- [${violation.checkId ?? 'check'}] ${String(violation.message ?? 'validation failed').slice(0, 300)}${excerpt}`)
    }
    lines.push('本次检查为程序判定；不通过时不要声称已修复，除非确实已修改。')
    return lines.join('\n')
  }

  /**
   * Insert the memory message into the entering batch, right after the messages
   * claimed for this step (the pattern shipped plugins use), then log the
   * assembly for `memory explain`.
   *
   * @param {{ sessionId: string, session: any, result: any, contentHash: string, text: string }} prepared
   * @param {any} decision
   * @param {any[]} claimedMessages
   * @param {number | undefined} turn
   * @param {number | undefined} step
   * @returns {any}
   */
  applyDecision(prepared, decision, claimedMessages, turn, step) {
    const message = host.buildMemoryMessage({
      text: prepared.text,
      contentHash: prepared.contentHash,
      sessionId: prepared.sessionId,
      turn,
      step,
    })
    const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
    const claimed = Array.isArray(claimedMessages) ? claimedMessages : []
    const lastClaimedIndex = messages.findLastIndex((candidate) => claimed.includes(candidate))
    if (lastClaimedIndex >= 0) messages.splice(lastClaimedIndex + 1, 0, message)
    else messages.push(message)
    // A failed deterministic check schedules at most `maxRepairAttempts`
    // reminders; the report itself always stays in `validation_logs`.
    const repair = this.repairMessageFor(prepared, turn, step)
    if (repair !== null) {
      const memoryIndex = messages.indexOf(message)
      messages.splice(memoryIndex + 1, 0, repair)
    }
    const assemblyId = this.assembler.log(prepared.result, { trigger: 'pre-step' })
    this.pendingAssemblies.set(prepared.contentHash, assemblyId)
    if ((this.config.diagnostics?.verbose ?? false) && this.logger?.debug !== undefined) {
      this.logger.debug(
        `session-memory: injected ${prepared.result.usedTokens} tokens (${prepared.result.tokenSource}), ` +
          `${prepared.result.items.length} memories, ${prepared.result.sections.length} sections`,
      )
    }
    return { ...decision, messages }
  }

  /**
   * Build the bounded repair reminder for this step, if one is due and the same
   * reminder is not already visible in the surface.
   *
   * @param {{ sessionId: string, session: any, state: SessionRuntimeState }} prepared
   * @param {number | undefined} turn
   * @param {number | undefined} step
   * @returns {any | null}
   */
  repairMessageFor(prepared, turn, step) {
    const state = prepared.state
    if (state === undefined || state.pendingRepair === null) return null
    const maxRepairAttempts = Number(this.config.validation?.maxRepairAttempts ?? 2)
    if (state.repairAttempts >= maxRepairAttempts) return null
    const { text, signature } = state.pendingRepair
    if (text.length === 0) return null
    if (host.hasVisibleMemoryMessage(prepared.session, signature)) return null
    state.repairAttempts += 1
    return host.buildMemoryMessage({
      text,
      contentHash: signature,
      sessionId: prepared.sessionId,
      turn,
      step,
      form: 'repair',
    })
  }

  /**
   * Whether the configured refresh interval makes an otherwise identical block
   * worth re-injecting (default 0 = never; rely on compaction/visibility).
   *
   * @param {string} sessionId
   * @param {number | undefined} turn
   * @returns {boolean}
   */
  refreshDue(sessionId, turn) {
    const interval = Number(this.config.assembly?.reinjectUnchangedTurns ?? 0)
    if (!Number.isInteger(interval) || interval <= 0) return false
    if (!Number.isInteger(turn)) return false
    const rows = this.store.listAssemblies(sessionId, { limit: 50 })
    const latestInjected = rows.find((row) => row.injected === true || row.injected === 1)
    if (latestInjected === undefined) return true
    const lastTurn = Number(latestInjected.turn)
    if (!Number.isInteger(lastTurn)) return true
    return turn - lastTurn >= interval
  }

  /**
   * Sync the enabled skills into the local index. The host owns discovery;
   * this plugin only derives a rule index and records versions/hashes.
   *
   * @param {any} agent
   * @param {SessionRuntimeState} state
   * @returns {void}
   */
  syncSkills(agent, state) {
    const service = host.optionalService(this.ctx, 'skills')
    if (service === undefined || typeof service.list !== 'function') return
    const now = Date.now()
    if (!state.skillsDirty && now - state.lastSkillSyncAt < SKILL_SYNC_INTERVAL_MS) return
    state.lastSkillSyncAt = now
    state.skillsDirty = false
    try {
      const summaries = this.callSkillList(service, agent)
      if (!Array.isArray(summaries) || summaries.length === 0) return
      /** @type {object[]} */
      const full = []
      for (const summary of summaries) {
        const name = String(summary?.name ?? '')
        if (name.length === 0) continue
        let definition = null
        try {
          definition = typeof service.get === 'function' ? this.callSkillGet(service, name, agent) : null
        } catch (error) {
          this.warn(`memory: failed to read skill "${name}"`, error)
        }
        const content = typeof definition?.content === 'string' ? definition.content : null
        if (content === null || content.trim().length === 0) continue
        full.push({
          name,
          content,
          path: typeof definition?.path === 'string' ? definition.path : typeof summary?.path === 'string' ? summary.path : null,
          source: typeof definition?.source === 'string' ? definition.source : 'host',
          description: typeof definition?.description === 'string' ? definition.description : String(summary?.description ?? ''),
          whenToUse: typeof definition?.whenToUse === 'string' ? definition.whenToUse : String(summary?.whenToUse ?? ''),
          invocation: typeof definition?.invocation === 'string' ? definition.invocation : null,
        })
      }
      if (full.length > 0) this.skills.ingestSkills(full)
    } catch (error) {
      this.warn('memory: skill sync failed', error)
    }
  }

  /**
   * @param {any} service
   * @param {any} agent
   * @returns {any}
   */
  callSkillList(service, agent) {
    try {
      const value = service.list({ agent })
      if (value !== null && typeof value?.then === 'function') throw new Error('skill list returned a promise')
      return value
    } catch {
      return service.list()
    }
  }

  /**
   * @param {any} service
   * @param {string} name
   * @param {any} agent
   * @returns {any}
   */
  callSkillGet(service, name, agent) {
    try {
      const value = service.get(name, { agent })
      if (value !== null && typeof value?.then === 'function') throw new Error('skill get returned a promise')
      return value
    } catch {
      return service.get(name)
    }
  }

  /**
   * Fallback task text: the last captured user message of the session.
   *
   * @param {string} sessionId
   * @param {SessionRuntimeState} state
   * @returns {string}
   */
  lastUserText(sessionId, state) {
    if (state.lastUserText.length > 0) return state.lastUserText
    const events = this.store.listEvents(sessionId, { types: ['user/message'], limit: 20 })
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      // `listEvents` returns raw rows (snake_case columns).
      const sourceKind = event.source_kind ?? null
      if (sourceKind !== null && GENERATED_SOURCE_KINDS.has(sourceKind)) continue
      const text = String(event.text ?? '')
      if (text.length > 0 && !text.startsWith('[tool/')) return text
    }
    return ''
  }

  // ------------------------------------------------------------- validation

  /**
   * Configured, program-decidable file preconditions may deny a tool call.
   * Semantic checks never run here.
   *
   * @param {any} exec
   * @param {() => Promise<any>} next
   * @returns {Promise<any>}
   */
  async onPreToolExecute(exec, next) {
    try {
      const session = exec?.agent?.session ?? null
      const { sessionId, cwd } = host.describeSession(session)
      const decision = this.validator.evaluatePreconditions({
        sessionId,
        cwd: cwd ?? null,
        toolName: String(exec?.tool?.name ?? exec?.call?.name ?? exec?.name ?? ''),
        args: exec?.arguments ?? exec?.args ?? exec?.call?.arguments ?? {},
        signal: exec?.signal,
      })
      // `evaluatePreconditions` returns `{kind:'deny', reason, info}`;
      // `{allow:false, deny:{...}}` is accepted too so the contract stays stable.
      const denied = decision?.kind === 'deny' || decision?.allow === false
      if (denied) {
        const deny = decision.deny ?? { reason: decision.reason, info: decision.info }
        return { kind: 'deny', reason: String(deny?.reason ?? 'blocked by session-memory precondition'), info: deny?.info }
      }
    } catch (error) {
      this.warn('memory: precondition evaluation failed; tool call continues', error)
    }
    return next()
  }

  // ---------------------------------------------------------------- commands

  /**
   * Register the `memory` slash command when the host exposes `commands`.
   *
   * @returns {void}
   */
  registerCommands() {
    if (this.config.commands?.register === false) return
    const name = typeof this.config.commands?.name === 'string' && this.config.commands.name.length > 0 ? this.config.commands.name : 'memory'
    const dispose = host.registerCommand(this.ctx, {
      name,
      description: 'Inspect and manage the long-term session memory (status/inspect/search/explain/retract/export/purge)',
      hint: 'status | inspect <id> | search <query> | explain | retract <id> [reason] | export [--events] | purge',
      handler: (invocation) => {
        try {
          this.ensureStore()
          const sessionId = host.describeSession(invocation?.agent?.session ?? null).sessionId
          const result = this.diagnostics.handle(invocation?.rawInput ?? '', { sessionId })
          return host.normalizeCommandResult(result)
        } catch (error) {
          return { kind: 'error', text: `session-memory: ${host.errorText(error)}` }
        }
      },
    })
    if (typeof dispose === 'function') this.disposers.push(dispose)
  }

  // ----------------------------------------------------------------- helpers

  /**
   * @param {string} label
   * @param {Function} callback
   * @returns {void}
   */
  guard(label, callback) {
    try {
      callback()
    } catch (error) {
      this.warn(`memory: ${label} listener failed`, error)
    }
  }

  /**
   * @param {string} message
   * @param {unknown} [error]
   * @returns {void}
   */
  warn(message, error) {
    const detail = error === undefined ? '' : ` (${host.errorText(error)})`
    try {
      if (this.logger?.warn !== undefined) this.logger.warn(`${message}${detail}`)
      else if (this.logger?.debug !== undefined) this.logger.debug(`${message}${detail}`)
    } catch {
      // Logging must never break the host pipeline.
    }
  }
}

/**
 * @param {{ ctx: any, config: any, logger?: any, version?: string }} options
 * @returns {MemoryRuntime}
 */
export function createRuntime(options) {
  return new MemoryRuntime(options)
}
