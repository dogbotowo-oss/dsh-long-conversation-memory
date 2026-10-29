/**
 * Integration: deterministic validation + bounded repair reminders, and
 * `tools/pre-execute` file preconditions that deny only on a real violation.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-validation-'))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Disposable temp dir.
    }
  })
  return dir
}

/**
 * @param {string} dataDir
 * @param {Record<string, any>} configInput
 */
function startRuntime(dataDir, configInput = {}) {
  const host = createFakeHost()
  const runtime = new MemoryRuntime({ ctx: host.ctx, config: normalizeConfig({ dataDir, ...configInput }), logger: host.ctx.logger })
  runtime.start()
  return { host, runtime }
}

/**
 * Run the registered `tools/pre-execute` waterfall exactly like the host.
 *
 * @param {ReturnType<typeof createFakeHost>} host
 * @param {object} exec
 */
async function runPreToolExecute(host, exec) {
  let decision = { kind: 'allow' }
  for (const listener of host.listeners.get('tools/pre-execute') ?? []) {
    decision = await listener(exec, async () => decision)
  }
  return decision
}

test('deterministic checks are persisted and repair reminders are bounded', async (t) => {
  const { host, runtime } = startRuntime(tempDataDir(t), {
    validation: {
      checks: [{ id: 'no-provisional-number', type: 'forbidden_terms', terms: ['99.99%'] }],
      maxRepairAttempts: 2,
      blockOnViolation: true,
    },
  })
  t.after(() => runtime.dispose())
  const sessionId = 'sess_validation'
  const session = host.createSession(sessionId)

  host.emit(session, 'turn/start', { turn: 1 })
  const userMessage = host.emitUser(session, '目标：核对正文中的准确率并给出口径。准确率 79.87%（v3 模型、测试集 S2、单次运行）。')
  host.emitAssistant(session, '最终准确率是 99.99%，这个数字已经确认。', { turn: 1, step: 1 })
  const first = await host.preStep(session, { messages: [userMessage], turn: 1, step: 1 })
  const repairs = first.messages.filter((entry) => entry.source?.form === 'repair')
  assert.equal(repairs.length, 1, 'a failed deterministic check schedules one repair reminder')
  assert.match(repairs[0].content[0].text, /校验提醒/, 'the reminder labels itself as a derived check result')
  assert.match(repairs[0].content[0].text, /99\.99%/, 'the reminder quotes the violated value')
  assert.equal(repairs[0].source.kind, 'long-conversation-memory')

  const logs = runtime.store.listValidationLogs(sessionId, { limit: 20 })
  assert.equal(logs.length, 1)
  assert.equal(logs[0].ok, false)
  assert.equal(logs[0].deterministic, true)
  assert.ok(Array.isArray(logs[0].violations) && logs[0].violations.length >= 1)
  assert.match(runtime.diagnostics.handle('status', { sessionId }).text, /校验: 未通过/)

  // More bad output later: reminders keep being bounded by maxRepairAttempts.
  host.emit(session, 'turn/start', { turn: 2 })
  const user2 = host.emitUser(session, '继续核对，别用临时数字。')
  host.emitAssistant(session, '再次声明准确率 99.99%（临时值）。', { turn: 2, step: 1 })
  const second = await host.preStep(session, { messages: [user2], turn: 2, step: 1 })
  const secondRepairs = second.messages.filter((entry) => entry.source?.form === 'repair')
  const repairCount = (visible) => visible.filter((entry) => entry.source?.form === 'repair').length
  assert.ok(repairCount(host.stateOf(session).messages) <= 2, 'repair reminders never exceed the configured bound')
  assert.equal(secondRepairs.length <= 1, true)
  assert.ok(runtime.store.listValidationLogs(sessionId, { limit: 20 }).length >= 2, 'every run is audited')

  // The deterministic audit trail is visible in `memory explain`.
  assert.match(runtime.diagnostics.handle('explain', { sessionId }).text, /校验/)
})

test('file preconditions deny only when the configured condition is violated', async (t) => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-precond-'))
  t.after(() => {
    try {
      fs.rmSync(workingDir, { recursive: true, force: true })
    } catch {
      // Disposable temp dir.
    }
  })
  const { host, runtime } = startRuntime(workingDir, {
    validation: {
      preconditions: [
        { id: 'outline-first', tools: ['write'], mustExist: true, message: '先创建 outline.md' },
        { id: 'no-overwrite', tools: ['write'], mustNotExist: true, pathPattern: 'final.md', message: '不要覆盖 final.md' },
      ],
    },
  })
  t.after(() => runtime.dispose())
  const session = host.createSession('sess_preconditions', { cwd: workingDir })

  const missing = await runPreToolExecute(host, {
    agent: { session },
    tool: { name: 'write' },
    arguments: { path: 'outline.md', content: '大纲' },
  })
  assert.equal(missing.kind, 'deny', 'a mustExist precondition denies a missing file')
  assert.match(String(missing.reason), /long-conversation-memory precondition/)
  assert.equal(missing.info?.deterministic, true)

  fs.writeFileSync(path.join(workingDir, 'outline.md'), '# outline\n')
  fs.writeFileSync(path.join(workingDir, 'final.md'), '# final\n')
  const allowExisting = await runPreToolExecute(host, {
    agent: { session },
    tool: { name: 'write' },
    arguments: { path: 'outline.md', content: '继续' },
  })
  assert.equal(allowExisting.kind, 'allow', 'an existing file passes the mustExist precondition')

  const overwrite = await runPreToolExecute(host, {
    agent: { session },
    tool: { name: 'write' },
    arguments: { path: 'final.md', content: '覆盖' },
  })
  assert.equal(overwrite.kind, 'deny', 'a mustNotExist precondition denies an existing file')
  assert.match(String(overwrite.reason), /final\.md/)

  const otherTool = await runPreToolExecute(host, {
    agent: { session },
    tool: { name: 'read' },
    arguments: { path: 'final.md' },
  })
  assert.equal(otherTool.kind, 'allow', 'preconditions only apply to the configured tools')
})
