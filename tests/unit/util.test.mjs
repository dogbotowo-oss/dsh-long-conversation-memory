/**
 * Unit tests for src/core/util.js — hashing, stable JSON, text normalization,
 * tokenization, number extraction and token estimation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clamp,
  clampText,
  contentBlocksToText,
  containsCjk,
  estimateTokens,
  escapeLike,
  extractNumbers,
  includesCaseInsensitive,
  isIsoTimestamp,
  isPlainObject,
  normalizeText,
  nowIso,
  oneLine,
  parseJson,
  sha256,
  stableId,
  stableStringify,
  takeLines,
  toIso,
  tokenize,
  toStringArray,
  truncateMiddle,
  uniqueBy,
  uuid,
} from '../../src/core/util.js'

test('sha256 is stable lowercase hex for the same input', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256('abc'), sha256('abc'))
  assert.match(sha256(''), /^[0-9a-f]{64}$/)
  assert.notEqual(sha256('abc'), sha256('abd'))
  assert.match(sha256('记忆'), /^[0-9a-f]{64}$/)
})

test('stableStringify sorts object keys recursively but keeps array order', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ a: 2, b: 1 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ b: { d: 4, c: 3 }, a: 1 }), '{"a":1,"b":{"c":3,"d":4}}')
  assert.equal(stableStringify([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]')
  assert.equal(stableStringify([1, 2, 3]), '[1,2,3]')
  assert.equal(stableStringify('text'), '"text"')
  assert.equal(stableStringify(42), '42')
})

test('stableId composes prefix, truncated session id and content hash', () => {
  assert.equal(stableId('mem', 'sess-01!', '0123456789abcdef99'), 'mem_sess01_0123456789abcdef')
  assert.equal(stableId('mem', '', 'abcdef0123456789ff'), 'mem_session_abcdef0123456789')
  // Non-alphanumeric characters never leak into the id.
  assert.doesNotMatch(stableId('mem', '中文/会话 id', 'ffffffffffffffff'), /[^A-Za-z0-9_]/)
})

test('time helpers produce ISO-8601 strings', () => {
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z')
  assert.equal(toIso(Date.UTC(2024, 0, 2, 3, 4, 5)), '2024-01-02T03:04:05.000Z')
  const now = nowIso()
  assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(isIsoTimestamp(now), true)
  assert.equal(isIsoTimestamp('2024-01-01T00:00:00Z'), true)
  assert.equal(isIsoTimestamp('not-a-date'), false)
  assert.equal(isIsoTimestamp(123), false)
})

test('uuid returns a v4 uuid', () => {
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(uuid(), uuid())
})

test('normalizeText canonicalizes whitespace without touching the CJK body', () => {
  assert.equal(normalizeText('  a\r\n\r\n\r\n b\t\tc  '), 'a\n\n b c')
  assert.equal(normalizeText('a\rb'), 'a\nb')
  assert.equal(normalizeText(''), '')
  assert.equal(normalizeText(null), '')
  assert.equal(normalizeText('准确率  79.87%'), '准确率 79.87%')
})

test('clampText keeps short text and truncates with an ellipsis', () => {
  assert.equal(clampText('abc', 10), 'abc')
  assert.equal(clampText('abcdef', 6), 'abcdef')
  const truncated = clampText('abcdef', 4)
  assert.equal(truncated, 'abc…')
  assert.equal(truncated.length, 4)
  assert.equal(clampText(null, 4), '')
})

test('contentBlocksToText flattens DSH content blocks deterministically', () => {
  assert.equal(contentBlocksToText('plain string'), 'plain string')
  assert.equal(contentBlocksToText([{ type: 'text', text: 'hi' }]), 'hi')
  assert.equal(
    contentBlocksToText([
      { type: 'text', text: 'hi' },
      { type: 'image' },
      { type: 'image_url', url: 'x' },
      { type: 'file', path: 'a.pdf' },
      { type: 'tool_call', name: 'grep' },
      { type: 'weird' },
    ]),
    'hi\n[image]\n[image]\n[file a.pdf]\n[tool_call grep]\n[weird]',
  )
  assert.equal(contentBlocksToText([]), '')
  assert.equal(contentBlocksToText(null), '')
  assert.equal(contentBlocksToText({ type: 'text' }), '')
})

test('containsCjk distinguishes CJK from latin text', () => {
  assert.equal(containsCjk('会话记忆'), true)
  assert.equal(containsCjk('plain ascii'), false)
  assert.equal(containsCjk('mixed 中文 text'), true)
  assert.equal(containsCjk(''), false)
})

test('tokenize keeps latin words whole and splits CJK runs into bigrams', () => {
  assert.deepEqual(tokenize('准确率 79.87% 在 v3 模型'), ['79.87', 'v3', '准确', '确率', '在', '模型'])
  assert.deepEqual(tokenize('Alpha beta'), ['alpha', 'beta'])
  assert.deepEqual(tokenize('a b'), [])
  assert.deepEqual(tokenize('中文'), ['中文'])
  assert.deepEqual(tokenize('记忆系统'), ['记忆', '忆系', '系统'])
  assert.deepEqual(tokenize('Alpha alpha ALPHA'), ['alpha'])
  assert.deepEqual(tokenize('x', { maxTokens: 1 }), [])
})

test('extractNumbers captures raw value unit and index', () => {
  const numbers = extractNumbers('准确率 79.87% 在 v3 模型、处理 120 页，耗时 -1.5 s')
  const byRaw = new Map(numbers.map((number) => [number.raw, number]))
  assert.equal(byRaw.get('79.87%')?.value, 79.87)
  assert.equal(byRaw.get('79.87%')?.unit, '%')
  assert.equal(byRaw.get('120 页')?.unit, '页')
  assert.equal(byRaw.get('-1.5 s')?.unit, 's')
  assert.equal(byRaw.get('-1.5 s')?.value, -1.5)
  assert.equal(typeof numbers[0].index, 'number')
  assert.equal(numbers[0].index, '准确率 '.length)
  assert.deepEqual(extractNumbers('no numbers here'), [])
  const many = extractNumbers(Array.from({ length: 80 }, (_, index) => `${index}`).join(' '))
  assert.equal(many.length, 50)
})

test('estimateTokens charges CJK more per character than latin', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('中文abcd'), 3)
  const cjk = '一'.repeat(100)
  const latin = 'a'.repeat(100)
  assert.ok(estimateTokens(cjk) > estimateTokens(latin))
  assert.equal(estimateTokens(cjk), Math.ceil(100 / 1.6))
})

test('oneLine flattens whitespace and clamps', () => {
  assert.equal(oneLine('  a\n b\t c '), 'a b c')
  assert.equal(oneLine('a'.repeat(20), 5), 'aaaa…')
  assert.equal(oneLine(null), '')
})

test('toStringArray and parseJson are defensive', () => {
  assert.deepEqual(toStringArray(['a', '', 1]), ['a', '1'])
  assert.deepEqual(toStringArray('a'), [])
  assert.deepEqual(toStringArray(null, ['fallback']), ['fallback'])
  assert.deepEqual(parseJson('{"a":1}', {}), { a: 1 })
  assert.deepEqual(parseJson('not json', { safe: true }), { safe: true })
  assert.deepEqual(parseJson('', ['fallback']), ['fallback'])
  assert.deepEqual(parseJson('null', { fallback: true }), null)
})

test('escapeLike escapes backslash percent and underscore', () => {
  assert.equal(escapeLike('50%_a\\b'), '50\\%\\_a\\\\b')
  assert.equal(escapeLike('plain'), 'plain')
})

test('clamp bounds finite numbers and maps non-finite to min', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(15, 0, 10), 10)
  assert.equal(clamp(Number.NaN, 2, 10), 2)
  assert.equal(clamp(Number.POSITIVE_INFINITY, 2, 10), 2)
})

test('uniqueBy keeps the first item for each key', () => {
  const list = [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
    { id: 'a', value: 3 },
  ]
  assert.deepEqual(uniqueBy(list, (item) => item.id), [
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
  ])
  assert.deepEqual(uniqueBy([], (item) => item), [])
})

test('truncateMiddle and takeLines shorten long output', () => {
  assert.equal(truncateMiddle('abcdefghij', 6), 'ab…ij')
  assert.equal(truncateMiddle('abc', 6), 'abc')
  assert.equal(takeLines('a\nb\nc', 2), 'a\nb\n…')
  assert.equal(takeLines('a\nb', 5), 'a\nb')
})

test('isPlainObject accepts only plain objects', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject('x'), false)
  assert.equal(isPlainObject(new (class Foo {})()), false)
})

test('includesCaseInsensitive matches case-insensitively and rejects empty needles', () => {
  assert.equal(includesCaseInsensitive('Accuracy 79.87%', 'accuracy'), true)
  assert.equal(includesCaseInsensitive('Accuracy', 'missing'), false)
  assert.equal(includesCaseInsensitive('Accuracy', ''), false)
})
