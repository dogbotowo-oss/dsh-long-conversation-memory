/**
 * Report assembly and human-readable rendering.
 *
 * The evaluation deliberately reports its metrics SEPARATELY — there is no
 * single composite score, because storage correctness, retrieval recall,
 * assembly coverage, token overhead and latency measure different things.
 *
 * @module tests/fixtures/synthetic/report
 */

import { TOKEN_PROFILE, aggregateQuestionMetrics } from './metrics.mjs'

/** Stable report format id. */
export const REPORT_FORMAT = 'dsh-long-conversation-memory-eval-report'

/** Report schema version. */
export const REPORT_VERSION = 1

/**
 * Metrics in the order they must appear in the report. `null` means "not
 * measurable for this baseline" (e.g. storage correctness of a baseline that
 * does not persist memory). `llmAnswerAccuracy` stays null unless the optional
 * `--answerer=llm` seam is explicitly wired with credentials.
 */
export const METRIC_ORDER = Object.freeze([
  'storageCorrectness',
  'retrievalRecall',
  'retrievalRank1',
  'assemblyCoverage',
  'ruleCoverage',
  'taskStateAccuracy',
  'guardPassRate',
  'extraTokensEstimate',
  'latencyMs',
  'llmAnswerAccuracy',
])

export const METRIC_LABELS = Object.freeze({
  storageCorrectness: {
    label: 'Storage correctness',
    unit: 'ratio',
    kind: 'ratio',
    note: 'answer-key checks over persisted memory items (value/unit/conditions/source/supersession/rules)',
  },
  retrievalRecall: {
    label: 'Retrieval recall',
    unit: 'ratio',
    kind: 'ratio',
    note: 'fraction of answer-bearing questions whose expected memory fact or raw evidence seq was returned by retrieval',
  },
  retrievalRank1: {
    label: 'Retrieval rank-1',
    unit: 'ratio',
    kind: 'ratio',
    note: 'fraction of applicable questions where the expected fact item was the top retrieval candidate',
  },
  assemblyCoverage: {
    label: 'Assembly coverage',
    unit: 'ratio',
    kind: 'ratio',
    note: 'fraction of expected answer-key checks satisfied by the assembled context text',
  },
  ruleCoverage: {
    label: 'Rule coverage',
    unit: 'ratio',
    kind: 'ratio',
    note: 'fraction of synthetic skill rules present in the assembled context',
  },
  taskStateAccuracy: {
    label: 'Task state accuracy',
    unit: 'ratio',
    kind: 'ratio',
    note: 'fraction of expected task-state facets (goal/progress/blocker-cleared/open items) recovered from stored state',
  },
  guardPassRate: {
    label: 'Guard pass rate',
    unit: 'ratio',
    kind: 'ratio',
    note: 'fraction of guard questions without forbidden values / cross-session leaks',
  },
  extraTokensEstimate: {
    label: 'Extra tokens (estimate)',
    unit: 'tokens',
    kind: 'tokens',
    note: 'estimated tokens injected by the baseline (CJK/1.6 + other/4); an estimate, not a tokenizer count',
  },
  latencyMs: {
    label: 'Latency',
    unit: 'ms',
    kind: 'latency',
    note: 'wall-clock per-question context construction time',
  },
  llmAnswerAccuracy: {
    label: 'LLM answer accuracy',
    unit: 'ratio',
    kind: 'ratio',
    note: 'only populated by the optional --answerer=llm seam (requires an external API key); the default harness reports null and makes no accuracy claim',
  },
})

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * @template T
 * @param {T[]} values
 * @param {(value: T) => number} pick
 * @returns {number}
 */
function sumBy(values, pick) {
  return values.reduce((total, value) => total + pick(value), 0)
}

/**
 * Ratio metric projection from an aggregateQuestionMetrics result.
 *
 * @param {{ score?: number, hits?: number, samples?: number } | null | undefined} source
 * @returns {{ score: number | null, hits: number | null, samples: number | null }}
 */
function ratioFrom(source) {
  if (source === null || source === undefined) return { score: null, hits: null, samples: null }
  return {
    score: Number.isFinite(source.score) ? round(source.score) : null,
    hits: Number.isFinite(source.hits) ? source.hits : null,
    samples: Number.isFinite(source.samples) ? source.samples : null,
  }
}

/**
 * Build the final report object from normalized baseline results.
 *
 * @param {{
 *   profile: string,
 *   seed: string,
 *   answerer: object,
 *   environment: object,
 *   fixture: { rootDir: string, manifest: object, sessions: object[] },
 *   baselines: Array<{
 *     id: string,
 *     label: string,
 *     available: boolean,
 *     notes: string[],
 *     aggregate: object,
 *     invariants: object[],
 *     extra: object,
 *     sessionRuns: Array<{
 *       sessionId: string,
 *       scenario: string,
 *       turns: number,
 *       group: string | null,
 *       variant: string,
 *       aggregate: object,
 *       storage: object | null,
 *       checkpoint: object | null,
 *       questions: Array<{ questionId: string, kind: string, lang: string, evaluation: object, retrievalEvaluation: object | null, tokens: number, latencyMs: number }>,
 *     }>,
 *   }>,
 *   notes?: string[],
 * }} input
 * @returns {object}
 */
export function buildReport(input) {
  const {
    profile,
    seed,
    answerer,
    environment,
    fixture,
    baselines,
    notes = [],
  } = input

  const baselineIds = baselines.map((baseline) => baseline.id)
  const baselineById = new Map(baselines.map((baseline) => [baseline.id, baseline]))

  /**
   * @param {(baseline: object) => any} pick
   * @returns {Record<string, any>}
   */
  const byBaseline = (pick) => {
    /** @type {Record<string, any>} */
    const out = {}
    for (const baseline of baselines) out[baseline.id] = baseline.available ? pick(baseline) : null
    return out
  }

  const aggregateById = new Map(baselines.map((baseline) => [baseline.id, baseline.aggregate ?? null]))
  void aggregateById

  /** @returns {{passed: number, total: number, score: number | null}} */
  const storageTotals = (() => {
    const memory = baselineById.get('memory')
    const runs = memory?.sessionRuns ?? []
    let passed = 0
    let total = 0
    for (const run of runs) {
      passed += Number(run.storage?.passed ?? 0)
      total += Number(run.storage?.total ?? 0)
    }
    return { passed, total, score: total === 0 ? null : round(passed / total) }
  })()

  /** @returns {{passed: number, total: number, score: number | null}} */
  const taskStateTotals = (() => {
    const memory = baselineById.get('memory')
    const runs = memory?.sessionRuns ?? []
    let passed = 0
    let total = 0
    for (const run of runs) {
      const task = run.storage?.taskState ?? {}
      for (const value of Object.values(task)) {
        if (typeof value !== 'boolean') continue
        total += 1
        if (value) passed += 1
      }
    }
    return { passed, total, score: total === 0 ? null : round(passed / total) }
  })()

  const ratioMetric = (key) => ({
    label: METRIC_LABELS[key].label,
    kind: METRIC_LABELS[key].kind,
    note: METRIC_LABELS[key].note,
    baselines: byBaseline((baseline) => {
      const aggregate = baseline.aggregate ?? {}
      return ratioFrom(aggregate[key])
    }),
  })

  const tokenMetric = {
    label: METRIC_LABELS.extraTokensEstimate.label,
    kind: 'tokens',
    note: `${METRIC_LABELS.extraTokensEstimate.note} (charsPerToken=${TOKEN_PROFILE.charsPerToken}, cjkCharsPerToken=${TOKEN_PROFILE.cjkCharsPerToken})`,
    baselines: byBaseline((baseline) => {
      const metric = baseline.aggregate?.extraTokensEstimate ?? null
      if (metric === null) return null
      return {
        method: metric.method ?? 'estimate',
        samples: metric.samples ?? 0,
        mean: round(Number(metric.mean ?? 0), 2),
        total: Math.round(Number(metric.total ?? 0)),
        max: Math.round(Number(metric.max ?? 0)),
      }
    }),
  }

  const latencyMetric = {
    label: METRIC_LABELS.latencyMs.label,
    kind: 'latency',
    note: METRIC_LABELS.latencyMs.note,
    baselines: byBaseline((baseline) => {
      const metric = baseline.aggregate?.latencyMs ?? null
      if (metric === null) return null
      return {
        count: metric.count ?? 0,
        mean: round(Number(metric.meanMs ?? 0), 3),
        p50: round(Number(metric.p50Ms ?? 0), 3),
        p95: round(Number(metric.p95Ms ?? 0), 3),
        max: round(Number(metric.maxMs ?? 0), 3),
      }
    }),
  }

  const metrics = {}
  for (const key of METRIC_ORDER) {
    if (key === 'storageCorrectness') {
      metrics[key] = {
        label: METRIC_LABELS[key].label,
        kind: 'ratio',
        note: METRIC_LABELS[key].note,
        baselines: byBaseline((baseline) => {
          if (baseline.id !== 'memory') return null
          return { score: storageTotals.score, passed: storageTotals.passed, total: storageTotals.total }
        }),
      }
    } else if (key === 'taskStateAccuracy') {
      metrics[key] = {
        label: METRIC_LABELS[key].label,
        kind: 'ratio',
        note: METRIC_LABELS[key].note,
        baselines: byBaseline((baseline) => {
          if (baseline.id !== 'memory') return null
          return { score: taskStateTotals.score, passed: taskStateTotals.passed, total: taskStateTotals.total }
        }),
      }
    } else if (key === 'extraTokensEstimate') {
      metrics[key] = tokenMetric
    } else if (key === 'latencyMs') {
      metrics[key] = latencyMetric
    } else if (key === 'llmAnswerAccuracy') {
      metrics[key] = {
        label: METRIC_LABELS[key].label,
        kind: 'ratio',
        note: METRIC_LABELS[key].note,
        baselines: Object.fromEntries(baselineIds.map((id) => [id, null])),
        answerer: answerer?.llm ?? null,
      }
    } else {
      metrics[key] = ratioMetric(key)
    }
  }

  /**
   * Group session runs by a facet and aggregate metrics per baseline.
   *
   * @param {(run: object) => string | null} keyOf
   * @returns {Record<string, Record<string, object>>}
   */
  const groupRuns = (keyOf) => {
    /** @type {Map<string, Map<string, object[]>>} */
    const groups = new Map()
    for (const baseline of baselines) {
      for (const run of baseline.sessionRuns ?? []) {
        const key = keyOf(run)
        if (key === null || key === undefined) continue
        if (!groups.has(key)) groups.set(key, new Map())
        const perBaseline = groups.get(key)
        if (!perBaseline.has(baseline.id)) perBaseline.set(baseline.id, [])
        perBaseline.get(baseline.id).push(run)
      }
    }
    /** @type {Record<string, Record<string, object>>} */
    const out = {}
    for (const [key, perBaseline] of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      out[key] = {}
      for (const id of baselineIds) {
        const runs = perBaseline.get(id)
        if (runs === undefined || runs.length === 0) {
          out[key][id] = null
          continue
        }
        const entries = runs.flatMap((run) => run.questions ?? [])
        const aggregate = aggregateEntries(entries)
        const memory = id === 'memory' ? runs : []
        let storagePassed = 0
        let storageTotal = 0
        for (const run of memory) {
          storagePassed += Number(run.storage?.passed ?? 0)
          storageTotal += Number(run.storage?.total ?? 0)
        }
        const assemblyScore = aggregate.assemblyCoverage?.score
        const retrievalScore = aggregate.retrievalRecall?.score
        const tokensMean = aggregate.extraTokensEstimate?.mean
        const latencyP95 = aggregate.latencyMs?.p95Ms
        const guardScore = aggregate.guardPassRate?.score
        out[key][id] = {
          sessions: runs.length,
          turns: sumBy(runs, (run) => Number(run.turns ?? 0)),
          storageCorrectness: storageTotal === 0 ? null : round(storagePassed / storageTotal),
          assemblyCoverage: assemblyScore === null || assemblyScore === undefined ? null : round(assemblyScore),
          retrievalRecall: id === 'memory' && retrievalScore !== null && retrievalScore !== undefined ? round(retrievalScore) : null,
          extraTokensEstimateMean: tokensMean === null || tokensMean === undefined ? null : round(tokensMean, 2),
          latencyMsP95: latencyP95 === null || latencyP95 === undefined ? null : round(latencyP95, 3),
          guardPassRate: guardScore === null || guardScore === undefined ? null : round(guardScore),
        }
      }
    }
    return out
  }

  const perScenario = groupRuns((run) => run.scenario ?? 'unknown')
  const perSize = groupRuns((run) => (run.turns === undefined || run.turns === null ? null : String(run.turns)))

  /** @type {Map<string, Map<string, object[]>>} */
  const questionIndex = new Map()
  for (const baseline of baselines) {
    for (const run of baseline.sessionRuns ?? []) {
      for (const question of run.questions ?? []) {
        if (!questionIndex.has(question.questionId)) questionIndex.set(question.questionId, new Map())
        const perBaseline = questionIndex.get(question.questionId)
        if (!perBaseline.has(baseline.id)) perBaseline.set(baseline.id, [])
        perBaseline.get(baseline.id).push({ ...question, sessionId: run.sessionId })
      }
    }
  }
  const questions = [...questionIndex.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([questionId, perBaseline]) => {
      const first = [...perBaseline.values()][0]?.[0] ?? {}
      const baselinesOut = {}
      for (const id of baselineIds) {
        const records = perBaseline.get(id) ?? []
        const record = records[0]
        if (record === undefined) {
          baselinesOut[id] = null
          continue
        }
        baselinesOut[id] = {
          sessionId: record.sessionId,
          covered: record.evaluation?.checks?.covered === true,
          passedChecks: record.evaluation?.checks?.passedChecks ?? 0,
          applicableChecks: record.evaluation?.checks?.applicableChecks ?? 0,
          retrievalRecall: record.retrievalEvaluation?.factRecall ?? null,
          tokens: Math.round(Number(record.tokens ?? 0)),
          latencyMs: round(Number(record.latencyMs ?? 0), 3),
        }
      }
      return {
        questionId,
        kind: first.kind ?? 'unknown',
        lang: first.lang ?? 'unknown',
        baselines: baselinesOut,
      }
    })

  const liveInvariants = baselines.find((baseline) => baseline.id === 'memory')?.invariants ?? []
  const hardInvariantFailures = liveInvariants.filter((invariant) => invariant.status === 'fail')

  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    profile,
    seed,
    answerer,
    environment,
    fixtures: {
      rootDir: fixture.rootDir,
      sessions: fixture.sessions.map((session) => ({
        sessionId: session.sessionId,
        scenario: session.scenario ?? null,
        group: session.group ?? null,
        turns: session.turns,
        variant: session.variant ?? 'full',
        uniqueEvents: session.uniqueEvents ?? session.meta?.uniqueEvents ?? null,
        questions: session.questions ?? null,
      })),
      totals: fixture.manifest?.totals ?? null,
      skill: fixture.manifest?.skill ?? null,
    },
    metricOrder: [...METRIC_ORDER],
    metrics,
    hardInvariants: liveInvariants,
    hardInvariantFailures: hardInvariantFailures.length,
    perScenario,
    perSize,
    questions,
    baselines: baselines.map((baseline) => ({
      id: baseline.id,
      label: baseline.label,
      available: baseline.available,
      notes: baseline.notes ?? [],
      extra: baseline.extra ?? null,
    })),
    notes: [
      'metrics are reported separately on purpose; there is no single composite score',
      'extra tokens are estimated (CJK/1.6 chars, other/4 chars), not tokenizer-exact',
      'no LLM answer-quality claim is made by the deterministic harness',
      ...notes,
    ],
  }
}

/**
 * Recompute the metric aggregate for a list of question entries.
 *
 * @param {object[]} entries
 * @returns {object}
 */
function aggregateEntries(entries) {
  return aggregateQuestionMetrics(entries.map((entry) => ({
    evaluation: entry.evaluation ?? null,
    retrieval: entry.retrievalEvaluation ?? null,
    tokens: Number(entry.tokens ?? entry.result?.usedTokens ?? 0),
    latencyMs: Number(entry.latencyMs ?? entry.assemblyMs ?? 0),
  })))
}

/**
 * Format a ratio as a percentage.
 *
 * @param {number | null | undefined} value
 * @returns {string}
 */
function percent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return `${(value * 100).toFixed(1)}%`
}

/**
 * @param {unknown} value
 * @param {number} width
 * @returns {string}
 */
function pad(value, width) {
  const text = String(value)
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/**
 * Render the human-readable table for stdout.
 *
 * @param {object} report
 * @returns {string}
 */
export function formatHumanReport(report) {
  const lines = []
  const baselineIds = report.baselines.map((baseline) => baseline.id)
  const labelFor = (id) => report.baselines.find((baseline) => baseline.id === id)?.label ?? id

  lines.push('DSH long-conversation-memory evaluation')
  lines.push(`profile: ${report.profile}    seed: ${report.seed}    answerer: ${report.answerer?.kind ?? 'deterministic'}`)
  lines.push(`generatedAt: ${report.generatedAt}`)
  const totals = report.fixtures.totals
  if (totals !== null && totals !== undefined) {
    lines.push(`fixtures: ${totals.sessions} sessions / ${totals.turns} turns / ${totals.uniqueEvents} unique events / ${totals.questions} questions`)
  }
  lines.push('')

  const metricRows = []
  for (const key of report.metricOrder) {
    const metric = report.metrics[key]
    if (metric === undefined) continue
    if (metric.kind === 'ratio') {
      const cells = baselineIds.map((id) => {
        const value = metric.baselines[id]
        if (value === null || value === undefined) return 'not applicable'
        if (typeof value === 'object') return percent(value.score)
        return percent(value)
      })
      metricRows.push([metric.label, ...cells])
    } else if (metric.kind === 'tokens') {
      const cells = baselineIds.map((id) => {
        const value = metric.baselines[id]
        if (value === null || value === undefined) return 'not applicable'
        return `${value.mean.toFixed(1)} mean / ${value.total} total`
      })
      metricRows.push([metric.label, ...cells])
    } else if (metric.kind === 'latency') {
      const cells = baselineIds.map((id) => {
        const value = metric.baselines[id]
        if (value === null || value === undefined) return 'not applicable'
        return `${value.mean.toFixed(2)} mean / ${value.p95.toFixed(2)} p95 ms`
      })
      metricRows.push([metric.label, ...cells])
    }
  }

  const header = ['metric', ...baselineIds.map((id) => labelFor(id))]
  const widths = header.map((cell, index) => Math.max(cell.length, ...metricRows.map((row) => String(row[index] ?? '').length)))
  lines.push(header.map((cell, index) => pad(cell, widths[index])).join('  '))
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of metricRows) lines.push(row.map((cell, index) => pad(cell, widths[index])).join('  '))
  lines.push('')

  const storage = report.metrics.storageCorrectness?.baselines?.memory
  if (storage !== null && storage !== undefined) {
    lines.push(`storage correctness: ${storage.passed}/${storage.total} answer-key checks (${percent(storage.score)})`)
  }
  const taskState = report.metrics.taskStateAccuracy?.baselines?.memory
  if (taskState !== null && taskState !== undefined) {
    lines.push(`task state accuracy: ${taskState.passed}/${taskState.total} facets (${percent(taskState.score)})`)
  }
  lines.push('')

  lines.push('per size:')
  for (const [size, perBaseline] of Object.entries(report.perSize ?? {})) {
    const cells = baselineIds.map((id) => {
      const value = perBaseline[id]
      if (value === null || value === undefined) return `${labelFor(id)}: n/a`
      return `${labelFor(id)}: coverage ${percent(value.assemblyCoverage)}, ${value.extraTokensEstimateMean.toFixed(1)} tok, p95 ${value.latencyMsP95.toFixed(2)} ms`
    })
    lines.push(`  ${size.padStart(4)} turns — ${cells.join('  |  ')}`)
  }
  lines.push('')

  lines.push('per scenario:')
  for (const [scenario, perBaseline] of Object.entries(report.perScenario ?? {})) {
    const cells = baselineIds.map((id) => {
      const value = perBaseline[id]
      if (value === null || value === undefined) return `${labelFor(id)}: n/a`
      return `${labelFor(id)}: coverage ${percent(value.assemblyCoverage)}, ${value.extraTokensEstimateMean.toFixed(1)} tok`
    })
    lines.push(`  ${scenario} — ${cells.join('  |  ')}`)
  }
  lines.push('')

  lines.push(`hard invariants: ${report.hardInvariants.length - report.hardInvariantFailures}/${report.hardInvariants.length} pass`)
  for (const invariant of report.hardInvariants) {
    const marker = invariant.status === 'pass' ? 'PASS' : invariant.status === 'skip' ? 'SKIP' : 'FAIL'
    lines.push(`  [${marker}] ${invariant.id}: ${invariant.detail}`)
  }
  lines.push('')

  if (Array.isArray(report.notes) && report.notes.length > 0) {
    lines.push('notes:')
    for (const note of report.notes) lines.push(`  - ${note}`)
  }
  return lines.join('\n')
}

/**
 * A rough one-line status line for CI logs.
 *
 * @param {object} report
 * @returns {string}
 */
export function summaryLine(report) {
  const failed = report.hardInvariants.filter((invariant) => invariant.status === 'fail').map((invariant) => invariant.id)
  const memory = report.metrics.assemblyCoverage?.baselines?.memory
  return [
    `profile=${report.profile}`,
    `sessions=${report.fixtures.totals?.sessions ?? '?'}`,
    `turns=${report.fixtures.totals?.turns ?? '?'}`,
    `questions=${report.fixtures.totals?.questions ?? '?'}`,
    `assemblyCoverage=${percent(typeof memory === 'object' && memory !== null ? memory.score : memory)}`,
    `hardInvariants=${report.hardInvariants.length - failed.length}/${report.hardInvariants.length}`,
    failed.length === 0 ? 'status=pass' : `status=fail(${failed.join(',')})`,
  ].join(' ')
}
