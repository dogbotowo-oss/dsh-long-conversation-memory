/**
 * Capture: turn committed host session events into durable evidence rows.
 *
 * Capture is deliberately lossless for human/tool text: raw text is stored in
 * `events` (and archived for content the host log may not replay), never
 * replaced by a derived summary. Derivation happens in `memory/extraction.js`.
 *
 * @module dsh-long-memory/capture
 */

import { CAPTURED_EVENT_TYPES, COMPACTION_EVENT_TYPES, LIMITS } from './core/constants.js'
import { clampText, contentBlocksToText, normalizeText, sha256 } from './core/util.js'

const CAPTURED = new Set([...CAPTURED_EVENT_TYPES, ...COMPACTION_EVENT_TYPES])

/**
 * Source kinds that are generated context, not human input. They are captured
 * as evidence (useful for diagnostics) but never scanned for memory extraction
 * and never treated as user instruction.
 */
export const GENERATED_SOURCE_KINDS = new Set([
  'long-memory',
  'runtime-context',
  'agent-instructions',
  'skill-invocation',
  'time-context',
  'compaction-checkpoint',
  'compact-checkpoint',
  'plan-mode',
])

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function optionalInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function safeStringify(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return contentBlocksToText(content)
  if (content && typeof content === 'object') return safeStringify(content) ?? ''
  return ''
}

/**
 * Convert one host `SessionEvent` into a store record, or `null` for event
 * types the memory plugin does not need to index.
 *
 * @param {string} sessionId
 * @param {object} event
 * @param {{ config?: { archive?: { maxCharsPerEvent?: number } } }} [options]
 * @returns {object | null} store record
 */
export function eventToRecord(sessionId, event, options = {}) {
  if (!event || typeof event !== 'object') return null
  const type = optionalString(event.type)
  if (type === null) return null
  if (!CAPTURED.has(type)) return null

  /** @type {Record<string, unknown>} */
  const record = {
    sessionId,
    seq: Number(event.seq),
    type,
    time: optionalString(event.time) ?? new Date().toISOString(),
    turn: null,
    step: null,
    role: null,
    text: null,
    sourceKind: null,
    sourceForm: null,
    toolName: null,
    callId: null,
    store: 'host',
    contentHash: null,
    truncated: false,
  }
  if (!Number.isInteger(record.seq) || record.seq < 0) return null

  const data = event.data ?? {}
  const maxChars = LIMITS.maxStoredTextChars
  /** @type {string | null} */
  let text = null
  switch (type) {
    case 'user/message': {
      const message = data
      record.role = 'user'
      record.sourceKind = optionalString(message.source?.kind)
      record.sourceForm = optionalString(message.source?.form)
      text = contentText(message.content)
      if (text.trim().length === 0) {
        // A pure marker message (e.g. injected context with no text) is kept
        // for provenance but carries no searchable text.
        text = ''
      }
      break
    }
    case 'assistant/message': {
      record.role = 'assistant'
      record.turn = optionalInt(data.turn)
      record.step = optionalInt(data.step)
      const message = data.message ?? {}
      text = contentText(message.content)
      break
    }
    case 'tool/call': {
      record.role = 'tool'
      record.turn = optionalInt(data.turn)
      record.step = optionalInt(data.step)
      record.toolName = optionalString(data.name)
      record.callId = optionalString(data.callId)
      const args = clampText(safeStringify(data.arguments) ?? '', LIMITS.maxStoredArgsChars)
      text = `[tool/call ${record.toolName ?? 'unknown'}] ${args}`
      break
    }
    case 'tool/result': {
      record.role = 'tool'
      record.turn = optionalInt(data.turn)
      record.step = optionalInt(data.step)
      const message = data.message ?? {}
      record.callId = optionalString(message.source?.callId)
      record.toolName = optionalString(message.source?.name)
      const resultText = contentText(message.content)
      const failed = data.error !== undefined || message.isError === true
      text = failed ? `[tool/result error] ${resultText}` : resultText
      break
    }
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end': {
      record.turn = optionalInt(data.turn)
      record.step = optionalInt(data.step)
      text = null
      break
    }
    case 'request/header': {
      record.turn = optionalInt(data.turn)
      record.step = optionalInt(data.step)
      text = null
      break
    }
    case 'compaction/summary': {
      const message = data.message ?? data.summary ?? data
      text = contentText(message?.content ?? message)
      break
    }
    case 'compaction/prune': {
      text = safeStringify(data)
      break
    }
    case 'compaction/start':
    case 'compaction/end': {
      text = safeStringify(data)
      break
    }
    case 'command/run':
    case 'command/done': {
      record.role = 'command'
      text = contentText(data.text ?? data.command ?? data)
      break
    }
    default: {
      text = safeStringify(data)
    }
  }

  if (typeof text === 'string') {
    const normalized = normalizeText(text)
    record.text = normalized.length > 0 ? clampText(normalized, maxChars) : null
    record.truncated = normalized.length > maxChars
    record.contentHash = normalized.length > 0 ? sha256(normalized) : null
  }
  return record
}

/**
 * Capture committed events for one session.
 *
 * Two intake paths are supported:
 * - live: `ctx.on('session/event', (session, event) => ...)` — the event was
 *   already durably appended by the host;
 * - replay/backlog: `session.snapshotEvents(fromSeq)` or `sessionQuery` after a
 *   restart, so a crash between the host append and our listener cannot lose
 *   evidence (insert-or-ignore makes this idempotent).
 */
export class CaptureService {
  /**
   * @param {import('./memory/store.js').MemoryStore} store
   * @param {{ config?: SectionMemoryConfig, logger?: { warn: Function, debug: Function } }} [options]
   */
  constructor(store, options = {}) {
    this.store = store
    this.config = options.config ?? {}
    this.logger = options.logger ?? null
    this.archiveTypes = new Set(this.config.archive?.archiveTypes ?? [])
    this.archiveMaxChars = this.config.archive?.maxCharsPerEvent ?? 4000
  }

  /**
   * @param {object} event
   * @returns {boolean} true when the event is a generated-context message
   */
  static isGeneratedContextMessage(event) {
    if (!event || event.type !== 'user/message') return false
    const kind = event.data?.source?.kind
    return typeof kind === 'string' && GENERATED_SOURCE_KINDS.has(kind)
  }

  /**
   * Convert and store one live event.
   *
   * @param {string} sessionId
   * @param {object} event
   * @returns {{ inserted: boolean, record: object | null }}
   */
  captureEvent(sessionId, event) {
    // Host-generated context (our own memory block, runtime-context snapshots,
    // skill bundles, ...) IS stored: the event log must stay audit-complete and
    // replayable, and the host writes these messages just like any other
    // committed event. The trust boundary is enforced at the consumers instead
    // of by dropping rows: extraction only derives memory from real user input,
    // retrieval filters GENERATED_SOURCE_KINDS out of evidence, and the task-text
    // fallback ignores generated messages. See GENERATED_SOURCE_KINDS above.
    const record = eventToRecord(sessionId, event)
    if (record === null) return { inserted: false, record: null }
    const checkpoint = this.store.getCheckpoint(sessionId)
    if (record.seq <= checkpoint.lastEventSeq) {
      // Already captured through a previous listener/replay: still make sure
      // the archive copy exists, then report no new evidence.
      this.maybeArchive(sessionId, record)
      return { inserted: false, record }
    }
    const inserted = this.store.recordEvent(record)
    this.maybeArchive(sessionId, record)
    return { inserted, record }
  }

  /**
   * Store a batch of events (already ordered by seq). Used for backlog/replay.
   *
   * @param {string} sessionId
   * @param {object[]} events
   * @returns {{ inserted: number, skipped: number, records: object[] }}
   */
  captureEvents(sessionId, events) {
    /** @type {object[]} */
    const records = []
    let skipped = 0
    for (const event of events) {
      const record = eventToRecord(sessionId, event)
      if (record === null) {
        skipped += 1
        continue
      }
      records.push(record)
    }
    records.sort((a, b) => a.seq - b.seq)
    const result = records.length === 0 ? { inserted: 0, skipped } : { inserted: this.store.recordEvents(records).inserted, skipped }
    for (const record of records) this.maybeArchive(sessionId, record)
    return { inserted: result.inserted, skipped: result.skipped + (result.inserted === 0 ? 0 : 0), records }
  }

  /**
   * Archive raw text the host log may not reliably replay (pruned tool results,
   * compaction summaries). This is deliberately selective: tool output is only
   * archived when it is large enough to be at risk, never wholesale.
   *
   * @param {string} sessionId
   * @param {object} record
   * @returns {boolean} true when archived
   */
  maybeArchive(sessionId, record) {
    if (this.config.archive?.enabled !== true) return false
    if (typeof record.text !== 'string' || record.text.length === 0) return false
    const isCompaction = record.type.startsWith('compaction/')
    const isArchivedType = this.archiveTypes.has(record.type)
    const atRisk = isCompaction || (isArchivedType && record.text.length > 1200)
    if (!atRisk) return false
    return this.store.archiveEvent({
      sessionId,
      ref: `seq:${record.seq}`,
      eventType: record.type,
      text: clampText(record.text, this.archiveMaxChars),
    })
  }
}
