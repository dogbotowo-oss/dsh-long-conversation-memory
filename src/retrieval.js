/**
 * Retrieval: deterministic (no extra model call) lookup over the session's
 * memory items and raw events. SQLite FTS5 (trigram tokenizer) handles Latin
 * words and CJK n-grams; exact matching handles paths, ids, numbers and
 * entities; every hit can be expanded to the original event text.
 *
 * @module dsh-long-conversation-memory/retrieval
 */

import { EVIDENCE_TYPES } from './core/constants.js'
import { GENERATED_SOURCE_KINDS } from './capture.js'
import { containsCjk, estimateTokens, extractNumbers, oneLine, tokenize } from './core/util.js'

const EVIDENCE_WEIGHT = { user_explicit: 1.0, skill: 0.9, artifact_verified: 0.95, assistant_proposal: 0.6, inferred: 0.4 }
const KIND_WEIGHT = { decision: 1.0, constraint: 1.0, fact: 0.95, preference: 0.8, open_question: 0.8, proposal: 0.5 }

const PATH_RE = /(?:[A-Za-z]:\\[^\s"'<>|]+|\/[A-Za-z0-9._-]+\/[^\s"'<>|]+)/gu
const ID_RE = /\b(?:[A-Z]{2,}[-_]?\d{2,}|[a-f0-9]{8,}|[A-Za-z]+_[A-Za-z0-9_]{4,})\b/gu

/**
 * @typedef {object} QuerySignals
 * @property {string} raw
 * @property {string[]} tokens FTS-able tokens (Latin words / CJK n-grams)
 * @property {string[]} exactTerms numbers, paths, ids, quoted phrases
 * @property {string[]} numbers numeric raws
 * @property {string[]} paths path-like strings
 * @property {string[]} quoteTerms quoted phrases
 * @property {Set<string>} termSet lowercase exact terms for fast matching
 */

/**
 * Extract deterministic query signals from the current task/user text.
 *
 * @param {string} text
 * @returns {QuerySignals}
 */
export function buildQuerySignals(text) {
  const raw = String(text ?? '')
  const tokens = tokenize(raw, { maxTokens: 160 })
  /** @type {string[]} */
  const exactTerms = []
  const paths = [...raw.matchAll(PATH_RE)].map((match) => match[0]).slice(0, 12)
  const ids = [...raw.matchAll(ID_RE)].map((match) => match[0]).filter((id) => /[-_\d]/.test(id)).slice(0, 12)
  const numbers = extractNumbers(raw).map((entry) => entry.raw).slice(0, 24)
  const quoteTerms = [...raw.matchAll(/[「『“"]([^」』”"]{2,80})[」』”"]/gu)].map((match) => match[1].trim()).slice(0, 8)
  exactTerms.push(...paths, ...ids, ...quoteTerms)
  // Two-character CJK runs that trigram FTS cannot match: keep them as LIKE terms.
  for (const run of raw.matchAll(/[\u4e00-\u9fff]{2}/gu)) {
    if (!tokens.includes(run[0])) exactTerms.push(run[0])
  }
  const termSet = new Set(exactTerms.map((term) => term.toLowerCase()))
  return { raw, tokens, exactTerms: [...new Set(exactTerms)].slice(0, 40), numbers, paths, quoteTerms, termSet }
}

/**
 * @param {import('./memory/store.js').MemoryStore} store
 * @param {{ config?: any }} [options]
 */
export class Retriever {
  constructor(store, options = {}) {
    this.store = store
    this.config = options.config ?? {}
  }

  /**
   * @param {string} sessionId
   * @param {{ query?: string, limit?: number, minScore?: number, recentEventSeq?: number }} [input]
   */
  retrieve(sessionId, input = {}) {
    const query = String(input.query ?? '').trim()
    const limit = Math.min(input.limit ?? this.config.retrieval?.limit ?? 24, 100)
    const minScore = input.minScore ?? this.config.retrieval?.minScore ?? 0.5
    const exactBoost = this.config.retrieval?.exactMatchBoost ?? 3
    const recencyBoost = this.config.retrieval?.recencyBoost ?? 0.5
    const signals = buildQuerySignals(query)
    /** @type {Map<string, { item: any, score: number, reasons: string[] }>} */
    const scored = new Map()

    if (signals.tokens.length > 0 || signals.exactTerms.length > 0) {
      const hits = this.store.searchMemory({ sessionId, query, limit: Math.max(limit * 2, 24), statuses: ['active'] })
      for (const hit of hits) {
        const item = hit.item
        let score = KIND_WEIGHT[item.kind] ?? 0.5
        const reasons = [`fts:${hit.matched}`]
        score += Math.min(Math.abs(hit.ftsScore ?? 0), 10) / 10
        let exactHits = 0
        const haystack = `${item.content}\n${(item.conditions ?? []).join('\n')}\n${(item.scope ?? []).join('\n')}`.toLowerCase()
        for (const term of signals.exactTerms) {
          if (term.length >= 2 && haystack.includes(term.toLowerCase())) exactHits += 1
        }
        if (exactHits > 0) {
          score += exactBoost * Math.min(exactHits, 3) / 3
          reasons.push(`exact:${exactHits}`)
        }
        const evidenceWeight = EVIDENCE_WEIGHT[item.evidenceType] ?? 0.6
        score *= evidenceWeight
        if (item.supersededBy !== null && item.supersededBy !== undefined) score *= 0.4
        if (typeof input.recentEventSeq === 'number' && typeof item.sourceRefs?.[0] === 'string') {
          const seq = Number.parseInt(String(item.sourceRefs[0]).replace('seq:', ''), 10)
          if (Number.isFinite(seq) && input.recentEventSeq - seq < 40) {
            score += recencyBoost
            reasons.push('recent')
          }
        }
        scored.set(item.id, { item, score, reasons })
      }
    }

    const ranked = [...scored.values()].sort((a, b) => b.score - a.score)
    const selected = ranked.filter((entry) => entry.score >= minScore).slice(0, limit)
    return {
      query,
      signals,
      items: selected.map((entry) => ({ item: entry.item, score: Number(entry.score.toFixed(3)), reasons: entry.reasons })),
      omitted: ranked.filter((entry) => entry.score < minScore).slice(0, 20).map((entry) => ({ id: entry.item.id, score: entry.score, reason: `below minScore ${minScore}` })),
    }
  }

  /**
   * Retrieve raw evidence for selected items and/or query signals. Text is
   * returned verbatim (evidence, not instruction) with its seq reference.
   *
   * @param {string} sessionId
   * @param {{ query?: string, items?: { item: any }[], limit?: number, fromSeq?: number }} [input]
   */
  retrieveEvidence(sessionId, input = {}) {
    const limit = Math.min(input.limit ?? this.config.assembly?.maxEvidence ?? 8, 40)
    const signals = buildQuerySignals(input.query ?? '')
    /** @type {Map<number, { seq: number, eventType: string, role: string | null, text: string, reason: string, score: number }>} */
    const found = new Map()
    for (const entry of input.items ?? []) {
      for (const ref of entry.item?.sourceRefs ?? []) {
        const match = /^seq:(\d+)$/u.exec(String(ref))
        if (match === null) continue
        const seq = Number.parseInt(match[1], 10)
        if (found.has(seq)) continue
        const event = this.store.getEvent(sessionId, seq)
        if (event === undefined || !event.text) continue
        if (event.sourceKind !== null && event.sourceKind !== undefined && GENERATED_SOURCE_KINDS.has(event.sourceKind)) continue
        found.set(seq, { seq, eventType: event.type, role: event.role, text: event.text, reason: `source of ${entry.item.id}`, score: 10 })
      }
    }
    const exactQuery = signals.exactTerms.join(' ') || (signals.numbers.join(' ') ?? '')
    // Search the raw query *and* the high-signal terms: a plain CJK phrase such
    // as "准确率" is neither a quoted term nor a number, but it is exactly what
    // the user typed, and trigram FTS matches it directly.
    const searchText = [String(input.query ?? '').trim(), ...signals.numbers, ...signals.paths, ...signals.quoteTerms]
      .filter((part) => part.length > 0)
      .join(' ')
    if (searchText.length > 0) {
      const hits = this.store.searchEvents({ sessionId, query: searchText, fromSeq: input.fromSeq, limit: limit * 3 })
      for (const hit of hits) {
        if (found.has(hit.seq)) continue
        // Generated context (our own memory block, runtime-context, skill
        // bundles, ...) is never evidence about the conversation.
        if (hit.sourceKind !== null && hit.sourceKind !== undefined && GENERATED_SOURCE_KINDS.has(hit.sourceKind)) continue
        found.set(hit.seq, { seq: hit.seq, eventType: hit.eventType, role: hit.role, text: hit.text, reason: `match (${hit.matched})`, score: hit.score + 5 })
      }
    }
    const evidence = [...found.values()].sort((a, b) => a.seq - b.seq).slice(0, limit)
    return { evidence, signals, query: exactQuery }
  }

  /**
   * Expand evidence references with adjacent raw events (for on-demand view).
   *
   * @param {string} sessionId
   * @param {number[]} seqs
   * @param {{ radius?: number, maxChars?: number }} [options]
   */
  expand(sessionId, seqs, options = {}) {
    const radius = options.radius ?? 1
    const maxChars = options.maxChars ?? 4000
    /** @type {Record<string, unknown>[]} */
    const expanded = []
    for (const seq of [...new Set(seqs)]) {
      const events = this.store.listEvents(sessionId, { fromSeq: Math.max(-1, seq - radius), toSeq: seq + radius, limit: 2 * radius + 1 })
      for (const event of events) {
        expanded.push({ seq: event.seq, type: event.type, role: event.role, turn: event.turn, step: event.step, text: oneLine(event.text ?? '', maxChars), isTarget: event.seq === seq })
      }
    }
    return expanded
  }

  /**
   * Compose the "evidence insufficient" answer body.
   *
   * @param {string} query
   */
  insufficient(query) {
    return {
      insufficientEvidence: true,
      query,
      text: `证据不足：会话记忆中未找到与「${oneLine(query, 80)}」相关的已提交证据，不能据此推断或补造历史。`,
    }
  }

  /**
   * Provenance summary of one memory item, for `memory inspect`.
   *
   * @param {string} id
   * @returns {{ item: any, events: any[], evidence: any[], tokens: number } | { error: string }}
   */
  inspectItem(id) {
    const item = this.store.getMemoryItem(String(id))
    if (item === undefined) return { error: `unknown memory item: ${id}` }
    const events = []
    for (const ref of item.sourceRefs ?? []) {
      const match = /^seq:(\d+)$/u.exec(String(ref))
      if (match === null) continue
      const event = this.store.getEvent(item.sessionId, Number.parseInt(match[1], 10))
      if (event !== undefined) events.push({ seq: event.seq, type: event.type, role: event.role, text: event.text, archived: false })
    }
    let evidence = events.map((event) => ({ seq: event.seq, text: event.text }))
    if (evidence.length === 0 && item.sourceRefs?.length > 0) {
      evidence = item.sourceRefs.map((ref) => {
        const archived = this.store.getArchived(item.sessionId, String(ref))
        return archived === undefined ? { ref, text: null } : { ref, text: archived.text }
      })
    }
    return { item, events: this.store.listMemoryEvents(id), evidence, tokens: estimateTokens(item.content) }
  }
}

/** @returns {string[]} evidence type names in trust order */
export function evidenceTrustOrder() {
  return [...EVIDENCE_TYPES]
}

/** @returns {boolean} true when a string contains CJK (for diagnostics) */
export function isCjkQuery(text) {
  return containsCjk(String(text ?? ''))
}
