/**
 * Deterministic memory extraction.
 *
 * This module is the default (and only) extractor in v1: it turns committed
 * user messages into candidate memory items with plain, testable heuristics and
 * makes no model calls. The semantic extractor interface is reserved (see
 * `docs/architecture.md` "Extension points"); a future extractor must obey the
 * same write principles, most importantly:
 *
 * - an assistant proposal is never promoted to a decision automatically;
 * - a correction creates a new item and supersedes (never deletes) the old one;
 * - numbers are stored together with their unit and qualifying conditions;
 * - extraction is idempotent per session event sequence number.
 *
 * @module dsh-long-memory/memory/extraction
 */

import { extractNumbers, normalizeText, nowIso, oneLine, tokenize } from '../core/util.js'

/** Sentences longer than this are split further before scanning. */
const MAX_SENTENCE_CHARS = 400
/** Do not create more than this many items from one event. */
const MAX_ITEMS_PER_EVENT = 8

/** Markers that indicate the user is correcting an earlier statement. */
export const CORRECTION_MARKERS = [
  '不是',
  '并非',
  '不再是',
  '不再',
  '纠正',
  '更正',
  '修正',
  '改为',
  '改成',
  '应为',
  '应该是',
  '实际是',
  '实际为',
  '正确(?:的)?(?:值)?是',
  '准确(?:地)?(?:说|讲|值)?是',
  '准确率为',
  '不对',
  '错了',
  '更正一下',
  '其实是',
  'actually',
  'correction',
  'instead of',
  'not ',
  'rather than',
  'should be',
  'correct value is',
]

/** Markers that indicate an explicit user decision. */
export const DECISION_MARKERS = [
  '决定',
  '采用',
  '选择',
  '就按',
  '定下来',
  '确定用',
  '最终用',
  '定为',
  '确定为',
  '选定',
  '选用',
  '就用',
  '方案是',
  '即日起',
  'we will',
  'we decided',
  'decided to',
  'go with',
  'final decision',
]

/** Markers that indicate a hard constraint. */
export const CONSTRAINT_MARKERS = [
  '必须',
  '务必',
  '不得',
  '禁止',
  '不要',
  '不能',
  '只能',
  '仅限',
  '严禁',
  '一律',
  'must ',
  'never ',
  'do not ',
  'only ',
  'shall ',
]

/** Markers that indicate a preference (soft, not a hard constraint). */
export const PREFERENCE_MARKERS = ['偏好', '倾向于', '更喜欢', '希望', 'prefer ', 'i would like', 'ideally']

/** Labelled task-state lines, e.g. `目标: ...`, `当前阻塞：...`, `TODO: ...`. */
const TASK_LABELS = [
  { field: 'goal', pattern: /^\s*(?:(?:当前|目前|最新|本轮)\s*)?(?:目标|goal|objective)\s*(?:[:：]|是)\s*(.+)$/iu },
  { field: 'progress', pattern: /^\s*(?:(?:当前|目前|最新|本轮)\s*)?(?:进度|已完成|完成情况|progress|done)\s*(?:情况|更新|状态)?\s*[:：]\s*(.+)$/iu },
  { field: 'blockers', pattern: /^\s*(?:(?:当前|目前|最新|本轮)\s*)?(?:阻塞|阻碍|blockers?|blocked by)\s*(?:情况|更新|状态)?\s*[:：]\s*(.+)$/iu },
  { field: 'openItems', pattern: /^\s*(?:(?:当前|目前|最新|本轮)\s*)?(?:待办|下一步|待完成|未完成|todo|next|open items?)\s*(?:情况|更新|状态)?\s*[:：]\s*(.+)$/iu },
]

/**
 * Explicit task-state clearing statements. These are deterministic phrase
 * patterns only: a user saying "阻塞已解除" or "已完成 X" removes the matching
 * entry instead of leaving a stale blocker in the assembled task state. The
 * removal is an append-only audit (`task_state.superseded_json`), so the old
 * value stays visible to `memory inspect`-style diagnostics.
 *
 * @param {string} text
 * @returns {{ op: 'complete' | 'unblock' | 'cancel', subject: string, sentence: string }[]}
 */
export function detectTaskClears(text) {
  /** @type {{ op: 'complete' | 'unblock' | 'cancel', subject: string, sentence: string }[]} */
  const clears = []
  for (const sentence of splitSentences(text)) {
    // Completion: "已完成/解决了 X" or "X 已完成".
    const completions = [
      ...sentence.matchAll(/(?:已|已经)\s*(?:完成|解决|搞定|处理完|修好)\s*[:：]?\s*([^，,。；;\n]{0,80})/giu),
      ...sentence.matchAll(/([^，,。；;\n]{0,80}?)\s*(?:已|已经)\s*(?:完成|解决|搞定|处理完|修好)/giu),
    ]
    let matched = false
    for (const match of completions) {
      clears.push({ op: 'complete', subject: oneLine(match[1] ?? '', 120), sentence })
      matched = true
    }
    if (matched) continue
    // Blocker cleared: "阻塞已解除", "X 不再是阻塞", "no longer blocked by X".
    const unblocks = [
      ...sentence.matchAll(/(?:阻塞|阻碍|blockers?)\s*(?:已|已经)?\s*(?:解除|解决|清除|消除|closed|cleared|resolved|removed)\s*[:：]?\s*([^，,。；;\n]{0,80})/giu),
      ...sentence.matchAll(/(?:不再|没有|无)\s*(?:阻塞|阻碍|blocked? by)\s*[:：]?\s*([^，,。；;\n]{0,80})/giu),
      ...sentence.matchAll(/(?:no longer|not)\s+blocked\s*(?:by)?\s*([^，,。；;\n]{0,80})/giu),
    ]
    matched = false
    for (const match of unblocks) {
      clears.push({ op: 'unblock', subject: oneLine(match[1] ?? '', 120), sentence })
      matched = true
    }
    if (matched) continue
    // Cancellation: "取消 X", "放弃 X".
    for (const match of sentence.matchAll(/(?:取消|放弃|撤销|不做了|cancelled|canceled|dropped?)\s*[:：]?\s*([^，,。；;\n]{1,80})/giu)) {
      clears.push({ op: 'cancel', subject: oneLine(match[1] ?? '', 120), sentence })
    }
  }
  // The same sentence can match a prefix pattern ("进度：已完成初稿" also yields
  // subject "进度："). Drop label-only/duplicate subjects so one statement clears
  // one task entry.
  const seen = new Set()
  /** @type {{ op: 'complete' | 'unblock' | 'cancel', subject: string, sentence: string }[]} */
  const unique = []
  for (const clear of clears) {
    const subject = clear.subject.replace(/[\s:：]+$/u, '').trim()
    if (subject.length === 0 || isTaskLabelOnly(subject)) continue
    const key = `${clear.op}:${subject.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...clear, subject })
  }
  return unique
}

/**
 * Whether a clearing subject is only a task-state label (e.g. the "进度" of
 * "进度：已完成初稿。") rather than a real subject.
 *
 * @param {string} subject
 * @returns {boolean}
 */
function isTaskLabelOnly(subject) {
  return /^(?:(?:当前|目前|最新|本轮)\s*)?(?:目标|goal|objective|进度|已完成|完成情况|progress|done|阻塞|阻碍|blockers?|blocked by|待办|下一步|待完成|未完成|todo|next|open items?)\s*(?:情况|更新|状态)?$/iu.test(
    subject,
  )
}

/** @param {string} entry @param {string} subject @param {string} sentence @returns {boolean} */
function taskEntryMatches(entry, subject, sentence) {
  const entryText = normalizeText(entry).toLowerCase()
  const subjectText = normalizeText(subject).toLowerCase()
  if (subjectText.length >= 2 && (entryText.includes(subjectText) || subjectText.includes(entryText))) return true
  const entryTokens = new Set(tokenize(entry, { maxTokens: 40 }))
  const subjectTokens = new Set(tokenize(subjectText, { maxTokens: 40 }))
  for (const token of subjectTokens) if (entryTokens.has(token) && token.length >= 2) return true
  // A generic clearing sentence ("阻塞已解除") without a subject: only clear an
  // entry when the sentence itself still names it.
  if (subjectText.length === 0) {
    const sentenceTokens = new Set(tokenize(sentence, { maxTokens: 60 }))
    for (const token of sentenceTokens) if (entryTokens.has(token) && token.length >= 3) return true
  }
  return false
}


/** Clauses that qualify the scope/conditions of a number or decision. */
const QUALIFIER_MARKERS = [
  '在',
  '针对',
  '基于',
  '按',
  '根据',
  '对于',
  '只',
  '仅',
  '限',
  '口径',
  '统计',
  '条件',
  '前提',
  '单位',
  '版本',
  '模型',
  '数据集',
  '样本',
  '场景',
  '环境',
  '适用',
  'when ',
  'under ',
  'for which',
  'assuming',
  'per ',
  'version ',
  'dataset',
  'benchmark',
]

/**
 * Split text into sentence-ish units, keeping the trailing punctuation.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const source = normalizeText(text)
  if (source.length === 0) return []
  /** @type {string[]} */
  const units = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/(?<=[。！？!?；;])|(?<=\.\s)/u)
    for (const part of parts) {
      const sentence = part.trim()
      if (sentence.length === 0) continue
      if (sentence.length <= MAX_SENTENCE_CHARS) {
        units.push(sentence)
      } else {
        for (let index = 0; index < sentence.length; index += MAX_SENTENCE_CHARS) {
          units.push(sentence.slice(index, index + MAX_SENTENCE_CHARS).trim())
        }
      }
    }
  }
  return units.filter((unit) => unit.length > 1)
}

/**
 * @param {string} text
 * @param {string[]} markers
 * @returns {string | null} the first marker matched
 */
function findMarker(text, markers) {
  const haystack = text.toLowerCase()
  for (const marker of markers) {
    if (marker.startsWith('/') || marker.includes('(')) {
      try {
        if (new RegExp(marker, 'iu').test(text)) return marker
      } catch {
        continue
      }
    } else if (haystack.includes(marker.toLowerCase().trim())) {
      return marker
    }
  }
  return null
}

/**
 * @param {string} sentence
 * @returns {string[]} qualifying clauses of a claim
 */
export function qualificationClauses(sentence) {
  const clauses = sentence
    .split(/[，,；;]/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 3)
  const qualifiers = clauses.filter((clause) => QUALIFIER_MARKERS.some((marker) => clause.toLowerCase().includes(marker.trim())))
  // The unit of a number is itself a condition; keep "79.87%" as "unit: %".
  for (const number of extractNumbers(sentence)) {
    if (number.unit.length > 0 && !qualifiers.some((clause) => clause.includes(number.raw))) {
      qualifiers.push(`unit: ${number.unit} (from ${number.raw})`)
    }
  }
  return [...new Set(qualifiers)].slice(0, 8)
}

/**
 * @param {string} text
 * @returns {'fact'|'decision'|'constraint'|'preference'|'proposal'|'open_question'}
 */
export function classifySentence(text) {
  if (findMarker(text, CORRECTION_MARKERS) !== null) return 'fact'
  if (findMarker(text, CONSTRAINT_MARKERS) !== null) return 'constraint'
  if (findMarker(text, DECISION_MARKERS) !== null) return 'decision'
  if (findMarker(text, PREFERENCE_MARKERS) !== null) return 'preference'
  if (/[?？]\s*$/u.test(text) || /(?:待确认|尚未确定|待定|是否)/u.test(text)) return 'open_question'
  return 'fact'
}

/**
 * Detect explicit corrections in a user message. A correction is a sentence
 * that both (a) carries a correction marker and (b) refers to at least one
 * value/number (or explicitly replaces a prior statement).
 *
 * Old/new values are collected both numerically ("不是 79.87%") and textually
 * ("不是 mimir-13b-v1.2，是 mimir-13b-v2.0"): version ids, model names and other
 * identifiers are not numbers, but a correction that names them is exactly the
 * case where the supersession link must be created.
 *
 * @param {string} text
 * @returns {{ sentence: string, marker: string, numbers: { raw: string, value: number, unit: string, index: number }[], oldValues: string[], newValues: string[] }[]}
 */
export function detectCorrections(text) {
  /** @type {{ sentence: string, marker: string, numbers: { raw: string, value: number, unit: string, index: number }[], oldValues: string[], newValues: string[] }[]} */
  const corrections = []
  for (const sentence of splitSentences(text)) {
    const marker = findMarker(sentence, CORRECTION_MARKERS)
    if (marker === null) continue
    const numbers = extractNumbers(sentence)
    const hasNegation = /(?:不是|并非|不再是|不对|错了|actually|instead of|rather than|not\s)/iu.test(sentence)
    if (numbers.length === 0 && !hasNegation) continue
    // Values that belonged to the previous statement appear right after a
    // negation marker: "不是 79.87%" -> old value 79.87.
    const oldValues = []
    for (const match of sentence.matchAll(/(?:不是|并非|不再是|不对|instead of|rather than|not)\s*([^，,。；;]{0,40})/giu)) {
      for (const number of extractNumbers(match[1])) oldValues.push(number.raw)
      const clause = cleanValueClause(match[1])
      if (clause.length >= 2) oldValues.push(clause)
    }
    // Values that replace the old statement appear after a copula at the start
    // of a clause: "不是 X，是 Y" / "实际是 Z". Requiring a clause boundary
    // keeps later "仍是 beam=5" / "口径是 …" fillers out of the new-value set.
    const newValues = []
    for (const match of sentence.matchAll(/(?:^|[，,。；;：:\n]\s*)(?:实际是|实际为|应为|应该是|正确(?:的)?(?:值)?是|准确(?:地)?(?:说|讲|值)?是|改为|改成|(?<![不非])是)\s*([^，,。；;]{1,40})/giu)) {
      for (const number of extractNumbers(match[1])) newValues.push(number.raw)
      const clause = cleanValueClause(match[1])
      if (clause.length >= 2) newValues.push(clause)
    }
    corrections.push({
      sentence,
      marker,
      numbers,
      oldValues: [...new Set(oldValues.filter((value) => value.length > 0))],
      newValues: [...new Set(newValues.filter((value) => value.length > 0))],
    })
  }
  return corrections
}

/**
 * Normalize the value clause captured next to a correction marker.
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanValueClause(raw) {
  let clause = String(raw ?? '').trim()
  clause = clause.replace(/^的/u, '').replace(/^["'“”‘’]+/u, '').replace(/["'“”‘’]+$/u, '').trim()
  // Drop trailing connectives that belong to the next clause, not the value.
  clause = clause.replace(/(?:为准|即可|就好|才对|才行)$/u, '').trim()
  if (clause.length < 2 || clause.length > 40) return ''
  // A clause made only of punctuation/stop words is not a value.
  if (!/[A-Za-z\u4e00-\u9fff0-9]/u.test(clause)) return ''
  if (/^(?:这样|那样|这个|那个|它|其)$/u.test(clause)) return ''
  return clause
}

/**
 * Extract task-state patches from labelled lines in a user message.
 *
 * @param {string} text
 * @returns {{ goal?: string, progress?: string[], blockers?: string[], openItems?: string[] }}
 */
export function extractTaskPatch(text) {
  /** @type {{ goal?: string, progress?: string[], blockers?: string[], openItems?: string[] }} */
  const patch = {}
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    for (const label of TASK_LABELS) {
      const match = label.pattern.exec(line)
      if (match === null) continue
      const value = oneLine(match[1], 300)
      if (value.length === 0) break
      if (label.field === 'goal') patch.goal = value
      else {
        const field = /** @type {'progress'|'blockers'|'openItems'} */ (label.field)
        patch[field] = [...(patch[field] ?? []), value]
      }
      break
    }
  }
  return patch
}

/**
 * Memory items derived from a user message (explicit user evidence).
 *
 * @param {string} text
 * @param {{ seq?: number | null }} [context]
 * @returns {{ kind: string, content: string, conditions: string[], evidenceType: string, extractor: string, derivedFromSeq: number | null, numbers: object[], corrections: { oldValues: string[] }[] }[]}
 */
export function extractUserMemories(text, context = {}) {
  /** @type {object[]} */
  const items = []
  const corrections = detectCorrections(text)
  const correctionSentences = new Set(corrections.map((correction) => correction.sentence))

  for (const correction of corrections) {
    if (items.length >= MAX_ITEMS_PER_EVENT) break
    items.push({
      kind: classifySentence(correction.sentence),
      content: correction.sentence,
      conditions: qualificationClauses(correction.sentence),
      evidenceType: 'user_explicit',
      extractor: 'correction',
      derivedFromSeq: context.seq ?? null,
      numbers: substantiveNumbers(correction.sentence),
      corrections: [{ sentence: correction.sentence, oldValues: correction.oldValues, newValues: correction.newValues }],
    })
  }

  for (const sentence of splitSentences(text)) {
    if (items.length >= MAX_ITEMS_PER_EVENT) break
    if (correctionSentences.has(sentence)) continue
    const numbers = substantiveNumbers(sentence)
    const hasNumber = numbers.length > 0
    const kind = classifySentence(sentence)
    const markerHit = findMarker(sentence, DECISION_MARKERS) ?? findMarker(sentence, CONSTRAINT_MARKERS) ?? findMarker(sentence, PREFERENCE_MARKERS)
    // Only keep declarative statements: numbers carry verifiable claims, and
    // marker sentences capture decisions/constraints/preferences.
    if (!hasNumber && markerHit === null) continue
    if (kind === 'open_question' && !hasNumber) continue
    items.push({
      kind,
      content: sentence,
      conditions: qualificationClauses(sentence),
      evidenceType: 'user_explicit',
      extractor: hasNumber ? (kind === 'fact' ? 'number' : kind) : kind,
      derivedFromSeq: context.seq ?? null,
      numbers,
      corrections: [],
    })
  }
  return items
}

/**
 * Assistant proposals are stored as proposals only. This function exists to
 * make the write rule explicit: return kind `proposal`, never `decision`.
 *
 * @param {string} text
 * @param {{ seq?: number | null }} [context]
 * @returns {{ kind: string, content: string, conditions: string[], evidenceType: string, extractor: string, derivedFromSeq: number | null, numbers: object[] }[]}
 */
export function extractAssistantProposals(text, context = {}) {
  /** @type {object[]} */
  const items = []
  const proposalMarkers = ['建议', '可以考虑', '可以尝试', '方案', '推荐', 'propose', 'recommend', 'suggest', 'option']
  for (const sentence of splitSentences(text)) {
    if (items.length >= 4) break
    const lower = sentence.toLowerCase()
    if (!proposalMarkers.some((marker) => lower.includes(marker))) continue
    items.push({
      kind: 'proposal',
      content: sentence,
      conditions: qualificationClauses(sentence),
      evidenceType: 'assistant_proposal',
      extractor: 'proposal',
      derivedFromSeq: context.seq ?? null,
      numbers: substantiveNumbers(sentence),
    })
  }
  return items
}

/**
 * Numbers that carry a verifiable claim, as opposed to identifiers that merely
 * contain digits (`v3`, `S2`). A memory item keeps a number when it carries a
 * unit (`81.20%`, `143 段`), is a decimal threshold (`0.8`), or is a bare integer
 * large enough to be a measurement (`12`). Identifiers glued to a Latin letter
 * are part of the claim's conditions, not standalone numeric evidence, so they
 * are dropped from `numbers` (the sentence itself is still stored in full).
 *
 * @param {string} text
 * @returns {{ raw: string, value: number, unit: string, index: number }[]}
 */
export function substantiveNumbers(text) {
  const input = String(text ?? '')
  /** @type {{ raw: string, value: number, unit: string, index: number }[]} */
  const out = []
  for (const number of extractNumbers(input)) {
    const raw = String(number.raw ?? '')
    if (raw.length === 0) continue
    const hasUnit = typeof number.unit === 'string' && number.unit.length > 0
    if (hasUnit) {
      out.push(number)
      continue
    }
    const before = number.index > 0 ? input[number.index - 1] : ''
    const afterIndex = number.index + raw.length
    const after = afterIndex < input.length ? input[afterIndex] : ''
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) continue
    const hasDecimal = /\d[.,]\d/u.test(raw)
    if (hasDecimal) {
      out.push(number)
      continue
    }
    if (Math.abs(number.value) >= 10) out.push(number)
  }
  return out
}

/** CJK runs of at least two characters (bigram source). */
const CJK_TERM_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/gu
/** Latin words long enough to name a metric ("wer", "ece", "latency", "bootstrap"). */
const LATIN_TERM_RE = /[a-z][a-z0-9_-]{2,}/gi
/** Latin words too common to prove two claims are about the same measurement. */
const GENERIC_LATIN_TERMS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'are', 'was', 'were',
  'has', 'have', 'its', 'their', 'run', 'runs', 'value', 'values', 'only', 'than',
])

/**
 * Distinctive terms of a sentence: Latin words plus CJK bigrams. Used to tell
 * two facts that share the same number apart ("p 值是 0.040" vs "ECE 是 0.040")
 * when a correction names that shared number as its old value.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function correctionTerms(text) {
  const value = String(text ?? '')
  /** @type {Set<string>} */
  const terms = new Set()
  for (const match of value.matchAll(LATIN_TERM_RE)) {
    const word = match[0].toLowerCase()
    if (!GENERIC_LATIN_TERMS.has(word)) terms.add(word)
  }
  for (const match of value.matchAll(CJK_TERM_RUN_RE)) {
    const run = match[0]
    for (let index = 0; index + 2 <= run.length; index += 1) {
      terms.add(run.slice(index, index + 2))
    }
  }
  return terms
}

/**
 * When the correction names an old value shared by several active facts, keep
 * only the facts whose wording overlaps the correction sentence. Refusing to
 * pick (returning `[]`) is deliberate: superseding the wrong fact corrupts the
 * derived index, while leaving the old value active is visible and fixable.
 *
 * @param {{ id: string, content: string }[]} items
 * @param {{ sentence?: string }[]} corrections
 * @returns {{ id: string, content: string }[]}
 */
export function disambiguateCorrectionTargets(items, corrections) {
  if (items.length <= 1) return items
  /** @type {Set<string>} */
  const terms = new Set()
  for (const correction of corrections) {
    for (const term of correctionTerms(correction.sentence ?? '')) terms.add(term)
  }
  if (terms.size === 0) return []
  const scored = items.map((item) => {
    const own = correctionTerms(item.content)
    let score = 0
    for (const term of terms) if (own.has(term)) score += 1
    return { item, score }
  })
  const max = Math.max(...scored.map((entry) => entry.score))
  if (max < 1) return []
  return scored.filter((entry) => entry.score === max).map((entry) => entry.item)
}

/**
 * Does `candidate` look like the previous version of the claim corrected by
 * `correction`? We only supersede when the correction sentence names one of the
 * candidate's numbers/values; source and scope are compared by the caller.
 *
 * Textual identifiers matter as much as numbers here: "不是 mimir-13b-v1.2，是
 * mimir-13b-v2.0" must supersede the old model-version item even though no digit
 * is stored as a substantive number.
 *
 * @param {{ numbers: { raw: string }[], content: string }} candidate
 * @param {{ sentence?: string, oldValues?: string[], newValues?: string[] }} correction
 * @returns {boolean}
 */
export function correctionTargetsCandidate(candidate, correction) {
  const content = String(candidate.content ?? '')
  const contentLower = content.toLowerCase()
  const numbers = Array.isArray(candidate.numbers) ? candidate.numbers : extractNumbers(content)
  // `corrections` entries attached to an extracted item only carry the old
  // values (the sentence is the item content itself); accept both shapes.
  const oldValues = Array.isArray(correction.oldValues) ? correction.oldValues : []
  const newValues = Array.isArray(correction.newValues) ? correction.newValues : []
  // A candidate that already carries the corrected value is not the stale item.
  // Values that also appear on the old side ("不是 X，是 X" style fragments) do
  // not count: "-13"/"1.2" are pieces of "mimir-13b-v1.2", not new values.
  const oldLower = oldValues.map((value) => String(value).toLowerCase())
  const freshNewValues = newValues.filter((value) => {
    const needle = String(value).toLowerCase()
    if (needle.length < 2) return false
    if (oldLower.some((old) => old.length > 0 && (old.includes(needle) || needle.includes(old)))) return false
    return true
  })
  if (freshNewValues.some((value) => contentLower.includes(String(value).toLowerCase()))) return false
  // Only the values the correction names as old are allowed to target a
  // candidate. Matching any number that merely appears in the sentence (for
  // example the "5 次运行" or "95% CI" it shares with unrelated facts) made a
  // p-value correction supersede the latency and BLEU records.
  const oldValueSet = new Set(oldValues.map((value) => String(value).trim()))
  if (numbers.some((number) => oldValueSet.has(String(number.raw ?? '').trim()))) return true
  return oldValues.some((value) => {
    const needle = String(value).trim().toLowerCase()
    if (needle.length < 2) return false
    // Short numeric fragments are not distinctive enough to target a fact; a
    // multi-digit value such as "79.85" or "0.041" is.
    if (/^[\d.\s%‰-]+$/u.test(needle) && needle.length < 4) return false
    return contentLower.includes(needle)
  })
}

/**
 * Orchestrates extraction over captured events. It runs incrementally using the
 * `checkpoints.last_extract_seq` cursor and is safe to retry: a failed event is
 * recorded in `pending_extraction`, the raw evidence is kept, and the next run
 * retries it instead of losing it.
 */
export class SessionExtractor {
  /**
   * @param {import('./store.js').MemoryStore} store
   * @param {{ config?: object, logger?: { warn: Function, debug: Function } }} [options]
   */
  constructor(store, options = {}) {
    this.store = store
    this.config = options.config ?? {}
    this.logger = options.logger ?? null
  }

  /**
   * Extract from every captured event after the cursor.
   *
   * @param {string} sessionId
   * @param {{ limit?: number, force?: boolean }} [options]
   * @returns {{ processed: number, created: number, superseded: number, errors: { seq: number, message: string }[], lastSeq: number }}
   */
  extractPending(sessionId, options = {}) {
    const enabled = this.config.extraction?.enabled !== false
    const checkpoint = this.store.getCheckpoint(sessionId)
    const limit = Number.isInteger(options.limit) ? options.limit : 500
    const events = this.store.listEventsAfter(sessionId, checkpoint.lastExtractSeq, { limit })
    /** @type {{ seq: number, message: string }[]} */
    const errors = []
    let created = 0
    let superseded = 0
    let processed = 0
    let lastSeq = checkpoint.lastExtractSeq
    if (enabled && (events.length > 0 || options.force === true)) {
      this.store.transaction(() => {
        for (const event of events) {
          try {
            const result = this.extractEvent(sessionId, event)
            created += result.created
            superseded += result.superseded
            this.store.clearPendingExtraction(sessionId, Number(event.seq))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.store.markPendingExtraction(sessionId, Number(event.seq), message)
            errors.push({ seq: Number(event.seq), message })
            this.logger?.warn?.(`long-memory: extraction failed at seq ${event.seq}: ${message}`)
          }
          processed += 1
          lastSeq = Math.max(lastSeq, Number(event.seq))
        }
      })
      this.store.setCheckpoint(sessionId, { lastExtractSeq: lastSeq })
    }
    return { processed, created, superseded, errors, lastSeq }
  }

  /**
   * Extract from one event row.
   *
   * @param {string} sessionId
   * @param {Record<string, unknown>} event
   * @returns {{ created: number, superseded: number }}
   */
  extractEvent(sessionId, event) {
    const type = String(event.type)
    const text = typeof event.text === 'string' ? event.text : ''
    if (text.trim().length === 0) return { created: 0, superseded: 0 }
    const sourceKind = event.source_kind === null || event.source_kind === undefined ? null : String(event.source_kind)
    const seq = Number(event.seq)
    if (type === 'user/message') {
      if (sourceKind !== null && !['user', 'input', 'prompt', 'steer'].includes(sourceKind)) {
        return { created: 0, superseded: 0 }
      }
      return this.extractUserEvent(sessionId, text, seq)
    }
    if (type === 'assistant/message') {
      if (this.config.extraction?.recordAssistantProposals === false) return { created: 0, superseded: 0 }
      let created = 0
      for (const item of extractAssistantProposals(text, { seq })) {
        const result = this.store.insertMemoryItem(sessionId, item)
        if (result.created) created += 1
      }
      return { created, superseded: 0 }
    }
    return { created: 0, superseded: 0 }
  }

  /**
   * @param {string} sessionId
   * @param {string} text
   * @param {number} seq
   * @returns {{ created: number, superseded: number }}
   */
  extractUserEvent(sessionId, text, seq) {
    let created = 0
    let superseded = 0
    const candidates = extractUserMemories(text, { seq })
    for (const candidate of candidates) {
      /** @type {string[]} */
      const supersedes = []
      if (candidate.extractor === 'correction') {
        const hits = this.store.searchMemory({ sessionId, query: candidate.content, limit: 20, statuses: ['active'] })
        /** @type {{ id: string, content: string }[]} */
        const matched = []
        for (const hit of hits) {
          if (hit.item.evidenceType !== 'user_explicit') continue
          if (hit.item.extractor === 'proposal') continue
          for (const correction of candidate.corrections ?? []) {
            // Number and textual value matching both live in
            // `correctionTargetsCandidate`; it also refuses to supersede an
            // item that already carries the corrected value.
            if (!correctionTargetsCandidate({ numbers: hit.item.numbers, content: hit.item.content }, correction)) continue
            matched.push({ id: hit.item.id, content: hit.item.content })
            break
          }
        }
        // A number can be shared across metrics (p value 0.040 vs ECE 0.040).
        // When several active facts match, wording overlap decides; no overlap
        // means we refuse to guess.
        for (const item of disambiguateCorrectionTargets(matched, candidate.corrections ?? [])) {
          supersedes.push(item.id)
        }
      }
      const result = this.store.insertMemoryItem(sessionId, {
        ...candidate,
        sourceRefs: [`seq:${seq}`],
        supersedes: [...new Set(supersedes)],
      })
      if (result.created) created += 1
      if (supersedes.length > 0) superseded += supersedes.length
    }
    this.updateTaskStateFromUserText(sessionId, text, seq)
    return { created, superseded }
  }

  /**
   * Merge deterministic task-state hints from a user message into `task_state`.
   *
   * @param {string} sessionId
   * @param {string} text
   * @param {number} seq
   * @returns {void}
   */
  updateTaskStateFromUserText(sessionId, text, seq) {
    const current = this.store.getTaskState(sessionId)
    const patch = extractTaskPatch(text)
    const clears = detectTaskClears(text)
    const superseded = [...current.superseded]
    const next = {
      goal: patch.goal ?? current.goal,
      progress: [...current.progress],
      blockers: [...current.blockers],
      openItems: [...current.openItems],
      superseded,
    }
    if (patch.goal === undefined && current.goal === null) {
      const firstLine = splitSentences(text).find((sentence) => sentence.trim().length >= 4)
      if (firstLine !== undefined) next.goal = oneLine(firstLine, 240)
    }
    for (const entry of patch.progress ?? []) if (!next.progress.includes(entry)) next.progress.push(entry)
    for (const entry of patch.blockers ?? []) if (!next.blockers.includes(entry)) next.blockers.push(entry)
    for (const entry of patch.openItems ?? []) if (!next.openItems.includes(entry)) next.openItems.push(entry)

    // Apply explicit clears: remove the matching stale entry from the active
    // lists and keep an audit trail in `superseded`. Completion statements also
    // add a progress line so the assembled task state shows what got finished.
    for (const clear of clears) {
      const removeFrom = clear.op === 'unblock' ? ['blockers'] : clear.op === 'complete' ? ['blockers', 'openItems'] : ['openItems']
      let removedAny = false
      for (const field of removeFrom) {
        const kept = []
        for (const entry of next[field]) {
          if (taskEntryMatches(entry, clear.subject, clear.sentence)) {
            superseded.push(`${field}: ${entry} (${clear.op} @seq:${seq})`)
            removedAny = true
          } else kept.push(entry)
        }
        next[field] = kept
      }
      if (clear.op === 'complete' && clear.subject.length >= 2) {
        const progressEntry = clear.subject
        // A labelled line ("进度：已完成初稿。") already records the progress;
        // do not duplicate it as a bare subject entry.
        const alreadyRecorded = next.progress.some(
          (entry) => entry.includes(progressEntry) || progressEntry.includes(entry),
        )
        if (!alreadyRecorded) next.progress.push(progressEntry)
      } else if (!removedAny && clear.op === 'complete' && clear.subject.length === 0) {
        // "已完成" with no subject and no matching entry: keep it as progress
        // evidence rather than inventing an item.
        const progressEntry = oneLine(clear.sentence, 200)
        if (!next.progress.includes(progressEntry)) next.progress.push(progressEntry)
      }
    }
    const changed = next.goal !== current.goal ||
      next.progress.length !== current.progress.length ||
      next.blockers.length !== current.blockers.length ||
      next.openItems.length !== current.openItems.length ||
      next.superseded.length !== current.superseded.length
    if (!changed) return
    this.store.setTaskState(sessionId, next, { updatedBySeq: seq })
  }
}

/**
 * @returns {{ at: string }} a fresh timestamp for tests that inject clocks
 */
export function extractionTimestamp() {
  return { at: nowIso() }
}
