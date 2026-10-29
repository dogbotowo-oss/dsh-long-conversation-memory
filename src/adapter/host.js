/**
 * DSH host boundary.
 *
 * Everything in this module is the ONLY place that knows about DeepSeek Harness
 * specifics. The core modules (`capture`, `skills`, `memory`, `retrieval`,
 * `assembly`, `validation`, `diagnostics`) never import a `@deepseek-ai/*`
 * package and never assume host internals.
 *
 * Design constraints verified against DSH 0.2.1-rc.3 (see docs/compatibility.md):
 *
 * - A plugin's `node_modules` resolution does not include the host packages
 *   (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, ...), and a
 *   publicly-installable plugin must not force a specific host build. Therefore
 *   this file ships local implementations of the two small host helpers it
 *   needs (message construction, home-path resolution) instead of importing the
 *   host packages. Both helpers were read from the shipped source; see
 *   docs/compatibility.md for the exact locations and signatures.
 * - `session.deriveMessages()` is the supported way to observe committed
 *   history. `session.eventAt()` / `session.snapshotEvents()` are marked
 *   @deprecated ("new calls are prohibited") and are not used here.
 * - Committed events are observed through the public `session/event` emit whose
 *   listener signature is `(session, event)`.
 * - The per-step hook is the `agent/pre-step` waterfall. Its payload contains
 *   only the messages claimed for the proposed step; committed history is read
 *   through `session.deriveMessages()`.
 * - Everything registered through `ctx.on` / `ctx.commands.register` is
 *   disposed by cordis with the plugin fiber; helpers here return the disposer.
 *
 * @module dsh-session-memory/adapter/host
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

import { MEMORY_SOURCE_FORM, MEMORY_SOURCE_KIND } from '../core/constants.js'
import { contentBlocksToText, isPlainObject } from '../core/util.js'

export const DSH_HOME_ENV = 'DSH_HOME'
export const PLUGIN_STATE_DIR_NAME = 'session-memory'

/**
 * Resolve the plugin's local data directory.
 *
 * Mirrors `@deepseek-ai/dsh-home-paths` (`lib/index.js:109-168` in the shipped
 * build): explicit config value -> `$DSH_HOME` -> `~/.dsh`. The plugin keeps its
 * own directory inside DSH home by default; it never writes into the host's
 * session-persistence database.
 *
 * @param {string | null | undefined} configured
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute directory path
 */
export function resolveDataDir(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(expandHomePath(configured.trim(), env))
  }
  const home = resolveDshHome(undefined, env)
  return path.join(home, PLUGIN_STATE_DIR_NAME)
}

/**
 * @param {string | null | undefined} configured
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDshHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(expandHomePath(configured.trim(), env))
  }
  const fromEnv = env?.[DSH_HOME_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return path.resolve(expandHomePath(fromEnv.trim(), env))
  }
  return path.join(env?.HOME || homedir(), '.dsh')
}

/**
 * Expand a leading `~` / `$VAR` only. Deliberately minimal: no globbing, no
 * command substitution.
 *
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function expandHomePath(value, env = process.env) {
  let output = String(value)
  if (output === '~') return env?.HOME || homedir()
  if (output.startsWith('~/') || output.startsWith('~\\')) {
    output = path.join(env?.HOME || homedir(), output.slice(2))
  }
  output = output.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
    const replacement = env?.[name]
    return typeof replacement === 'string' ? replacement : match
  })
  return output
}

/**
 * Build a host-valid user message carrying the memory block.
 *
 * The plugin cannot import `createUserMessage` from `@deepseek-ai/dsh-llm`, so
 * this reproduces its verified behaviour (`dsh-llm/lib/index.js:37-64`):
 * `{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source }`.
 * Session append validation is structural only, so a JSON-serializable message
 * object with a safe `source` is accepted.
 *
 * The `source.kind` is what lets a later step recognise its own injection
 * (`session.deriveMessages()`) and avoid re-appending identical content.
 *
 * @param {{ text: string, contentHash: string, sessionId: string, turn?: number, step?: number, form?: string }} input
 * @returns {{ id: string, role: 'user', content: { type: 'text', text: string }[], source: Record<string, unknown> }}
 */
export function buildMemoryMessage(input) {
  const text = String(input.text ?? '')
  /** @type {Record<string, unknown>} */
  const source = {
    kind: MEMORY_SOURCE_KIND,
    form: typeof input.form === 'string' && input.form.length > 0 ? input.form : MEMORY_SOURCE_FORM,
    contentHash: String(input.contentHash ?? ''),
    sessionId: String(input.sessionId ?? ''),
  }
  if (Number.isInteger(input.turn)) source.turn = input.turn
  if (Number.isInteger(input.step)) source.step = input.step
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

/**
 * Read the visible (non-compacted) history as plain messages.
 *
 * `session.deriveMessages()` returns a fresh array whose message objects are
 * deep-frozen and shared; we only read them.
 *
 * @param {any} session
 * @returns {any[]}
 */
export function visibleMessages(session) {
  try {
    if (session === null || session === undefined) return []
    if (typeof session.deriveMessages === 'function') {
      const messages = session.deriveMessages()
      return Array.isArray(messages) ? messages : []
    }
  } catch {
    // A host without the projection API is reported by diagnostics; memory
    // assembly still works, it just cannot dedupe by visibility.
  }
  return []
}

/**
 * The content hash of the newest visible plugin-injected memory message, if any.
 *
 * @param {any} session
 * @returns {string | null}
 */
export function latestVisibleMemoryHash(session) {
  const messages = visibleMessages(session)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const source = isPlainObject(message) ? message.source : undefined
    if (isPlainObject(source) && source.kind === MEMORY_SOURCE_KIND) {
      return typeof source.contentHash === 'string' ? source.contentHash : null
    }
  }
  return null
}

/**
 * Whether the plugin already injected a message with this exact content into
 * the visible history.
 *
 * @param {any} session
 * @param {string} contentHash
 * @returns {boolean}
 */
export function hasVisibleMemoryMessage(session, contentHash) {
  const messages = visibleMessages(session)
  if (messages.length === 0) return false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const source = isPlainObject(message) ? message.source : undefined
    if (isPlainObject(source) && source.kind === MEMORY_SOURCE_KIND) {
      if (source.contentHash === contentHash) return true
    }
  }
  return false
}

/**
 * @param {any} session
 * @param {string} kind
 * @returns {boolean}
 */
export function isGeneratedSource(session, kind) {
  return latestVisibleMemoryHash(session) !== null && kind === MEMORY_SOURCE_KIND
}

/**
 * Session identity and header facts used for durable bookkeeping.
 *
 * @param {any} session
 * @returns {{ sessionId: string, cwd: string | null, origin: string | null, project: string | null }}
 */
export function describeSession(session) {
  const header = isPlainObject(session?.header) ? session.header : {}
  const id = String(header.id ?? session?.id ?? '')
  return {
    sessionId: id,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    origin: typeof header.origin === 'string' ? header.origin : null,
    project: typeof header.project === 'string' ? header.project : null,
  }
}

/**
 * Subagent sessions are excluded from memory by default (their events are
 * implementation detail of the parent task).
 *
 * @param {any} session
 * @returns {boolean}
 */
export function isSubagentSession(session) {
  return describeSession(session).origin === 'subagent'
}

/**
 * Text of a list of LLM messages (content blocks flattened).
 *
 * @param {any[]} messages
 * @returns {string}
 */
export function messagesText(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    const text = contentBlocksToText(message?.content)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n').trim()
}

/**
 * Register a listener on a host event, tolerating a host without that event.
 *
 * @param {any} ctx
 * @param {string} event
 * @param {Function} listener
 * @returns {() => void} disposer (no-op when registration failed)
 */
export function onHostEvent(ctx, event, listener) {
  try {
    if (typeof ctx?.on === 'function') {
      const disposer = ctx.on(event, listener)
      return typeof disposer === 'function' ? disposer : () => {}
    }
  } catch {
    // Fall through: diagnostics report the missing capability.
  }
  return () => {}
}

/**
 * The optional services this plugin uses, read defensively: none of them is a
 * hard dependency (`inject` stays empty so the plugin loads on any profile).
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
export function optionalService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    if (isPlainObject(ctx?.[name])) return ctx[name]
  } catch {
    // Unknown service shape: treated as absent.
  }
  return undefined
}

/**
 * Register the `memory` slash command when the host exposes `commands`.
 *
 * @param {any} ctx
 * @param {{ name: string, description: string, hint?: string, handler: (invocation: any) => any }} definition
 * @returns {() => void} disposer
 */
export function registerCommand(ctx, definition) {
  const commands = optionalService(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') return () => {}
  try {
    const disposer = commands.register({
      name: definition.name,
      description: definition.description,
      input: { hint: definition.hint ?? '' },
      handler: definition.handler,
    })
    return typeof disposer === 'function' ? disposer : () => {}
  } catch {
    return () => {}
  }
}

/**
 * Exact token measurement for the injected block, when the host exposes a
 * meter. Returns `undefined` when unavailable so assembly falls back to the
 * documented estimate and records `tokenSource: 'estimate'`.
 *
 * @param {any} ctx
 * @param {any} session
 * @param {string} text
 * @returns {number | undefined}
 */
export function measureTextTokens(ctx, session, text) {
  const meter = optionalService(ctx, 'tokenMeter')
  if (meter === undefined) return undefined
  try {
    if (typeof meter.estimateText === 'function') {
      const value = meter.estimateText(text)
      if (Number.isFinite(value)) return Math.max(0, Math.ceil(value))
    }
    if (typeof meter.estimateMessage === 'function') {
      const value = meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
      if (Number.isFinite(value)) return Math.max(0, Math.ceil(value))
    }
    if (typeof meter.measure === 'function' && session !== undefined) {
      const measurement = meter.measure(session)
      if (Number.isFinite(measurement?.baseline) && Number.isFinite(measurement?.totalTokens)) {
        // Not attributable to this text alone; leave it to the estimator.
        return undefined
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Best-effort compaction compatibility report.
 *
 * A plugin cannot inspect another plugin's internal listener order through the
 * public API, so this reports what *is* knowable and labels the rest as
 * unconfirmed (the spec requires that honesty):
 *
 * - whether the host exposes a `compaction` service at all;
 * - whether compaction events have been observed in this session;
 * - the configured expectation (`compatibility.compactionPolicy`).
 *
 * @param {any} ctx
 * @param {{ configured: string, observedCompactionEvents: number, lastCompactionSeq: number | null, lastCompactionAt: string | null }} state
 * @returns {{ configured: string, compactionService: boolean, observedEvents: number, lastCompactionSeq: number | null, lastCompactionAt: string | null, status: 'confirmed' | 'unconfirmed', note: string }}
 */
export function compactionCompatibility(ctx, state) {
  const hasService = optionalService(ctx, 'compaction') !== undefined
  const observed = Number(state?.observedCompactionEvents ?? 0)
  const configured = String(state?.configured ?? 'auto')
  let status = 'unconfirmed'
  if (observed > 0) status = 'confirmed'
  let note
  if (observed > 0) {
    note = 'compaction events observed in this session; re-injection after compaction is active'
  } else if (hasService) {
    note = 'host exposes a compaction service; no compaction observed yet, so recovery is untested for this session'
  } else {
    note = 'host exposes no compaction service; the plugin works without compaction but cannot demonstrate recovery'
  }
  if (configured === 'none') {
    note = 'compaction compatibility explicitly marked as not applicable (compatibility.compactionPolicy = none)'
    status = observed > 0 ? 'confirmed' : 'unconfirmed'
  }
  return {
    configured,
    compactionService: hasService,
    observedEvents: observed,
    lastCompactionSeq: Number.isInteger(state?.lastCompactionSeq) ? state.lastCompactionSeq : null,
    lastCompactionAt: typeof state?.lastCompactionAt === 'string' ? state.lastCompactionAt : null,
    status,
    note,
  }
}

/**
 * Normalize a command handler result for `ctx.commands` (which validates
 * `{ kind: 'success' | 'error', text? }`).
 *
 * @param {{ kind?: string, text?: string }} result
 * @returns {{ kind: 'success', text: string } | { kind: 'error', text: string }}
 */
export function normalizeCommandResult(result) {
  const kind = result?.kind === 'error' ? 'error' : 'success'
  return { kind, text: String(result?.text ?? '') }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
