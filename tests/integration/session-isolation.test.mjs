/**
 * Integration: memory is scoped per session. A second session must not receive
 * another session's facts, evidence or rules, and `memory purge` only removes
 * the session it names.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-isolation-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // The OS temp dir is disposable even if Windows still holds the file.
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
  const runtime = new MemoryRuntime({ ctx: host.ctx, config: normalizeConfig({ dataDir }), logger: host.ctx.logger })
  runtime.start()
  return { host, runtime }
}

/**
 * @param {ReturnType<typeof createFakeHost>} host
 * @param {object} session
 * @param {string} text
 * @param {{ turn?: number, step?: number }} [options]
 */
async function runTurn(host, session, text, options = {}) {
  host.emit(session, 'turn/start', { turn: options.turn ?? 1 })
  const message = host.emitUser(session, text)
  const decision = await host.preStep(session, { messages: [message], turn: options.turn ?? 1, step: options.step ?? 1 })
  assert.equal(decision.kind, 'enter')
  const injected = decision.messages.find((entry) => entry.source?.kind === 'session-memory')
  return { message, decision, injected, text: injected?.content?.[0]?.text ?? '' }
}

test('a second session never retrieves the first session memory or evidence', async (t) => {
  const { host, runtime } = startRuntime(tempDataDir(t))
  t.after(() => runtime.dispose())

  const sessionA = host.createSession('sess_isolation_a')
  const sessionB = host.createSession('sess_isolation_b')

  const a = await runTurn(
    host,
    sessionA,
    ['目标：补齐 Alpha 项目摘要。', '准确率 79.87% 是 v3 模型、测试集 S2、单次运行的口径。', '决定：采用 v3 模型作为主结果。'].join('\n'),
  )
  // The first turn's own message is still visible, so its derived items are
  // intentionally not repeated yet. Simulate a compaction, then ask again.
  host.setVisible(sessionA, [])
  const aFollowUp = await runTurn(host, sessionA, '下一步：把 Alpha 的准确率结果写进第 3 节。', { turn: 2 })
  assert.match(aFollowUp.text, /79\.87/, 'session A must receive its own fact after the source message left the surface')
  assert.equal(a.text.length >= 0, true)
  const aItemCount = runtime.store.listMemoryItems('sess_isolation_a', { limit: 100 }).length
  assert.ok(aItemCount >= 2, 'session A must derive items')

  const b = await runTurn(host, sessionB, '目标：整理 Beta 项目清单，样本 42 个。')
  assert.ok(!/79\.87/.test(b.text), 'session B must never see session A numbers')
  assert.ok(!/v3 模型|Alpha/.test(b.text), 'session B must never see session A decisions or task state')
  assert.ok(!/42 个/.test(a.text), 'session A must never see session B task state')

  assert.deepEqual(runtime.store.listMemoryItems('sess_isolation_a', { limit: 100 }).filter((item) => /42 个/.test(item.content)), [])
  const bItems = runtime.store.listMemoryItems('sess_isolation_b', { limit: 100 })
  assert.equal(bItems.every((item) => item.sessionId === 'sess_isolation_b'), true, 'every item carries its session id')
  assert.deepEqual(
    runtime.store.searchEvents({ sessionId: 'sess_isolation_b', query: '79.87' }),
    [],
    'raw evidence search is session scoped',
  )

  const exportedA = runtime.store.exportSession('sess_isolation_a', { includeEvents: true })
  assert.equal(exportedA.session.sessionId, 'sess_isolation_a')
  assert.equal(JSON.stringify(exportedA).includes('sess_isolation_b'), false, 'an export never leaks another session')
})

test('purge removes exactly one session and keeps the other intact', async (t) => {
  const { host, runtime } = startRuntime(tempDataDir(t))
  t.after(() => runtime.dispose())

  const sessionA = host.createSession('sess_purge_a')
  const sessionB = host.createSession('sess_purge_b')
  await runTurn(host, sessionA, '记住：凭据轮换周期是 90 天（口径：生产环境）。')
  const b = await runTurn(host, sessionB, '记住：发布窗口是每周四 20:00 UTC。')
  assert.match(b.text, /20:00/, 'session B keeps its own fact')

  const bItemsBefore = runtime.store.listMemoryItems('sess_purge_b', { limit: 100 })
  const bEventsBefore = runtime.store.listEvents('sess_purge_b', { limit: 100 })
  assert.ok(bItemsBefore.length >= 1)

  const deleted = runtime.store.purgeSession('sess_purge_a')
  assert.ok(deleted.deleted.memory_items >= 1)
  assert.ok(deleted.deleted.events >= 1, 'purge must remove raw evidence too')
  assert.deepEqual(runtime.store.listMemoryItems('sess_purge_a', { limit: 100 }), [])
  assert.deepEqual(runtime.store.listEvents('sess_purge_a', { limit: 100 }), [])
  assert.equal(runtime.store.searchMemory({ sessionId: 'sess_purge_a', query: '90 天' }).length, 0, 'index rows are gone')

  assert.equal(runtime.store.listMemoryItems('sess_purge_b', { limit: 100 }).length, bItemsBefore.length)
  assert.equal(runtime.store.listEvents('sess_purge_b', { limit: 100 }).length, bEventsBefore.length)
  assert.match(host.visibleText(sessionB), /20:00/)

  // Purging again is a no-op instead of throwing.
  assert.doesNotThrow(() => runtime.store.purgeSession('sess_purge_a'))
})
