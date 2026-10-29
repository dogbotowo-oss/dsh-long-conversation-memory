/**
 * Unit tests for src/memory/store.js — event ingestion and FTS, memory item
 * lifecycle (dedupe, supersede, retract, reindex), task state, checkpoints,
 * skill versioning and rule overrides, assembly logs, export and purge.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { sha256, stableStringify } from '../../src/core/util.js'
import { memoryContentHash, normalizeMemoryItem } from '../../src/memory/store.js'
import { createMemoryStore } from './_helpers.mjs'

/** Build a fully shaped event record accepted by store.recordEvent(). */
function eventRecord(sessionId, seq, type, text, extra = {}) {
  return {
    sessionId,
    seq,
    type,
    time: '2024-01-01T00:00:00.000Z',
    turn: 1,
    step: 1,
    role: type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : null,
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

/** Insert a plain user-explicit memory item and return the created item. */
function insertItem(store, sessionId, overrides = {}) {
  return store.insertMemoryItem(sessionId, {
    kind: 'fact',
    content: '准确率 81.20% 是在 v3 模型、测试集 S2 口径下统计的。',
    conditions: ['v3 模型', '测试集 S2'],
    scope: [],
    evidenceType: 'user_explicit',
    extractor: 'correction',
    sourceRefs: ['seq:2'],
    numbers: [{ raw: '81.20%', value: 81.2, unit: '%' }],
    derivedFromSeq: 2,
    ...overrides,
  })
}

test('ensureSession, listSessions and memory-enabled toggles', () => {
  const { store, sessionId } = createMemoryStore()
  const session = store.getSession(sessionId)
  assert.equal(session.sessionId, sessionId)
  assert.equal(store.isMemoryEnabled(sessionId), true)
  assert.equal(store.isMemoryEnabled('sess_unknown'), true)

  store.setMemoryEnabled(sessionId, false)
  assert.equal(store.isMemoryEnabled(sessionId), false)
  assert.equal(store.getSession('sess_unknown'), undefined)

  const other = store.ensureSession({ sessionId: 'sess_other', origin: 'subagent' })
  assert.equal(other.sessionId, 'sess_other')
  assert.equal(other.origin, 'subagent')
  const sessions = store.listSessions()
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.map((entry) => entry.sessionId).sort(), ['sess_other', sessionId])
})

test('recordEvent and recordEvents are idempotent on (session_id, seq)', () => {
  const { store, db, sessionId } = createMemoryStore()
  const record = eventRecord(sessionId, 1, 'user/message', '目标：把摘要指标补全。')
  assert.equal(store.recordEvent(record), true)
  assert.equal(store.recordEvent(record), false)
  assert.equal(store.listEvents(sessionId).length, 1)
  assert.equal(store.getCheckpoint(sessionId).lastEventSeq, 1)

  const batch = store.recordEvents([
    eventRecord(sessionId, 2, 'assistant/message', '好的。'),
    eventRecord(sessionId, 3, 'tool/call', '[tool/call read] {"path":"a.txt"}', { toolName: 'read' }),
    eventRecord(sessionId, 3, 'tool/call', 'duplicate retry'),
  ])
  assert.equal(batch.inserted, 2)
  assert.equal(store.listEvents(sessionId).length, 3)
  assert.equal(store.getCheckpoint(sessionId).lastEventSeq, 3)
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM events').n), 3)
})

test('listEvents supports sequence ranges, type filters and limits', () => {
  const { store, sessionId } = createMemoryStore()
  store.recordEvents([
    eventRecord(sessionId, 1, 'user/message', 'one'),
    eventRecord(sessionId, 2, 'assistant/message', 'two'),
    eventRecord(sessionId, 3, 'user/message', 'three'),
    eventRecord(sessionId, 4, 'user/message', 'four'),
  ])
  assert.deepEqual(store.listEvents(sessionId).map((row) => row.seq), [1, 2, 3, 4])
  assert.deepEqual(store.listEvents(sessionId, { fromSeq: 2 }).map((row) => row.seq), [2, 3, 4])
  assert.deepEqual(store.listEvents(sessionId, { fromSeq: 1, toSeq: 3 }).map((row) => row.seq), [1, 2])
  assert.deepEqual(store.listEvents(sessionId, { types: ['user/message'] }).map((row) => row.seq), [1, 3, 4])
  assert.deepEqual(store.listEvents(sessionId, { limit: 2 }).map((row) => row.seq), [1, 2])
  assert.deepEqual(store.listEventsAfter(sessionId, 2).map((row) => row.seq), [3, 4])
  assert.equal(store.getEvent(sessionId, 3).text, 'three')
  assert.equal(store.getEvent(sessionId, 99), undefined)
})

test('searchEvents uses FTS for latin and 3+ char CJK terms, LIKE for 2-char CJK', () => {
  const { store, sessionId } = createMemoryStore()
  store.recordEvents([
    eventRecord(sessionId, 1, 'user/message', 'The accuracy is 79.87 percent under the v3 model.'),
    eventRecord(sessionId, 2, 'user/message', '准确率是 81.20%，在测试集 S2 口径下统计。'),
    eventRecord(sessionId, 3, 'user/message', '阻塞已解除：等待 GPU 资源。'),
  ])

  const latin = store.searchEvents({ sessionId, query: 'accuracy' })
  assert.ok(latin.length >= 1)
  assert.equal(latin[0].matched, 'fts')
  assert.equal(latin[0].seq, 1)

  const cjkFts = store.searchEvents({ sessionId, query: '准确率' })
  assert.ok(cjkFts.length >= 1, 'expected FTS hit for a 3-char CJK term')
  assert.equal(cjkFts[0].seq, 2)
  assert.equal(cjkFts[0].matched, 'fts')

  const cjkLike = store.searchEvents({ sessionId, query: '阻塞' })
  assert.equal(cjkLike.length, 1)
  assert.equal(cjkLike[0].seq, 3)
  assert.equal(cjkLike[0].matched, 'like')

  // An empty query must not degrade into `LIKE '%%'` (which would return the
  // whole log): there are no needles, so the search returns nothing.
  const emptyQuery = store.searchEvents({ sessionId, query: '' })
  assert.deepEqual(emptyQuery, [])
  assert.deepEqual(store.searchEvents({ sessionId, query: 'nothingmatches' }), [])
})

test('insertMemoryItem dedupes identical active content by content hash', () => {
  const { store, sessionId } = createMemoryStore()
  const first = insertItem(store, sessionId)
  assert.equal(first.created, true)
  assert.match(first.item.id, /^mem_/)
  assert.equal(first.item.status, 'active')
  assert.deepEqual(first.item.conditions, ['v3 模型', '测试集 S2'])

  const duplicate = insertItem(store, sessionId, { sourceRefs: ['seq:99'] })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.item.id, first.item.id)
  assert.equal(store.listMemoryItems(sessionId).length, 1)

  // The same text with a different kind is a distinct memory.
  const differentKind = insertItem(store, sessionId, { kind: 'constraint' })
  assert.equal(differentKind.created, true)
  assert.notEqual(differentKind.item.id, first.item.id)
})

test('insertMemoryItem supersedes the old item and records an audit event', () => {
  const { store, sessionId } = createMemoryStore()
  const old = insertItem(store, sessionId, {
    content: '准确率 79.87%，在 v3 模型口径下统计。',
    numbers: [{ raw: '79.87%', value: 79.87, unit: '%' }],
    sourceRefs: ['seq:1'],
    derivedFromSeq: 1,
  })
  const fresh = insertItem(store, sessionId, {
    content: '准确率 81.20%，在 v3 模型、测试集 S2 口径下统计。',
    sources: undefined,
    sourceRefs: ['seq:4'],
    derivedFromSeq: 4,
    supersedes: [old.item.id],
  })
  assert.equal(fresh.created, true)

  const oldAfter = store.getMemoryItem(old.item.id)
  assert.equal(oldAfter.status, 'superseded')
  assert.equal(oldAfter.supersededBy, fresh.item.id)
  assert.deepEqual(fresh.item.supersedes, [old.item.id])

  const audit = store.listMemoryEvents(old.item.id)
  const supersededEvent = audit.find((entry) => entry.event === 'superseded')
  assert.ok(supersededEvent, 'expected a superseded audit event')
  assert.equal(JSON.parse(supersededEvent.detail_json).by, fresh.item.id)
  assert.equal(store.listMemoryEvents(fresh.item.id).some((entry) => entry.event === 'created'), true)

  // Superseding an unknown id must not throw or create a dangling update.
  const orphan = insertItem(store, sessionId, { content: '无主条目 42', supersedes: ['mem_missing'] })
  assert.equal(orphan.created, true)
  assert.deepEqual(orphan.item.supersedes, ['mem_missing'])
})

test('retractItem hides the item from active search but keeps row and audit', () => {
  const { store, sessionId } = createMemoryStore()
  const item = insertItem(store, sessionId, { content: '临时决定：先用 v2 模型跑基线。', kind: 'decision' })
  assert.equal(store.searchMemory({ sessionId, query: 'v2 模型' }).some((hit) => hit.item.id === item.item.id), true)

  const retracted = store.retractItem(item.item.id, { actor: 'tests', reason: 'wrong premise' })
  assert.equal(retracted.status, 'retracted')
  assert.equal(retracted.supersededBy, null)
  assert.equal(store.searchMemory({ sessionId, query: 'v2 模型' }).some((hit) => hit.item.id === item.item.id), false)
  assert.equal(store.getMemoryItem(item.item.id).status, 'retracted')
  const events = store.listMemoryEvents(item.item.id)
  const retractEvent = events.find((entry) => entry.event === 'retracted')
  assert.ok(retractEvent)
  assert.equal(retractEvent.actor, 'tests')
  assert.equal(JSON.parse(retractEvent.detail_json).reason, 'wrong premise')
})

test('updateMemoryItem reindexes FTS and records a revision', () => {
  const { store, sessionId } = createMemoryStore()
  const item = insertItem(store, sessionId, { content: 'alpha accuracy metric', conditions: [] }).item
  assert.equal(store.searchMemory({ sessionId, query: 'alpha' }).length, 1)

  const updated = store.updateMemoryItem(item.id, { content: 'beta blocker resolved' }, { actor: 'tests' })
  assert.equal(updated.content, 'beta blocker resolved')
  assert.equal(store.searchMemory({ sessionId, query: 'alpha' }).length, 0)
  const betaHits = store.searchMemory({ sessionId, query: 'beta' })
  assert.equal(betaHits.length, 1)
  assert.equal(betaHits[0].item.id, item.id)
  assert.equal(store.listMemoryEvents(item.id).some((event) => event.event === 'revised'), true)
  assert.equal(store.updateMemoryItem('mem_missing', { content: 'x' }), undefined)
})

test('searchMemory only searches active items by default', () => {
  const { store, sessionId } = createMemoryStore()
  const active = insertItem(store, sessionId, { content: '保留两位小数口径', conditions: [] }).item
  const retired = insertItem(store, sessionId, { content: '保留四位小数口径（旧）', conditions: [] }).item
  store.retractItem(retired.id, { reason: 'superseded convention' })

  const hits = store.searchMemory({ sessionId, query: '小数口径' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].item.id, active.id)
  assert.equal(hits[0].item.status, 'active')
  assert.ok(['fts', 'like'].includes(hits[0].matched))

  const all = store.searchMemory({ sessionId, query: '小数口径', statuses: ['active', 'retracted'] })
  assert.equal(all.length, 2)
})

test('task state round-trips and resets to documented defaults', () => {
  const { store, sessionId } = createMemoryStore()
  assert.deepEqual(store.getTaskState(sessionId), {
    goal: null,
    progress: [],
    blockers: [],
    openItems: [],
    superseded: [],
    updatedAt: null,
    updatedBySeq: null,
  })
  const saved = store.setTaskState(
    sessionId,
    {
      goal: '把摘要指标补全',
      progress: ['已完成初稿'],
      blockers: ['等待 GPU 资源'],
      openItems: ['补充消融实验'],
      superseded: ['blockers: 旧阻塞 (unblock @seq:3)'],
    },
    { updatedBySeq: 7 },
  )
  assert.equal(saved.goal, '把摘要指标补全')
  assert.deepEqual(saved.progress, ['已完成初稿'])
  assert.deepEqual(saved.blockers, ['等待 GPU 资源'])
  assert.deepEqual(saved.openItems, ['补充消融实验'])
  assert.equal(saved.updatedBySeq, 7)
  assert.ok(typeof saved.updatedAt === 'string' && saved.updatedAt.includes('T'))
  assert.deepEqual(store.getTaskState(sessionId), saved)
})

test('checkpoints merge patches and keep prior counters', () => {
  const { store, sessionId } = createMemoryStore()
  assert.deepEqual(store.getCheckpoint(sessionId), {
    lastEventSeq: -1,
    lastExtractSeq: -1,
    lastAssemblySeq: -1,
  })
  const first = store.setCheckpoint(sessionId, { lastEventSeq: 5 })
  assert.deepEqual(first, { lastEventSeq: 5, lastExtractSeq: -1, lastAssemblySeq: -1 })
  const second = store.setCheckpoint(sessionId, { lastExtractSeq: 7 })
  assert.deepEqual(second, { lastEventSeq: 5, lastExtractSeq: 7, lastAssemblySeq: -1 })
  assert.deepEqual(store.getCheckpoint(sessionId), second)
})

test('upsertSkill versions content changes and reuses unchanged content', () => {
  const { db, store } = createMemoryStore()
  const contentA = '# Demo skill\n\n## 流程\n1. 先读数据\n\n- 必须保留两位小数\n'
  const first = store.upsertSkill({ name: 'demo', content: contentA, path: 'skills/demo/SKILL.md', source: 'test' })
  assert.equal(first.changed, true)
  assert.equal(first.version, 1)
  assert.match(first.versionId, /^skv_/)

  const same = store.upsertSkill({ name: 'demo', content: contentA, path: 'skills/demo/SKILL.md', source: 'test' })
  assert.equal(same.changed, false)
  assert.equal(same.version, 1)
  assert.equal(same.versionId, first.versionId)

  const contentB = `${contentA}- 必须注明统计口径\n`
  const second = store.upsertSkill({ name: 'demo', content: contentB, path: 'skills/demo/SKILL.md', source: 'test' })
  assert.equal(second.changed, true)
  assert.equal(second.version, 2)
  assert.notEqual(second.versionId, first.versionId)

  const versions = db.all('SELECT * FROM skill_versions WHERE name = ? ORDER BY version ASC', ['demo'])
  assert.equal(versions.length, 2)
  assert.equal(versions[1].supersedes, first.versionId)
  assert.equal(store.getSkillContent('demo').content, contentB)
  assert.equal(store.listSkillFiles().length, 1)
  assert.equal(store.setSkillEnabled('demo', false), true)
  assert.equal(Number(store.getSkillFile('demo').enabled), 0)
  assert.equal(store.setSkillEnabled('demo', true), true)
})

test('rule overrides survive replaceSkillRules because rule ids are stable', () => {
  const { store } = createMemoryStore()
  const skill = store.upsertSkill({ name: 'writer', content: '# Writer\n- 必须保留两位小数\n', path: 'writer.md' })
  const writeRules = () =>
    store.replaceSkillRules('writer', skill.versionId, [
      { key: 'r1', text: '必须保留两位小数', category: 'stable_rule', scope: ['body'], sourcePath: 'writer.md', sourceLine: 3 },
      { key: 'r2', text: '引用原文时允许保留原始精度', category: 'stable_rule', scope: ['exceptions: quote'], sourcePath: 'writer.md', sourceLine: 4 },
    ])
  assert.equal(writeRules(), 2)

  const listed = store.listRules({ skillNames: ['writer'] })
  assert.equal(listed.length, 2)
  const target = listed.find((rule) => rule.text.includes('两位小数'))
  assert.match(target.id, /^rule_/)
  assert.equal(target.category, 'stable_rule')
  assert.deepEqual(target.scope, ['body'])

  assert.equal(store.setRuleOverride(target.id, { category: 'data_convention', active: false, note: 'changed' }), true)
  assert.equal(store.listRules({ skillNames: ['writer'] }).length, 1)
  const inactive = store.listRules({ skillNames: ['writer'], includeInactive: true })
  const overridden = inactive.find((rule) => rule.id === target.id)
  assert.equal(overridden.category, 'data_convention')
  assert.equal(overridden.active, false)

  // Rewriting the rules must keep the override attached to the same rule id.
  assert.equal(writeRules(), 2)
  const after = store.listRules({ skillNames: ['writer'], includeInactive: true }).find((rule) => rule.id === target.id)
  assert.equal(after.category, 'data_convention')
  assert.equal(after.active, false)
  // And the active filter still hides it.
  assert.equal(store.listRules({ skillNames: ['writer'] }).length, 1)
})

test('assembly logs persist structured data and parse back', () => {
  const { store, sessionId } = createMemoryStore()
  const id = store.logAssembly({
    sessionId,
    turn: 2,
    step: 1,
    trigger: 'pre-step',
    budgetTokens: 3000,
    usedTokens: 321,
    tokenSource: 'estimate',
    contentHash: 'abc123',
    injected: true,
    sections: [{ name: 'task', tokens: 30, ids: [] }],
    items: ['mem_a'],
    omitted: [{ kind: 'memory', id: 'mem_b', reason: 'budget' }],
    reasons: [{ id: 'mem_a', reason: 'selected by retrieval' }],
    errors: [],
  })
  assert.ok(Number.isInteger(id))
  const parsed = store.getAssembly(id)
  assert.equal(parsed.id, id)
  assert.equal(parsed.sessionId, sessionId)
  assert.equal(parsed.turn, 2)
  assert.equal(parsed.step, 1)
  assert.equal(parsed.trigger, 'pre-step')
  assert.equal(parsed.budgetTokens, 3000)
  assert.equal(parsed.usedTokens, 321)
  assert.equal(parsed.tokenSource, 'estimate')
  assert.equal(parsed.contentHash, 'abc123')
  assert.equal(parsed.injected, true)
  assert.equal(parsed.messageSeq, null)
  assert.deepEqual(parsed.sections, [{ name: 'task', tokens: 30, ids: [] }])
  assert.deepEqual(parsed.items, ['mem_a'])
  assert.deepEqual(parsed.omitted, [{ kind: 'memory', id: 'mem_b', reason: 'budget' }])
  assert.deepEqual(parsed.reasons, [{ id: 'mem_a', reason: 'selected by retrieval' }])

  assert.equal(store.setAssemblyMessageSeq(id, 9), true)
  assert.equal(store.latestAssembly(sessionId).messageSeq, 9)
  assert.equal(store.listAssemblies(sessionId).length, 1)
  assert.equal(store.latestAssembly('sess_unknown'), undefined)

  const secondId = store.logAssembly({ sessionId, trigger: 'post-compaction', budgetTokens: 3000, usedTokens: 0, tokenSource: 'estimate', injected: false, contentHash: '' })
  assert.ok(secondId > id)
  assert.equal(store.listAssemblies(sessionId)[0].id, secondId)
  assert.equal(store.listAssemblies(sessionId)[1].id, id)
})

test('archives store one copy per ref and can be fetched', () => {
  const { store, sessionId } = createMemoryStore()
  assert.equal(store.archiveEvent({ sessionId, ref: 'seq:5', eventType: 'tool/result', text: 'raw tool output' }), true)
  assert.equal(store.archiveEvent({ sessionId, ref: 'seq:5', eventType: 'tool/result', text: 'other' }), false)
  assert.deepEqual(store.getArchived(sessionId, 'seq:5'), {
    ref: 'seq:5',
    eventType: 'tool/result',
    text: 'raw tool output',
  })
  assert.equal(store.getArchived(sessionId, 'seq:6'), undefined)
})

test('pending extraction retries are tracked and can be cleared', () => {
  const { store, sessionId } = createMemoryStore()
  store.markPendingExtraction(sessionId, 3, 'first failure')
  store.markPendingExtraction(sessionId, 3, 'x'.repeat(3000))
  const pending = store.listPendingExtraction(sessionId)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].seq, 3)
  assert.equal(pending[0].attempts, 2)
  assert.equal(pending[0].lastError.length, 2000)
  store.clearPendingExtraction(sessionId, 3)
  assert.deepEqual(store.listPendingExtraction(sessionId), [])
})

test('stats and memoryBreakdown count the session rows', () => {
  const { store, sessionId } = createMemoryStore()
  store.recordEvents([eventRecord(sessionId, 1, 'user/message', '目标：补全指标。')])
  const active = insertItem(store, sessionId, { content: '活跃事实 11%', conditions: [] }).item
  const retired = insertItem(store, sessionId, { content: '旧事实 12%', conditions: [] }).item
  store.retractItem(retired.id, { reason: 'test' })
  store.logAssembly({ sessionId, trigger: 'pre-step', budgetTokens: 3000, usedTokens: 10, tokenSource: 'estimate', injected: true, contentHash: 'h' })

  const stats = store.stats(sessionId)
  assert.equal(stats.events, 1)
  assert.equal(stats.memoryItems, 2)
  assert.equal(stats.activeMemoryItems, 1)
  assert.equal(stats.memoryEvents, 3) // created x2 + retracted x1
  assert.equal(stats.assemblyLogs, 1)
  assert.equal(stats.archived, 0)
  assert.equal(stats.pendingExtraction, 0)
  assert.equal(stats.checkpoint.lastEventSeq, 1)
  assert.equal(stats.taskState.goal, null)

  const breakdown = store.memoryBreakdown(sessionId)
  assert.equal(breakdown.total, 2)
  assert.equal(breakdown.active, 1)
  assert.deepEqual(breakdown.byStatus, { active: 1, retracted: 1 })
  assert.deepEqual(breakdown.byKind, { fact: 2 })
})

test('exportSession omits raw events unless requested', () => {
  const { store, sessionId } = createMemoryStore()
  store.recordEvents([eventRecord(sessionId, 1, 'user/message', '目标：补全指标。')])
  insertItem(store, sessionId)
  store.logAssembly({ sessionId, trigger: 'pre-step', budgetTokens: 3000, usedTokens: 10, tokenSource: 'estimate', injected: true, contentHash: 'h' })

  const exported = store.exportSession(sessionId)
  assert.equal(exported.format, 'dsh-session-memory-export')
  assert.equal(exported.version, 1)
  assert.ok(typeof exported.exportedAt === 'string')
  assert.equal(exported.session.sessionId, sessionId)
  assert.ok(Array.isArray(exported.memoryItems) && exported.memoryItems.length === 1)
  assert.ok(Array.isArray(exported.memoryEvents) && exported.memoryEvents.length >= 1)
  assert.ok(Array.isArray(exported.assemblies) && exported.assemblies.length === 1)
  assert.deepEqual(exported.taskState.progress, [])
  assert.equal(exported.events, undefined)

  const withEvents = store.exportSession(sessionId, { includeEvents: true })
  assert.equal(withEvents.events.length, 1)
  assert.equal(withEvents.events[0].text, '目标：补全指标。')
  // JSON round-trip must work (the command prints it as JSON).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(exported)))
})

test('purgeSession removes rows including FTS indexes', () => {
  const { db, store, sessionId } = createMemoryStore()
  store.recordEvents([eventRecord(sessionId, 1, 'user/message', '需要被清除的事实 55%')])
  const item = insertItem(store, sessionId, { content: '需要被清除的记忆 55%', conditions: [] }).item
  store.setTaskState(sessionId, { goal: 'g' }, { updatedBySeq: 1 })
  store.logAssembly({ sessionId, trigger: 'pre-step', budgetTokens: 3000, usedTokens: 1, tokenSource: 'estimate', injected: true, contentHash: 'h' })
  store.archiveEvent({ sessionId, ref: 'seq:1', eventType: 'user/message', text: 'raw' })
  store.markPendingExtraction(sessionId, 1, 'err')

  const { deleted } = store.purgeSession(sessionId)
  assert.equal(deleted.events, 1)
  assert.equal(deleted.memory_items, 1)
  assert.equal(deleted.sessions, 1)
  assert.equal(store.getSession(sessionId), undefined)
  assert.equal(store.getMemoryItem(item.id), undefined)
  assert.deepEqual(store.listEvents(sessionId), [])
  assert.deepEqual(store.searchEvents({ sessionId, query: '清除' }), [])
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM events_fts WHERE session_id = ?', [sessionId]).n), 0)
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM memory_fts WHERE session_id = ?', [sessionId]).n), 0)
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM assembly_logs WHERE session_id = ?', [sessionId]).n), 0)
  assert.equal(store.integrityCheck().ok, true)
})

test('purgeRetracted only removes retracted items and their audit rows', () => {
  const { store, sessionId } = createMemoryStore()
  const keep = insertItem(store, sessionId, { content: '保留条目 1%', conditions: [] }).item
  const drop = insertItem(store, sessionId, { content: '撤回条目 2%', conditions: [] }).item
  store.retractItem(drop.id, { reason: 'test' })
  assert.equal(store.purgeRetracted(sessionId), 1)
  assert.equal(store.getMemoryItem(drop.id), undefined)
  assert.equal(store.listMemoryEvents(drop.id).length, 0)
  assert.equal(store.getMemoryItem(keep.id).status, 'active')
  assert.equal(store.purgeRetracted(sessionId), 0)
})

test('memoryContentHash and normalizeMemoryItem behave deterministically', () => {
  const hashA = memoryContentHash({ kind: 'fact', content: ' 准确率 81.20% ', conditions: ['v3 模型'], scope: [] })
  const hashB = memoryContentHash({ kind: 'fact', content: '准确率 81.20%', conditions: ['v3 模型'], scope: [] })
  assert.equal(hashA, hashB)
  assert.equal(hashA, memoryContentHash({ kind: 'fact', content: '准确率 81.20%', conditions: ['v3 模型'], scope: [] }))
  assert.equal(
    hashA,
    sha256(stableStringify({ kind: 'fact', content: '准确率 81.20%', conditions: ['v3 模型'], scope: [] })),
  )
  assert.notEqual(
    hashA,
    memoryContentHash({ kind: 'fact', content: '准确率 81.20%', conditions: ['测试集 S2'], scope: [] }),
  )

  assert.throws(() => normalizeMemoryItem('sess_test', { content: '   ' }), /content must not be empty/)
  const normalized = normalizeMemoryItem('sess_test', { content: '一条事实' })
  assert.equal(normalized.kind, 'fact')
  assert.equal(normalized.evidenceType, 'inferred')
  assert.equal(normalized.status, 'active')
  assert.equal(normalized.extractor, 'rule')
  assert.match(normalized.id, /^mem_/)
  assert.deepEqual(normalized.conditions, [])
  assert.deepEqual(normalized.scope, [])
  assert.deepEqual(normalizeMemoryItem('sess_test', { content: '一条事实' }).id, normalized.id)
})
