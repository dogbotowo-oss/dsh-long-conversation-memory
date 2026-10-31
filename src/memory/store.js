/**
 * The session memory store: all SQL lives here and nowhere else.
 *
 * Design rules (see docs/architecture.md):
 * - raw evidence (`events`, `archive`) is append-only and never overwritten by
 *   summaries; summaries and derived indexes (`memory_fts`, `rules`) can be
 *   rebuilt from raw rows;
 * - memory rows are never deleted by revision flows: corrections create a new
 *   row and mark the old one `superseded`, with an audit trail in
 *   `memory_events`;
 * - every write is idempotent per session event sequence number, so retries,
 *   restores and repeated ingest cannot duplicate memories.
 *
 * @module dsh-long-memory/memory/store
 */

import {
  EVIDENCE_TYPES,
  MEMORY_EVENT_TYPES,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  RULE_CATEGORIES,
} from '../core/constants.js'
import {
  clamp,
  clampText,
  nowIso,
  parseJson,
  sha256,
  stableId,
  stableStringify,
  uniqueBy,
} from '../core/util.js'

/** @typedef {import('../core/db.js').MemoryDatabase} MemoryDatabase */

const ACTIVE = 'active'
const SUPERSEDED = 'superseded'

/**
 * @param {unknown} value
 * @returns {string} JSON text for an array column
 */
function jsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : [])
}

/**
 * @param {string | null | undefined} json
 * @returns {string[]}
 */
function parseArray(json) {
  const parsed = parseJson(json, [])
  return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : []
}

/**
 * @param {string | null | undefined} json
 * @returns {{ raw: string, value: number, unit: string, index: number }[]}
 */
function parseNumbers(json) {
  const parsed = parseJson(json, [])
  return Array.isArray(parsed) ? parsed : []
}

/**
 * Compute the canonical content hash for a memory item. The hash covers the
 * semantic identity (kind, content, conditions, scope) but not provenance, so
 * the same claim re-stated at a later step keeps one stable row.
 *
 * @param {Partial<MemoryItem>} item
 * @returns {string}
 */
export function memoryContentHash(item) {
  return sha256(
    stableStringify({
      kind: item.kind,
      content: String(item.content ?? '').trim(),
      conditions: Array.isArray(item.conditions) ? item.conditions : [],
      scope: Array.isArray(item.scope) ? item.scope : [],
    }),
  )
}

/**
 * @typedef {object} MemoryItem
 * @property {string} id
 * @property {string} sessionId
 * @property {'fact'|'decision'|'constraint'|'preference'|'proposal'|'open_question'} kind
 * @property {string} content
 * @property {string[]} conditions
 * @property {string[]} scope
 * @property {string[]} sourceRefs
 * @property {'user_explicit'|'skill'|'artifact_verified'|'assistant_proposal'|'inferred'} evidenceType
 * @property {'active'|'superseded'|'disputed'|'retracted'} status
 * @property {string[]} supersedes
 * @property {string | null} supersededBy
 * @property {string} contentHash
 * @property {{ raw: string, value: number, unit: string, index: number }[]} numbers
 * @property {string} extractor
 * @property {number | null} derivedFromSeq
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Normalize an incoming memory item, filling defaults and validating enums.
 *
 * @param {string} sessionId
 * @param {Partial<MemoryItem>} input
 * @returns {MemoryItem}
 */
export function normalizeMemoryItem(sessionId, input) {
  const content = String(input.content ?? '').trim()
  if (content.length === 0) throw new Error('memory item content must not be empty')
  const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : 'fact'
  const evidenceType = EVIDENCE_TYPES.includes(input.evidenceType) ? input.evidenceType : 'inferred'
  const status = MEMORY_STATUSES.includes(input.status) ? input.status : ACTIVE
  const conditions = (Array.isArray(input.conditions) ? input.conditions : []).map((entry) => String(entry)).filter(Boolean)
  const scope = (Array.isArray(input.scope) ? input.scope : []).map((entry) => String(entry)).filter(Boolean)
  const sourceRefs = (Array.isArray(input.sourceRefs) ? input.sourceRefs : []).map((entry) => String(entry)).filter(Boolean)
  const numbers = Array.isArray(input.numbers) ? input.numbers : []
  const contentHash = input.contentHash || memoryContentHash({ kind, content, conditions, scope })
  const now = nowIso()
  return {
    id: input.id || stableId('mem', sessionId, contentHash),
    sessionId,
    kind,
    content,
    conditions,
    scope,
    sourceRefs,
    evidenceType,
    status,
    supersedes: Array.isArray(input.supersedes) ? input.supersedes.map(String).filter(Boolean) : [],
    supersededBy: input.supersededBy ?? null,
    contentHash,
    numbers,
    extractor: typeof input.extractor === 'string' && input.extractor.length > 0 ? input.extractor : 'rule',
    derivedFromSeq: Number.isInteger(input.derivedFromSeq) ? input.derivedFromSeq : null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {MemoryItem}
 */
function rowToMemoryItem(row) {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    kind: /** @type {MemoryItem['kind']} */ (row.kind),
    content: String(row.content),
    conditions: parseArray(/** @type {string} */ (row.conditions_json)),
    scope: parseArray(/** @type {string} */ (row.scope_json)),
    sourceRefs: parseArray(/** @type {string} */ (row.source_refs_json)),
    evidenceType: /** @type {MemoryItem['evidenceType']} */ (row.evidence_type),
    status: /** @type {MemoryItem['status']} */ (row.status),
    supersedes: parseArray(/** @type {string} */ (row.supersedes_json)),
    supersededBy: row.superseded_by === null || row.superseded_by === undefined ? null : String(row.superseded_by),
    contentHash: String(row.content_hash),
    numbers: parseNumbers(/** @type {string} */ (row.numbers_json)),
    extractor: String(row.extractor),
    derivedFromSeq: row.derived_from_seq === null || row.derived_from_seq === undefined ? null : Number(row.derived_from_seq),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {{ sessionId: string, cwd: string | null, project: string | null, origin: string | null, dshVersion: string | null, memoryEnabled: boolean, createdAt: string, lastSeenAt: string }} session in the same camelCase shape the rest of the store exposes
 */
function rowToSession(row) {
  return {
    sessionId: String(row.session_id),
    cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
    project: row.project === null || row.project === undefined ? null : String(row.project),
    origin: row.origin === null || row.origin === undefined ? null : String(row.origin),
    dshVersion: row.dsh_version === null || row.dsh_version === undefined ? null : String(row.dsh_version),
    memoryEnabled: row.memory_enabled === 1,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  }
}

/**
 * Build a trigram-compatible FTS5 MATCH expression from free text. The
 * `trigram` tokenizer needs tokens of at least 3 characters, so 2-char CJK
 * bigrams are dropped here and handled by the LIKE fallback instead.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string} MATCH string or `''` when nothing usable was found
 */
export function ftsMatchExpression(text, limit = 12) {
  const source = String(text ?? '')
  const terms = []
  for (const word of source.match(/[A-Za-z0-9_@./\\-]{3,}/g) ?? []) terms.push(word.toLowerCase())
  for (const run of source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]{3,}/gu) ?? []) {
    terms.push(run)
  }
  const unique = uniqueBy(terms, (term) => term).slice(0, limit)
  if (unique.length === 0) return ''
  return unique.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * Case-insensitive LIKE needles for a mixed Chinese/Latin query.
 *
 * SQLite's trigram FTS tokenizer needs a three-character substring, so a long
 * CJK run without spaces ("把准确率结果写进第") would only match itself. This
 * helper also emits overlapping two-character CJK n-grams, which is enough to
 * find `准确率` inside a longer sentence without a full segmenter.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function cjkLikeNeedles(text, limit = 16) {
  const source = String(text ?? '')
  const needles = []
  for (const word of source.match(/[A-Za-z0-9_@./\\-]{3,}/g) ?? []) needles.push(word)
  for (const run of source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]{2,}/gu) ?? []) {
    if (run.length <= 4) {
      needles.push(run)
      continue
    }
    for (let index = 0; index + 2 <= run.length; index += 1) needles.push(run.slice(index, index + 2))
  }
  return uniqueBy(needles, (needle) => needle).slice(0, limit)
}

export class MemoryStore {
  /**
   * @param {MemoryDatabase} db
   * @param {{ config?: object, now?: () => string }} [options]
   */
  constructor(db, options = {}) {
    this.db = db
    this.config = options.config ?? {}
    /** @type {() => string} */
    this.now = options.now ?? (() => nowIso())
  }

  /** @returns {void} */
  close() {
    this.db.close()
  }

  /**
   * Run a callback inside one durable transaction.
   *
   * Delegates to {@link MemoryDatabase.transaction} (`BEGIN IMMEDIATE` with
   * savepoint nesting). Higher-level services (extraction, replacement
   * batches) compose several store writes and must not interleave with another
   * writer; they call this instead of reaching into `store.db`.
   *
   * @template T
   * @param {() => T} callback
   * @returns {T}
   */
  transaction(callback) {
    return this.db.transaction(callback)
  }

  // ------------------------------------------------------------------ sessions

  /**
   * Ensure the session row exists and refresh last_seen_at. Returns the row.
   *
   * @param {{ sessionId: string, cwd?: string | null, project?: string | null, origin?: string | null, dshVersion?: string | null }} input
   * @returns {Record<string, unknown>}
   */
  ensureSession(input) {
    const now = this.now()
    this.db.run(
      `INSERT INTO sessions (session_id, cwd, project, origin, dsh_version, memory_enabled, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
         cwd = COALESCE(excluded.cwd, sessions.cwd),
         origin = COALESCE(excluded.origin, sessions.origin),
         dsh_version = COALESCE(excluded.dsh_version, sessions.dsh_version)`,
      [input.sessionId, input.cwd ?? null, input.project ?? null, input.origin ?? null, input.dshVersion ?? null, now, now],
    )
    return this.getSession(input.sessionId) ?? {}
  }

  /**
   * @param {string} sessionId
   * @returns {Record<string, unknown> | undefined}
   */
  getSession(sessionId) {
    const row = this.db.get('SELECT * FROM sessions WHERE session_id = ?', [sessionId])
    return row === undefined ? undefined : rowToSession(row)
  }

  /**
   * @param {{ limit?: number }} [options]
   * @returns {Record<string, unknown>[]}
   */
  listSessions(options = {}) {
    const limit = clamp(options.limit ?? 50, 1, 1000)
    return this.db
      .all('SELECT * FROM sessions ORDER BY last_seen_at DESC LIMIT ?', [limit])
      .map(rowToSession)
  }

  /**
   * @param {string} sessionId
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setMemoryEnabled(sessionId, enabled) {
    const result = this.db.run('UPDATE sessions SET memory_enabled = ? WHERE session_id = ?', [enabled, sessionId])
    return result.changes > 0
  }

  /**
   * @param {string} sessionId
   * @returns {boolean}
   */
  isMemoryEnabled(sessionId) {
    const row = this.db.get('SELECT memory_enabled FROM sessions WHERE session_id = ?', [sessionId])
    return row === undefined ? true : row.memory_enabled === 1
  }

  // -------------------------------------------------------------------- events

  /**
   * Insert one captured host event. Idempotent on `(session_id, seq)`.
   *
   * @param {object} record
   * @param {string} record.sessionId
   * @param {number} record.seq
   * @param {string} record.type
   * @param {string} record.time
   * @param {number | null} [record.turn]
   * @param {number | null} [record.step]
   * @param {string | null} [record.role]
   * @param {string | null} [record.text]
   * @param {string | null} [record.sourceKind]
   * @param {string | null} [record.sourceForm]
   * @param {string | null} [record.toolName]
   * @param {string | null} [record.callId]
   * @param {string} [record.store]
   * @param {string | null} [record.contentHash]
   * @param {boolean} [record.truncated]
   * @returns {boolean} true when a new row was inserted
   */
  recordEvent(record) {
    return this.recordEvents([record]).inserted > 0
  }

  /**
   * @param {object[]} records
   * @returns {{ inserted: number, skipped: number, lastSeq: number }}
   */
  recordEvents(records) {
    const now = this.now()
    let inserted = 0
    let skipped = 0
    let lastSeq = -1
    this.db.transaction(() => {
      for (const record of records) {
        const result = this.db.run(
          `INSERT OR IGNORE INTO events
            (session_id, seq, type, time, turn, step, role, text, source_kind, source_form, tool_name, call_id, store, content_hash, truncated, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.sessionId,
            record.seq,
            record.type,
            record.time ?? now,
            record.turn ?? null,
            record.step ?? null,
            record.role ?? null,
            record.text ?? null,
            record.sourceKind ?? null,
            record.sourceForm ?? null,
            record.toolName ?? null,
            record.callId ?? null,
            record.store ?? 'host',
            record.contentHash ?? null,
            record.truncated === true ? 1 : 0,
            now,
          ],
        )
        if (result.changes > 0) {
          inserted += 1
          lastSeq = Math.max(lastSeq, record.seq)
          if (typeof record.text === 'string' && record.text.trim().length > 0) {
            this.db.run('INSERT INTO events_fts (text, session_id, seq) VALUES (?, ?, ?)', [record.text, record.sessionId, record.seq])
          }
        } else {
          skipped += 1
        }
      }
      if (lastSeq >= 0) {
        this.db.run(
          `INSERT INTO checkpoints (session_id, last_event_seq, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET last_event_seq = MAX(checkpoints.last_event_seq, excluded.last_event_seq), updated_at = excluded.updated_at`,
          [records[0].sessionId, lastSeq, now],
        )
      }
    })
    return { inserted, skipped, lastSeq }
  }

  /**
   * @param {string} sessionId
   * @param {{ fromSeq?: number, toSeq?: number, types?: string[], limit?: number }} [options]
   * @returns {Record<string, unknown>[]}
   */
  listEvents(sessionId, options = {}) {
    const limit = clamp(options.limit ?? 2000, 1, 100000)
    const fromSeq = Number.isInteger(options.fromSeq) ? options.fromSeq : 0
    const params = [sessionId, fromSeq]
    let sql = 'SELECT * FROM events WHERE session_id = ? AND seq >= ?'
    if (Number.isInteger(options.toSeq)) {
      sql += ' AND seq < ?'
      params.push(options.toSeq)
    }
    if (Array.isArray(options.types) && options.types.length > 0) {
      sql += ` AND type IN (${options.types.map(() => '?').join(',')})`
      params.push(...options.types)
    }
    sql += ' ORDER BY seq ASC LIMIT ?'
    params.push(limit)
    return this.db.all(sql, params)
  }

  /**
   * @param {string} sessionId
   * @param {number} seq
   * @returns {Record<string, unknown> | undefined}
   */
  getEvent(sessionId, seq) {
    return this.db.get('SELECT * FROM events WHERE session_id = ? AND seq = ?', [sessionId, seq])
  }

  /**
   * @param {string} sessionId
   * @param {number} afterSeq events with seq > afterSeq
   * @param {{ limit?: number, types?: string[] }} [options]
   * @returns {Record<string, unknown>[]}
   */
  listEventsAfter(sessionId, afterSeq, options = {}) {
    const limit = clamp(options.limit ?? 2000, 1, 100000)
    const params = [sessionId, afterSeq]
    let sql = 'SELECT * FROM events WHERE session_id = ? AND seq > ?'
    if (Array.isArray(options.types) && options.types.length > 0) {
      sql += ` AND type IN (${options.types.map(() => '?').join(',')})`
      params.push(...options.types)
    }
    sql += ' ORDER BY seq ASC LIMIT ?'
    params.push(limit)
    return this.db.all(sql, params)
  }

  /**
   * Keyword search over captured evidence. Uses the FTS5 index when the query
   * yields trigram-compatible tokens and a LIKE scan as a fallback.
   *
   * @param {{ sessionId: string, query: string, limit?: number, fromSeq?: number, types?: string[] }} input
   * @returns {{ seq: number, eventType: string, role: string | null, text: string, turn: number | null, step: number | null, score: number, matched: 'fts'|'like' }[]}
   */
  searchEvents(input) {
    const limit = clamp(input.limit ?? 20, 1, 200)
    const match = ftsMatchExpression(input.query)
    /** @type {{ seq: number, eventType: string, role: string | null, text: string, turn: number | null, step: number | null, sourceKind: string | null, score: number, matched: 'fts'|'like' }[]} */
    const hits = []
    if (match.length > 0) {
      const params = [match, input.sessionId]
      let sql = `SELECT e.seq, e.type, e.role, e.text, e.turn, e.step, e.source_kind, bm25(events_fts) AS score
                 FROM events_fts JOIN events e ON e.session_id = events_fts.session_id AND e.seq = events_fts.seq
                 WHERE events_fts MATCH ? AND e.session_id = ?`
      if (Number.isInteger(input.fromSeq)) {
        sql += ' AND e.seq >= ?'
        params.push(input.fromSeq)
      }
      sql += ' ORDER BY score LIMIT ?'
      params.push(limit)
      for (const row of this.db.all(sql, params)) {
        hits.push({
          seq: Number(row.seq),
          eventType: String(row.type),
          role: row.role === null || row.role === undefined ? null : String(row.role),
          text: String(row.text ?? ''),
          turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
          step: row.step === null || row.step === undefined ? null : Number(row.step),
          sourceKind: row.source_kind === null || row.source_kind === undefined ? null : String(row.source_kind),
          score: Number(row.score ?? 0),
          matched: 'fts',
        })
      }
    }
    if (hits.length < limit) {
      for (const needle of cjkLikeNeedles(input.query, 12)) {
        if (hits.length >= limit) break
        const likeParams = [input.sessionId, `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`]
        let sql = `SELECT seq, type, role, text, turn, step, source_kind FROM events
                 WHERE session_id = ? AND text LIKE ? ESCAPE '\\'`
        if (Number.isInteger(input.fromSeq)) {
          sql += ' AND seq >= ?'
          likeParams.push(input.fromSeq)
        }
        sql += ' ORDER BY seq DESC LIMIT ?'
        likeParams.push(limit)
        for (const row of this.db.all(sql, likeParams)) {
          if (hits.some((hit) => hit.seq === Number(row.seq))) continue
          hits.push({
            seq: Number(row.seq),
            eventType: String(row.type),
            role: row.role === null || row.role === undefined ? null : String(row.role),
            text: String(row.text ?? ''),
            turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
            step: row.step === null || row.step === undefined ? null : Number(row.step),
            sourceKind: row.source_kind === null || row.source_kind === undefined ? null : String(row.source_kind),
            score: 0,
            matched: 'like',
          })
        }
      }
    }
    return hits.slice(0, limit)
  }

  // -------------------------------------------------------------- memory items

  /**
   * Insert a memory item. Idempotent for an identical active claim in one
   * session; when `supersedes` is given the referenced rows are marked
   * `superseded` and linked to the new row (never deleted).
   *
   * @param {string} sessionId
   * @param {Partial<MemoryItem>} input
   * @returns {{ item: MemoryItem, created: boolean }}
   */
  insertMemoryItem(sessionId, input) {
    const item = normalizeMemoryItem(sessionId, input)
    let created = false
    let resultItem = item
    this.db.transaction(() => {
      const existing = this.db.get(
        `SELECT * FROM memory_items WHERE session_id = ? AND content_hash = ? AND status = 'active'`,
        [sessionId, item.contentHash],
      )
      if (existing !== undefined) {
        resultItem = rowToMemoryItem(existing)
        return
      }
      for (const oldId of item.supersedes) {
        const old = this.db.get('SELECT id, status FROM memory_items WHERE id = ? AND session_id = ?', [oldId, sessionId])
        if (old === undefined || old.status === SUPERSEDED) continue
        this.db.run(
          `UPDATE memory_items SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`,
          [item.id, item.updatedAt, oldId],
        )
        this.db.run(
          `INSERT INTO memory_events (memory_id, session_id, event, at, actor, detail_json) VALUES (?, ?, 'superseded', ?, ?, ?)`,
          [oldId, sessionId, item.updatedAt, item.extractor, JSON.stringify({ by: item.id, reason: 'superseded by newer item' })],
        )
      }
      this.db.run(
        `INSERT OR IGNORE INTO memory_items
          (id, session_id, kind, content, conditions_json, scope_json, source_refs_json, evidence_type, status,
           supersedes_json, superseded_by, content_hash, numbers_json, extractor, derived_from_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          sessionId,
          item.kind,
          item.content,
          jsonArray(item.conditions),
          jsonArray(item.scope),
          jsonArray(item.sourceRefs),
          item.evidenceType,
          item.status,
          jsonArray(item.supersedes),
          item.supersededBy,
          item.contentHash,
          jsonArray(item.numbers),
          item.extractor,
          item.derivedFromSeq,
          item.createdAt,
          item.updatedAt,
        ],
      )
      const inserted = this.db.get('SELECT id FROM memory_items WHERE id = ?', [item.id])
      if (inserted === undefined) return
      this.db.run('INSERT INTO memory_fts (text, memory_id, session_id) VALUES (?, ?, ?)', [
        `${item.content}\n${item.conditions.join('\n')}\n${item.scope.join(' ')}`,
        item.id,
        sessionId,
      ])
      this.db.run(
        `INSERT INTO memory_events (memory_id, session_id, event, at, actor, detail_json) VALUES (?, ?, 'created', ?, ?, ?)`,
        [item.id, sessionId, item.createdAt, item.extractor, JSON.stringify({ evidenceType: item.evidenceType, sourceRefs: item.sourceRefs })],
      )
      created = true
    })
    return { item: resultItem, created }
  }

  /**
   * @param {string} id
   * @returns {MemoryItem | undefined}
   */
  getMemoryItem(id) {
    const row = this.db.get('SELECT * FROM memory_items WHERE id = ?', [id])
    return row === undefined ? undefined : rowToMemoryItem(row)
  }

  /**
   * @param {string} sessionId
   * @param {{ status?: string, statuses?: string[], kinds?: string[], extractors?: string[], limit?: number, offset?: number, order?: 'desc'|'asc' }} [options]
   * @returns {MemoryItem[]}
   */
  listMemoryItems(sessionId, options = {}) {
    const limit = clamp(options.limit ?? 100, 1, 10000)
    const offset = clamp(options.offset ?? 0, 0, 1000000)
    const params = [sessionId]
    let sql = 'SELECT * FROM memory_items WHERE session_id = ?'
    if (options.status) {
      sql += ' AND status = ?'
      params.push(options.status)
    }
    if (Array.isArray(options.statuses) && options.statuses.length > 0) {
      sql += ` AND status IN (${options.statuses.map(() => '?').join(',')})`
      params.push(...options.statuses)
    }
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      sql += ` AND kind IN (${options.kinds.map(() => '?').join(',')})`
      params.push(...options.kinds)
    }
    if (Array.isArray(options.extractors) && options.extractors.length > 0) {
      sql += ` AND extractor IN (${options.extractors.map(() => '?').join(',')})`
      params.push(...options.extractors)
    }
    sql += ` ORDER BY updated_at ${options.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`
    params.push(limit, offset)
    return this.db.all(sql, params).map(rowToMemoryItem)
  }

  /**
   * Update a memory item in place (revision). The row keeps its id; the
   * previous state is recoverable from `memory_events` + the event evidence.
   *
   * @param {string} id
   * @param {Partial<MemoryItem>} patch
   * @param {{ actor?: string, event?: string, detail?: object }} [options]
   * @returns {MemoryItem | undefined}
   */
  updateMemoryItem(id, patch, options = {}) {
    const existing = this.getMemoryItem(id)
    if (existing === undefined) return undefined
    const next = normalizeMemoryItem(existing.sessionId, {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    })
    this.db.transaction(() => {
      this.db.run(
        `UPDATE memory_items SET kind = ?, content = ?, conditions_json = ?, scope_json = ?, source_refs_json = ?,
           evidence_type = ?, status = ?, supersedes_json = ?, superseded_by = ?, content_hash = ?, numbers_json = ?,
           extractor = ?, derived_from_seq = ?, updated_at = ? WHERE id = ?`,
        [
          next.kind,
          next.content,
          jsonArray(next.conditions),
          jsonArray(next.scope),
          jsonArray(next.sourceRefs),
          next.evidenceType,
          next.status,
          jsonArray(next.supersedes),
          next.supersededBy,
          next.contentHash,
          jsonArray(next.numbers),
          next.extractor,
          next.derivedFromSeq,
          next.updatedAt,
          id,
        ],
      )
      this.db.run('DELETE FROM memory_fts WHERE memory_id = ?', [id])
      this.db.run('INSERT INTO memory_fts (text, memory_id, session_id) VALUES (?, ?, ?)', [
        `${next.content}\n${next.conditions.join('\n')}\n${next.scope.join(' ')}`,
        id,
        next.sessionId,
      ])
      const eventType = MEMORY_EVENT_TYPES.includes(options.event) ? options.event : 'revised'
      this.db.run(
        `INSERT INTO memory_events (memory_id, session_id, event, at, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, next.sessionId, eventType, next.updatedAt, options.actor ?? 'user', JSON.stringify(options.detail ?? {})],
      )
    })
    return this.getMemoryItem(id)
  }

  /**
   * Create a replacement item and mark the old one superseded in one
   * transaction.
   *
   * @param {string} sessionId
   * @param {string} oldId
   * @param {Partial<MemoryItem>} input
   * @returns {{ item: MemoryItem, created: boolean }}
   */
  supersedeItem(sessionId, oldId, input) {
    const old = this.getMemoryItem(oldId)
    if (old === undefined || old.sessionId !== sessionId) {
      return this.insertMemoryItem(sessionId, input)
    }
    const replacement = this.insertMemoryItem(sessionId, {
      ...input,
      supersedes: [...new Set([...(input.supersedes ?? []), oldId])],
    })
    return replacement
  }

  /**
   * Soft-delete a memory item: status becomes `retracted` and it disappears
   * from active retrieval. Raw rows and audit trail stay.
   *
   * @param {string} id
   * @param {{ actor?: string, reason?: string }} [options]
   * @returns {MemoryItem | undefined}
   */
  retractItem(id, options = {}) {
    return this.updateMemoryItem(id, { status: 'retracted' }, {
      actor: options.actor ?? 'user',
      event: 'retracted',
      detail: { reason: options.reason ?? '' },
    })
  }

  /**
   * Lifecycle audit rows for one memory item, oldest first.
   *
   * @param {string} id
   * @returns {{ id: number, memoryId: string, sessionId: string, event: string, at: string, actor: string | null, detail: Record<string, unknown>, detail_json: string }[]}
   */
  listMemoryEvents(id) {
    return this.db
      .all('SELECT * FROM memory_events WHERE memory_id = ? ORDER BY id ASC', [id])
      .map((row) => ({
        id: Number(row.id),
        memoryId: String(row.memory_id),
        sessionId: String(row.session_id),
        event: String(row.event),
        at: String(row.at),
        actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
        detail: parseJson(/** @type {string} */ (row.detail_json), {}),
        detail_json: String(row.detail_json ?? '{}'),
      }))
  }

  /**
   * FTS/LIKE keyword search over active memory rows. Ranking is completed by
   * the retrieval module; this returns raw candidates with their FTS score.
   *
   * @param {{ sessionId: string, query: string, limit?: number, statuses?: string[] }} input
   * @returns {{ item: MemoryItem, ftsScore: number, matched: 'fts'|'like' }[]}
   */
  searchMemory(input) {
    const limit = clamp(input.limit ?? 40, 1, 500)
    const statuses = Array.isArray(input.statuses) && input.statuses.length > 0 ? input.statuses : [ACTIVE]
    const statusSql = `(${statuses.map(() => '?').join(',')})`
    const match = ftsMatchExpression(input.query)
    /** @type {{ item: MemoryItem, ftsScore: number, matched: 'fts'|'like' }[]} */
    const out = []
    const seen = new Set()
    if (match.length > 0) {
      const rows = this.db.all(
        `SELECT m.id, bm25(memory_fts) AS score
         FROM memory_fts JOIN memory_items m ON m.id = memory_fts.memory_id
         WHERE memory_fts MATCH ? AND m.session_id = ? AND m.status IN ${statusSql}
         ORDER BY score LIMIT ?`,
        [match, input.sessionId, ...statuses, limit],
      )
      for (const row of rows) {
        const item = this.getMemoryItem(String(row.id))
        if (item === undefined || seen.has(item.id)) continue
        seen.add(item.id)
        out.push({ item, ftsScore: Number(row.score ?? 0), matched: 'fts' })
      }
    }
    if (out.length < limit) {
      const needles = cjkLikeNeedles(input.query, 12)
      for (const needle of needles) {
        const rows = this.db.all(
          `SELECT * FROM memory_items WHERE session_id = ? AND status IN ${statusSql}
             AND (content LIKE ? ESCAPE '\\' OR conditions_json LIKE ? ESCAPE '\\')
           ORDER BY updated_at DESC LIMIT ?`,
          [input.sessionId, ...statuses, `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`, `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`, limit],
        )
        for (const row of rows) {
          const item = rowToMemoryItem(row)
          if (seen.has(item.id)) continue
          seen.add(item.id)
          out.push({ item, ftsScore: 0, matched: 'like' })
        }
        if (out.length >= limit) break
      }
    }
    return out.slice(0, limit)
  }

  // ---------------------------------------------------------------- task state

  /**
   * @param {string} sessionId
   * @returns {{ goal: string | null, progress: string[], blockers: string[], openItems: string[], superseded: string[], updatedAt: string | null, updatedBySeq: number | null }}
   */
  getTaskState(sessionId) {
    const row = this.db.get('SELECT * FROM task_state WHERE session_id = ?', [sessionId])
    if (row === undefined) {
      return { goal: null, progress: [], blockers: [], openItems: [], superseded: [], updatedAt: null, updatedBySeq: null }
    }
    return {
      goal: row.goal === null || row.goal === undefined ? null : String(row.goal),
      progress: parseArray(/** @type {string} */ (row.progress_json)),
      blockers: parseArray(/** @type {string} */ (row.blockers_json)),
      openItems: parseArray(/** @type {string} */ (row.open_items_json)),
      superseded: parseArray(/** @type {string} */ (row.superseded_json)),
      updatedAt: String(row.updated_at),
      updatedBySeq: row.updated_by_seq === null || row.updated_by_seq === undefined ? null : Number(row.updated_by_seq),
    }
  }

  /**
   * Replace the task state for a session (the caller merges old + new).
   *
   * @param {string} sessionId
   * @param {{ goal?: string | null, progress?: string[], blockers?: string[], openItems?: string[], superseded?: string[] }} state
   * @param {{ updatedBySeq?: number | null }} [meta]
   * @returns {ReturnType<MemoryStore['getTaskState']>}
   */
  setTaskState(sessionId, state, meta = {}) {
    const now = this.now()
    this.db.run(
      `INSERT INTO task_state (session_id, goal, progress_json, blockers_json, open_items_json, superseded_json, updated_at, updated_by_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET goal = excluded.goal, progress_json = excluded.progress_json,
         blockers_json = excluded.blockers_json, open_items_json = excluded.open_items_json,
         superseded_json = excluded.superseded_json, updated_at = excluded.updated_at, updated_by_seq = excluded.updated_by_seq`,
      [
        sessionId,
        state.goal ?? null,
        jsonArray((state.progress ?? []).map(String)),
        jsonArray((state.blockers ?? []).map(String)),
        jsonArray((state.openItems ?? []).map(String)),
        jsonArray((state.superseded ?? []).map(String)),
        now,
        meta.updatedBySeq ?? null,
      ],
    )
    return this.getTaskState(sessionId)
  }

  // --------------------------------------------------------------- checkpoints

  /**
   * @param {string} sessionId
   * @returns {{ lastEventSeq: number, lastExtractSeq: number, lastAssemblySeq: number }}
   */
  getCheckpoint(sessionId) {
    const row = this.db.get('SELECT * FROM checkpoints WHERE session_id = ?', [sessionId])
    if (row === undefined) return { lastEventSeq: -1, lastExtractSeq: -1, lastAssemblySeq: -1 }
    return {
      lastEventSeq: Number(row.last_event_seq),
      lastExtractSeq: Number(row.last_extract_seq),
      lastAssemblySeq: Number(row.last_assembly_seq),
    }
  }

  /**
   * @param {string} sessionId
   * @param {{ lastEventSeq?: number, lastExtractSeq?: number, lastAssemblySeq?: number }} patch
   * @returns {ReturnType<MemoryStore['getCheckpoint']>}
   */
  setCheckpoint(sessionId, patch) {
    const current = this.getCheckpoint(sessionId)
    const next = {
      lastEventSeq: patch.lastEventSeq ?? current.lastEventSeq,
      lastExtractSeq: patch.lastExtractSeq ?? current.lastExtractSeq,
      lastAssemblySeq: patch.lastAssemblySeq ?? current.lastAssemblySeq,
    }
    this.db.run(
      `INSERT INTO checkpoints (session_id, last_event_seq, last_extract_seq, last_assembly_seq, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_event_seq = excluded.last_event_seq,
         last_extract_seq = excluded.last_extract_seq, last_assembly_seq = excluded.last_assembly_seq,
         updated_at = excluded.updated_at`,
      [sessionId, next.lastEventSeq, next.lastExtractSeq, next.lastAssemblySeq, this.now()],
    )
    return next
  }

  // ----------------------------------------------------------------- skills

  /**
   * Record the observed version of a skill file. Content is stored verbatim;
   * a changed content hash creates a new version linked to the previous one.
   *
   * @param {{ name: string, source?: string | null, path?: string | null, content: string, description?: string | null, whenToUse?: string | null, invocation?: string | null }} input
   * @returns {{ versionId: string, version: number, changed: boolean, contentHash: string, skill: Record<string, unknown> | undefined }}
   */
  upsertSkill(input) {
    const contentHash = sha256(input.content)
    const now = this.now()
    let result = { versionId: '', version: 0, changed: false, contentHash, skill: undefined }
    this.db.transaction(() => {
      const existing = this.db.get('SELECT * FROM skill_versions WHERE name = ? AND content_hash = ?', [input.name, contentHash])
      if (existing !== undefined) {
        this.db.run('UPDATE skill_versions SET last_seen_at = ? WHERE id = ?', [now, existing.id])
        result = {
          versionId: String(existing.id),
          version: Number(existing.version),
          changed: false,
          contentHash,
          skill: this.getSkillFile(input.name),
        }
        return
      }
      const latest = this.db.get('SELECT * FROM skill_versions WHERE name = ? ORDER BY version DESC LIMIT 1', [input.name])
      const version = latest === undefined ? 1 : Number(latest.version) + 1
      const versionId = `skv_${sha256(`${input.name}|${contentHash}`).slice(0, 20)}`
      this.db.run(
        `INSERT INTO skill_versions (id, name, source, path, content, content_hash, version, supersedes, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [versionId, input.name, input.source ?? null, input.path ?? null, input.content, contentHash, version, latest === undefined ? null : String(latest.id), now, now],
      )
      const previousFile = this.getSkillFile(input.name)
      this.db.run(
        `INSERT INTO skill_files (name, latest_version_id, content_hash, enabled, description, when_to_use, invocation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET latest_version_id = excluded.latest_version_id, content_hash = excluded.content_hash,
           description = excluded.description, when_to_use = excluded.when_to_use, invocation = excluded.invocation, updated_at = excluded.updated_at`,
        [
          input.name,
          versionId,
          contentHash,
          previousFile === undefined ? 1 : previousFile.enabled === 1 ? 1 : 0,
          input.description ?? null,
          input.whenToUse ?? null,
          input.invocation ?? null,
          now,
        ],
      )
      result = { versionId, version, changed: true, contentHash, skill: this.getSkillFile(input.name) }
    })
    return result
  }

  /**
   * @returns {Record<string, unknown>[]}
   */
  listSkillFiles() {
    return this.db.all('SELECT * FROM skill_files ORDER BY name ASC')
  }

  /**
   * @param {string} name
   * @returns {Record<string, unknown> | undefined}
   */
  getSkillFile(name) {
    return this.db.get('SELECT * FROM skill_files WHERE name = ?', [name])
  }

  /**
   * @param {string} name
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setSkillEnabled(name, enabled) {
    return this.db.run('UPDATE skill_files SET enabled = ?, updated_at = ? WHERE name = ?', [enabled ? 1 : 0, this.now(), name]).changes > 0
  }

  /**
   * @param {string} name
   * @returns {Record<string, unknown> | undefined}
   */
  getSkillContent(name) {
    const row = this.db.get(
      `SELECT v.* FROM skill_versions v JOIN skill_files f ON f.latest_version_id = v.id WHERE f.name = ?`,
      [name],
    )
    return row
  }

  /**
   * Replace the derived rule index of one skill. Rule ids are stable per skill
   * + rule key, so user overrides survive rule text edits.
   *
   * @param {string} skillName
   * @param {string} skillVersionId
   * @param {{ key: string, text: string, category: string, scope?: string[], sourcePath?: string | null, sourceLine?: number | null }[]} rules
   * @returns {number} number of rules written
   */
  replaceSkillRules(skillName, skillVersionId, rules) {
    const now = this.now()
    let written = 0
    this.db.transaction(() => {
      this.db.run('DELETE FROM rules WHERE skill_name = ?', [skillName])
      for (const rule of rules) {
        const category = RULE_CATEGORIES.includes(rule.category) ? rule.category : 'stable_rule'
        const text = clampText(rule.text, 20000)
        if (text.trim().length === 0) continue
        const id = `rule_${sha256(`${skillName}|${rule.key}`).slice(0, 20)}`
        const contentHash = sha256(`${category}|${text}`)
        this.db.run(
          `INSERT OR REPLACE INTO rules (id, skill_name, skill_version_id, rule_key, text, category, source_path, source_line, scope_json, active, content_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [id, skillName, skillVersionId, rule.key, text, category, rule.sourcePath ?? null, rule.sourceLine ?? null, jsonArray(rule.scope ?? []), contentHash, now],
        )
        written += 1
      }
    })
    return written
  }

  /**
   * Active rules for the given skill names, with user overrides applied.
   *
   * @param {{ skillNames?: string[], categories?: string[], includeInactive?: boolean }} [filter]
   * @returns {{ id: string, skillName: string, text: string, category: string, scope: string[], active: boolean, sourcePath: string | null, sourceLine: number | null }[]}
   */
  listRules(filter = {}) {
    const params = []
    let sql = `SELECT r.*, o.category AS override_category, o.active AS override_active, o.scope_json AS override_scope, o.note AS override_note
               FROM rules r LEFT JOIN rule_overrides o ON o.rule_id = r.id WHERE 1 = 1`
    if (Array.isArray(filter.skillNames) && filter.skillNames.length > 0) {
      sql += ` AND r.skill_name IN (${filter.skillNames.map(() => '?').join(',')})`
      params.push(...filter.skillNames)
    }
    sql += ' ORDER BY r.skill_name ASC, r.id ASC'
    return this.db.all(sql, params).map((row) => {
      const category = row.override_category ?? row.category
      const active = row.override_active === null || row.override_active === undefined ? row.active === 1 : row.override_active === 1
      const scope = row.override_scope === null || row.override_scope === undefined ? parseArray(row.scope_json) : parseArray(row.override_scope)
      return {
        id: String(row.id),
        skillName: String(row.skill_name),
        text: String(row.text),
        category: /** @type {string} */ (category),
        scope,
        active,
        sourcePath: row.source_path === null || row.source_path === undefined ? null : String(row.source_path),
        sourceLine: row.source_line === null || row.source_line === undefined ? null : Number(row.source_line),
      }
    }).filter((rule) => {
      if (!filter.includeInactive && !rule.active) return false
      if (Array.isArray(filter.categories) && filter.categories.length > 0 && !filter.categories.includes(rule.category)) return false
      return true
    })
  }

  /**
   * Persist a user override for a derived rule classification/scope.
   *
   * @param {string} ruleId
   * @param {{ category?: string | null, active?: boolean | null, scope?: string[] | null, note?: string | null }} override
   * @returns {boolean}
   */
  setRuleOverride(ruleId, override) {
    const patch = {
      category: override.category ?? null,
      active: override.active === undefined || override.active === null ? null : override.active ? 1 : 0,
      scope: Array.isArray(override.scope) ? JSON.stringify(override.scope) : null,
      note: override.note ?? null,
    }
    return this.db.run(
      `INSERT INTO rule_overrides (rule_id, category, active, scope_json, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id) DO UPDATE SET category = COALESCE(excluded.category, rule_overrides.category),
         active = COALESCE(excluded.active, rule_overrides.active),
         scope_json = COALESCE(excluded.scope_json, rule_overrides.scope_json),
         note = COALESCE(excluded.note, rule_overrides.note), updated_at = excluded.updated_at`,
      [ruleId, patch.category, patch.active, patch.scope, patch.note, this.now()],
    ).changes > 0
  }

  // ------------------------------------------------------------ assembly logs

  /**
   * @param {object} record
   * @param {string} record.sessionId
   * @param {number} [record.turn]
   * @param {number} [record.step]
   * @param {string} record.trigger
   * @param {number} record.budgetTokens
   * @param {number} record.usedTokens
   * @param {string} record.tokenSource
   * @param {string} [record.contentHash]
   * @param {boolean} record.injected
   * @param {number | null} [record.messageSeq]
   * @param {object[]} [record.sections]
   * @param {object[]} [record.items]
   * @param {object[]} [record.omitted]
   * @param {object[]} [record.reasons]
   * @param {object[]} [record.errors]
   * @returns {number} assembly log id
   */
  logAssembly(record) {
    const result = this.db.run(
      `INSERT INTO assembly_logs (session_id, turn, step, created_at, trigger, budget_tokens, used_tokens, token_source, content_hash,
         injected, message_seq, sections_json, items_json, omitted_json, reasons_json, errors_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.sessionId,
        record.turn ?? null,
        record.step ?? null,
        this.now(),
        record.trigger,
        record.budgetTokens,
        record.usedTokens,
        record.tokenSource,
        record.contentHash ?? null,
        record.injected ? 1 : 0,
        record.messageSeq ?? null,
        JSON.stringify(record.sections ?? []),
        JSON.stringify(record.items ?? []),
        JSON.stringify(record.omitted ?? []),
        JSON.stringify(record.reasons ?? []),
        JSON.stringify(record.errors ?? []),
      ],
    )
    return Number(result.lastInsertRowid)
  }

  /**
   * Attach the committed session sequence number to an assembly log row.
   *
   * The injected message is appended by the host *after* the pre-step waterfall
   * returns, so the log row is written first and the exact `seq` is filled in by
   * the capture listener when the append event arrives. Keeping the outbound
   * pointer makes `memory explain` able to point at the exact committed message.
   *
   * @param {number} id assembly log id
   * @param {number | null} seq committed session sequence, or null to clear
   * @returns {boolean} whether a row was updated
   */
  setAssemblyMessageSeq(id, seq) {
    if (!Number.isInteger(id)) return false
    const result = this.db.run('UPDATE assembly_logs SET message_seq = ? WHERE id = ?', [
      Number.isInteger(seq) ? seq : null,
      id,
    ])
    return Number(result.changes) > 0
  }

  /**
   * @param {number} id
   * @returns {Record<string, unknown> | undefined}
   */
  getAssembly(id) {
    const row = this.db.get('SELECT * FROM assembly_logs WHERE id = ?', [id])
    return row === undefined ? undefined : this.parseAssembly(row)
  }

  /**
   * @param {string} sessionId
   * @param {{ limit?: number }} [options]
   * @returns {Record<string, unknown>[]}
   */
  listAssemblies(sessionId, options = {}) {
    const limit = clamp(options.limit ?? 20, 1, 500)
    return this.db
      .all('SELECT * FROM assembly_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?', [sessionId, limit])
      .map((row) => this.parseAssembly(row))
  }

  /**
   * @param {string} sessionId
   * @returns {Record<string, unknown> | undefined}
   */
  latestAssembly(sessionId) {
    const row = this.db.get('SELECT * FROM assembly_logs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [sessionId])
    return row === undefined ? undefined : this.parseAssembly(row)
  }

  /**
   * @param {Record<string, unknown>} row
   * @returns {Record<string, unknown>}
   */
  parseAssembly(row) {
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
      step: row.step === null || row.step === undefined ? null : Number(row.step),
      createdAt: String(row.created_at),
      trigger: String(row.trigger),
      budgetTokens: Number(row.budget_tokens),
      usedTokens: Number(row.used_tokens),
      tokenSource: String(row.token_source),
      contentHash: row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash),
      injected: row.injected === 1,
      messageSeq: row.message_seq === null || row.message_seq === undefined ? null : Number(row.message_seq),
      sections: parseJson(/** @type {string} */ (row.sections_json), []),
      items: parseJson(/** @type {string} */ (row.items_json), []),
      omitted: parseJson(/** @type {string} */ (row.omitted_json), []),
      reasons: parseJson(/** @type {string} */ (row.reasons_json), []),
      errors: parseJson(/** @type {string} */ (row.errors_json), []),
    }
  }

  // -------------------------------------------------------------- validation

  /**
   * Persist one deterministic validation run (audit trail for `memory status`).
   *
   * @param {{ sessionId: string, turn?: number | null, step?: number | null, eventSeq?: number | null, trigger?: string, target?: string, run: { ok: boolean, checked?: number, skipped?: number, blocked?: boolean, deterministic?: boolean, violations?: object[], errors?: string[] } }} record
   * @returns {number} validation log id
   */
  addValidationLog(record) {
    const run = record.run ?? {}
    const result = this.db.run(
      `INSERT INTO validation_logs (session_id, turn, step, event_seq, trigger, target, ok, checked, skipped, blocked,
         deterministic, violations_json, errors_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.sessionId,
        record.turn ?? null,
        record.step ?? null,
        record.eventSeq ?? null,
        String(record.trigger ?? 'assistant/message'),
        String(record.target ?? 'body'),
        run.ok === true ? 1 : 0,
        Number(run.checked ?? 0),
        Number(run.skipped ?? 0),
        run.blocked === true ? 1 : 0,
        run.deterministic === false ? 0 : 1,
        JSON.stringify(run.violations ?? []),
        JSON.stringify(run.errors ?? []),
        this.now(),
      ],
    )
    return Number(result.lastInsertRowid)
  }

  /**
   * @param {string} sessionId
   * @param {{ limit?: number }} [options]
   * @returns {Record<string, unknown>[]} newest first
   */
  listValidationLogs(sessionId, options = {}) {
    const limit = clamp(options.limit ?? 20, 1, 500)
    return this.db
      .all('SELECT * FROM validation_logs WHERE session_id = ? ORDER BY id DESC LIMIT ?', [sessionId, limit])
      .map((row) => this.parseValidationLog(row))
  }

  /**
   * @param {string} sessionId
   * @returns {Record<string, unknown> | undefined}
   */
  latestValidationLog(sessionId) {
    const row = this.db.get('SELECT * FROM validation_logs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [sessionId])
    return row === undefined ? undefined : this.parseValidationLog(row)
  }

  /**
   * @param {Record<string, unknown>} row
   * @returns {Record<string, unknown>}
   */
  parseValidationLog(row) {
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
      step: row.step === null || row.step === undefined ? null : Number(row.step),
      eventSeq: row.event_seq === null || row.event_seq === undefined ? null : Number(row.event_seq),
      trigger: String(row.trigger),
      target: String(row.target),
      ok: row.ok === 1,
      checked: Number(row.checked),
      skipped: Number(row.skipped),
      blocked: row.blocked === 1,
      deterministic: row.deterministic === 1,
      violations: parseJson(/** @type {string} */ (row.violations_json), []),
      errors: parseJson(/** @type {string} */ (row.errors_json), []),
      createdAt: String(row.created_at),
    }
  }

  // ---------------------------------------------------------------- archives

  /**
   * Store a raw evidence copy for content the host log may not replay.
   *
   * @param {{ sessionId: string, ref: string, eventType: string, text: string }} input
   * @returns {boolean}
   */
  archiveEvent(input) {
    const result = this.db.run(
      `INSERT OR IGNORE INTO archive (session_id, ref, event_type, text, created_at) VALUES (?, ?, ?, ?, ?)`,
      [input.sessionId, input.ref, input.eventType, input.text, this.now()],
    )
    return result.changes > 0
  }

  /**
   * @param {string} sessionId
   * @param {string} ref
   * @returns {{ ref: string, eventType: string, text: string } | undefined}
   */
  getArchived(sessionId, ref) {
    const row = this.db.get('SELECT * FROM archive WHERE session_id = ? AND ref = ?', [sessionId, ref])
    if (row === undefined) return undefined
    return { ref: String(row.ref), eventType: String(row.event_type), text: String(row.text) }
  }

  // ------------------------------------------------------- pending extraction

  /**
   * @param {string} sessionId
   * @param {number} seq
   * @param {string} error
   * @returns {void}
   */
  markPendingExtraction(sessionId, seq, error) {
    this.db.run(
      `INSERT INTO pending_extraction (session_id, seq, attempts, last_error, created_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET attempts = pending_extraction.attempts + 1, last_error = excluded.last_error`,
      [sessionId, seq, String(error).slice(0, 2000), this.now()],
    )
  }

  /**
   * @param {string} sessionId
   * @param {number} seq
   * @returns {void}
   */
  clearPendingExtraction(sessionId, seq) {
    this.db.run('DELETE FROM pending_extraction WHERE session_id = ? AND seq = ?', [sessionId, seq])
  }

  /**
   * @param {string} sessionId
   * @param {{ limit?: number }} [options]
   * @returns {{ seq: number, attempts: number, lastError: string | null }[]}
   */
  listPendingExtraction(sessionId, options = {}) {
    const limit = clamp(options.limit ?? 100, 1, 1000)
    return this.db
      .all('SELECT * FROM pending_extraction WHERE session_id = ? ORDER BY seq ASC LIMIT ?', [sessionId, limit])
      .map((row) => ({
        seq: Number(row.seq),
        attempts: Number(row.attempts),
        lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
      }))
  }

  // ------------------------------------------------------------- diagnostics

  /**
   * @param {string} sessionId
   * @returns {Record<string, unknown>}
   */
  stats(sessionId) {
    const count = (table, where = 'session_id = ?') => {
      const row = this.db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, [sessionId])
      return Number(row?.count ?? 0)
    }
    return {
      session: this.getSession(sessionId),
      events: count('events'),
      memoryItems: count('memory_items'),
      activeMemoryItems: count('memory_items', "session_id = ? AND status = 'active'"),
      memoryEvents: count('memory_events'),
      assemblyLogs: count('assembly_logs'),
      archived: count('archive'),
      pendingExtraction: count('pending_extraction'),
      checkpoint: this.getCheckpoint(sessionId),
      taskState: this.getTaskState(sessionId),
    }
  }

  /**
   * Aggregate memory counts by kind and status for one session.
   *
   * @param {string} sessionId
   * @returns {{ total: number, active: number, byKind: Record<string, number>, byStatus: Record<string, number> }}
   */
  memoryBreakdown(sessionId) {
    const rows = this.db.all(
      'SELECT kind, status, COUNT(*) AS count FROM memory_items WHERE session_id = ? GROUP BY kind, status',
      [sessionId],
    )
    /** @type {Record<string, number>} */
    const byKind = {}
    /** @type {Record<string, number>} */
    const byStatus = {}
    let total = 0
    let active = 0
    for (const row of rows) {
      const count = Number(row.count ?? 0)
      const kind = String(row.kind)
      const status = String(row.status)
      byKind[kind] = (byKind[kind] ?? 0) + count
      byStatus[status] = (byStatus[status] ?? 0) + count
      total += count
      if (status === 'active') active += count
    }
    return { total, active, byKind, byStatus }
  }

  /**
   * Export one session as plain JSON. Raw event text is included only when
   * `includeEvents` is set, because it can be large.
   *
   * @param {string} sessionId
   * @param {{ includeEvents?: boolean }} [options]
   * @returns {Record<string, unknown>}
   */
  exportSession(sessionId, options = {}) {
    const session = this.getSession(sessionId)
    const items = this.listMemoryItems(sessionId, { limit: 100000 })
    const itemIds = new Set(items.map((item) => item.id))
    const memoryEvents = this.db
      .all(
        `SELECT * FROM memory_events WHERE session_id = ? ORDER BY id ASC LIMIT 100000`,
        [sessionId],
      )
      .filter((row) => itemIds.has(String(row.memory_id)))
    return {
      format: 'dsh-long-memory-export',
      version: 1,
      exportedAt: this.now(),
      session: session ?? null,
      taskState: this.getTaskState(sessionId),
      checkpoint: this.getCheckpoint(sessionId),
      memoryItems: items,
      memoryEvents,
      assemblies: this.listAssemblies(sessionId, { limit: 50 }),
      events: options.includeEvents === true ? this.listEvents(sessionId, { limit: 100000 }) : undefined,
    }
  }

  /**
   * Irreversibly remove all memory for one session (events, memories, derived
   * indexes, logs, archives). Raw host session logs are untouched.
   *
   * @param {string} sessionId
   * @returns {{ deleted: Record<string, number> }}
   */
  purgeSession(sessionId) {
    const deleted = {}
    const tableCols = {
      events: 'session_id = ?',
      memory_items: 'session_id = ?',
      memory_events: 'session_id = ?',
      task_state: 'session_id = ?',
      checkpoints: 'session_id = ?',
      assembly_logs: 'session_id = ?',
      archive: 'session_id = ?',
      pending_extraction: 'session_id = ?',
      sessions: 'session_id = ?',
    }
    this.db.transaction(() => {
      const seqRows = this.db.all('SELECT seq FROM events WHERE session_id = ?', [sessionId])
      for (const row of seqRows) {
        this.db.run('DELETE FROM events_fts WHERE session_id = ? AND seq = ?', [sessionId, Number(row.seq)])
      }
      const itemRows = this.db.all('SELECT id FROM memory_items WHERE session_id = ?', [sessionId])
      for (const row of itemRows) {
        this.db.run('DELETE FROM memory_fts WHERE memory_id = ?', [String(row.id)])
      }
      for (const [table, where] of Object.entries(tableCols)) {
        const result = this.db.run(`DELETE FROM ${table} WHERE ${where}`, [sessionId])
        deleted[table] = result.changes
      }
    })
    return { deleted }
  }

  /**
   * Delete memory items whose status is retracted and older than the given
   * retention count (used by `memory purge --retracted`).
   *
   * @param {string} sessionId
   * @returns {number}
   */
  purgeRetracted(sessionId) {
    const rows = this.db.all(
      `SELECT id FROM memory_items WHERE session_id = ? AND status = 'retracted'`,
      [sessionId],
    )
    this.db.transaction(() => {
      for (const row of rows) {
        const id = String(row.id)
        this.db.run('DELETE FROM memory_fts WHERE memory_id = ?', [id])
        this.db.run('DELETE FROM memory_events WHERE memory_id = ?', [id])
        this.db.run('DELETE FROM memory_items WHERE id = ?', [id])
      }
    })
    return rows.length
  }

  /**
   * @returns {{ ok: boolean, errors: string[] }}
   */
  integrityCheck() {
    return this.db.integrityCheck()
  }
}

/** Re-exported enums for callers that validate user input. */
export { EVIDENCE_TYPES, MEMORY_KINDS, MEMORY_STATUSES }
