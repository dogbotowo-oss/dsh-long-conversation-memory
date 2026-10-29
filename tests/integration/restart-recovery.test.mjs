/**
 * Integration: a process restart must keep every memory item, raw evidence row
 * and checkpoint, and re-feeding the backlog must not duplicate anything.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createFakeHost } from './_fake-host.mjs'
import { normalizeConfig } from '../../src/config.js'
import { MemoryRuntime } from '../../src/adapter/runtime.js'

/**
 * @param {import('node:test').TestContext} t
 */
function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-restart-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold the sqlite file briefly; the OS temp dir is fine
    }
  })
  return dir
}

/**
 * @param {string} dataDir
 * @param {Record<string, any>} [services]
 */
function startRuntime(dataDir, services = {}) {
  const host = createFakeHost({ services })
  const config = normalizeConfig({ dataDir, dbFile: 'memory.sqlite' })
  const runtime = new MemoryRuntime({ ctx: host.ctx, config, logger: host.ctx.logger })
  runtime.start()
  return { host, runtime, config }
}

test('restart keeps memory, evidence and checkpoint; backlog replay is idempotent', async (t) => {
  const dataDir = tempDataDir(t)
  const sessionId = 'sess_restart_integration'

  const first = startRuntime(dataDir)
  t.after(() => first.runtime.dispose())
  const session = first.host.createSession(sessionId)

  first.host.emit(session, 'turn/start', { turn: 1 })
  const userMessage = first.host.emitUser(
    session,
    [
      '目标：补齐摘要指标，并在终稿中引用。',
      '准确率 79.87% 是在 v3 模型、测试集 S2、单次运行的口径下统计的。',
      '决定：采用 v3 模型作为主结果。',
    ].join('\n'),
  )
  const firstDecision = await first.host.preStep(session, { messages: [userMessage], turn: 1, step: 1 })
  assert.equal(firstDecision.kind, 'enter')
  assert.equal(firstDecision.messages.length, 2, 'expected the memory message to be injected')

  const itemsBefore = first.runtime.store.listMemoryItems(sessionId, { limit: 100 })
  const evidenceBefore = first.runtime.store.listEvents(sessionId, { limit: 500 })
  const checkpointBefore = first.runtime.store.getCheckpoint(sessionId)
  assert.ok(itemsBefore.length >= 2, 'number fact and decision should be derived')
  assert.equal(evidenceBefore.length >= 2, true)
  assert.ok(checkpointBefore.lastEventSeq >= 2)

  // Simulate a restart: close the SQLite handle, then reopen the same file.
  first.runtime.dispose()

  const second = startRuntime(dataDir)
  t.after(() => second.runtime.dispose())
  const resumed = second.host.createSession(sessionId, {
    visible: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }],
  })

  // 1. Memory survived the restart.
  const itemsAfter = second.runtime.store.listMemoryItems(sessionId, { limit: 100 })
  assert.equal(itemsAfter.length, itemsBefore.length, 'memory items must survive a restart')
  assert.ok(
    itemsAfter.some((item) => String(item.content).includes('79.87')),
    'the number with its conditions must survive a restart',
  )
  assert.ok(itemsAfter.some((item) => item.kind === 'decision'), 'the decision must survive a restart')
  const checkpointAfter = second.runtime.store.getCheckpoint(sessionId)
  assert.equal(checkpointAfter.lastEventSeq, checkpointBefore.lastEventSeq)
  assert.equal(checkpointAfter.lastExtractSeq, checkpointBefore.lastExtractSeq)

  // 2. Replay the whole backlog exactly as the host might after recovery.
  for (const event of evidenceBefore) second.host.replayEvent(resumed, event)
  const eventsAfterReplay = second.runtime.store.listEvents(sessionId, { limit: 500 })
  assert.equal(eventsAfterReplay.length, evidenceBefore.length, 'replayed raw evidence must not duplicate rows')
  const itemsAfterReplay = second.runtime.store.listMemoryItems(sessionId, { limit: 100 })
  assert.equal(itemsAfterReplay.length, itemsBefore.length, 'replayed events must not duplicate memory items')

  // 3. A new turn after the restart still injects memory and extracts only new content.
  second.host.emit(resumed, 'turn/start', { turn: 2 })
  const nextMessage = second.host.emitUser(resumed, '下一步：把准确率结果写进第 3 节。')
  const decision = await second.host.preStep(resumed, { messages: [nextMessage], turn: 2, step: 1 })
  const injected = decision.messages[decision.messages.length - 1]
  assert.equal(injected.source.kind, 'session-memory')
  assert.match(injected.content[0].text, /79\.87/, 'a related query after restart must retrieve the stored number')
  const finalCheckpoint = second.runtime.store.getCheckpoint(sessionId)
  assert.ok(finalCheckpoint.lastEventSeq > checkpointBefore.lastEventSeq, 'the checkpoint advances after new events')

  // 4. Export is a complete recovery snapshot (it may also contain the item the
  // new turn derived, so compare with a lower bound of the pre-restart items).
  const exported = second.runtime.store.exportSession(sessionId, { includeEvents: true })
  assert.equal(exported.format, 'dsh-session-memory-export')
  assert.ok(exported.memoryItems.length >= itemsAfterReplay.length)
  assert.ok(exported.events.length >= eventsAfterReplay.length)
})
