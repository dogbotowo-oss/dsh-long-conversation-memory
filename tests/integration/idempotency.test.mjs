/**
 * Integration: retries, cancelled steps and duplicated event appends must be
 * idempotent. Event ids are `(session_id, seq)` and every derived item is
 * keyed by a deterministic content hash, so replaying a backlog can never
 * duplicate memory.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createFakeHost } from './_fake-host.mjs'
import { normalizeConfig } from '../../src/config.js'
import { MemoryRuntime } from '../../src/adapter/runtime.js'

/** @param {import('node:test').TestContext} t */
function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-idem-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup: the OS temp dir is disposable.
    }
  })
  return dir
}

/**
 * @param {string} dataDir
 */
function startRuntime(dataDir) {
  const host = createFakeHost()
  const runtime = new MemoryRuntime({ ctx: host.ctx, config: normalizeConfig({ dataDir }), logger: host.ctx.logger })
  runtime.start()
  return { host, runtime }
}

test('duplicated event appends and repeated extraction are idempotent', async (t) => {
  const { host, runtime } = startRuntime(tempDataDir(t))
  t.after(() => runtime.dispose())
  const sessionId = 'sess_idem'
  const session = host.createSession(sessionId)

  host.emit(session, 'turn/start', { turn: 1 })
  const userMessage = host.emitUser(session, '目标：验证幂等性。准确率 79.87% 来自 v3 模型、测试集 S2 的单次运行。')
  const first = await host.preStep(session, { messages: [userMessage], turn: 1, step: 1 })
  assert.equal(first.messages.length, 2)

  const eventsBefore = runtime.store.listEvents(sessionId, { limit: 500 })
  const itemsBefore = runtime.store.listMemoryItems(sessionId, { limit: 200 })
  const checkpointBefore = runtime.store.getCheckpoint(sessionId)
  assert.ok(eventsBefore.length >= 2)
  assert.ok(itemsBefore.length >= 1)

  // The host may re-append exactly the same committed events after a retry or a
  // restored session; the primary key (session_id, seq) must swallow them.
  for (const event of eventsBefore) host.replayEvent(session, event)
  for (const event of eventsBefore) host.replayEvent(session, event)
  assert.equal(runtime.store.listEvents(sessionId, { limit: 500 }).length, eventsBefore.length)
  assert.equal(runtime.store.listMemoryItems(sessionId, { limit: 200 }).length, itemsBefore.length)

  // A retried extraction pass sees the generated memory block as new (stored
  // for audit) but derives nothing from it; a second pass is a strict no-op.
  const rerun = await runtime.extractor.extractPending(sessionId)
  assert.equal(rerun.created, 0)
  const rerunAgain = await runtime.extractor.extractPending(sessionId)
  assert.equal(rerunAgain.processed, 0, 'a fully processed event log is a no-op')
  assert.equal(runtime.store.listMemoryItems(sessionId, { limit: 200 }).length, itemsBefore.length)
  assert.ok(runtime.store.getCheckpoint(sessionId).lastExtractSeq >= checkpointBefore.lastExtractSeq)

  // A retried pre-step decision may include the already-injected block, but the
  // same derived item must never be added twice: content hashes dedupe it.
  const retried = await host.preStep(session, { messages: [userMessage], turn: 1, step: 2 })
  assert.equal(retried.kind, 'enter')
  const itemsAfterRetry = runtime.store.listMemoryItems(sessionId, { limit: 200 })
  assert.equal(itemsAfterRetry.length, itemsBefore.length, 'a retried step must not duplicate memory items')
  assert.equal(
    itemsAfterRetry.filter((item) => /79\.87/.test(item.content)).length,
    1,
    'the number fact exists exactly once',
  )
  const checkpointAfter = runtime.store.getCheckpoint(sessionId)
  assert.ok(checkpointAfter.lastEventSeq >= checkpointBefore.lastEventSeq, 'checkpoints never regress')
  assert.ok(checkpointAfter.lastExtractSeq >= checkpointBefore.lastExtractSeq)
})

test('the same rendered memory block is never appended twice', async (t) => {
  const { host, runtime } = startRuntime(tempDataDir(t))
  t.after(() => runtime.dispose())
  const session = host.createSession('sess_dedupe')
  host.emit(session, 'turn/start', { turn: 1 })
  const userMessage = host.emitUser(session, '目标：验证记忆块去重。准确率 79.87% 口径为 v3 模型、测试集 S2。')

  /** @type {number} */
  const memoryCount = () =>
    host.stateOf(session).messages.filter((entry) => entry.message?.source?.kind === 'long-conversation-memory').length

  const first = await host.preStep(session, { messages: [userMessage], turn: 1, step: 1 })
  assert.equal(first.messages.filter((entry) => entry.source?.kind === 'long-conversation-memory').length, 1)
  assert.equal(memoryCount(), 1)

  // A retry may legitimately render a different (smaller) block once the first
  // block became visible, but the same rendered content must never repeat.
  await host.preStep(session, { messages: [userMessage], turn: 1, step: 2 })
  const afterSecond = memoryCount()
  assert.ok(afterSecond <= 2, 'at most one extra block for a changed rendering')

  const third = await host.preStep(session, { messages: [userMessage], turn: 1, step: 3 })
  assert.equal(third.kind, 'enter')
  assert.equal(memoryCount(), afterSecond, 'a byte-identical block is never appended again')

  const hashes = host
    .stateOf(session)
    .messages.filter((entry) => entry.message?.source?.kind === 'long-conversation-memory')
    .map((entry) => entry.message.source.contentHash)
  assert.equal(new Set(hashes).size, hashes.length, 'each visible block has a unique content hash')
})
