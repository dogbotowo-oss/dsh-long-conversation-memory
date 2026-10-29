#!/usr/bin/env node
/**
 * Offline memory CLI.
 *
 * Runs the same diagnostics surface as the in-chat `/memory` command, but
 * directly against the SQLite file, without booting DSH. Useful for operators,
 * for tests, and as a reference implementation of the storage contract.
 *
 * Usage:
 *   node scripts/memory-cli.mjs [--db <file>] [--session <id>] [--json] <command> [args]
 *
 * Commands: status, sessions, inspect <id>, search <query>, explain,
 *           retract <id> [reason], export [--events], purge [--yes]
 */

import fs from 'node:fs'
import path from 'node:path'

import { openDatabase } from '../src/core/db.js'
import { MemoryStore } from '../src/memory/store.js'
import { SkillManager } from '../src/skills.js'
import { Retriever } from '../src/retrieval.js'
import { Diagnostics } from '../src/diagnostics.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js'
import { PLUGIN_VERSION } from '../src/core/constants.js'
import { resolveDataDir } from '../src/adapter/host.js'

const USAGE = `dsh-long-conversation-memory CLI ${PLUGIN_VERSION}

Usage: node scripts/memory-cli.mjs [options] <command> [args]

Options:
  --db <file>        SQLite file (default: <DSH_HOME>/long-conversation-memory/memory.sqlite)
  --session <id>     Session id (default: most recently seen session)
  --json             Print the raw JSON result instead of formatted text
  -h, --help         Show this help

Commands:
  status             Counts, task state, checkpoints, skills, compatibility
  sessions           List sessions in this database
  inspect <id>       One memory item with its sources and audit history
  search <query>     Full-text search over memories and raw evidence
  explain            Why the last request included what it did
  retract <id> [why] Retract a memory item (stays auditable, leaves retrieval)
  export [--events]  Export the session's memory as JSON
  purge [--yes]      Permanently delete this session's memory
`

/**
 * @param {string[]} argv
 * @returns {{ db: string | null, session: string | null, json: boolean, command: string, args: string[] }}
 */
function parseArgs(argv) {
  /** @type {{ db: string | null, session: string | null, json: boolean, command: string, args: string[] }} */
  const options = { db: null, session: null, json: false, command: '', args: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--db') {
      index += 1
      options.db = argv[index] ?? null
    } else if (arg === '--session') {
      index += 1
      options.session = argv[index] ?? null
    } else if (arg === '--json') {
      options.json = true
    } else if (options.command.length === 0) {
      options.command = arg
    } else {
      options.args.push(arg)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.command === '' || options.command === '-h' || options.command === '--help' || options.command === 'help') {
  process.stdout.write(USAGE)
  process.exit(0)
}

const config = normalizeConfig(DEFAULT_CONFIG)
const dbFile = options.db !== null ? path.resolve(options.db) : path.join(resolveDataDir(config.dataDir), 'memory.sqlite')
if (!fs.existsSync(dbFile)) {
  process.stderr.write(`long-conversation-memory: database not found: ${dbFile}\n`)
  process.exit(2)
}

const store = new MemoryStore(openDatabase(dbFile, { migrate: true }), { config })
const skills = new SkillManager(store, { config, version: PLUGIN_VERSION })
const retriever = new Retriever(store, { config })
const diagnostics = new Diagnostics(store, {
  config,
  skills,
  retriever,
  version: PLUGIN_VERSION,
  dbFile,
  sessionId: options.session,
})

/** @param {string} sessionId @returns {string} */
function describeSession(sessionId) {
  const session = store.getSession(sessionId)
  if (session === undefined) {
    process.stderr.write(`long-conversation-memory: unknown session: ${sessionId}\n`)
    process.exit(2)
  }
  return sessionId
}

try {
  let sessionId = options.session
  if (sessionId === null) {
    const sessions = store.listSessions({ limit: 1 })
    sessionId = sessions.length > 0 ? String(sessions[0].sessionId) : null
  }

  let result
  switch (options.command) {
    case 'status': {
      if (sessionId === null) {
        result = { kind: 'success', text: `long-conversation-memory: no sessions yet\n  db: ${dbFile}` }
        break
      }
      result = diagnostics.handle('status', { sessionId: describeSession(sessionId) })
      break
    }
    case 'sessions': {
      const rows = store.listSessions({ limit: 50 }).map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        origin: session.origin,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        memoryEnabled: session.memoryEnabled,
      }))
      result = { kind: 'success', text: JSON.stringify(rows, null, 2) }
      break
    }
    case 'inspect':
    case 'search':
    case 'explain':
    case 'retract':
    case 'export': {
      if (sessionId === null) {
        process.stderr.write('long-conversation-memory: no session available; pass --session <id>\n')
        process.exit(2)
      }
      const raw = options.command === 'export' && options.args.includes('--events') ? 'export --events' : [options.command, ...options.args].join(' ')
      result = diagnostics.handle(raw, { sessionId: describeSession(sessionId) })
      break
    }
    case 'purge': {
      if (sessionId === null || !options.args.includes('--yes')) {
        process.stderr.write('long-conversation-memory: purge needs --session <id> and --yes\n')
        process.exit(2)
      }
      result = diagnostics.handle(`purge ${options.args.filter((arg) => arg !== '--yes').join(' ')}`.trim(), {
        sessionId: describeSession(sessionId),
      })
      break
    }
    default: {
      process.stderr.write(`long-conversation-memory: unknown command "${options.command}"\n${USAGE}`)
      process.exit(2)
    }
  }

  const ok = result?.kind !== 'error'
  const text = String(result?.text ?? '')
  process.stdout.write(options.json && ok ? `${text}\n` : `${text}\n`)
  process.exitCode = ok ? 0 : 1
} catch (error) {
  process.stderr.write(`long-conversation-memory: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  store.close()
}
