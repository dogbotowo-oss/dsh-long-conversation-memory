/**
 * Unit tests for src/memory/extraction.js — sentence/classification helpers
 * and the SessionExtractor that turns captured events into memory items and
 * task state.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { sha256 } from '../../src/core/util.js'
import {
  CONSTRAINT_MARKERS,
  CORRECTION_MARKERS,
  DECISION_MARKERS,
  PREFERENCE_MARKERS,
  SessionExtractor,
  classifySentence,
  correctionTargetsCandidate,
  detectCorrections,
  detectTaskClears,
  extractAssistantProposals,
  extractTaskPatch,
  extractUserMemories,
  qualificationClauses,
  splitSentences,
} from '../../src/memory/extraction.js'
import { normalizeConfig } from '../../src/config.js'
import { createMemoryStore } from './_helpers.mjs'

/** Build an event record for direct store ingestion. */
function eventRecord(sessionId, seq, type, text, extra = {}) {
  return {
    sessionId,
    seq,
    type,
    time: '2024-01-01T00:00:00.000Z',
    turn: 1,
    step: 1,
    role: type === 'user/message' ? 'user' : 'assistant',
    text,
    sourceKind: null,
    sourceForm: null,
    toolName: null,
    callId: null,
    store: 'host',
    contentHash: text ? sha256(text) : null,
    truncated: false,
    ...extra,
  }
}

/** Create an extractor bound to a fresh in-memory store. */
function createExtractor(config = {}) {
  const created = createMemoryStore({ config })
  const extractor = new SessionExtractor(created.store, { config: created.config })
  return { ...created, extractor }
}

const CORRECTION_TEXT = '更正：准确率不是 79.87%，实际是 81.20%，在 v3 模型、测试集 S2 的口径下。'

test('marker tables are non-empty and exported', () => {
  for (const markers of [CORRECTION_MARKERS, DECISION_MARKERS, CONSTRAINT_MARKERS, PREFERENCE_MARKERS]) {
    assert.ok(Array.isArray(markers) && markers.length > 0)
  }
  assert.ok(CORRECTION_MARKERS.includes('更正'))
  assert.ok(DECISION_MARKERS.includes('决定'))
  assert.ok(CONSTRAINT_MARKERS.includes('必须'))
  assert.ok(PREFERENCE_MARKERS.includes('更喜欢'))
})

test('splitSentences splits CJK punctuation and keeps every unit', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？'])
  assert.deepEqual(splitSentences('one. two. three.'), ['one.', 'two.', 'three.'])
  assert.deepEqual(splitSentences('   '), [])
  assert.deepEqual(splitSentences(''), [])
  const long = `${'x'.repeat(450)}。`
  const chunks = splitSentences(long)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((chunk) => chunk.length <= 400))
})

test('detectCorrections finds the marker, numbers and old values', () => {
  const corrections = detectCorrections(CORRECTION_TEXT)
  assert.equal(corrections.length, 1)
  const correction = corrections[0]
  assert.equal(correction.sentence, CORRECTION_TEXT)
  assert.equal(correction.marker, '不是')
  assert.ok(correction.numbers.some((number) => number.raw === '79.87%'))
  assert.ok(correction.oldValues.includes('79.87%'))
  assert.deepEqual(detectCorrections('这是一句普通陈述，没有更正。'), [])
  assert.deepEqual(detectCorrections(''), [])
})

test('correctionTargetsCandidate matches old values and false positives', () => {
  const correction = detectCorrections(CORRECTION_TEXT)[0]
  assert.equal(correctionTargetsCandidate({ numbers: [{ raw: '79.87%' }], content: '旧值' }, correction), true)
  assert.equal(correctionTargetsCandidate({ numbers: [{ raw: '55%' }], content: '无关' }, correction), false)
  // Falls back to extracting numbers from the candidate content.
  assert.equal(correctionTargetsCandidate({ content: '准确率是 79.87% 的记录' }, correction), true)
})

test('qualificationClauses captures scope and number units', () => {
  const clauses = qualificationClauses(CORRECTION_TEXT)
  assert.ok(clauses.length >= 1)
  assert.ok(clauses.some((clause) => clause.includes('口径')))
  assert.ok(clauses.some((clause) => clause.startsWith('unit: %')))
  assert.deepEqual(qualificationClauses('普通的一句话。'), [])
})

test('classifySentence maps markers to memory kinds', () => {
  assert.equal(classifySentence('决定：采用 v3 模型作为主结果。'), 'decision')
  assert.equal(classifySentence('必须保留两位小数。'), 'constraint')
  assert.equal(classifySentence('我更喜欢用中文写报告。'), 'preference')
  assert.equal(classifySentence('是否要把阈值设为 0.8？'), 'open_question')
  assert.equal(classifySentence('准确率 81.20%。'), 'fact')
  assert.equal(classifySentence(CORRECTION_TEXT), 'fact')
})

test('extractTaskPatch reads labelled task lines', () => {
  const patch = extractTaskPatch(
    '目标：把摘要指标补全。\n进度：已完成初稿。\n阻塞：等待 GPU 资源。\n待办：补充消融实验。',
  )
  assert.equal(patch.goal, '把摘要指标补全。')
  assert.deepEqual(patch.progress, ['已完成初稿。'])
  assert.deepEqual(patch.blockers, ['等待 GPU 资源。'])
  assert.deepEqual(patch.openItems, ['补充消融实验。'])
  assert.deepEqual(extractTaskPatch('没有标签的普通文字'), {})
})

test('detectTaskClears recognises completion, unblock and cancel', () => {
  const unblock = detectTaskClears('阻塞已解除：等待 GPU 资源。')
  assert.equal(unblock.length, 1)
  assert.equal(unblock[0].op, 'unblock')
  assert.equal(unblock[0].subject, '等待 GPU 资源')

  const noLonger = detectTaskClears('不再阻塞：GPU 资源。')
  assert.equal(noLonger[0].op, 'unblock')
  assert.equal(noLonger[0].subject, 'GPU 资源')

  const complete = detectTaskClears('已完成初稿。')
  assert.ok(complete.length >= 1)
  assert.ok(complete.every((clear) => clear.op === 'complete'))
  assert.equal(complete[0].subject, '初稿')

  const cancel = detectTaskClears('取消：补充消融实验。')
  assert.equal(cancel.length, 1)
  assert.equal(cancel[0].op, 'cancel')
  assert.equal(cancel[0].subject, '补充消融实验')

  assert.deepEqual(detectTaskClears('今天天气不错。'), [])
})

test('extractUserMemories classifies kinds and keeps conditions', () => {
  const items = extractUserMemories(
    `${CORRECTION_TEXT}\n决定：采用 v3 模型作为主结果。\n必须保留两位小数。\n我更喜欢用中文写报告。\n是否要把阈值设为 0.8？`,
    { seq: 2 },
  )
  assert.ok(items.length >= 5)
  assert.equal(items[0].kind, 'fact')
  assert.equal(items[0].extractor, 'correction')
  assert.deepEqual(items[0].corrections[0].oldValues, ['79.87%'])
  assert.ok(items[0].conditions.length >= 1)

  const decision = items.find((item) => item.kind === 'decision')
  assert.ok(decision && decision.content.includes('采用 v3 模型'))
  const constraint = items.find((item) => item.kind === 'constraint')
  assert.ok(constraint && constraint.content.includes('两位小数'))
  const preference = items.find((item) => item.kind === 'preference')
  assert.ok(preference && preference.content.includes('中文'))
  const question = items.find((item) => item.kind === 'open_question')
  assert.ok(question && question.content.includes('阈值'))
  assert.ok(items.every((item) => item.evidenceType === 'user_explicit'))
  assert.ok(items.every((item) => item.derivedFromSeq === 2))

  // Plain sentences without markers or numbers are not memories.
  assert.deepEqual(extractUserMemories('你好，今天过得怎么样呢。', { seq: 1 }), [])
  // A bare open question without a number is dropped.
  assert.deepEqual(extractUserMemories('是否要补充消融实验？', { seq: 1 }), [])
})

test('numbers keep their qualification conditions', () => {
  const items = extractUserMemories('准确率 81.20% 是在 v3 模型、测试集 S2、单次运行的口径下统计的。', { seq: 1 })
  assert.equal(items.length, 1)
  const item = items[0]
  assert.equal(item.extractor, 'number')
  assert.equal(item.numbers[0].raw, '81.20%')
  assert.ok(item.numbers.some((number) => number.raw === '81.20%'))
  assert.ok(item.conditions.some((clause) => clause.includes('口径') || clause.includes('v3 模型')))
})

test('extractAssistantProposals never produces decisions', () => {
  const proposals = extractAssistantProposals('建议先跑 v3 模型的消融实验。方案：采用分块统计。普通陈述。', { seq: 3 })
  assert.ok(proposals.length >= 2)
  for (const proposal of proposals) {
    assert.equal(proposal.kind, 'proposal')
    assert.equal(proposal.evidenceType, 'assistant_proposal')
    assert.equal(proposal.extractor, 'proposal')
  }
  assert.ok(proposals.every((proposal) => proposal.kind !== 'decision'))

  const many = extractAssistantProposals(
    Array.from({ length: 6 }, (_, index) => `建议方案 ${index} 可以尝试。`).join(''),
    { seq: 1 },
  )
  assert.equal(many.length, 4)
})

test('extractPending updates task state and is idempotent', () => {
  const { store, sessionId, extractor } = createExtractor()
  store.recordEvents([eventRecord(sessionId, 1, 'user/message', '目标：把摘要指标补全。\n阻塞：等待 GPU 资源。')])

  const first = extractor.extractPending(sessionId)
  assert.deepEqual(first, { processed: 1, created: 0, superseded: 0, errors: [], lastSeq: 1 })
  const state = store.getTaskState(sessionId)
  assert.equal(state.goal, '把摘要指标补全。')
  assert.deepEqual(state.blockers, ['等待 GPU 资源。'])
  assert.equal(state.updatedBySeq, 1)
  assert.deepEqual(store.getCheckpoint(sessionId).lastExtractSeq, 1)

  // Re-running without new events is a no-op (checkpoint guard).
  publicIdempotent(extractor.extractPending(sessionId))
  // Only the new event is processed on the next run.
  store.recordEvents([eventRecord(sessionId, 2, 'user/message', '进度：已完成初稿。')])
  const third = extractor.extractPending(sessionId)
  assert.equal(third.processed, 1)
  assert.equal(third.lastSeq, 2)
  assert.deepEqual(store.getTaskState(sessionId).progress, ['已完成初稿。'])
})

/** Assert the zero-work shape of a repeated extraction run. */
function publicIdempotent(result) {
  assert.equal(result.processed, 0)
  assert.equal(result.created, 0)
  assert.equal(result.superseded, 0)
}

test('task clearing removes blockers and records superseded history', () => {
  const { store, sessionId, extractor } = createExtractor()
  store.recordEvents([eventRecord(sessionId, 1, 'user/message', '阻塞：等待 GPU 资源。')])
  extractor.extractPending(sessionId)
  assert.deepEqual(store.getTaskState(sessionId).blockers, ['等待 GPU 资源。'])

  store.recordEvents([eventRecord(sessionId, 2, 'user/message', '阻塞已解除：等待 GPU 资源。')])
  extractor.extractPending(sessionId)
  const state = store.getTaskState(sessionId)
  assert.deepEqual(state.blockers, [])
  assert.equal(state.superseded.length, 1)
  assert.match(state.superseded[0], /^blockers: 等待 GPU 资源/)
  assert.match(state.superseded[0], /unblock @seq:2/)
  assert.equal(state.updatedBySeq, 2)
})

test('correction supersedes the older fact in the same session', () => {
  const { store, sessionId, extractor } = createExtractor()
  const old = store.insertMemoryItem(sessionId, {
    kind: 'fact',
    content: '准确率 79.87%，在 v3 模型、测试集 S2、单次运行的口径下统计的。',
    conditions: ['统计口径'],
    evidenceType: 'user_explicit',
    extractor: 'number',
    numbers: [{ raw: '79.87%', value: 79.87, unit: '%' }],
    sourceRefs: ['seq:1'],
    derivedFromSeq: 1,
  }).item

  store.recordEvents([eventRecord(sessionId, 2, 'user/message', CORRECTION_TEXT)])
  const result = extractor.extractPending(sessionId)
  assert.equal(result.created, 1)
  assert.equal(result.superseded, 1)

  const oldAfter = store.getMemoryItem(old.id)
  assert.equal(oldAfter.status, 'superseded')
  const replacement = store.getMemoryItem(oldAfter.supersededBy)
  assert.equal(replacement.status, 'active')
  assert.equal(replacement.extractor, 'correction')
  assert.match(replacement.content, /81\.20%/)
  assert.match(replacement.content, /更正/)
})

test('assistant messages produce proposals, not decisions', () => {
  const { store, sessionId, extractor } = createExtractor()
  store.recordEvents([eventRecord(sessionId, 1, 'assistant/message', '建议先跑 v3 模型的消融实验。方案：采用分块统计。')])
  const result = extractor.extractPending(sessionId)
  assert.equal(result.created, 2)
  const items = store.listMemoryItems(sessionId)
  assert.equal(items.length, 2)
  for (const item of items) {
    assert.equal(item.kind, 'proposal')
    assert.equal(item.evidenceType, 'assistant_proposal')
    assert.equal(item.extractor, 'proposal')
  }
})

test('recordAssistantProposals can be disabled by config', () => {
  const { store, sessionId } = createExtractor({ extraction: { recordAssistantProposals: false } })
  const extractor = new SessionExtractor(store, { config: normalizeConfig({ extraction: { recordAssistantProposals: false } }) })
  store.recordEvents([eventRecord(sessionId, 1, 'assistant/message', '建议先跑消融实验。')])
  assert.deepEqual(extractor.extractPending(sessionId), { processed: 1, created: 0, superseded: 0, errors: [], lastSeq: 1 })
  assert.equal(store.listMemoryItems(sessionId).length, 0)
})

test('only genuine user messages are extracted', () => {
  const { store, sessionId, extractor } = createExtractor()
  store.recordEvents([
    eventRecord(sessionId, 1, 'user/message', '注入的记忆内容 42%', { sourceKind: 'long-conversation-memory' }),
    eventRecord(sessionId, 2, 'user/message', '运行时上下文 42%', { sourceKind: 'runtime-context' }),
    eventRecord(sessionId, 3, 'user/message', '决定：采用 v3 模型。', { sourceKind: 'user' }),
    eventRecord(sessionId, 4, 'tool/result', '准确率 81.20% 的结果行'),
    eventRecord(sessionId, 5, 'turn/start', null),
  ])
  const result = extractor.extractPending(sessionId)
  assert.equal(result.processed, 5)
  const items = store.listMemoryItems(sessionId)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'decision')
  assert.equal(items[0].derivedFromSeq, 3)
})

test('extractPending respects extraction.enabled = false', () => {
  const { store, sessionId } = createMemoryStore({ config: { extraction: { enabled: false } } })
  const extractor = new SessionExtractor(store, { config: normalizeConfig({ extraction: { enabled: false } }) })
  store.recordEvents([eventRecord(sessionId, 1, 'user/message', '决定：采用 v3 模型。')])
  assert.deepEqual(extractor.extractPending(sessionId), { processed: 0, created: 0, superseded: 0, errors: [], lastSeq: -1 })
  assert.equal(store.listMemoryItems(sessionId).length, 0)
  assert.deepEqual(store.getCheckpoint(sessionId).lastExtractSeq, -1)
})

test('extractPending clears stale pending-extraction markers for processed events', () => {
  const { store, sessionId, extractor } = createExtractor()
  store.recordEvents([eventRecord(sessionId, 1, 'user/message', '决定：采用 v3 模型。')])
  store.markPendingExtraction(sessionId, 1, 'transient failure')
  assert.equal(store.listPendingExtraction(sessionId).length, 1)
  extractor.extractPending(sessionId)
  assert.deepEqual(store.listPendingExtraction(sessionId), [])
})

test('extractEvent skips empty text and unknown event types', () => {
  const { store, sessionId, extractor } = createExtractor()
  const record = eventRecord(sessionId, 1, 'user/message', '决定：采用 v3 模型。')
  assert.deepEqual(extractor.extractEvent(sessionId, { ...record, text: null }), { created: 0, superseded: 0 })
  assert.deepEqual(extractor.extractEvent(sessionId, { ...record, type: 'turn/start' }), { created: 0, superseded: 0 })
})
