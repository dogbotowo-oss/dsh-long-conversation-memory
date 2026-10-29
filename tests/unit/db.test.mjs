/**
 * Unit tests for src/core/db.js — schema migrations, transactions and
 * savepoints, integrity helpers and parameter normalization.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryDatabase, normalizeParam, openDatabase, openTestDatabase } from '../../src/core/db.js'
import { SCHEMA_VERSION } from '../../src/core/constants.js'
import { MIGRATIONS } from '../../src/core/schema.js'

/** Create a temp directory that is removed when the test finishes. */
function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sm-db-'))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function count(db, sql, params = []) {
  const row = db.get(sql, params)
  return Number(Object.values(row)[0])
}

test('openTestDatabase opens an in-memory database with the current schema', () => {
  const db = openTestDatabase()
  t_assertDbShape(db)
  assert.equal(db.filePath, ':memory:')
  assert.equal(db.userVersion(), SCHEMA_VERSION)
  assert.equal(db.expectedVersion, SCHEMA_VERSION)
  const tables = db.tableNames()
  for (const name of ['meta', 'sessions', 'events', 'events_fts', 'memory_items', 'memory_fts', 'task_state', 'checkpoints', 'skill_versions', 'rules', 'assembly_logs', 'archive']) {
    assert.ok(tables.includes(name), `expected table ${name} in ${tables.join(',')}`)
  }
  db.close()
  assert.equal(db.closed, true)
})

test('migrate() is idempotent and reports from/to versions', () => {
  const db = openTestDatabase()
  const second = db.migrate()
  assert.equal(second.from, SCHEMA_VERSION)
  assert.equal(second.to, SCHEMA_VERSION)
  assert.deepEqual(second.applied, [])
  assert.equal(db.userVersion(), SCHEMA_VERSION)
  db.close()
})

test('a fresh file database can defer migration and then apply it once', (t) => {
  const dir = makeTempDir(t)
  const file = path.join(dir, 'deferred.sqlite')
  const db = openDatabase(file, { migrate: false })
  assert.equal(db.userVersion(), 0)
  assert.deepEqual(db.tableNames(), [])
  const applied = db.migrate()
  assert.equal(applied.from, 0)
  assert.equal(applied.to, SCHEMA_VERSION)
  assert.equal(applied.applied.length, MIGRATIONS.length)
  const versionOf = (entry) => (typeof entry === 'object' && entry !== null ? entry.version : entry)
  assert.equal(versionOf(applied.applied[0]), MIGRATIONS[0].version)
  assert.equal(versionOf(applied.applied.at(-1)), SCHEMA_VERSION)
  assert.equal(db.userVersion(), SCHEMA_VERSION)
  assert.equal(db.migrate().applied.length, 0)
  db.close()
})

test('data persists across close and reopen of the same file', (t) => {
  const dir = makeTempDir(t)
  const file = path.join(dir, 'persist.sqlite')
  let db = openDatabase(file)
  db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['k', 'v1'])
  db.close()

  db = openDatabase(file)
  assert.equal(db.get('SELECT value FROM meta WHERE key = ?', ['k']).value, 'v1')
  assert.equal(db.userVersion(), SCHEMA_VERSION)
  db.close()
})

test('file databases use WAL journal mode and support read-only opens', (t) => {
  const dir = makeTempDir(t)
  const file = path.join(dir, 'wal.sqlite')
  const writer = openDatabase(file)
  const journal = String(writer.get('PRAGMA journal_mode').journal_mode).toLowerCase()
  assert.equal(journal, 'wal')
  writer.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['a', '1'])
  writer.close()

  const reader = openDatabase(file, { readOnly: true })
  assert.equal(reader.get('SELECT value FROM meta WHERE key = ?', ['a']).value, '1')
  assert.throws(() => reader.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['b', '2']))
  reader.close()
})

test('transaction() commits, returns the callback value and rolls back on throw', () => {
  const db = openTestDatabase()
  const returned = db.transaction(() => {
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['a', '1'])
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['b', '2'])
    return 'done'
  })
  assert.equal(returned, 'done')
  assert.equal(count(db, 'SELECT COUNT(*) FROM meta'), 2)

  assert.throws(
    () =>
      db.transaction(() => {
        db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['c', '3'])
        throw new Error('boom')
      }),
    /boom/,
  )
  assert.equal(count(db, "SELECT COUNT(*) FROM meta WHERE key = 'c'"), 0)
  assert.equal(count(db, 'SELECT COUNT(*) FROM meta'), 2)
  assert.equal(db.txDepth, 0)
  db.close()
})

test('nested transaction() uses a savepoint and keeps outer work on inner failure', () => {
  const db = openTestDatabase()
  db.transaction(() => {
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['outer', '1'])
    assert.throws(
      () =>
        db.transaction(() => {
          db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['inner', '2'])
          throw new Error('inner-fail')
        }),
      /inner-fail/,
    )
    assert.equal(count(db, "SELECT COUNT(*) FROM meta WHERE key = 'inner'"), 0)
    assert.equal(count(db, "SELECT COUNT(*) FROM meta WHERE key = 'outer'"), 1)
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['outer2', '3'])
  })
  assert.equal(count(db, "SELECT COUNT(*) FROM meta WHERE key LIKE 'outer%'"), 2)
  assert.equal(db.txDepth, 0)
  db.close()
})

test('integrityCheck passes and rowCounts reports user tables only', () => {
  const db = openTestDatabase()
  const check = db.integrityCheck()
  assert.equal(check.ok, true)
  assert.deepEqual(check.errors, [])

  db.run('INSERT INTO sessions (session_id, created_at, last_seen_at) VALUES (?, ?, ?)', ['sess_a', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'])
  db.run('INSERT INTO events (session_id, seq, type, time, text, ingested_at) VALUES (?, ?, ?, ?, ?, ?)', [
    'sess_a',
    1,
    'user/message',
    '2024-01-01T00:00:00.000Z',
    'hi',
    '2024-01-01T00:00:00.000Z',
  ])
  const counts = db.rowCounts()
  assert.ok(Array.isArray(counts))
  assert.ok(counts.every((entry) => !entry.table.endsWith('_fts')))
  assert.ok(counts.every((entry) => !entry.table.startsWith('sqlite_')))
  const byTable = Object.fromEntries(counts.map((entry) => [entry.table, Number(entry.rows)]))
  assert.equal(byTable.sessions, 1)
  assert.equal(byTable.events, 1)
  db.close()
})

test('prepare() caches statements per SQL text', () => {
  const db = openTestDatabase()
  const first = db.prepare('SELECT 1 AS one')
  const second = db.prepare('SELECT 1 AS one')
  assert.equal(first, second)
  assert.equal(first.get().one, 1)
  db.close()
})

test('normalizeParam converts JavaScript values to SQLite parameters', () => {
  assert.equal(normalizeParam(undefined), null)
  assert.equal(normalizeParam(null), null)
  assert.equal(normalizeParam(true), 1)
  assert.equal(normalizeParam(false), 0)
  assert.equal(normalizeParam('x'), 'x')
  assert.equal(normalizeParam(3.5), 3.5)
  assert.equal(normalizeParam(10n), 10n)
  const iso = new Date('2024-01-02T03:04:05.000Z').toISOString()
  assert.equal(normalizeParam(new Date('2024-01-02T03:04:05.000Z')), iso)
  assert.deepEqual(JSON.parse(normalizeParam({ a: 1 })), { a: 1 })
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(normalizeParam(bytes), bytes)
})

/** Shared sanity checks for a freshly opened database. */
function t_assertDbShape(db) {
  assert.ok(db instanceof MemoryDatabase)
  assert.equal(db.closed, false)
  for (const method of ['migrate', 'userVersion', 'prepare', 'run', 'get', 'all', 'exec', 'transaction', 'tableNames', 'integrityCheck', 'rowCounts', 'close']) {
    assert.equal(typeof db[method], 'function', `missing db.${method}`)
  }
}
