/**
 * Deterministic evaluation metrics for the synthetic memory benchmark.
 *
 * The harness never merges the measurements into a single opaque score: every
 * metric in this module is scored independently and the report keeps storage
 * correctness, retrieval recall, assembly coverage, extra injected tokens
 * (estimate) and latency apart. Answer accuracy against a real language model is
 * deliberately out of scope here; see `answerer.mjs` for the optional seam.
 *
 * The module is intentionally free of `src/` imports so baselines and replay
 * tests can be scored without loading the plugin, and so the expected values can
 * only come from the fixture answer key.
 *
 * @module tests/fixtures/synthetic/metrics
 */

/** Mirrors the plugin's documented token estimator (4 chars/token, 1.6 CJK). */
export const TOKEN_PROFILE = Object.freeze({ charsPerToken: 4, cjkCharsPerToken: 1.6 })

/**
 * Deterministic token estimate, labelled as such in reports.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  if (value.length === 0) return 0
  let cjk = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1
    else if (code >= 0xff00 && code <= 0xffef) cjk += 1
  }
  const other = value.length - cjk
  return Math.max(1, Math.ceil(cjk / TOKEN_PROFILE.cjkCharsPerToken + other / TOKEN_PROFILE.charsPerToken))
}

/**
 * Normalize text for containment checks (unicode NFC, collapsed whitespace,
 * ASCII-lowercased). Chinese characters are preserved exactly, so a unit such
 * as 分 is never confused with %.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[A-Z]/gu, (char) => char.toLowerCase())
}

/**
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
export function textIncludes(haystack, needle) {
  const hay = normalizeForMatch(haystack)
  const pin = normalizeForMatch(needle)
  if (pin.length === 0) return true
  return hay.includes(pin)
}

/**
 * @param {string[]} values
 * @returns {(number | null)}
 */
export function ratio(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  return values.filter(Boolean).length / values.length
}

/**
 * @param {Array<{ text: string }>} items
 * @param {string} needle
 * @returns {boolean}
 */
function anyItemTextIncludes(items, needle) {
  return items.some((entry) => textIncludes(entry.text, needle))
}

/**
 * Extract the numeric ids from memory source refs (`seq:12`) and event refs.
 *
 * @param {string[] | undefined} refs
 * @returns {number[]}
 */
export function seqsFromRefs(refs) {
  /** @type {number[]} */
  const out = []
  for (const ref of refs ?? []) {
    const match = /seq:(\d+)/u.exec(String(ref))
    if (match !== null) out.push(Number(match[1]))
  }
  return out
}

/**
 * @param {Array<{ item: object }>} items
 * @returns {string}
 */
function itemsToText(items) {
  return items
    .map((entry) => {
      const item = entry.item ?? entry
      return [item.content ?? '', ...(item.conditions ?? []), ...(item.scope ?? [])].join('\n')
    })
    .join('\n')
}

/**
 * Values the answer key expects to be visible for a question. Derived only from
 * the answer key (the explicit `values` list plus the `factKeys` facts), never
 * from the generated conversation.
 *
 * @param {object} question
 * @param {Map<string, object>} factsByKey
 * @returns {string[]}
 */
export function expectedValues(question, factsByKey) {
  /** @type {string[]} */
  const values = [...(question?.expect?.values ?? [])]
  for (const key of question?.expect?.factKeys ?? []) {
    const fact = factsByKey.get(key)
    if (fact !== undefined && typeof fact.value === 'string' && fact.value.length > 0 && !values.includes(fact.value)) {
      values.push(fact.value)
    }
  }
  return values
}

/**
 * @param {object} question
 * @param {Map<string, object>} factsByKey
 * @returns {string}
 */
export function expectedUnit(question, factsByKey) {
  if (typeof question?.expect?.unit === 'string' && question.expect.unit.length > 0) return question.expect.unit
  for (const key of question?.expect?.factKeys ?? []) {
    const fact = factsByKey.get(key)
    if (fact !== undefined && typeof fact.unit === 'string' && fact.unit.length > 0) return fact.unit
  }
  return ''
}

/**
 * Score one injected context (plugin assembly OR a baseline window) against the
 * answer-key expectations. All checks are recorded individually so the report
 * can show assembly coverage without collapsing it into accuracy.
 *
 * @param {{
 *   question: object,
 *   factsByKey: Map<string, object>,
 *   context: string,
 *   evidenceSeqs?: number[] | null,
 * }} input
 * @returns {object}
 */
export function evaluateQuestion({ question, factsByKey, context, evidenceSeqs = null }) {
  const text = String(context ?? '')
  const values = expectedValues(question, factsByKey)
  const unit = expectedUnit(question, factsByKey)
  const expect = question?.expect ?? {}
  const valueChecks = values.map((value) => textIncludes(text, value))
  const unitCheck = unit.length > 0 ? textIncludes(text, unit) : null
  const conditionChecks = (expect.conditions ?? []).map((condition) => textIncludes(text, condition))
  const modelVersionCheck = typeof expect.modelVersion === 'string' && expect.modelVersion.length > 0
    ? textIncludes(text, expect.modelVersion)
    : null
  const ruleChecks = (expect.ruleMatches ?? []).map((fragment) => textIncludes(text, fragment))
  const seqSet = new Set(Array.isArray(evidenceSeqs) ? evidenceSeqs.map((seq) => Number(seq)) : [])
  // Evidence-in-context is optional for questions whose real target is retrieval
  // grounding: the assembler caps the verbatim evidence section (default 8) and
  // sorts it by seq, so a late correction seq may legitimately not be quoted even
  // when it is stored and retrieved. Such questions still check value/unit/rules
  // in the assembled context; evidence survival is covered by a hard invariant.
  const evidenceChecks = expect.assemblyOptional === true
    ? []
    : (expect.evidenceSeqs ?? []).map((seq) => seqSet.has(Number(seq)))

  const forbiddenHits = (expect.forbiddenValues ?? []).filter((value) => textIncludes(text, value))
  const mustNotHits = (expect.mustNotContain ?? []).filter((value) => textIncludes(text, value))

  const applicable = [
    ...valueChecks,
    unitCheck,
    ...conditionChecks,
    modelVersionCheck,
    ...ruleChecks,
    ...evidenceChecks,
  ].filter((entry) => entry !== null)

  const passed = applicable.filter(Boolean).length
  const guardApplicable = (expect.forbiddenValues ?? []).length > 0 ||
    (expect.mustNotContain ?? []).length > 0 ||
    question?.kind === 'pollution' ||
    expect.guard === true

  return {
    questionId: question?.id ?? 'unknown',
    kind: question?.kind ?? 'unknown',
    lang: question?.lang ?? '',
    values,
    unit,
    checks: {
      valueChecks,
      unitCheck,
      conditionChecks,
      modelVersionCheck,
      ruleChecks,
      evidenceChecks,
      forbiddenHits,
      mustNotHits,
      guardApplicable,
      guardOk: forbiddenHits.length === 0 && mustNotHits.length === 0,
      applicableChecks: applicable.length,
      passedChecks: passed,
      covered: applicable.length === 0 ? guardApplicable && forbiddenHits.length === 0 && mustNotHits.length === 0 : passed === applicable.length,
    },
    contextTokens: estimateTokens(text),
  }
}

/**
 * Score retrieval for one question from the candidate list the retriever returned.
 *
 * - `factRecall`: every expected value appears in at least one candidate item.
 * - `factRank1`: the top candidate carries every expected value.
 * - `evidenceRecall`: the expected correction/source seq appears in the returned
 *   evidence entries or in a candidate item's sourceRefs.
 *
 * @param {{
 *   question: object,
 *   factsByKey: Map<string, object>,
 *   items: Array<{ item: object }>,
 *   evidence?: Array<{ seq: number }>,
 * }} input
 * @returns {object}
 */
export function evaluateRetrieval({ question, factsByKey, items, evidence = [] }) {
  const expect = question?.expect ?? {}
  const values = expectedValues(question, factsByKey)
  const candidates = Array.isArray(items) ? items : []
  const candidateText = itemsToText(candidates)
  const topText = candidates.length > 0 ? itemsToText([candidates[0]]) : ''
  const factApplicable = values.length > 0 && expect.retrieval === 'fact'
  const valueHits = values.map((value) => textIncludes(candidateText, value))
  const topHits = values.map((value) => textIncludes(topText, value))
  const evidenceSeqs = Array.isArray(evidence) ? evidence.map((entry) => Number(entry.seq)) : []
  const sourceRefSeqs = candidates.flatMap((entry) => seqsFromRefs(entry.item?.sourceRefs))
  const returnedSeqs = new Set([...evidenceSeqs, ...sourceRefSeqs])
  const evidenceChecks = (expect.evidenceSeqs ?? []).map((seq) => returnedSeqs.has(Number(seq)))
  return {
    questionId: question?.id ?? 'unknown',
    kind: question?.kind ?? 'unknown',
    factApplicable,
    factRecall: factApplicable ? valueHits.every(Boolean) : null,
    factRank1: factApplicable ? topHits.every(Boolean) : null,
    evidenceApplicable: evidenceChecks.length > 0,
    evidenceRecall: evidenceChecks.length > 0 ? evidenceChecks.every(Boolean) : null,
    candidates: candidates.length,
    evidenceReturned: evidenceSeqs.length,
  }
}

/**
 * Storage correctness: did the plugin persist the answer-key facts with the
 * right value, unit, statistical conditions, source reference, supersession
 * link and rule index? Receives already-fetched store rows so it stays pure.
 *
 * @param {{
 *   answerKey: object,
 *   items: object[],
 *   rules: object[],
 *   taskState: object | null,
 * }} input
 * @returns {object}
 */
export function scoreStorage({ answerKey, items, rules, taskState }) {
  const allItems = Array.isArray(items) ? items : []
  const active = allItems.filter((item) => item.status === 'active')
  const rows = Array.isArray(rules) ? rules : []
  /** @type {object[]} */
  const factDetails = []

  for (const fact of answerKey?.facts ?? []) {
    const hasInitialValue = fact.initialValue !== null && fact.initialValue !== undefined && String(fact.initialValue).length > 0
    const expectedSourceSeq = Number(fact.correctionSeq ?? fact.sourceSeq)
    const valueCandidates = active.filter((item) => textIncludes(item.content, fact.value))
    // Prefer the item whose own source reference points at the expected evidence
    // seq (semantic distractors may carry the same number in another item).
    const valueItem = valueCandidates.find((item) => seqsFromRefs(item.sourceRefs).includes(expectedSourceSeq)) ?? valueCandidates[0]
    const oldItems = hasInitialValue
      ? allItems.filter((item) => textIncludes(item.content, fact.initialValue))
      : []
    const oldSuperseded = oldItems.some((item) => item.status === 'superseded' && (item.supersededBy ?? null) !== null)
    const oldStillActive = hasInitialValue
      ? active.some(
        (item) => textIncludes(item.content, fact.initialValue) && seqsFromRefs(item.sourceRefs).includes(Number(fact.sourceSeq)),
      )
      : false
    const conditionText = valueItem === undefined
      ? ''
      : [...(valueItem.conditions ?? []), valueItem.content ?? ''].join('\n')
    const conditionChecks = (fact.conditionHints ?? fact.conditions ?? []).map((condition) => textIncludes(conditionText, condition))
    const sourceSeqs = valueItem === undefined ? [] : seqsFromRefs(valueItem.sourceRefs)
    factDetails.push({
      key: fact.key,
      valueStored: valueItem !== undefined,
      valueItemId: valueItem?.id ?? null,
      unitStored: valueItem !== undefined && (fact.unit.length === 0 || textIncludes(valueItem.content, fact.unit)),
      conditionsStored: valueItem !== undefined && conditionChecks.every(Boolean),
      conditionChecks,
      sourceRecorded: valueItem !== undefined && sourceSeqs.includes(expectedSourceSeq),
      sourceSeqs,
      corrected: hasInitialValue,
      supersession: hasInitialValue ? oldSuperseded && !oldStillActive : true,
      supersededActiveLeak: oldStillActive,
    })
  }

  const ruleMatched = (fact) => rows.filter((rule) => textIncludes(rule.text, fact.match))
  const ruleDetails = (answerKey?.skill?.rules ?? []).map((rule) => {
    const matches = ruleMatched(rule)
    return {
      key: rule.key,
      expectedCategory: rule.category,
      expectedSourceLine: rule.sourceLine,
      indexed: matches.length > 0,
      active: matches.length > 0 && matches.every((match) => match.active === true),
      sourceLineMatches: matches.length > 0 && matches.some((match) => Number(match.sourceLine) === Number(rule.sourceLine)),
      categoryMatches: matches.length > 0 && matches.some((match) => match.category === rule.category),
      observedCategories: matches.map((match) => match.category),
      observedSourceLines: matches.map((match) => match.sourceLine),
    }
  })

  const expected = answerKey?.expectedTaskState ?? {}
  const goalText = String(taskState?.goal ?? '')
  const progressText = (taskState?.progress ?? []).join('\n')
  const blockerText = (taskState?.blockers ?? []).join('\n')
  const openText = (taskState?.openItems ?? []).join('\n')
  const taskChecks = {
    goal: expected.goal === undefined ? null : textIncludes(goalText, expected.goal),
    progress: expected.progress === undefined ? null : expected.progress.every((entry) => textIncludes(progressText, entry)),
    blockersCleared: expected.blockers === undefined ? null : (expected.blockers.length === 0 ? blockerText.trim().length === 0 : expected.blockers.every((entry) => textIncludes(blockerText, entry))),
    openItems: expected.openItems === undefined ? null : expected.openItems.every((entry) => textIncludes(openText, entry)),
  }

  const factChecks = factDetails.flatMap((detail) => [
    detail.valueStored,
    detail.unitStored,
    detail.conditionsStored,
    detail.sourceRecorded,
    detail.supersession,
  ])
  const ruleChecks = ruleDetails.flatMap((detail) => [detail.indexed, detail.active, detail.sourceLineMatches, detail.categoryMatches])
  const taskCheckValues = Object.values(taskChecks).filter((value) => value !== null)
  const allChecks = [...factChecks, ...ruleChecks, ...taskCheckValues]
  const passed = allChecks.filter(Boolean).length

  return {
    score: allChecks.length === 0 ? null : passed / allChecks.length,
    passed,
    total: allChecks.length,
    facts: {
      fired: factDetails.filter((detail) => detail.valueStored).length,
      total: factDetails.length,
      details: factDetails,
    },
    rules: {
      indexed: ruleDetails.filter((detail) => detail.indexed).length,
      active: ruleDetails.filter((detail) => detail.active).length,
      sourceLines: ruleDetails.filter((detail) => detail.sourceLineMatches).length,
      categories: ruleDetails.filter((detail) => detail.categoryMatches).length,
      total: ruleDetails.length,
      details: ruleDetails,
    },
    taskState: taskChecks,
  }
}

/**
 * Latency summary (milliseconds, wall clock of the harness process).
 *
 * @param {number[]} samples
 * @returns {{ count: number, totalMs: number, meanMs: number | null, p50Ms: number | null, p95Ms: number | null, maxMs: number | null }}
 */
export function latencySummary(samples) {
  const values = (Array.isArray(samples) ? samples : []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (values.length === 0) return { count: 0, totalMs: 0, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null }
  const totalMs = values.reduce((sum, value) => sum + value, 0)
  const pick = (fraction) => {
    const index = Math.min(values.length - 1, Math.max(0, Math.ceil(fraction * values.length) - 1))
    return values[index]
  }
  return {
    count: values.length,
    totalMs: roundMs(totalMs),
    meanMs: roundMs(totalMs / values.length),
    p50Ms: roundMs(pick(0.5)),
    p95Ms: roundMs(pick(0.95)),
    maxMs: roundMs(values[values.length - 1]),
  }
}

/**
 * @param {number} value
 * @returns {number}
 */
export function roundMs(value) {
  return Math.round(Number(value) * 1000) / 1000
}

/**
 * Aggregate per-question evaluation records into the report metric block.
 * Every metric stays separate; `null` means "not applicable for this baseline".
 *
 * @param {Array<object>} records
 * @param {Array<{ questionId: string, evaluation: object, retrieval?: object, latencyMs: number, tokens: number, guardOnly?: boolean }>} entries
 * @returns {object}
 */
export function aggregateQuestionMetrics(entries) {
  const list = Array.isArray(entries) ? entries : []
  const withChecks = list.filter((entry) => entry.evaluation?.checks?.applicableChecks > 0)
  const applicableChecks = withChecks.reduce((sum, entry) => sum + entry.evaluation.checks.applicableChecks, 0)
  const passedChecks = withChecks.reduce((sum, entry) => sum + entry.evaluation.checks.passedChecks, 0)
  const guardEntries = list.filter((entry) => entry.evaluation?.checks?.guardApplicable === true)
  const guardPassed = guardEntries.filter((entry) => entry.evaluation.checks.guardOk).length
  const retrievalEntries = list.filter((entry) => entry.retrieval !== undefined && entry.retrieval !== null && entry.retrieval.factApplicable === true)
  const factRecallHits = retrievalEntries.filter((entry) => entry.retrieval.factRecall === true).length
  const rank1Hits = retrievalEntries.filter((entry) => entry.retrieval.factRank1 === true).length
  const evidenceEntries = list.filter((entry) => entry.retrieval?.evidenceApplicable === true)
  const evidenceHits = evidenceEntries.filter((entry) => entry.retrieval.evidenceRecall === true).length
  const ruleEntries = list.filter((entry) => (entry.evaluation?.checks?.ruleChecks ?? []).length > 0)
  const ruleChecks = ruleEntries.map((entry) => (entry.evaluation.checks.ruleChecks ?? []).every(Boolean))
  const tokens = list.map((entry) => entry.tokens).filter((value) => Number.isFinite(value))
  const latencies = list.map((entry) => entry.latencyMs).filter((value) => Number.isFinite(value))
  const latency = latencySummary(latencies)
  const tokenMean = tokens.length === 0 ? null : roundMs(tokens.reduce((sum, value) => sum + value, 0) / tokens.length)
  const retrievalTotal = retrievalEntries.length + evidenceEntries.length
  const retrievalHits = factRecallHits + evidenceHits
  return {
    questions: list.length,
    assemblyCoverage: {
      score: applicableChecks === 0 ? null : passedChecks / applicableChecks,
      passedChecks,
      applicableChecks,
      questionsWithChecks: withChecks.length,
    },
    retrievalRecall: {
      score: retrievalTotal === 0 ? null : retrievalHits / retrievalTotal,
      hits: retrievalHits,
      samples: retrievalTotal,
      factRecall: retrievalEntries.length === 0 ? null : factRecallHits / retrievalEntries.length,
      factSamples: retrievalEntries.length,
      evidenceRecall: evidenceEntries.length === 0 ? null : evidenceHits / evidenceEntries.length,
      evidenceSamples: evidenceEntries.length,
    },
    retrievalRank1: {
      score: retrievalEntries.length === 0 ? null : rank1Hits / retrievalEntries.length,
      hits: rank1Hits,
      samples: retrievalEntries.length,
    },
    ruleCoverage: {
      score: ruleChecks.length === 0 ? null : ruleChecks.filter(Boolean).length / ruleChecks.length,
      hits: ruleChecks.filter(Boolean).length,
      samples: ruleChecks.length,
    },
    guardPassRate: {
      score: guardEntries.length === 0 ? null : guardPassed / guardEntries.length,
      passed: guardPassed,
      samples: guardEntries.length,
    },
    extraTokensEstimate: {
      mean: tokenMean,
      total: tokens.reduce((sum, value) => sum + value, 0),
      max: tokens.length === 0 ? null : Math.max(...tokens),
      samples: tokens.length,
      method: 'estimate',
      profile: { ...TOKEN_PROFILE },
      note: 'estimated from characters (CJK 1.6 chars/token, other 4 chars/token); not a model tokenizer count',
    },
    latencyMs: {
      ...latency,
      note: 'wall-clock milliseconds measured by the harness process',
    },
  }
}
