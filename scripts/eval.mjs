#!/usr/bin/env node
/**
 * Reproducible evaluation harness for the `dsh-long-conversation-memory` plugin.
 *
 * Compares three baselines on the same deterministic synthetic sessions:
 *
 *   1. `skill-only`        – the synthetic skill rules are always in context, no memory.
 *   2. `rolling-summary`   – skill rules + a rolling summary that keeps only a slim
 *                            recent window (early facts and corrections are lost).
 *   3. `memory`            – the real `src/` plugin modules (capture → extract →
 *                            retrieve → assemble) over one temporary SQLite DB.
 *
 * Every metric is reported separately and labelled: storage correctness,
 * retrieval recall/rank-1, assembly coverage, rule coverage, task-state
 * accuracy, guard pass rate, extra tokens (estimate) and wall-clock latency.
 * No single composite score is produced and no LLM answer accuracy is claimed
 * by default; see `tests/fixtures/synthetic/answerer.mjs` for the optional,
 * explicitly gated seam.
 *
 * Usage:
 *   node scripts/eval.mjs                       # smoke profile: 100 and 200 turns
 *   node scripts/eval.mjs --profile standard    # + 500 turns
 *   node scripts/eval.mjs --profile full        # + 1000 turns
 *   node scripts/eval.mjs --profile seed        # replay the committed tiny fixtures
 *   node scripts/eval.mjs --baselines skill-only,rolling-summary
 *
 * Exit codes: 0 = report produced and all hard invariants pass; 1 = a hard
 * invariant failed; 2 = environment/argument error (missing modules, missing
 * fixtures, bad flags).
 *
 * @module scripts/eval
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_SEED,
  PROFILE_IDS,
  generateFixtures,
} from '../tests/fixtures/synthetic/generator.mjs'
import {
  generatedRootFor,
  readFixtureBundle,
  writeFixtureBundle,
} from '../tests/fixtures/synthetic/fixture-io.mjs'
import {
  BASELINE_IDS,
  runRollingSummaryBaseline,
  runSkillOnlyBaseline,
} from '../tests/fixtures/synthetic/baselines.mjs'
import {
  TOKEN_PROFILE,
  aggregateQuestionMetrics,
  evaluateQuestion,
} from '../tests/fixtures/synthetic/metrics.mjs'
import {
  PLUGIN_MODULE_FILES,
  loadPluginModules,
  runMemoryBaseline,
} from '../tests/fixtures/synthetic/plugin-runner.mjs'
import {
  REPORT_FORMAT,
  buildReport,
  formatHumanReport,
  summaryLine,
} from '../tests/fixtures/synthetic/report.mjs'
import {
  ANSWERER_IDS,
  describeAnswerer,
  resolveAnswerer,
} from '../tests/fixtures/synthetic/answerer.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED_FIXTURE_ROOT = 'tests/fixtures/synthetic/seed'
const DEFAULT_OUT_DIR = 'eval-results'
const DEFAULT_PROFILE = 'smoke'
const BASELINE_LABELS = Object.freeze({
  'skill-only': 'skill-only',
  'rolling-summary': 'skill+rolling-summary',
  memory: 'memory-plugin',
})

/**
 * @typedef {{
 *   profile: string,
 *   seed: string,
 *   turns: number[],
 *   fixtures: string | null,
 *   out: string | null,
 *   baselines: string[],
 *   regenerate: boolean,
 *   answerer: string,
 *   json: boolean,
 *   verbose: boolean,
 *   help: boolean,
 *   noWrite: boolean,
 * }} EvalOptions
 */

/**
 * @param {string[]} argv
 * @returns {EvalOptions}
 */
function parseArguments(argv) {
  /** @type {EvalOptions} */
  const options = {
    profile: DEFAULT_PROFILE,
    seed: DEFAULT_SEED,
    turns: [],
    fixtures: null,
    out: null,
    baselines: [...BASELINE_IDS],
    regenerate: false,
    answerer: 'deterministic',
    json: false,
    verbose: false,
    help: false,
    noWrite: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--profile':
        options.profile = String(argv[++index] ?? '')
        break
      case '--seed':
        options.seed = String(argv[++index] ?? '')
        break
      case '--turns':
        options.turns = String(argv[++index] ?? '')
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value) && value > 0)
        break
      case '--fixtures':
        options.fixtures = String(argv[++index] ?? '')
        break
      case '--out':
        options.out = String(argv[++index] ?? '')
        break
      case '--baselines':
        options.baselines = String(argv[++index] ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
        break
      case '--regenerate':
        options.regenerate = true
        break
      case '--answerer':
        options.answerer = String(argv[++index] ?? '')
        break
      case '--json':
        options.json = true
        break
      case '--verbose':
        options.verbose = true
        break
      case '--no-write':
        options.noWrite = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new EnvironmentError(`unknown argument "${argument}"; try --help`)
    }
  }
  if (!PROFILE_IDS.includes(options.profile) && options.fixtures === null) {
    throw new EnvironmentError(`unknown profile "${options.profile}"; expected one of ${PROFILE_IDS.join(', ')}`)
  }
  if (typeof options.seed !== 'string' || options.seed.length === 0) {
    throw new EnvironmentError('--seed must be a non-empty string')
  }
  if (options.fixtures !== null && options.turns.length > 0) {
    throw new EnvironmentError('--turns cannot be combined with --fixtures (fixtures already contain their turn sizes)')
  }
  if (!ANSWERER_IDS.includes(options.answerer)) {
    throw new EnvironmentError(`unknown answerer "${options.answerer}"; expected one of ${ANSWERER_IDS.join(', ')}`)
  }
  const unknownBaselines = options.baselines.filter((baseline) => !BASELINE_IDS.includes(baseline))
  if (unknownBaselines.length > 0) {
    throw new EnvironmentError(`unknown baseline(s) ${unknownBaselines.join(', ')}; expected one of ${BASELINE_IDS.join(', ')}`)
  }
  options.baselines = BASELINE_IDS.filter((baseline) => options.baselines.includes(baseline))
  return options
}

/** Marker class for environment/argument problems that map to exit code 2. */
class EnvironmentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EnvironmentError'
  }
}

/**
 * @param {string} relativeOrAbsolute
 * @returns {string}
 */
function resolvePath(relativeOrAbsolute) {
  return path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(REPO_ROOT, relativeOrAbsolute)
}

/**
 * @param {number} milliseconds
 * @returns {string}
 */
function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1000).toFixed(2)} s`
}

/**
 * Resolve (and if needed generate) the fixture bundle the run should use.
 *
 * @param {EvalOptions} options
 * @param {(message: string) => void} log
 * @returns {Promise<object>}
 */
async function resolveFixtures(options, log) {
  if (options.fixtures !== null) {
    const rootDir = resolvePath(options.fixtures)
    try {
      const bundle = await readFixtureBundle(rootDir)
      log(`loaded custom fixtures from ${path.relative(REPO_ROOT, rootDir)}`)
      return { ...bundle, source: 'custom' }
    } catch (error) {
      throw new EnvironmentError(`cannot read fixtures at ${rootDir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (options.profile === 'seed') {
    const rootDir = resolvePath(SEED_FIXTURE_ROOT)
    try {
      const bundle = await readFixtureBundle(rootDir)
      log(`replaying committed seed fixtures from ${SEED_FIXTURE_ROOT}`)
      return { ...bundle, source: 'seed' }
    } catch (error) {
      throw new EnvironmentError(
        `committed seed fixtures are missing (${SEED_FIXTURE_ROOT}); regenerate them with ` +
        `"node scripts/generate-fixtures.mjs --profile seed": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const rootDir = generatedRootFor(REPO_ROOT, options.profile, options.seed)
  const manifestPath = path.join(rootDir, 'manifest.json')
  const turns = options.turns.length > 0 ? options.turns : undefined
  let regenerate = options.regenerate === true || !fs.existsSync(manifestPath)
  if (!regenerate) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const sameProfile = existing.profile === options.profile
      const sameSeed = existing.seed === options.seed
      const sameTurns = turns === undefined || JSON.stringify(existing.longHaulTurns) === JSON.stringify([...turns].sort((a, b) => a - b))
      if (!sameProfile || !sameSeed || !sameTurns) {
        regenerate = true
        log('fixture bundle does not match the requested profile/seed/turns; regenerating')
      }
    } catch {
      regenerate = true
    }
  }
  if (regenerate) {
    const startedAt = Date.now()
    const generated = generateFixtures({ profile: options.profile, seed: options.seed, turns })
    await writeFixtureBundle({ rootDir, manifest: generated.manifest, files: generated.files })
    log(`generated ${options.profile} fixtures in ${formatDuration(Date.now() - startedAt)} (${generated.files.length} files, seed "${options.seed}")`)
  }
  const bundle = await readFixtureBundle(rootDir)
  return { ...bundle, source: 'generated' }
}

/**
 * @param {object} bundle
 * @returns {object}
 */
function describeFixtures(bundle) {
  return {
    rootDir: path.relative(REPO_ROOT, bundle.rootDir).split(path.sep).join('/'),
    manifest: bundle.manifest,
    sessions: bundle.sessions.map((entry) => ({
      sessionId: entry.session.sessionId,
      scenario: entry.session.scenario,
      group: entry.session.group ?? null,
      turns: entry.session.turns,
      variant: entry.session.variant ?? 'full',
      uniqueEvents: entry.session.meta?.uniqueEvents ?? null,
      questions: entry.answerKey.questions?.length ?? 0,
    })),
  }
}

/**
 * Normalize the raw memory-baseline result into the report's baseline shape.
 *
 * @param {object} raw
 * @returns {object}
 */
function normalizeMemoryBaseline(raw) {
  const label = BASELINE_LABELS.memory
  if (raw.available !== true) {
    return {
      id: 'memory',
      label,
      available: false,
      notes: raw.notes ?? [],
      sessionRuns: [],
      aggregate: aggregateQuestionMetrics([]),
      invariants: [],
      extra: { missingModules: raw.missingModules ?? [] },
    }
  }
  // aggregateQuestionMetrics() consumes entries shaped `{ evaluation, retrieval,
  // tokens, latencyMs }`, while the harness keeps retrieval results under
  // `retrievalEvaluation`. Map explicitly so retrieval recall is attributed to
  // the memory baseline instead of showing up as "n/a".
  const toAggregateEntries = (questions) => questions.map((question) => ({
    evaluation: question.evaluation,
    retrieval: question.retrievalEvaluation ?? null,
    tokens: question.tokens,
    latencyMs: question.latencyMs,
  }))
  /** @type {object[]} */
  const sessionRuns = (raw.sessions ?? []).map((run) => {
    const questions = (run.questions ?? []).map((question) => ({
      questionId: question.questionId,
      kind: question.kind,
      lang: question.lang,
      query: question.query,
      evaluation: question.evaluation,
      retrievalEvaluation: question.retrievalEvaluation,
      tokens: question.result?.usedTokens ?? 0,
      latencyMs: question.assemblyMs ?? 0,
    }))
    return {
      sessionId: run.sessionId,
      scenario: run.scenario,
      turns: run.turns,
      group: run.group ?? null,
      variant: run.variant ?? 'full',
      aggregate: aggregateQuestionMetrics(toAggregateEntries(questions)),
      storage: run.storage ?? null,
      checkpoint: run.checkpoint ?? null,
      questions,
    }
  })
  const allQuestions = sessionRuns.flatMap((run) => run.questions)
  return {
    id: 'memory',
    label,
    available: true,
    notes: raw.notes ?? [],
    sessionRuns,
    aggregate: aggregateQuestionMetrics(toAggregateEntries(allQuestions)),
    invariants: raw.invariants ?? [],
    extra: {
      ingestMs: raw.ingestMs ?? null,
      captureMs: raw.captureMs ?? null,
      extractionMs: raw.extractionMs ?? null,
      extractionErrors: raw.extractionErrors ?? [],
      pipelineErrors: raw.pipelineErrors ?? [],
      restartRecords: raw.restartRecords ?? [],
      skillRegistration: raw.skillRegistration ?? null,
      missingModules: raw.missingModules ?? [],
    },
  }
}

/**
 * Normalize one of the two in-harness simulator baselines.
 *
 * @param {'skill-only' | 'rolling-summary'} id
 * @param {object} raw
 * @param {object} bundle
 * @returns {object}
 */
function normalizeSimulatorBaseline(id, raw, bundle) {
  const bySession = new Map(bundle.sessions.map((entry) => [entry.session.sessionId, entry]))
  /** @type {object[]} */
  const sessionRuns = []
  for (const simSession of raw.sessions ?? []) {
    const entry = bySession.get(simSession.sessionId)
    if (entry === undefined) continue
    const factsByKey = new Map((entry.answerKey.facts ?? []).map((fact) => [fact.key, fact]))
    const questionsById = new Map((entry.answerKey.questions ?? []).map((question) => [question.id, question]))
    const questions = (simSession.contexts ?? []).map((context) => {
      const question = questionsById.get(context.questionId) ?? {
        id: context.questionId,
        kind: 'unknown',
        lang: '',
        expect: {},
      }
      const evaluation = evaluateQuestion({
        question,
        factsByKey,
        context: context.context,
        evidenceSeqs: null,
      })
      return {
        questionId: context.questionId,
        kind: question.kind,
        lang: question.lang,
        evaluation,
        retrievalEvaluation: null,
        tokens: context.tokens,
        latencyMs: context.latencyMs,
      }
    })
    sessionRuns.push({
      sessionId: simSession.sessionId,
      scenario: entry.session.scenario,
      turns: entry.session.turns,
      group: entry.session.group ?? null,
      variant: entry.session.variant ?? 'full',
      aggregate: aggregateQuestionMetrics(questions),
      storage: null,
      checkpoint: null,
      questions,
    })
  }
  const allQuestions = sessionRuns.flatMap((run) => run.questions)
  return {
    id,
    label: BASELINE_LABELS[id],
    available: true,
    notes: raw.notes ?? [],
    sessionRuns,
    aggregate: aggregateQuestionMetrics(allQuestions),
    invariants: [],
    extra: null,
  }
}

/**
 * Run the two in-harness simulators over every fixture session.
 *
 * @param {object} bundle
 * @param {string[]} selected baseline ids to run
 * @returns {object[]}
 */
function runSimulatorBaselines(bundle, selected) {
  const results = []
  for (const id of ['skill-only', 'rolling-summary']) {
    if (!selected.includes(id)) continue
    /** @type {object[]} */
    const sessions = []
    for (const entry of bundle.sessions) {
      const raw = id === 'skill-only'
        ? runSkillOnlyBaseline({ session: entry.session, answerKey: entry.answerKey, skillContent: bundle.skillContent })
        : runRollingSummaryBaseline({ session: entry.session, answerKey: entry.answerKey, skillContent: bundle.skillContent })
      sessions.push(...(raw.sessions ?? []))
    }
    results.push(normalizeSimulatorBaseline(id, { id, sessions }, bundle))
  }
  return results
}

/**
 * @param {EvalOptions} options
 */
async function main(options) {
  if (options.help) {
    console.log([
      'Usage: node scripts/eval.mjs [options]',
      '',
      'Options:',
      '  --profile <seed|smoke|standard|full>   fixture profile (default: smoke = 100,200 turns)',
      '  --turns <list>                         comma-separated long-haul turn sizes (e.g. 100,200)',
      '  --seed <seed>                          PRNG seed for deterministic fixtures',
      '  --fixtures <dir>                       read an existing generated fixture bundle',
      '  --baselines <list>                     subset of skill-only,rolling-summary,memory',
      '  --regenerate                           regenerate fixtures even if they already exist',
      '  --answerer <deterministic|llm>         default: deterministic metrics only',
      '  --out <file>                           report JSON path (default: eval-results/<timestamp>.json)',
      '  --json                                 print the full JSON report to stdout',
      '  --no-write                             do not write a report file',
      '  --verbose                              extra progress output on stderr',
      '  --help                                 show this help',
      '',
      'Exit codes: 0 all hard invariants pass, 1 hard invariant failed, 2 environment/argument error.',
    ].join('\n'))
    return 0
  }

  const startedAt = Date.now()
  const log = (message) => {
    if (!options.json) process.stderr.write(`${message}\n`)
  }

  const answerer = resolveAnswerer(options.answerer, { env: process.env })
  if (options.answerer === 'llm') {
    log(`answerer: ${describeAnswerer(answerer)}`)
  }

  const bundle = await resolveFixtures(options, (message) => log(message))
  const fixture = describeFixtures(bundle)
  const totals = bundle.manifest?.totals ?? {}
  log(
    `fixtures: ${fixture.rootDir} — ${fixture.sessions.length} sessions, ` +
    `${totals.turns ?? '?'} turns, ${totals.uniqueEvents ?? '?'} unique events, ${totals.questions ?? '?'} questions`,
  )

  const plugin = options.baselines.includes('memory')
    ? await loadPluginModules(REPO_ROOT)
    : { available: true, modules: {}, missingModules: [] }
  if (options.baselines.includes('memory') && !plugin.available) {
    log(`warning: memory baseline unavailable — missing modules: ${plugin.missingModules.join(', ')}`)
  }

  /** @type {object[]} */
  const baselines = []

  // Baseline 1 + 2: pure in-harness simulators (no plugin imports).
  const simulatorStartedAt = Date.now()
  const simulatorBaselines = runSimulatorBaselines(bundle, options.baselines)
  for (const baseline of simulatorBaselines) {
    if (!options.baselines.includes(baseline.id)) continue
    baselines.push(baseline)
    log(`baseline ${baseline.id}: ${baseline.aggregate.questions} question contexts scored (${formatDuration(Date.now() - simulatorStartedAt)})`)
  }

  // Baseline 3: the real plugin modules.
  if (options.baselines.includes('memory')) {
    log(`baseline memory: driving src/ modules over one temporary SQLite file…`)
    const memoryStartedAt = Date.now()
    const raw = await runMemoryBaseline({
      repoRoot: REPO_ROOT,
      fixture: {
        manifest: bundle.manifest,
        sessions: bundle.sessions,
        skillContent: bundle.skillContent,
      },
    })
    const memory = normalizeMemoryBaseline(raw)
    baselines.push(memory)
    log(
      memory.available
        ? `baseline memory: ${memory.sessionRuns.length} sessions measured in ${formatDuration(Date.now() - memoryStartedAt)} ` +
          `(ingest ${formatDuration(Number(memory.extra?.ingestMs ?? 0))}, extraction errors ${memory.extra?.extractionErrors?.length ?? 0})`
        : 'baseline memory: not available (module set incomplete)',
    )
  }

  // Correct report order regardless of the order baselines completed.
  const orderedBaselines = BASELINE_IDS
    .map((id) => baselines.find((baseline) => baseline.id === id))
    .filter((baseline) => baseline !== undefined)

  const environment = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    plugin: {
      available: plugin.available,
      missingModules: plugin.missingModules,
      moduleFiles: PLUGIN_MODULE_FILES,
    },
    tokenProfile: { ...TOKEN_PROFILE },
  }

  const report = buildReport({
    profile: fixture.manifest?.profile ?? options.profile,
    seed: fixture.manifest?.seed ?? options.seed,
    answerer,
    environment,
    fixture,
    baselines: orderedBaselines,
    notes: [
      `harness command: node scripts/eval.mjs --profile ${options.profile}${options.fixtures === null ? '' : ' --fixtures <dir>'}`,
      `fixture source: ${bundle.source}`,
      ...(options.baselines.includes('memory') && !plugin.available
        ? [`memory baseline unavailable: missing ${plugin.missingModules.join(', ')}`]
        : []),
      ...(answerer.kind === 'llm' ? [describeAnswerer(answerer)] : []),
    ],
  })

  let outPath = null
  if (!options.noWrite) {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
    outPath = options.out !== null
      ? resolvePath(options.out)
      : path.join(REPO_ROOT, DEFAULT_OUT_DIR, `${timestamp}-${report.profile}.json`)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatHumanReport(report)}\n\n`)
    process.stdout.write(`${summaryLine(report)}\n`)
    if (outPath !== null) process.stdout.write(`report: ${path.relative(REPO_ROOT, outPath).split(path.sep).join('/')}\n`)
    process.stdout.write(`total wall clock: ${formatDuration(Date.now() - startedAt)}\n`)
    if (answerer.kind === 'llm') process.stdout.write(`answerer: ${describeAnswerer(answerer)}\n`)
  }

  const memoryBaseline = orderedBaselines.find((baseline) => baseline.id === 'memory')
  if (options.baselines.includes('memory') && memoryBaseline !== undefined && memoryBaseline.available === false) {
    process.stderr.write('the real plugin modules are not all available; memory metrics are null (environment error)\n')
    return 2
  }
  if (report.hardInvariantFailures > 0) {
    const failed = report.hardInvariants.filter((invariant) => invariant.status === 'fail').map((invariant) => invariant.id)
    process.stderr.write(`hard invariant failure(s): ${failed.join(', ')}\n`)
    return 1
  }
  return 0
}

const options = parseArguments(process.argv.slice(2))
main(options)
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    if (error instanceof EnvironmentError) process.exitCode = 2
    else {
      if (process.argv.includes('--verbose')) process.stderr.write(`${error instanceof Error ? error.stack ?? '' : ''}\n`)
      process.exitCode = 2
    }
  })
