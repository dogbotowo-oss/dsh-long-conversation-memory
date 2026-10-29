/**
 * Thin, dependency-free wrapper around `node:sqlite` used by the store.
 *
 * Why a plugin-local SQLite file instead of the host storage services:
 * - retrieval needs ranked full-text search (FTS5) over memory and evidence;
 * - the shipped `storageDomain` backends are KV only (JSON file backend);
 * - the host session-query FTS database is a derived host asset we must not
 *   write to. See docs/architecture.md "Persistence" for the full rationale.
 *
 * @module dsh-session-memory/core/db
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_VERSION } from './constants.js'
import { pendingMigrations } from './schema.js'

/**
 * @typedef {string | number | bigint | Uint8Array | null} SqlParam
 */

/**
 * Coerce a JS value into a value `node:sqlite` accepts. Boolean -> 0/1,
 * `undefined` -> NULL, Date -> ISO string; objects are JSON encoded so callers
 * cannot accidentally bind an object and get a runtime error.
 *
 * @param {unknown} value
 * @returns {SqlParam}
 */
export function normalizeParam(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

/**
 * @param {unknown[] | undefined} params
 * @returns {SqlParam[]}
 */
function normalizeParams(params) {
  if (params === undefined) return []
  return params.map(normalizeParam)
}

export class MemoryDatabase {
  /**
   * @param {DatabaseSync} db
   * @param {string} filePath
   */
  constructor(db, filePath) {
    this.db = db
    this.filePath = filePath
    this.closed = false
    /** @type {Map<string, import('node:sqlite').StatementSync>} */
    this.statements = new Map()
    this.txDepth = 0
  }

  /**
   * Open (or create) the database, apply pragmas and migrations.
   *
   * @param {string} filePath
   * @param {{ readOnly?: boolean, inMemory?: boolean, migrate?: boolean }} [options]
   * @returns {MemoryDatabase}
   */
  static open(filePath, options = {}) {
    const inMemory = options.inMemory === true || filePath === ':memory:'
    if (!inMemory) mkdirSync(dirname(filePath), { recursive: true })
    const db = new DatabaseSync(inMemory ? ':memory:' : filePath, {
      readOnly: options.readOnly === true,
      enableForeignKeyConstraints: true,
    })
    const wrapper = new MemoryDatabase(db, inMemory ? ':memory:' : filePath)
    if (!inMemory) {
      wrapper.exec('PRAGMA journal_mode = WAL')
      wrapper.exec('PRAGMA synchronous = NORMAL')
      wrapper.exec('PRAGMA busy_timeout = 5000')
    }
    if (options.migrate !== false) wrapper.migrate()
    return wrapper
  }

  /**
   * Apply every pending migration in a transaction and record the schema
   * version. Re-running is a no-op.
   *
   * @returns {{ from: number, to: number, applied: number[] }}
   */
  migrate() {
    const from = this.userVersion()
    const pending = pendingMigrations(from)
    if (pending.length === 0) return { from, to: from, applied: [] }
    this.transaction(() => {
      for (const migration of pending) {
        for (const statement of migration.statements) this.db.exec(statement)
        this.exec(`PRAGMA user_version = ${migration.version}`)
      }
    })
    return { from, to: this.userVersion(), applied: pending.map((migration) => migration.version) }
  }

  /** @returns {number} current `PRAGMA user_version` */
  userVersion() {
    const row = this.db.prepare('PRAGMA user_version').get()
    return Number(row?.user_version ?? 0)
  }

  /** @returns {number} expected schema version of this build */
  get expectedVersion() {
    return SCHEMA_VERSION
  }

  /**
   * @param {string} sql
   * @returns {import('node:sqlite').StatementSync}
   */
  prepare(sql) {
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {import('node:sqlite').StatementResultingChanges}
   */
  run(sql, params) {
    return this.prepare(sql).run(...normalizeParams(params))
  }

  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {Record<string, unknown> | undefined}
   */
  get(sql, params) {
    return /** @type {Record<string, unknown> | undefined} */ (this.prepare(sql).get(...normalizeParams(params)))
  }

  /**
   * @param {string} sql
   * @param {unknown[]} [params]
   * @returns {Record<string, unknown>[]}
   */
  all(sql, params) {
    return /** @type {Record<string, unknown>[]} */ (this.prepare(sql).all(...normalizeParams(params)))
  }

  /**
   * @param {string} sql
   * @returns {void}
   */
  exec(sql) {
    this.db.exec(sql)
  }

  /**
   * Run a function atomically. Nested calls use savepoints, so store methods
   * compose safely inside one outer transaction.
   *
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    if (this.txDepth === 0) {
      this.exec('BEGIN IMMEDIATE')
    } else {
      this.exec(`SAVEPOINT sp_${this.txDepth}`)
    }
    this.txDepth += 1
    try {
      const result = fn()
      this.txDepth -= 1
      if (this.txDepth === 0) this.exec('COMMIT')
      else this.exec(`RELEASE sp_${this.txDepth}`)
      return result
    } catch (error) {
      this.txDepth -= 1
      if (this.txDepth === 0) this.exec('ROLLBACK')
      else this.exec(`ROLLBACK TO sp_${this.txDepth}`)
      throw error
    }
  }

  /** @returns {string[]} table names in the schema, sorted */
  tableNames() {
    const rows = this.all("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    return rows.map((row) => String(row.name))
  }

  /** @returns {{ ok: boolean, errors: string[] }} */
  integrityCheck() {
    const rows = this.all('PRAGMA integrity_check')
    const errors = rows.map((row) => String(row.integrity_check)).filter((value) => value !== 'ok')
    return { ok: errors.length === 0, errors }
  }

  /**
   * @returns {{ table: string, rows: number }[]} row counts for diagnostics
   */
  rowCounts() {
    return this.tableNames()
      .filter((table) => !table.includes('_fts') && !table.startsWith('sqlite_'))
      .map((table) => {
        const row = this.get(`SELECT COUNT(*) AS count FROM "${table}"`)
        return { table, rows: Number(row?.count ?? 0) }
      })
  }

  /** @returns {void} */
  close() {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    this.db.close()
  }
}

/**
 * Open a database at the given path.
 *
 * @param {string} filePath
 * @param {{ readOnly?: boolean, migrate?: boolean }} [options]
 * @returns {MemoryDatabase}
 */
export function openDatabase(filePath, options) {
  return MemoryDatabase.open(filePath, options)
}

/**
 * Build a unique in-memory database for tests.
 *
 * @returns {MemoryDatabase}
 */
export function openTestDatabase() {
  return MemoryDatabase.open(':memory:', { inMemory: true })
}
