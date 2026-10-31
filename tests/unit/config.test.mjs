/**
 * Unit tests for src/config.js — frozen defaults, deep merge, clamping,
 * passthrough of unknown keys and the schemastery schema builder (which must
 * work without importing the optional host package).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  DEFAULT_SOFT_BUDGET_TOKENS,
  PLUGIN_ID,
  buildSchemasterySchema,
  clampInt,
  clampNumber,
  isPlainObject,
  merge,
  normalizeConfig,
} from '../../src/config.js'

/**
 * Minimal stand-in for the schemastery module. Records the node tree so the
 * test can assert on the declared shape instead of a rendered schema.
 */
function makeFakeSchemastery() {
  const makeNode = (kind, extra = {}) => {
    const node = { kind, ...extra }
    const api = {
      __node: node,
      default(value) {
        node.defaultValue = value
        return api
      },
    }
    return api
  }
  return {
    object(shape) {
      return makeNode('object', { shape })
    },
    number() {
      return makeNode('number')
    },
    boolean() {
      return makeNode('boolean')
    },
    string() {
      return makeNode('string')
    },
    array(inner) {
      return makeNode('array', { inner: inner?.__node ?? null })
    },
    any() {
      return makeNode('any')
    },
  }
}

test('defaults are deeply frozen and expose the documented constants', () => {
  assert.equal(PLUGIN_ID, 'long-memory')
  assert.equal(DEFAULT_SOFT_BUDGET_TOKENS, 3000)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.assembly), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.archive.archiveTypes), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.skills.include), true)
  assert.throws(() => {
    DEFAULT_CONFIG.assembly.softBudgetTokens = 1
  }, TypeError)
  assert.throws(() => {
    DEFAULT_CONFIG.archive.archiveTypes.push('turn/start')
  }, TypeError)
})

test('normalizeConfig returns defaults and never mutates frozen defaults', () => {
  const normalized = normalizeConfig()
  assert.deepEqual(normalized, DEFAULT_CONFIG)
  assert.notEqual(normalized, DEFAULT_CONFIG)
  // Default arrays are deep-frozen; the merge keeps the frozen reference so a
  // caller cannot corrupt the shared defaults.
  assert.equal(Object.isFrozen(normalized.archive.archiveTypes), true)
  assert.throws(() => normalized.archive.archiveTypes.push('turn/start'), TypeError)
  // An explicit array override produces a fresh, mutable array.
  const overridden = normalizeConfig({ archive: { archiveTypes: ['tool/result'] } })
  assert.deepEqual(overridden.archive.archiveTypes, ['tool/result'])
  assert.equal(Object.isFrozen(overridden.archive.archiveTypes), false)
  overridden.archive.archiveTypes.push('turn/start')
  assert.deepEqual(overridden.archive.archiveTypes, ['tool/result', 'turn/start'])
  assert.deepEqual(DEFAULT_CONFIG.archive.archiveTypes, ['tool/result', 'compaction/summary'])
})

test('normalizeConfig accepts missing or non-object input', () => {
  for (const input of [undefined, null, 'nope', 42, []]) {
    const normalized = normalizeConfig(input)
    assert.equal(normalized.assembly.softBudgetTokens, 3000)
    assert.equal(normalized.dbFile, 'memory.sqlite')
  }
})

test('normalizeConfig deep-merges partial sections over defaults', () => {
  const normalized = normalizeConfig({
    assembly: { softBudgetTokens: 5000 },
    retrieval: { minScore: 1.5 },
  })
  assert.equal(normalized.assembly.softBudgetTokens, 5000)
  assert.equal(normalized.assembly.maxMemoryItems, 40)
  assert.equal(normalized.assembly.minBudgetTokens, 600)
  assert.equal(normalized.retrieval.minScore, 1.5)
  assert.equal(normalized.retrieval.limit, 24)
})

test('normalizeConfig does not mutate the caller input', () => {
  const input = { assembly: { softBudgetTokens: 5000 }, skills: { include: ['a'] } }
  normalizeConfig(input)
  assert.deepEqual(input, { assembly: { softBudgetTokens: 5000 }, skills: { include: ['a'] } })
})

test('normalizeConfig clamps the assembly budget and item caps', () => {
  assert.equal(normalizeConfig({ assembly: { softBudgetTokens: 100 } }).assembly.softBudgetTokens, 200)
  assert.equal(normalizeConfig({ assembly: { softBudgetTokens: 999999 } }).assembly.softBudgetTokens, 20000)
  assert.equal(normalizeConfig({ assembly: { softBudgetTokens: 'abc' } }).assembly.softBudgetTokens, 3000)
  assert.equal(normalizeConfig({ assembly: { softBudgetTokens: 4321.9 } }).assembly.softBudgetTokens, 4321)
  assert.equal(normalizeConfig({ assembly: { minBudgetTokens: 50 } }).assembly.minBudgetTokens, 100)
  assert.equal(
    normalizeConfig({ assembly: { softBudgetTokens: 500, minBudgetTokens: 900 } }).assembly.minBudgetTokens,
    500,
  )
  assert.equal(normalizeConfig({ assembly: { maxMemoryItems: 0 } }).assembly.maxMemoryItems, 1)
  assert.equal(normalizeConfig({ assembly: { maxMemoryItems: 1000 } }).assembly.maxMemoryItems, 200)
  assert.equal(normalizeConfig({ assembly: { maxRules: -5 } }).assembly.maxRules, 0)
  assert.equal(normalizeConfig({ assembly: { maxEvidence: 1000 } }).assembly.maxEvidence, 100)
  assert.equal(
    normalizeConfig({ assembly: { reinjectUnchangedTurns: 5000 } }).assembly.reinjectUnchangedTurns,
    1000,
  )
})

test('normalizeConfig clamps retrieval tuning values', () => {
  const normalized = normalizeConfig({
    retrieval: {
      limit: 1000,
      exactMatchBoost: -1,
      scopeBoost: 30,
      recencyBoost: 10,
      minScore: 'bad',
    },
  })
  assert.equal(normalized.retrieval.limit, 200)
  assert.equal(normalized.retrieval.exactMatchBoost, 0)
  assert.equal(normalized.retrieval.scopeBoost, 20)
  assert.equal(normalized.retrieval.recencyBoost, 5)
  assert.equal(normalized.retrieval.minScore, 0.5)
  assert.equal(normalizeConfig({ retrieval: { limit: 0 } }).retrieval.limit, 1)
})

test('normalizeConfig clamps diagnostics, archive, skills and validation', () => {
  const normalized = normalizeConfig({
    diagnostics: { assemblyLogRetention: 5 },
    archive: { maxCharsPerEvent: 10 },
    skills: { residentCoreMaxChars: 10, maxRuleChars: 999999 },
    validation: { maxRepairAttempts: 99, checks: 'nope', preconditions: {} },
  })
  assert.equal(normalized.diagnostics.assemblyLogRetention, 10)
  assert.equal(normalized.archive.maxCharsPerEvent, 200)
  assert.equal(normalized.skills.residentCoreMaxChars, 200)
  assert.equal(normalized.skills.maxRuleChars, 20000)
  assert.equal(normalized.validation.maxRepairAttempts, 10)
  assert.deepEqual(normalized.validation.checks, [])
  assert.deepEqual(normalized.validation.preconditions, [])
})

test('normalizeConfig sanitizes scalar fields and enums', () => {
  assert.equal(normalizeConfig({ dbFile: '' }).dbFile, 'memory.sqlite')
  assert.equal(normalizeConfig({ dbFile: 42 }).dbFile, 'memory.sqlite')
  assert.equal(normalizeConfig({ dataDir: 42 }).dataDir, '')
  assert.equal(normalizeConfig({ dataDir: '/tmp/data' }).dataDir, '/tmp/data')
  assert.equal(normalizeConfig({ includeSubagents: 'true' }).includeSubagents, false)
  assert.equal(normalizeConfig({ includeSubagents: true }).includeSubagents, true)
  assert.equal(
    normalizeConfig({ compatibility: { compactionPolicy: 'billion-context' } }).compatibility.compactionPolicy,
    'billion-context',
  )
  assert.equal(
    normalizeConfig({ compatibility: { compactionPolicy: 'weird' } }).compatibility.compactionPolicy,
    'auto',
  )
  assert.equal(normalizeConfig({ compatibility: { compactionPolicy: 'none' } }).compatibility.compactionPolicy, 'none')
})

test('unknown keys survive normalization for forward compatibility', () => {
  const normalized = normalizeConfig({
    experimentalFlag: true,
    assembly: { experimentalBudget: 7 },
    skills: { include: ['a', 'b'] },
  })
  assert.equal(normalized.experimentalFlag, true)
  assert.equal(normalized.assembly.experimentalBudget, 7)
  assert.equal(normalized.assembly.softBudgetTokens, 3000)
  // Arrays are replaced, never concatenated.
  assert.deepEqual(normalized.skills.include, ['a', 'b'])
})

test('isPlainObject accepts any non-array object (config semantics)', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject(new (class Foo {})()), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject('x'), false)
})

test('merge is recursive, replaces arrays and leaves the base untouched', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], value: 1 }
  const merged = merge(base, { a: { b: 9 }, list: [3], value: 2 })
  assert.deepEqual(merged, { a: { b: 9, c: 2 }, list: [3], value: 2 })
  assert.deepEqual(base, { a: { b: 1, c: 2 }, list: [1, 2], value: 1 })
  assert.deepEqual(merge({ a: 1 }, undefined), { a: 1 })
  assert.deepEqual(merge([1, 2], [3]), [3])
  assert.deepEqual(merge(null, { a: 1 }), { a: 1 })
})

test('clampInt and clampNumber bound and truncate values', () => {
  assert.equal(clampInt('42', 0, 100, 7), 42)
  assert.equal(clampInt(1.9, 0, 100, 7), 1)
  assert.equal(clampInt(Number.NaN, 0, 100, 7), 7)
  assert.equal(clampInt(500, 0, 100, 7), 100)
  assert.equal(clampNumber('1.5', 0, 2, 0), 1.5)
  assert.equal(clampNumber(Number.POSITIVE_INFINITY, 0, 2, 0.5), 0.5)
  assert.equal(clampNumber(-3, 0, 2, 0.5), 0)
})

test('buildSchemasterySchema builds the documented shape without the host', () => {
  const z = makeFakeSchemastery()
  const schema = buildSchemasterySchema(z)
  assert.equal(schema.__node.kind, 'object')
  const shape = schema.__node.shape
  assert.deepEqual(Object.keys(shape).sort(), [
    'archive',
    'assembly',
    'commands',
    'compatibility',
    'dataDir',
    'dbFile',
    'diagnostics',
    'enabled',
    'extraction',
    'includeSubagents',
    'retrieval',
    'skills',
    'validation',
  ])
  assert.equal(shape.enabled.__node.kind, 'boolean')
  assert.equal(shape.enabled.__node.defaultValue, true)
  assert.equal(shape.dbFile.__node.kind, 'string')
  assert.equal(shape.dbFile.__node.defaultValue, 'memory.sqlite')
  assert.equal(shape.includeSubagents.__node.defaultValue, false)

  const assembly = shape.assembly.__node.shape
  assert.equal(assembly.softBudgetTokens.__node.kind, 'number')
  assert.equal(assembly.softBudgetTokens.__node.defaultValue, DEFAULT_SOFT_BUDGET_TOKENS)
  assert.equal(assembly.minBudgetTokens.__node.defaultValue, 600)
  assert.equal(assembly.maxRules.__node.defaultValue, 12)

  const validation = shape.validation.__node.shape
  assert.equal(validation.checks.__node.kind, 'array')
  assert.equal(validation.checks.__node.inner.kind, 'any')
  assert.deepEqual(validation.checks.__node.defaultValue, [])

  const archive = shape.archive.__node.shape
  assert.equal(archive.archiveTypes.__node.kind, 'array')
  assert.equal(archive.archiveTypes.__node.inner.kind, 'string')
  assert.deepEqual(archive.archiveTypes.__node.defaultValue, ['tool/result', 'compaction/summary'])

  const compatibility = shape.compatibility.__node.shape
  assert.equal(compatibility.compactionPolicy.__node.defaultValue, 'auto')
})

test('buildSchemasterySchema unwraps a module namespace with default export', () => {
  const z = makeFakeSchemastery()
  const schema = buildSchemasterySchema({ default: z })
  assert.equal(schema.__node.kind, 'object')
  assert.equal(schema.__node.shape.assembly.__node.shape.maxEvidence.__node.defaultValue, 8)
})
