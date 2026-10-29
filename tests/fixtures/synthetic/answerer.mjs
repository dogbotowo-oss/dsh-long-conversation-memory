/**
 * Optional answerer seam.
 *
 * The evaluation harness deliberately makes NO claim about real language-model
 * answer accuracy. By default (`--answerer=deterministic`) it reports only
 * deterministic measurements: storage correctness, retrieval recall, assembly
 * coverage, extra tokens (estimate) and latency.
 *
 * The `llm` answerer exists as an explicit, documented extension point. It is
 * never exercised implicitly and requires:
 *
 *   1. `DSH_EVAL_LLM_API_KEY` in the environment (the harness never reads or
 *      prints it; only its presence is reported), and
 *   2. an injected `fetchAnswer` implementation supplied by the caller, because
 *      the harness does not bundle any network client, endpoint or model name.
 *
 * With those two conditions met the report's `llmAnswerAccuracy` metric may be
 * filled by the injected callback; without them the metric stays `null`.
 *
 * @module tests/fixtures/synthetic/answerer
 */

/** Supported answerer ids. */
export const ANSWERER_IDS = Object.freeze(['deterministic', 'llm'])

/** Environment variable the optional LLM seam requires (presence only). */
export const ANSWERER_ENV_KEY = 'DSH_EVAL_LLM_API_KEY'

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Resolve the answerer descriptor from the CLI option and the environment.
 *
 * @param {string} kind `deterministic` or `llm`
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {{ kind: 'deterministic' | 'llm', llm: null | { available: boolean, reason: string, apiKeyPresent: boolean, needsInjectedFetchAnswer: boolean } }}
 */
export function resolveAnswerer(kind, options = {}) {
  const env = options.env ?? {}
  if (kind === 'deterministic') {
    return {
      kind: 'deterministic',
      llm: null,
    }
  }
  if (kind !== 'llm') {
    throw new Error(`unknown answerer "${kind}"; expected one of ${ANSWERER_IDS.join(', ')}`)
  }
  const apiKeyPresent = typeof env[ANSWERER_ENV_KEY] === 'string' && env[ANSWERER_ENV_KEY].length > 0
  return {
    kind: 'llm',
    llm: {
      available: apiKeyPresent,
      apiKeyPresent,
      reason: apiKeyPresent
        ? `environment variable ${ANSWERER_ENV_KEY} is present; the harness still needs an injected fetchAnswer callback before it can score answers`
        : `environment variable ${ANSWERER_ENV_KEY} is not set, so the optional LLM answerer is disabled and llmAnswerAccuracy stays null`,
      needsInjectedFetchAnswer: true,
    },
  }
}

/**
 * Human-readable description of the answerer descriptor.
 *
 * @param {{ kind: string, llm: null | { available: boolean, reason: string } }} answerer
 * @returns {string}
 */
export function describeAnswerer(answerer) {
  if (answerer?.kind !== 'llm') {
    return 'deterministic metrics only (no LLM answer accuracy is measured or claimed)'
  }
  const state = answerer.llm?.available === true ? 'API key present, injected callback required' : 'disabled'
  return `optional LLM answerer: ${state} — ${answerer.llm?.reason ?? 'no reason recorded'}`
}

/**
 * Build a caller-supplied LLM answerer. The harness intentionally ships no
 * provider client; callers pass `fetchAnswer({ question, context, apiKey })`
 * and receive the raw model answer string.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchAnswer?: (input: { question: object, context: string, apiKey: string }) => Promise<string> | string,
 * }} [options]
 * @returns {{ available: boolean, reason: string, answer: null | ((input: { question: object, context: string }) => Promise<{ questionId: string, answer: string | null, error: string | null }>) }}
 */
export function createLlmAnswerer(options = {}) {
  const env = options.env ?? {}
  const apiKey = env[ANSWERER_ENV_KEY]
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return {
      available: false,
      reason: `${ANSWERER_ENV_KEY} is not set; the optional LLM answerer is disabled`,
      answer: null,
    }
  }
  if (typeof options.fetchAnswer !== 'function') {
    return {
      available: false,
      reason: 'no fetchAnswer callback was injected; the harness does not bundle an LLM provider client',
      answer: null,
    }
  }
  const fetchAnswer = options.fetchAnswer
  return {
    available: true,
    reason: 'caller-injected fetchAnswer callback will be used (API key is never logged)',
    async answer({ question, context }) {
      try {
        const answer = await fetchAnswer({ question, context, apiKey })
        return { questionId: question?.id ?? 'unknown', answer: String(answer ?? ''), error: null }
      } catch (error) {
        return { questionId: question?.id ?? 'unknown', answer: null, error: errorMessage(error) }
      }
    },
  }
}

/**
 * Score LLM answers when the seam is wired. Returns the `llmAnswerAccuracy`
 * metric payload, or `null` when the seam is inactive — the default path.
 *
 * This helper does not call any network API by itself; it only compares the
 * answers produced by an already-wired `createLlmAnswerer` callback against the
 * answer-key values.
 *
 * @param {{
 *   answerer: ReturnType<typeof createLlmAnswerer>,
 *   questions: Array<{ question: object, context: string }>,
 *   factsByKey: Map<string, object>,
 *   normalize?: (value: string) => string,
 * }} input
 * @returns {Promise<null | { score: number, passed: number, total: number, errors: number, note: string }>}
 */
export async function scoreLlmAnswers({ answerer, questions, factsByKey, normalize }) {
  if (answerer === null || answerer === undefined || answerer.available !== true || typeof answerer.answer !== 'function') {
    return null
  }
  const canonical = typeof normalize === 'function'
    ? normalize
    : (value) => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
  let passed = 0
  let total = 0
  let errors = 0
  for (const entry of questions ?? []) {
    const question = entry.question ?? {}
    const expectedValues = [
      ...(question?.expect?.values ?? []),
      ...(question?.expect?.factKeys ?? [])
        .map((key) => factsByKey?.get?.(key)?.value)
        .filter((value) => typeof value === 'string'),
    ]
    if (expectedValues.length === 0) continue
    total += 1
    const result = await answerer.answer({ question, context: String(entry.context ?? '') })
    if (result.error !== null || result.answer === null) {
      errors += 1
      continue
    }
    const answerText = canonical(result.answer)
    if (expectedValues.every((value) => answerText.includes(canonical(value)))) passed += 1
  }
  return {
    score: total === 0 ? null : passed / total,
    passed,
    total,
    errors,
    note: 'scored against answer-key values; only present when a caller-injected LLM answerer was supplied',
  }
}
