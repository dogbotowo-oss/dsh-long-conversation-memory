#!/usr/bin/env node
/**
 * Repository check: static shape, honesty, and a real end-to-end smoke test that
 * exercises the plugin against a fake cordis host.
 *
 * Run: `node scripts/check.mjs` (also `npm run check`).
 *
 * Checks:
 * 1. every source module imports without side effects;
 * 2. `PLUGIN_VERSION` matches package.json;
 * 3. the public-repo hygiene rules from the brief: no absolute personal paths,
 *    no paper/user-skill data, no database/session artefacts, no credentials;
 * 4. end-to-end: fake host → capture → extraction → pre-step assembly →
 *    injection → compaction shadowing → re-injection → restart/recovery.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let checks = 0

/** @param {string} name @param {() => any} fn */
function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {string} name @param {() => Promise<any>} fn */
async function checkAsync(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  /** @type {string[]} */
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'tmp') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

// --------------------------------------------------------------- static shape

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

await checkAsync('all source modules import', async () => {
  const files = listFiles(path.join(ROOT, 'src')).filter((file) => file.endsWith('.js'))
  assert.ok(files.length >= 12, `expected the core modules, found ${files.length} source files`)
  for (const file of files) {
    await import(pathToFileURL(file).href)
  }
})

await checkAsync('PLUGIN_VERSION matches package.json', async () => {
  const constants = await import(pathToFileURL(path.join(ROOT, 'src/core/constants.js')).href)
  assert.equal(constants.PLUGIN_VERSION, packageJson.version, 'src/core/constants.js PLUGIN_VERSION drifted from package.json')
})

check('package.json plugin manifest is consistent', () => {
  assert.equal(packageJson.name, 'dsh-long-conversation-memory')
  assert.equal(packageJson.type, 'module')
  assert.equal(packageJson.main, './src/index.js')
  assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(fs.existsSync(path.join(ROOT, packageJson.main)))
  assert.ok(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')))
  assert.ok(packageJson.files.includes('src'))
  assert.ok(packageJson.files.includes('docs'))
  assert.equal(packageJson.license, 'MIT')
  assert.deepEqual(packageJson.dependencies ?? {}, {}, 'the plugin must stay dependency-free')
})

check('cordis patch targets this package', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*long-conversation-memory/)
  assert.match(patch, /name:\s*['"]dsh-long-conversation-memory['"]/)
})

// -------------------------------------------------------- public repo hygiene
// These patterns are things that were true of the development machine. A public
// release must never contain them: personal paths, the local test manuscript,
// session state, credentials, or SQLite files. The forbidden tokens are built by
// concatenation so this scanner does not flag its own source.
const HYGIENE = [
  { name: 'absolute personal Windows path', pattern: /C:\\Users\\[A-Za-z0-9._-]+/i },
  { name: 'absolute personal POSIX home path', pattern: /\/home\/[A-Za-z0-9._-]+\/(?:Desktop|Documents)/ },
  { name: 'paper workspace reference', pattern: new RegExp(['nczfo', 'paper'].join('-') + '|' + ['33', 'Wiley'].join('_') + '|' + ['论', '文'].join('') + '\\\\', 'i') },
  { name: 'real local DSH profile id', pattern: /profiles[\\/]desktop[\\/]package/, ignoreIn: ['docs/'] },
  { name: 'credential material', pattern: /sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*['"][^'"]{12,}/i },
]

check('public-repo hygiene scan', () => {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp', 'eval-results', 'tests/fixtures/generated'])
  const files = listFiles(ROOT).filter((file) => {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    return !SKIP_DIRS.has(rel.split('/')[0]) && !/(^|\/)(?:memory\.sqlite|.*session\.jsonl.*)$/u.test(rel)
  })
  const findings = []
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const ext = path.extname(file).toLowerCase()
    if (!['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt'].includes(ext)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const rule of HYGIENE) {
      if (rule.ignoreIn !== undefined && rel.startsWith(rule.ignoreIn)) continue
      const match = rule.pattern.exec(text)
      if (match !== null) findings.push(`${rel}: ${rule.name} (${match[0].slice(0, 60)})`)
    }
  }
  assert.deepEqual(findings, [], `public-repo hygiene violations:\n${findings.join('\n')}`)
})

check('no database or session artefacts are tracked', () => {
  const offenders = listFiles(ROOT).filter((file) => /\.(?:sqlite|sqlite3|db-wal|db-shm)$|session\.jsonl(?:\.zstd)?$/u.test(file))
  assert.deepEqual(offenders, [])
})

check('.gitignore covers local state', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  for (const needle of ['*.sqlite', 'eval-results', 'node_modules', 'tests/fixtures/generated']) {
    assert.ok(ignore.includes(needle), `.gitignore missing ${needle}`)
  }
})

// ------------------------------------------------------------- end-to-end
let cliWorks = false
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/memory-cli.mjs'), '--help'], { stdio: 'ignore' })
  cliWorks = true
} catch {
  cliWorks = false
}

/** Fake cordis context + one fake session, enough to drive the runtime. */
function createFakeHost() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const commands = []
  const ctx = {
    logger: { warn() {}, debug() {} },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const at = current.indexOf(listener)
        if (at >= 0) current.splice(at, 1)
      }
    },
    get(service) {
      if (service === 'commands') return { register: (definition) => { commands.push(definition); return () => {} } }
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      return () => dispose?.()
    },
  }
  const messages = []
  const session = {
    id: 'sess_smoke',
    header: { id: 'sess_smoke', cwd: os.tmpdir(), origin: 'user' },
    surface: { nodes: [], contentGeneration: 0 },
    deriveMessages() {
      return messages.map((entry) => entry.message)
    },
    __append(event, message) {
      messages.push({ event, message })
    },
  }
  return { ctx, listeners, commands, session, messages }
}

await checkAsync('end-to-end pipeline against a fake host', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-long-conversation-memory-check-'))
  const dataDir = path.join(tmpDir, 'data')
  const { ctx, listeners, commands, session, messages } = createFakeHost()

  const { normalizeConfig } = await import(pathToFileURL(path.join(ROOT, 'src/config.js')).href)
  const { MemoryRuntime } = await import(pathToFileURL(path.join(ROOT, 'src/adapter/runtime.js')).href)
  const config = normalizeConfig({ dataDir, dbFile: 'smoke.sqlite' })
  const runtime = new MemoryRuntime({ ctx, config, logger: ctx.logger })
  runtime.start()

  // 1. User states a goal, a number with its statistical condition, and a decision.
  const seq = (value) => value
  let seqNo = 0
  const emit = (type, data) => {
    seqNo += 1
    const event = { type, seq: seq(seqNo), time: new Date().toISOString(), data }
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    return event
  }

  emit('turn/start', { turn: 1 })
  const userMessage = {
    id: 'u1',
    role: 'user',
    content: [
      {
        type: 'text',
        text: '目标：把摘要指标补全。\n准确率 79.87% 是在 v3 模型、测试集 S2、单次运行的口径下统计的。\n决定：采用 v3 模型作为主结果。',
      },
    ],
    source: { kind: 'user' },
  }
  emit('user/message', userMessage)
  messages.push({ event: null, message: userMessage })

  // 2. First pre-step: assemble + inject through the waterfall.
  const decisions = []
  const preStep = async (payload) => {
    let decision = { kind: 'enter', messages: payload.messages }
    for (const listener of listeners.get('agent/pre-step') ?? []) {
      decision = await listener(payload, async () => decision)
    }
    decisions.push(decision)
    for (const message of decision.messages) {
      if (!payload.messages.includes(message)) messages.push({ event: null, message })
    }
    return decision
  }
  const agent = { id: session.id, session }
  const first = await preStep({ agent, messages: [userMessage], turn: 1, step: 1, signal: new AbortController().signal })
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 2, 'expected claimed message + memory injection')
  const injected = first.messages[1]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'long-conversation-memory')
  assert.match(injected.content[0].text, /目标/)
  assert.match(injected.content[0].text, /证据|evidence/i)
  // The claimed message of this very step is already visible to the model, so
  // its derived fact/evidence must NOT be repeated in the memory block.
  assert.doesNotMatch(injected.content[0].text, /^- \[mem mem_/m)

  // 3. Second step with identical content: no duplicate injection.
  const second = await preStep({ agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal })
  assert.equal(second.messages.length, 0, 'expected no re-injection while the block is still visible')

  // 4. Compaction shadows the injected message (and the original user message):
  //    the memory block must be re-injected from the store, which is independent
  //    of the compaction summary, and must recall the number + its conditions.
  messages.length = 0 // the visible surface is now replaced by the summary
  emit('compaction/summary', { summary: 'compacted', from: 1, to: 4 })
  const third = await preStep({ agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal })
  assert.equal(third.messages.length, 1, 'expected re-injection after compaction')
  const reinjected = third.messages[0]
  assert.equal(reinjected.source.kind, 'long-conversation-memory')
  assert.match(reinjected.content[0].text, /79\.87/)
  assert.match(reinjected.content[0].text, /v3 模型/)
  messages.push({ event: null, message: reinjected })

  // 5. A user correction supersedes the old number. While the correction itself
  //    is still the visible input it is not repeated back; once it leaves the
  //    surface the corrected value is assembled from the derived index.
  seqNo += 1
  const correction = {
    id: 'u2',
    role: 'user',
    content: [{ type: 'text', text: '更正：准确率不是 79.87%，实际是 81.20%，在 v3 模型、测试集 S2 的口径下。' }],
    source: { kind: 'user' },
  }
  emit('user/message', correction)
  messages.push({ event: null, message: correction })
  await preStep({ agent, messages: [correction], turn: 2, step: 2, signal: new AbortController().signal })
  messages.length = 0
  emit('compaction/summary', { summary: 'compacted again', from: 5, to: 6 })
  const fourth = await preStep({ agent, messages: [], turn: 3, step: 1, signal: new AbortController().signal })
  const correctedBlock = fourth.messages[fourth.messages.length - 1]
  assert.equal(correctedBlock.source.kind, 'long-conversation-memory')
  assert.match(correctedBlock.content[0].text, /81\.20/)
  // The superseded *memory item* must leave the derived index, but the original
  // user message is raw evidence and must still be quoted verbatim.
  assert.doesNotMatch(correctedBlock.content[0].text, /\[mem [^\]]+\][^\n]*准确率 79\.87/)
  assert.match(correctedBlock.content[0].text, /\[ev seq:2\/user\/message\][^\n]*准确率 79\.87/)
  messages.push({ event: null, message: correctedBlock })

  // 6. Diagnostics: the command is registered, memory has items/audit, explain works.
  assert.equal(commands.length, 1)
  const status = runtime.diagnostics.handle('status', { sessionId: session.id })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /long-conversation-memory|记忆/)
  const explain = runtime.diagnostics.handle('explain', { sessionId: session.id })
  assert.equal(explain.kind, 'success')
  assert.match(explain.text, /assembly|装配|tokens/i)
  const exportResult = runtime.diagnostics.handle('export', { sessionId: session.id })
  assert.equal(exportResult.kind, 'success')
  const exported = JSON.parse(exportResult.text)
  assert.ok(Array.isArray(exported.memoryItems) && exported.memoryItems.length >= 1)
  assert.ok(exported.memoryItems.some((item) => item.status === 'superseded'))
  assert.ok(exported.memoryItems.some((item) => String(item.content).includes('81.20')))

  // 7. Restart/recovery: close, reopen the same file, and re-run assembly.
  runtime.dispose()
  const { openDatabase } = await import(pathToFileURL(path.join(ROOT, 'src/core/db.js')).href)
  const { MemoryStore } = await import(pathToFileURL(path.join(ROOT, 'src/memory/store.js')).href)
  const reopened = new MemoryStore(openDatabase(path.join(dataDir, 'smoke.sqlite'), { migrate: true }), { config })
  const items = reopened.listMemoryItems(session.id, { limit: 50 })
  assert.ok(items.length >= 2, 'memory must survive a restart')
  assert.ok(items.some((item) => item.kind === 'decision'), 'decision item must survive a restart')
  const checkpoint = reopened.getCheckpoint(session.id)
  assert.ok(checkpoint.lastEventSeq >= 5)
  reopened.close()

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

if (!cliWorks) {
  failures.push({ name: 'scripts/memory-cli.mjs --help', error: new Error('CLI did not exit 0') })
  checks += 1
}

// ----------------------------------------------------------------------------

console.log(`\n${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`- ${failure.name}`)
  process.exitCode = 1
}
