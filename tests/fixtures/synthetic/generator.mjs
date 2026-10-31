/**
 * Fixture profile definitions and the deterministic fixture generator.
 *
 * `generateFixtures()` is pure: it returns an in-memory `{ manifest, files }`
 * bundle and never touches the file system, so unit/replay tests can generate a
 * tiny fixture set without any disk I/O. `fixture-io.mjs` owns writing and
 * reading the bundle.
 *
 * @module tests/fixtures/synthetic/generator
 */

import { buildSkillMarkdown, SKILL_NAME, SKILL_FILE } from './skill.mjs'
import {
  LOGICAL_START,
  SESSION_FORMAT,
  ANSWER_KEY_FORMAT,
  SCENARIO_LONG_HAUL,
  SCENARIO_MULTI_SESSION,
  buildLongHaulSession,
  buildIsolationGroup,
} from './conversation.mjs'

/** Version of the fixture format (bump when the shape changes). */
export const GENERATOR_VERSION = '1.0.0'
/** Manifest discriminator. */
export const MANIFEST_FORMAT = 'dsh-long-memory-eval-fixtures'
/** Default deterministic seed for all fixture data. */
export const DEFAULT_SEED = 'dsh-long-memory-eval-v1'
/** Default profile used by `node scripts/eval.mjs` and `npm run eval`. */
export const DEFAULT_PROFILE = 'smoke'

/**
 * Profile definitions.
 *
 * - `seed`     small checked-in sample (tests/replay + `--profile seed`)
 * - `smoke`    default quick evaluation, ~seconds
 * - `standard` adds the 500-turn session
 * - `full`     adds the 1000-turn session
 *
 * @typedef {{ id: string, description: string, longHaul: { turns: number, variant: 'full'|'mini' }[], isolation: { turns: number, variant: 'full'|'mini' } }} ProfileDefinition
 * @type {Record<string, ProfileDefinition>}
 */
export const PROFILES = Object.freeze({
  seed: {
    id: 'seed',
    description: 'small checked-in sample: one 20-turn long-haul session + 2x10-turn isolation sessions',
    longHaul: [{ turns: 20, variant: 'mini' }],
    isolation: { turns: 10, variant: 'mini' },
  },
  smoke: {
    id: 'smoke',
    description: 'quick default: 100 and 200 turn long-haul sessions + 30-turn isolation group',
    longHaul: [
      { turns: 100, variant: 'full' },
      { turns: 200, variant: 'full' },
    ],
    isolation: { turns: 30, variant: 'full' },
  },
  standard: {
    id: 'standard',
    description: 'standard: 100, 200 and 500 turn long-haul sessions + isolation group',
    longHaul: [
      { turns: 100, variant: 'full' },
      { turns: 200, variant: 'full' },
      { turns: 500, variant: 'full' },
    ],
    isolation: { turns: 30, variant: 'full' },
  },
  full: {
    id: 'full',
    description: 'full: 100, 200, 500 and 1000 turn long-haul sessions + isolation group',
    longHaul: [
      { turns: 100, variant: 'full' },
      { turns: 200, variant: 'full' },
      { turns: 500, variant: 'full' },
      { turns: 1000, variant: 'full' },
    ],
    isolation: { turns: 40, variant: 'full' },
  },
})

/** @type {string[]} */
export const PROFILE_IDS = Object.keys(PROFILES)

/**
 * @param {string} profile
 * @returns {ProfileDefinition}
 */
export function resolveProfile(profile) {
  const definition = PROFILES[profile]
  if (definition === undefined) {
    throw new Error(`unknown fixture profile "${profile}" (expected one of: ${PROFILE_IDS.join(', ')})`)
  }
  return definition
}

/**
 * @param {number[]} turnsList
 * @returns {string}
 */
function turnsLabel(turnsList) {
  return turnsList.map((turns) => `${turns}`).join(',')
}

/**
 * Build the fixture bundle for a profile.
 *
 * @param {{
 *   profile?: string,
 *   seed?: string,
 *   turns?: number[] | null,
 * }} [options]
 * @returns {{ manifest: object, files: { path: string, content: string }[] }}
 */
export function generateFixtures(options = {}) {
  const profile = options.profile ?? DEFAULT_PROFILE
  const seed = options.seed ?? DEFAULT_SEED
  const definition = resolveProfile(profile)

  /** @type {{ turns: number, variant: 'full'|'mini' }[]} */
  let longHaulSpecs = definition.longHaul.map((spec) => ({ ...spec }))
  if (Array.isArray(options.turns) && options.turns.length > 0) {
    longHaulSpecs = options.turns.map((turns) => ({ turns, variant: 'full' }))
  }
  const minTurns = Math.min(...longHaulSpecs.map((spec) => spec.turns))
  const isolationSpec = {
    turns: Array.isArray(options.turns) ? Math.max(10, Math.round(minTurns * 0.3)) : definition.isolation.turns,
    variant: 'full',
  }

  const skill = buildSkillMarkdown()
  /** @type {{ path: string, content: string }[]} */
  const files = [{ path: SKILL_FILE, content: skill.content }]

  /** @type {object[]} */
  const sessionDescriptors = []
  /** @type {object[]} */
  const groups = []

  const longHaulSessions = []
  for (const spec of longHaulSpecs) {
    const built = buildLongHaulSession({ seed, turns: spec.turns, variant: spec.variant })
    longHaulSessions.push(built)
  }
  longHaulSessions.sort((a, b) => a.session.turns - b.session.turns)

  const isolationBuilt = buildIsolationGroup({ seed, turns: isolationSpec.turns, variant: isolationSpec.variant })
  groups.push(isolationBuilt.group)

  const allSessions = [...longHaulSessions.map((built) => built.session), ...isolationBuilt.sessions]
  const allKeys = [...longHaulSessions.map((built) => built.answerKey), ...isolationBuilt.answerKeys]

  for (let index = 0; index < allSessions.length; index += 1) {
    const session = allSessions[index]
    const answerKey = allKeys[index]
    const directory = `sessions/${session.sessionId}`
    const sessionPath = `${directory}/session.json`
    const answerKeyPath = `${directory}/answer-key.json`
    files.push({ path: sessionPath, content: `${JSON.stringify(session, null, 2)}\n` })
    files.push({ path: answerKeyPath, content: `${JSON.stringify(answerKey, null, 2)}\n` })
    sessionDescriptors.push({
      scenario: session.scenario,
      group: session.group ?? null,
      sessionId: session.sessionId,
      turns: session.turns,
      directory,
      files: { session: sessionPath, answerKey: answerKeyPath },
      eventEntries: session.events.length,
      uniqueEvents: session.meta.uniqueEvents,
      questionCount: answerKey.questions.length,
      compactions: session.meta.compactions,
      restarts: session.meta.restarts,
      variant: session.variant,
    })
  }

  const longHaulTurns = longHaulSessions.map((built) => built.session.turns)
  const manifest = {
    format: MANIFEST_FORMAT,
    version: 1,
    generatorVersion: GENERATOR_VERSION,
    profile,
    seed,
    logicalStart: LOGICAL_START,
    variant: 'synthetic',
    skill: { name: SKILL_NAME, path: SKILL_FILE },
    profiles: PROFILE_IDS,
    longHaulTurns,
    groupProfile: groups[0]?.group ?? null,
    sessions: sessionDescriptors,
    groups,
    totals: {
      sessions: sessionDescriptors.length,
      longHaulSessions: longHaulSessions.length,
      isolationSessions: isolationBuilt.sessions.length,
      turns: sessionDescriptors.reduce((sum, descriptor) => sum + descriptor.turns, 0),
      uniqueEvents: sessionDescriptors.reduce((sum, descriptor) => sum + descriptor.uniqueEvents, 0),
      rawEventEntries: sessionDescriptors.reduce((sum, descriptor) => sum + descriptor.eventEntries, 0),
      questions: sessionDescriptors.reduce((sum, descriptor) => sum + descriptor.questionCount, 0),
    },
    formats: { session: SESSION_FORMAT, answerKey: ANSWER_KEY_FORMAT },
    notes: [
      'Generated data is deterministic for a given (profile, seed, turns).',
      'Answer keys are independent of the evaluation harness: they are derived from the fixture definition, not from the answer path.',
      'Large generated fixtures belong in tests/fixtures/generated/ (gitignored); only the small seed profile is checked in.',
    ],
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return { manifest, files }
}

/**
 * Human readable label for a turns override, used in logs/reports.
 *
 * @param {number[] | null | undefined} turns
 * @returns {string | null}
 */
export function describeTurnsOverride(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return null
  return turnsLabel(turns)
}
