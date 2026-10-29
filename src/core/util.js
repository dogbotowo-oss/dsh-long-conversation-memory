/**
 * Dependency-free helpers shared by every module: hashing, stable JSON, time,
 * text normalization, query tokenization and token estimation.
 *
 * @module dsh-session-memory/core/util
 */

import { createHash, randomUUID } from 'node:crypto'

/** @returns {string} a new UUID v4 string */
export function uuid() {
  return randomUUID()
}

/**
 * @param {string} input
 * @returns {string} lowercase hex sha-256
 */
export function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Deterministic JSON: object keys sorted recursively, so equal values always
 * hash to the same digest (used for content hashes and dedupe).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

/** @param {unknown} value @returns {unknown} */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key])
    return out
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Build a stable identifier from a prefix, an optional session fragment and a
 * content hash. The result is short, sortable and collision resistant enough
 * for a per-session memory store.
 *
 * @param {string} prefix
 * @param {string} sessionId
 * @param {string} contentHash
 * @returns {string}
 */
export function stableId(prefix, sessionId, contentHash) {
  const sessionPart = sessionId.replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) || 'session'
  return `${prefix}_${sessionPart}_${contentHash.slice(0, 16)}`
}

/**
 * @param {number} now epoch milliseconds
 * @returns {string} ISO-8601 timestamp
 */
export function toIso(now) {
  return new Date(now).toISOString()
}

/** @returns {string} current ISO-8601 timestamp */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
}

/**
 * Canonical text normalization used for hashing and dedupe. It trims, collapses
 * whitespace and lowercases ASCII only (never the CJK body).
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clampText(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Extract the visible text of a DSH content-block array without relying on
 * host helpers. Non-text blocks are summarised deterministically.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function contentBlocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!isPlainObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'image' || block.type === 'image_url') {
      parts.push('[image]')
    } else if (block.type === 'file' || block.type === 'attachment') {
      parts.push(`[file ${String(block.path ?? block.name ?? '')}]`)
    } else if (block.type === 'tool_call') {
      parts.push(`[tool_call ${String(block.name ?? '')}]`)
    } else {
      parts.push(`[${String(block.type ?? 'block')}]`)
    }
  }
  return parts.join('\n')
}

/** Matches CJK unified ideographs, kana and hangul ranges. */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u

/**
 * @param {string} text
 * @returns {boolean}
 */
export function containsCjk(text) {
  return CJK_RE.test(text)
}

/**
 * Query tokenization used by the keyword leg of retrieval:
 * - latin/digit runs (>= 2 chars) are kept as words and lowercased
 * - CJK runs are split into character bigrams (plus the full run when short)
 * - numbers, identifiers and paths are additionally kept as exact tokens
 *
 * The same tokenizer runs at index time, so the two sides agree.
 *
 * @param {string} text
 * @param {{ maxTokens?: number }} [options]
 * @returns {string[]} unique tokens in first-seen order
 */
export function tokenize(text, options = {}) {
  const maxTokens = options.maxTokens ?? 200
  const tokens = []
  const seen = new Set()
  /** @param {string} token */
  const push = (token) => {
    const normalized = token.toLowerCase()
    if (normalized.length === 0 || seen.has(normalized) || tokens.length >= maxTokens) return
    seen.add(normalized)
    tokens.push(normalized)
  }

  const source = String(text ?? '')
  const latin = source.match(/[A-Za-z0-9_@./\\-]+/g) ?? []
  for (const word of latin) {
    if (word.length >= 2) push(word)
  }
  const cjkRuns = source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/gu) ?? []
  for (const run of cjkRuns) {
    if (run.length <= 2) {
      push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i += 1) push(run.slice(i, i + 2))
  }
  return tokens
}

/** Matches a number with optional unit/suffix, e.g. `79.87%`, `143段`, `1.2 mm`. */
const NUMBER_RE = /-?\d+(?:\.\d+)?\s*(?:%|‰|mm|cm|m|km|kg|g|mg|ms|s|min|h|dpi|px|段|页|个|行|字|章|节|条|项|倍|次|nm|μm|um|°C|℃|V|A|W|Hz)?/gu

/**
 * Extract numbers together with their immediate unit and a small window of
 * following text. Numbers are stored with their conditions by the extractor.
 *
 * @param {string} text
 * @returns {{ raw: string, value: number, unit: string, index: number }[]}
 */
export function extractNumbers(text) {
  const source = String(text ?? '')
  const out = []
  NUMBER_RE.lastIndex = 0
  let match
  while ((match = NUMBER_RE.exec(source)) !== null) {
    const raw = match[0].trim()
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) continue
    const unit = raw.replace(/^-?\d+(?:\.\d+)?\s*/u, '').trim()
    out.push({ raw, value: parsed, unit, index: match.index })
    if (out.length >= 50) break
  }
  return out
}

/**
 * Estimate tokens for a text. CJK text costs ~1 token per 1.6 characters, other
 * text ~4 characters per token. Always reported as `estimate`, never exact.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const source = String(text ?? '')
  if (source.length === 0) return 0
  let cjk = 0
  for (const char of source) {
    if (CJK_RE.test(char)) cjk += 1
  }
  const rest = source.length - cjk
  return Math.ceil(cjk / 1.6 + rest / 4)
}

/**
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean} case-insensitive containment
 */
export function includesCaseInsensitive(haystack, needle) {
  if (needle.length === 0) return false
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase())
}

/**
 * @param {string} text
 * @returns {string} text safe to embed in a one-line diagnostic
 */
export function oneLine(text, max = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clampText(flat, max)
}

/**
 * @param {unknown} value
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function toStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback]
  return value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
}

/**
 * @param {string | null | undefined} json
 * @param {unknown} fallback
 * @returns {unknown}
 */
export function parseJson(json, fallback) {
  if (typeof json !== 'string' || json.length === 0) return fallback
  try {
    const parsed = JSON.parse(json)
    return parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

/**
 * @param {string} value
 * @returns {string} value escaped for a SQL LIKE pattern with `ESCAPE '\\'`
 */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * @template T
 * @param {T[]} list
 * @param {(item: T) => string} keyFn
 * @returns {T[]}
 */
export function uniqueBy(list, keyFn) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateMiddle(text, maxChars) {
  const source = String(text ?? '')
  if (source.length <= maxChars) return source
  const half = Math.max(1, Math.floor((maxChars - 1) / 2))
  return `${source.slice(0, half)}…${source.slice(source.length - half)}`
}

/**
 * @param {string} text
 * @param {number} maxLines
 * @returns {string}
 */
export function takeLines(text, maxLines) {
  const lines = String(text ?? '').split('\n')
  if (lines.length <= maxLines) return lines.join('\n')
  return `${lines.slice(0, maxLines).join('\n')}\n…`
}
