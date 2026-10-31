/**
 * SQLite schema and migrations for the session memory database.
 *
 * The database is an ordinary file owned by this plugin. It never writes to the
 * host session-persistence database and never rewrites host session logs.
 *
 * @module dsh-long-memory/core/schema
 */

import { SCHEMA_VERSION } from './constants.js'

/**
 * @typedef {object} Migration
 * @property {number} version target `PRAGMA user_version`
 * @property {string} description human readable summary
 * @property {string[]} statements DDL applied in one transaction
 */

/** @type {Migration[]} */
export const MIGRATIONS = [
  {
    version: 1,
    description: 'initial session memory schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT,
        project TEXT,
        origin TEXT,
        dsh_version TEXT,
        memory_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        time TEXT NOT NULL,
        turn INTEGER,
        step INTEGER,
        role TEXT,
        text TEXT,
        source_kind TEXT,
        source_form TEXT,
        tool_name TEXT,
        call_id TEXT,
        store TEXT NOT NULL DEFAULT 'host',
        content_hash TEXT,
        truncated INTEGER NOT NULL DEFAULT 0,
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      )`,
      `CREATE INDEX IF NOT EXISTS events_session_type_seq ON events(session_id, type, seq)`,
      `CREATE INDEX IF NOT EXISTS events_session_turn ON events(session_id, turn, step)`,
      `CREATE INDEX IF NOT EXISTS events_content_hash ON events(session_id, content_hash)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        text,
        session_id UNINDEXED,
        seq UNINDEXED,
        tokenize='trigram'
      )`,
      `CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        conditions_json TEXT NOT NULL DEFAULT '[]',
        scope_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        evidence_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        supersedes_json TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        content_hash TEXT NOT NULL,
        numbers_json TEXT NOT NULL DEFAULT '[]',
        extractor TEXT NOT NULL DEFAULT 'rule',
        derived_from_seq INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS memory_items_session_status ON memory_items(session_id, status, kind)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_dedupe ON memory_items(session_id, content_hash) WHERE status = 'active'`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        text,
        memory_id UNINDEXED,
        session_id UNINDEXED,
        tokenize='trigram'
      )`,
      `CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        at TEXT NOT NULL,
        actor TEXT,
        detail_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS memory_events_memory ON memory_events(memory_id, id)`,
      `CREATE INDEX IF NOT EXISTS memory_events_session ON memory_events(session_id, id)`,
      `CREATE TABLE IF NOT EXISTS task_state (
        session_id TEXT PRIMARY KEY,
        goal TEXT,
        progress_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        open_items_json TEXT NOT NULL DEFAULT '[]',
        superseded_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        updated_by_seq INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT PRIMARY KEY,
        last_event_seq INTEGER NOT NULL DEFAULT -1,
        last_extract_seq INTEGER NOT NULL DEFAULT -1,
        last_assembly_seq INTEGER NOT NULL DEFAULT -1,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT,
        path TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        supersedes TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(name, content_hash)
      )`,
      `CREATE TABLE IF NOT EXISTS skill_files (
        name TEXT PRIMARY KEY,
        latest_version_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        when_to_use TEXT,
        invocation TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        skill_version_id TEXT NOT NULL,
        rule_key TEXT NOT NULL,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        source_path TEXT,
        source_line INTEGER,
        scope_json TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(skill_name, rule_key)
      )`,
      `CREATE INDEX IF NOT EXISTS rules_skill ON rules(skill_name, active)`,
      `CREATE TABLE IF NOT EXISTS rule_overrides (
        rule_id TEXT PRIMARY KEY,
        category TEXT,
        active INTEGER,
        scope_json TEXT,
        note TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS assembly_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn INTEGER,
        step INTEGER,
        created_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        budget_tokens INTEGER NOT NULL,
        used_tokens INTEGER NOT NULL,
        token_source TEXT NOT NULL,
        content_hash TEXT,
        injected INTEGER NOT NULL,
        message_seq INTEGER,
        sections_json TEXT NOT NULL DEFAULT '[]',
        items_json TEXT NOT NULL DEFAULT '[]',
        omitted_json TEXT NOT NULL DEFAULT '[]',
        reasons_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]'
      )`,
      `CREATE INDEX IF NOT EXISTS assembly_logs_session ON assembly_logs(session_id, id)`,
      `CREATE TABLE IF NOT EXISTS pending_extraction (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      )`,
      `CREATE TABLE IF NOT EXISTS archive (
        session_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        event_type TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, ref)
      )`,
    ],
  },
  {
    version: 2,
    description: 'validation audit log for deterministic checks on produced artifacts',
    statements: [
      `CREATE TABLE IF NOT EXISTS validation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn INTEGER,
        step INTEGER,
        event_seq INTEGER,
        trigger TEXT NOT NULL DEFAULT 'assistant/message',
        target TEXT NOT NULL DEFAULT 'body',
        ok INTEGER NOT NULL,
        checked INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        deterministic INTEGER NOT NULL DEFAULT 1,
        violations_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS validation_logs_session ON validation_logs(session_id, id)`,
    ],
  },
]

/** @returns {Migration[]} migrations newer than the given schema version */
export function pendingMigrations(currentVersion) {
  return MIGRATIONS.filter((migration) => migration.version > currentVersion).sort((a, b) => a.version - b.version)
}

/** @returns {string[]} every DDL statement in the latest schema (tests only) */
export function allStatements() {
  const statements = MIGRATIONS.flatMap((migration) => migration.statements)
  if (!MIGRATIONS.some((migration) => migration.version === SCHEMA_VERSION)) {
    throw new Error(`no migration reaches schema version ${SCHEMA_VERSION}`)
  }
  return statements
}

/** Tables the diagnostics command reports on. */
export const REPORT_TABLES = Object.freeze([
  'sessions',
  'events',
  'memory_items',
  'memory_events',
  'task_state',
  'checkpoints',
  'skill_versions',
  'rules',
  'assembly_logs',
])
