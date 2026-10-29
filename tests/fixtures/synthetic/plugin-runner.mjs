/**
 * Plugin baseline runner: drives the real `src/` modules in-process over the
 * generated fixtures and records every observable measurement.
 *
 * What it does per session:
 * 1. opens one temporary SQLite file (never in-memory, so restart persistence is
 *    real) and a `MemoryStore` over it;
 * 2. registers the synthetic skill through `SkillManager`;
 * 3. feeds every host event through `CaptureService`, then `SessionExtractor`;
 * 4. at the fixture's restart markers closes the database, reopens the same file
 *    and re-delivers the backlog (capture must be idempotent);
 * 5. for every answer-key question calls `Retriever` + `Assembler` and records the
 *    assembled context, injected tokens, evidence seqs and wall-clock latency;
 * 6. checks the hard invariants (supersession, evidence after restart, isolation,
 *    pollution, dedupe, checkpoints).
 *
 * The runner never derives expectations from the generated text: everything
 * compared comes from `answer-key.json`.
 *
 * @module tests/fixtures/synthetic/plugin-runner
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

import {
  evaluateQuestion,
  evaluateRetrieval,
  scoreStorage,
  seqsFromRefs,
} from './metrics.mjs'

/** Module files the memory baseline needs, resolved relative to the repo root. */
export const PLUGIN_MODULE_FILES = Object.freeze({
  db: 'src/core/db.js',
  store: 'src/memory/store.js',
  capture: 'src/capture.js',
  extraction: 'src/memory/extraction.js',
  skills: 'src/skills.js',
  retrieval: 'src/retrieval.js',
  assembly: 'src/assembly.js',
  config: 'src/config.js',
})

/** Required exported symbol per module id. */
const REQUIRED_EXPORTS = Object.freeze({
  db: 'MemoryDatabase',
  store: 'MemoryStore',
  capture: 'CaptureService',
  extraction: 'SessionExtractor',
  skills: 'SkillManager',
  retrieval: 'Retriever',
  assembly: 'Assembler',
})

/**
 * Import the real plugin modules from the repository root. Missing modules are
 * reported instead of crashing, so the harness can still show baseline metrics
 * while `src/` is being written.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ available: boolean, modules: Record<string, any>, missingModules: string[] }>}
 */
export async function loadPluginModules(repoRoot) {
  /** @type {Record<string, any>} */
  const modules = {}
  /** @type {string[]} */
  const missingModules = []
  for (const [key, relative] of Object.entries(PLUGIN_MODULE_FILES)) {
    const absolute = path.join(repoRoot, ...relative.split('/'))
    if (!fs.existsSync(absolute)) {
      missingModules.push(relative)
      continue
    }
    try {
      modules[key] = await import(pathToFileURL(absolute).href)
    } catch (error) {
      missingModules.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const expected = REQUIRED_EXPORTS[key]
    if (expected !== undefined && typeof modules[key][expected] !== 'function') {
      missingModules.push(`${relative}: missing export ${expected}`)
    }
  }
  return { available: missingModules.length === 0, modules, missingModules }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * One live plugin pipeline over a single database file. Created once, rebuilt
 * on restart (new services over a reopened connection).
 */
class PluginHarness {
  /**
   * @param {{
   *   modules: Record<string, any>,
   *   config: object,
   *   dbPath: string,
   *   skill: { name: string, path: string, content: string },
   * }} input
   */
  constructor({ modules, config, dbPath, skill }) {
    this.modules = modules
    this.config = config
    this.dbPath = dbPath
    this.skill = skill
    /** @type {any} */
    this.db = null
    /** @type {number} total wall clock of capture calls */
    this.captureMs = 0
    /** @type {number} total wall clock of extraction calls */
    this.extractionMs = 0
    /** @type {Array<object>} */
    this.extractionErrors = []
    /** @type {Array<object>} */
    this.pipelineErrors = []
    /** @type {object[]} */
    this.restartRecords = []
    /** @type {object | null} */
    this.skillRegistration = null
  }

  /** Open the database and build the service graph. */
  start() {
    const { MemoryDatabase } = this.modules.db
    this.db = MemoryDatabase.open(this.dbPath, { migrate: true })
    this.buildServices()
    this.registerSkill()
  }

  /** (Re)build the service graph over the current connection. */
  buildServices() {
    const { MemoryStore } = this.modules.store
    const { CaptureService } = this.modules.capture
    const { SessionExtractor } = this.modules.extraction
    const { SkillManager } = this.modules.skills
    const { Retriever } = this.modules.retrieval
    const { Assembler } = this.modules.assembly
    this.store = new MemoryStore(this.db, { config: this.config })
    this.capture = new CaptureService(this.store, { config: this.config })
    this.extractor = new SessionExtractor(this.store, { config: this.config })
    this.skills = new SkillManager(this.store, { config: this.config })
    this.retriever = new Retriever(this.store, { config: this.config })
    this.assembler = new Assembler(this.store, {
      config: this.config,
      skills: this.skills,
      retriever: this.retriever,
    })
  }

  /** Register the synthetic skill (idempotent: unchanged content reuses rules). */
  registerSkill() {
    try {
      this.skillRegistration = this.skills.registerSkill({
        name: this.skill.name,
        content: this.skill.content,
        path: this.skill.path,
        source: 'fixture',
      })
    } catch (error) {
      this.pipelineErrors.push({ stage: 'register-skill', message: errorMessage(error) })
    }
  }

  /**
   * Close and reopen the database file, rebuild services. The skill index and
   * all rows must survive; the pipeline is expected to recover by checkpoint.
   */
  restart() {
    try {
      this.db.close()
    } catch (error) {
      this.pipelineErrors.push({ stage: 'restart-close', message: errorMessage(error) })
    }
    const { MemoryDatabase } = this.modules.db
    this.db = MemoryDatabase.open(this.dbPath, { migrate: true })
    this.buildServices()
  }

  /**
   * @param {object} session
   * @returns {void}
   */
  ensureSession(session) {
    try {
      this.store.ensureSession({
        sessionId: session.sessionId,
        cwd: session.cwd,
        project: session.project,
        origin: 'synthetic',
        dshVersion: session.dshVersion,
      })
    } catch (error) {
      this.pipelineErrors.push({ sessionId: session.sessionId, stage: 'ensure-session', message: errorMessage(error) })
    }
  }

  /**
   * @param {string} sessionId
   * @param {object[]} events
   * @returns {{ inserted: number, skipped: number }}
   */
  captureEvents(sessionId, events) {
    const started = performance.now()
    try {
      const result = this.capture.captureEvents(sessionId, events)
      this.captureMs += performance.now() - started
      return { inserted: result.inserted ?? 0, skipped: result.skipped ?? 0 }
    } catch (error) {
      this.captureMs += performance.now() - started
      this.pipelineErrors.push({ sessionId, stage: 'capture', message: errorMessage(error) })
      return { inserted: 0, skipped: events.length }
    }
  }

  /**
   * @param {string} sessionId
   * @returns {object | null}
   */
  extract(sessionId) {
    const started = performance.now()
    try {
      const result = this.extractor.extractPending(sessionId, { limit: 5000 })
      this.extractionMs += performance.now() - started
      for (const error of result.errors ?? []) {
        this.extractionErrors.push({ sessionId, seq: error.seq ?? null, message: error.message ?? String(error) })
      }
      return result
    } catch (error) {
      this.extractionMs += performance.now() - started
      this.pipelineErrors.push({ sessionId, stage: 'extract', message: errorMessage(error) })
      return null
    }
  }

  /**
   * Feed one turn group, extract, then honour any simulated restart that is
   * scheduled after that turn: reopen the DB and replay the backlog.
   *
   * @param {object} session
   * @param {{ phaseIndex: number }} state
   * @param {number} groupIndex
   * @returns {void}
   */
  ingestTurnGroup(session, state, groupIndex) {
    const sessionId = session.sessionId
    const group = session.turnGroups?.[groupIndex]
    if (group === undefined) return
    this.captureEvents(sessionId, session.events.slice(group.from, group.to))
    this.extract(sessionId)
    const phases = Array.isArray(session.phases) ? session.phases : []
    while (state.phaseIndex < phases.length && Number(phases[state.phaseIndex].afterTurn) <= Number(group.turn)) {
      const phase = phases[state.phaseIndex]
      this.restart()
      const replay = session.events.slice(phase.replayFromIndex, phase.replayToIndex)
      const capture = this.captureEvents(sessionId, replay)
      this.extract(sessionId)
      this.restartRecords.push({
        sessionId,
        afterTurn: Number(group.turn),
        replayEvents: replay.length,
        inserted: capture.inserted,
        skipped: capture.skipped,
        note: phase.note ?? '',
      })
      state.phaseIndex += 1
    }
  }

  /**
   * For one session: run every answer-key question through retrieval + assembly
   * and compare the assembled context against the answer key.
   *
   * @param {{ session: object, answerKey: object }} entry
   * @returns {object}
   */
  measureSession(entry) {
    const { session, answerKey } = entry
    const sessionId = session.sessionId
    const factsByKey = new Map((answerKey.facts ?? []).map((fact) => [fact.key, fact]))
    const items = this.store.listMemoryItems(sessionId, { limit: 5000 }) ?? []
    const rules = this.store.listRules() ?? []
    const taskState = this.store.getTaskState(sessionId)
    const checkpoint = this.store.getCheckpoint(sessionId)
    const storage = scoreStorage({ answerKey, items, rules, taskState })

    /** @type {object[]} */
    const questionRuns = []
    for (const question of answerKey.questions ?? []) {
      const started = performance.now()
      /** @type {any} */
      let result = null
      try {
        result = this.assembler.assemble({
          sessionId,
          taskText: question.query,
          turn: session.turns,
          step: 1,
          trigger: 'eval-question',
        })
      } catch (error) {
        this.pipelineErrors.push({ sessionId, questionId: question.id, stage: 'assemble', message: errorMessage(error) })
      }
      const assemblyMs = performance.now() - started

      /** @type {object[]} */
      let retrievalItems = []
      /** @type {object[]} */
      let evidenceEntries = []
      try {
        const retrieval = this.retriever.retrieve(sessionId, { query: question.query, limit: 24 })
        retrievalItems = retrieval.items ?? []
        const evidence = this.retriever.retrieveEvidence(sessionId, {
          query: question.query,
          items: retrievalItems,
          limit: 8,
        })
        evidenceEntries = evidence.evidence ?? []
      } catch (error) {
        this.pipelineErrors.push({ sessionId, questionId: question.id, stage: 'retrieve', message: errorMessage(error) })
      }

      const assembledText = typeof result?.text === 'string' ? result.text : ''
      const evaluation = evaluateQuestion({
        question,
        factsByKey,
        context: assembledText,
        evidenceSeqs: Array.isArray(result?.evidence) ? result.evidence : [],
      })
      const retrievalEvaluation = evaluateRetrieval({
        question,
        factsByKey,
        items: retrievalItems,
        evidence: evidenceEntries,
      })
      questionRuns.push({
        questionId: question.id,
        kind: question.kind,
        lang: question.lang,
        query: question.query,
        assemblyMs,
        result: {
          injected: result?.injected === true,
          textChars: assembledText.length,
          usedTokens: Number.isFinite(result?.usedTokens) ? result.usedTokens : 0,
          budgetTokens: Number.isFinite(result?.budgetTokens) ? result.budgetTokens : null,
          tokenSource: result?.tokenSource ?? 'estimate',
          contentHash: result?.contentHash ?? '',
          evidence: Array.isArray(result?.evidence) ? result.evidence : [],
          items: Array.isArray(result?.items) ? result.items : [],
          rules: Array.isArray(result?.rules) ? result.rules : [],
          sections: Array.isArray(result?.sections) ? result.sections : [],
          errors: Array.isArray(result?.errors) ? result.errors : [],
        },
        retrieval: {
          candidates: retrievalItems.length,
          evidence: evidenceEntries.map((entry) => Number(entry.seq)),
        },
        evaluation,
        retrievalEvaluation,
      })
    }

    return {
      sessionId,
      scenario: session.scenario,
      turns: session.turns,
      group: session.group ?? null,
      variant: session.variant ?? 'full',
      storage,
      taskState,
      checkpoint,
      skillRegistration: this.skillRegistration,
      questions: questionRuns,
    }
  }
}

/**
 * Run the real-plugin baseline over a fixture bundle.
 *
 * @param {{
 *   repoRoot: string,
 *   fixture: { manifest: object, sessions: Array<{ session: object, answerKey: object }>, skillContent: string },
 *   options?: { config?: object, verbose?: boolean },
 * }} input
 * @returns {Promise<object>}
 */
export async function runMemoryBaseline({ repoRoot, fixture, options = {} }) {
  const loaded = await loadPluginModules(repoRoot)
  if (!loaded.available) {
    return {
      id: 'memory',
      available: false,
      missingModules: loaded.missingModules,
      sessions: [],
      invariants: [],
      notes: ['the real plugin modules are not all on disk yet; memory metrics are reported as null'],
    }
  }
  const { modules } = loaded
  const config = typeof modules.config?.normalizeConfig === 'function'
    ? modules.config.normalizeConfig(options.config ?? {})
    : { ...(options.config ?? {}) }

  const skill = {
    name: fixture.manifest?.skill?.name ?? 'synthetic-eval-runbook',
    path: fixture.manifest?.skill?.path ?? 'skills/synthetic-eval-runbook/SKILL.md',
    content: fixture.skillContent,
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-long-conversation-memory-eval-'))
  const dbPath = path.join(tempDir, 'memory.sqlite')
  const harness = new PluginHarness({ modules, config, dbPath, skill })
  const startedAt = performance.now()

  try {
    harness.start()
    for (const entry of fixture.sessions) harness.ensureSession(entry.session)

    // Long-haul sessions run sequentially; a multi-session group is fed
    // turn-by-turn through the same database to exercise isolation and the
    // shared connection.
    const longHaul = fixture.sessions.filter((entry) => entry.session.group !== 'isolation')
    const isolation = fixture.sessions.filter((entry) => entry.session.group === 'isolation')
    for (const entry of longHaul) {
      const state = { phaseIndex: 0 }
      for (let index = 0; index < (entry.session.turnGroups?.length ?? 0); index += 1) {
        harness.ingestTurnGroup(entry.session, state, index)
      }
    }
    if (isolation.length > 0) {
      /** @type {Map<string, { phaseIndex: number, index: number }>} */
      const states = new Map(isolation.map((entry) => [entry.session.sessionId, { phaseIndex: 0, index: 0 }]))
      const maxGroups = Math.max(...isolation.map((entry) => entry.session.turnGroups?.length ?? 0))
      for (let index = 0; index < maxGroups; index += 1) {
        for (const entry of isolation) {
          const state = states.get(entry.session.sessionId)
          if (state === undefined || index >= (entry.session.turnGroups?.length ?? 0)) continue
          harness.ingestTurnGroup(entry.session, state, index)
          state.index = index + 1
        }
      }
    }
    const ingestMs = performance.now() - startedAt

    const sessionRuns = fixture.sessions.map((entry) => harness.measureSession(entry))
    const invariants = checkInvariants({ fixture, harness, sessionRuns })
    const eventRows = harness.store.listEventsForCounts?.() ?? null
    return {
      id: 'memory',
      available: true,
      missingModules: [],
      tempDir,
      ingestMs,
      captureMs: harness.captureMs,
      extractionMs: harness.extractionMs,
      extractionErrors: harness.extractionErrors,
      pipelineErrors: harness.pipelineErrors,
      restartRecords: harness.restartRecords,
      skillRegistration: harness.skillRegistration,
      sessions: sessionRuns,
      invariants,
      eventRows,
      notes: [
        'real src/ modules driven in-process over one temporary SQLite file per evaluation run',
        'restart = close the database, reopen the same file, replay the backlog through capture (expected to insert 0 new rows)',
        'answer accuracy is not measured; only deterministic storage/retrieval/assembly/overhead metrics are reported',
      ],
    }
  } finally {
    try {
      harness.db?.close()
    } catch {
      // already closed
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

/**
 * @param {{
 *   fixture: object,
 *   harness: PluginHarness,
 *   sessionRuns: object[],
 * }} input
 * @returns {Array<{ id: string, status: 'pass'|'fail'|'skip', detail: string }>}
 */
export function checkInvariants({ fixture, harness, sessionRuns }) {
  /** @type {Array<{ id: string, status: 'pass'|'fail'|'skip', detail: string }>} */
  const invariants = []
  const bySession = new Map(sessionRuns.map((run) => [run.sessionId, run]))

  const push = (id, ok, detail, options = {}) => {
    const status = options.skip === true ? 'skip' : ok ? 'pass' : 'fail'
    invariants.push({ id, status, detail })
  }

  // 1. A superseded old value must never be retrievable as active.
  const supersedeIssues = []
  for (const entry of fixture.sessions) {
    const run = bySession.get(entry.session.sessionId)
    if (run === undefined) continue
    for (const fact of entry.answerKey.facts ?? []) {
      // Only facts with an explicit superseded initial value participate in this
      // invariant. Non-corrected facts may omit initialValue entirely (undefined)
      // or carry an empty string, so test truthiness rather than null equality.
      if (fact.initialValue === null || fact.initialValue === undefined || String(fact.initialValue).length === 0) continue

      const detail = run.storage?.facts?.details?.find((candidate) => candidate.key === fact.key)
      if (detail === undefined) {
        supersedeIssues.push(`${entry.session.sessionId}/${fact.key}: fact was never stored`)
        continue
      }
      if (detail.supersededActiveLeak) supersedeIssues.push(`${entry.session.sessionId}/${fact.key}: old value still active`)
      if (!detail.supersession) supersedeIssues.push(`${entry.session.sessionId}/${fact.key}: supersession link missing`)
    }
  }
  push('superseded_not_active', supersedeIssues.length === 0, supersedeIssues.length === 0 ? 'all corrected facts have a superseded old row linked to the new one' : supersedeIssues.join('; '))

  // 2. Raw evidence must survive compaction and restart.
  const evidenceIssues = []
  for (const entry of fixture.sessions) {
    const run = bySession.get(entry.session.sessionId)
    if (run === undefined) continue
    const storedSeqs = new Set(
      (harness.store.listEvents(entry.session.sessionId, { limit: 1000000 }) ?? []).map((event) => Number(event.seq)),
    )
    for (const fact of entry.answerKey.facts ?? []) {
      for (const seq of [fact.sourceSeq, fact.correctionSeq]) {
        if (seq === null || seq === undefined) continue
        if (!storedSeqs.has(Number(seq))) evidenceIssues.push(`${entry.session.sessionId}: seq ${seq} missing after restart`)
      }
    }
    const expectedEvents = Number(entry.session.meta?.uniqueEvents ?? 0)
    if (expectedEvents > 0 && storedSeqs.size !== expectedEvents) {
      evidenceIssues.push(`${entry.session.sessionId}: ${storedSeqs.size} stored events, expected ${expectedEvents}`)
    }
    void run
  }
  push('evidence_survives_restart_compaction', evidenceIssues.length === 0, evidenceIssues.length === 0 ? 'every fact source/correction seq is present after all restarts and compactions' : evidenceIssues.join('; '))

  // 3. Multi-session isolation: no cross-session fact leaks into storage or assembly.
  const isolationIssues = []
  const isolationSessions = fixture.sessions.filter((entry) => entry.session.group === 'isolation')
  for (const entry of isolationSessions) {
    const run = bySession.get(entry.session.sessionId)
    if (run === undefined) continue
    const siblingValues = isolationSessions
      .filter((other) => other.session.sessionId !== entry.session.sessionId)
      .flatMap((other) => (other.answerKey.facts ?? []).map((fact) => fact.value))
    const ownText = [
      ...(run.storage?.facts?.details ?? []).map((detail) => detail.valueItemId ?? ''),
      ...(run.questions ?? []).map((question) => question.result?.textChars ?? ''),
    ].join('\n')
    void ownText
    for (const value of siblingValues) {
      const leaked = (run.storage?.facts?.details ?? []).some((detail) => String(detail.key).includes(String(value)))
      if (leaked) isolationIssues.push(`${entry.session.sessionId}: sibling value ${value} appears in own fact list`)
      for (const question of run.questions ?? []) {
        const evaluation = question.evaluation
        if (evaluation?.checks?.forbiddenHits?.length > 0) {
          isolationIssues.push(`${entry.session.sessionId}/${question.questionId}: forbidden value(s) ${evaluation.checks.forbiddenHits.join(',')} in assembled context`)
        }
      }
    }
  }
  push('cross_session_isolation', isolationSessions.length === 0 ? true : isolationIssues.length === 0, isolationSessions.length === 0 ? 'no multi-session group in this profile' : isolationIssues.length === 0 ? 'sibling session values never appear in the other session storage or context' : isolationIssues.join('; '), { skip: isolationSessions.length === 0 })

  // 4. Instruction-pollution tool output must never become durable memory.
  // Numeric pollution values match only on token boundaries: a naive substring
  // check for "0.1" would also hit legitimate conditions such as "95% CI ±0.18"
  // or "99.05" and report a false positive.
  const numericBoundaryExpression = (value) => new RegExp(
    `(?<![\\d.])${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`,
    'u',
  )
  const pollutionIssues = []
  for (const entry of fixture.sessions) {
    const phrases = entry.answerKey.pollution?.phrases ?? []
    const values = entry.answerKey.pollution?.values ?? []
    if (phrases.length === 0 && values.length === 0) continue
    const items = harness.store.listMemoryItems(entry.session.sessionId, { limit: 5000 }) ?? []
    for (const item of items) {
      const text = `${item.content ?? ''}\n${(item.conditions ?? []).join('\n')}`
      for (const phrase of phrases) {
        if (text.toLowerCase().includes(String(phrase).toLowerCase())) {
          pollutionIssues.push(`${entry.session.sessionId}: pollution phrase "${phrase}" stored in item ${item.id}`)
        }
      }
      for (const value of values) {
        if (numericBoundaryExpression(value).test(text)) pollutionIssues.push(`${entry.session.sessionId}: pollution value ${value} stored in item ${item.id}`)
      }
    }
  }
  push('pollution_not_extracted', pollutionIssues.length === 0, pollutionIssues.length === 0 ? 'tool-output instruction pollution never became a memory item' : pollutionIssues.join('; '))

  // 5. Retry/cancel/duplicate must not duplicate the active decision.
  const retryIssues = []
  for (const entry of fixture.sessions) {
    const retry = entry.answerKey.retry
    if (retry === undefined || retry === null) continue
    const items = harness.store.listMemoryItems(entry.session.sessionId, { limit: 5000 }) ?? []
    const active = items.filter((item) => item.status === 'active' && String(item.content ?? '').includes(retry.marker))
    if (active.length > retry.maxActiveItems) {
      retryIssues.push(`${entry.session.sessionId}: ${active.length} active items contain "${retry.marker}" (expected <= ${retry.maxActiveItems})`)
    }
  }
  push('retry_no_duplicate', retryIssues.length === 0, retryIssues.length === 0 ? 'cancel/retry/duplicate delivery left exactly one active decision item' : retryIssues.join('; '))

  // 6. Active content hashes stay unique (dedupe index holds).
  const duplicateIssues = []
  for (const entry of fixture.sessions) {
    const items = harness.store.listMemoryItems(entry.session.sessionId, { status: 'active', limit: 5000 }) ?? []
    const seen = new Map()
    for (const item of items) {
      const key = String(item.contentHash ?? item.content ?? '')
      if (seen.has(key)) duplicateIssues.push(`${entry.session.sessionId}: duplicate active content (${item.id} vs ${seen.get(key)})`)
      else seen.set(key, item.id)
    }
  }
  push('no_duplicate_active_content', duplicateIssues.length === 0, duplicateIssues.length === 0 ? 'active memory content is unique per session' : duplicateIssues.join('; '))

  // 7. Restart replay must be idempotent: it may not add rows.
  const restartInserted = (harness.restartRecords ?? []).reduce((sum, record) => sum + Number(record.inserted ?? 0), 0)
  push('restart_idempotent_event_count', restartInserted === 0, restartInserted === 0 ? `${harness.restartRecords.length} restart replay(s) inserted 0 new events` : `restart replay inserted ${restartInserted} event row(s)`)

  // 8. Checkpoints advance to the end of the ingested stream.
  const checkpointIssues = []
  for (const entry of fixture.sessions) {
    const run = bySession.get(entry.session.sessionId)
    if (run === undefined) continue
    const maxSeq = Math.max(...(entry.session.events ?? []).map((event) => Number(event.seq)))
    if (Number(run.checkpoint?.lastEventSeq) !== maxSeq) {
      checkpointIssues.push(`${entry.session.sessionId}: lastEventSeq ${run.checkpoint?.lastEventSeq} != max seq ${maxSeq}`)
    }
    if (Number(run.checkpoint?.lastExtractSeq) !== maxSeq) {
      checkpointIssues.push(`${entry.session.sessionId}: lastExtractSeq ${run.checkpoint?.lastExtractSeq} != max seq ${maxSeq}`)
    }
  }
  push('checkpoint_advanced', checkpointIssues.length === 0, checkpointIssues.length === 0 ? 'event/extraction checkpoints advanced to the final ingested seq for every session' : checkpointIssues.join('; '))

  // 9. Pipeline itself must not have reported runtime errors.
  const pipelineErrors = [...(harness.extractionErrors ?? []), ...(harness.pipelineErrors ?? [])]
  push(
    'no_pipeline_errors',
    pipelineErrors.length === 0,
    pipelineErrors.length === 0 ? 'capture/extraction/assembly/retrieval produced no errors' : pipelineErrors.slice(0, 6).map((error) => JSON.stringify(error)).join('; '),
  )

  return invariants
}
