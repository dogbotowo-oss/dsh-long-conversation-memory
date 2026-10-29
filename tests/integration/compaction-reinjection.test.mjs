/**
 * Integration: after the host compacts the conversation (the injected memory
 * block is no longer in the visible surface) the next pre-step must re-assemble
 * and re-inject the effective rules / task state / evidence, and the memory
 * store itself must stay independent of the compaction summary.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MemoryRuntime } from '../../src/adapter/runtime.js'
import { normalizeConfig } from '../../src/config.js'
import { createFakeHost } from './_fake-host.mjs'

/**
 * @param {import('node:test').TestContext} t
 */
function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-compaction-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold the sqlite file briefly
    }
  })
  return dir
}

test('post-compaction pre-step re-injects rules, task state and evidence refs', async (t) => {
  const dataDir = tempDataDir(t)
  const host = createFakeHost({})
  const config = normalizeConfig({
    dataDir,
    dbFile: 'memory.sqlite',
    assembly: { softBudgetTokens: 3000 },
    skills: { include: ['test-skill'] },
  })
  const runtime = new MemoryRuntime({ ctx: host.ctx, config, logger: host.ctx.logger })
  runtime.start()
  t.after(() => runtime.dispose())

  const sessionId = 'sess_compaction'
  const session = host.createSession(sessionId)

  // A skill (with a body-scoped rule) and a user turn with a goal + a number
  // carrying its statistical conditions.
  runtime.skills.registerSkill({
    name: 'test-skill',
    source: 'integration-test',
    content: ['# Test skill', '', '## 规则', '', '- 正文禁止使用缩写 WER，正文必须写全称。', '- 数字必须带单位与统计口径。'].join('\n'),
  })
  assert.ok(runtime.store.listRules({ skillNames: ['test-skill'] }).length >= 2)

  host.emit(session, 'turn/start', { turn: 1 })
  const firstUser = host.emitUser(
    session,
    ['目标：把准确率写进终稿第 3 节。', '准确率 79.87% 是在 v3 模型、S2 测试集口径下统计的。'].join('\n'),
  )
  const firstDecision = await host.preStep(session, { messages: [firstUser], turn: 1, step: 1 })
  assert.equal(firstDecision.kind, 'enter')
  const firstInjected = firstDecision.messages.filter((message) => message.source?.kind === 'long-conversation-memory')
  assert.equal(firstInjected.length, 1, 'first pre-step should inject one memory block')
  const firstText = firstInjected[0].content[0].text
  assert.match(firstText, /WER/) // resident core surfaces the constraint
  assert.match(firstText, /目标/)
  // The claimed message of this very step is already visible, so its derived
  // fact and raw quote are deliberately not repeated in the memory block.
  assert.doesNotMatch(firstText, /^- \[mem /m)

  // The host compacts: the visible span is replaced by a summary message and the
  // committed summary event is logged. The injected memory block is gone.
  const summaryMessage = { id: 'compaction_summary', role: 'user', content: [{ type: 'text', text: '（压缩摘要：前 1 轮已折叠）' }], source: { kind: 'compaction', form: 'summary' } }
  host.emit(session, 'compaction/summary', { summary: summaryMessage.content[0].text, replacedSequences: [1, 2, 3] })
  host.setVisible(session, [summaryMessage])

  // Next turn: the memory block must come back because it is not visible.
  host.emit(session, 'turn/start', { turn: 2 })
  const nextUser = host.emitUser(session, '下一步：把准确率结果和口径写进第 3 节。')
  const secondDecision = await host.preStep(session, { messages: [nextUser], turn: 2, step: 1 })
  const secondInjected = secondDecision.messages.filter((message) => message.source?.kind === 'long-conversation-memory')
  assert.equal(secondInjected.length, 1, 'post-compaction pre-step must re-inject the memory block')
  assert.match(secondInjected[0].content[0].text, /79\.87/)
  assert.match(secondInjected[0].content[0].text, /S2/)

  // The memory store is independent of the compaction summary.
  const evidence = runtime.store.searchEvents({ sessionId, query: '79.87' })
  assert.ok(evidence.length >= 1, 'raw evidence survives compaction')
  const items = runtime.store.listMemoryItems(sessionId, { limit: 100 })
  assert.ok(items.some((item) => String(item.content).includes('79.87')))

  // Diagnostics honestly report the observed compaction events.
  const status = runtime.diagnostics.handle('status', { sessionId })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /压缩事件: 已观察 1 条/)
  assert.match(status.text, /压缩兼容:/)

  // No duplicate injection while the block is visible. This second step of the
  // same turn has no new user input, so the assembled block is byte-identical
  // (same rules, task state, facts and evidence) and must be deduplicated
  // against the still-visible copy instead of being appended again.
  const thirdDecision = await host.preStep(session, { messages: [], turn: 2, step: 2 })
  const thirdInjected = thirdDecision.messages.filter((message) => message.source?.kind === 'long-conversation-memory')
  assert.equal(thirdInjected.length, 0, 'an unchanged visible memory block is not appended again')
})
