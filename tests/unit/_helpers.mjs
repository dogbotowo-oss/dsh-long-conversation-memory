/**
 * Shared fixtures for unit tests. Not picked up by `node --test` because the
 * filename does not match the test-file pattern.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openTestDatabase } from '../../src/core/db.js'
import { MemoryStore } from '../../src/memory/store.js'
import { normalizeConfig } from '../../src/config.js'

/**
 * Create an in-memory store with one registered session.
 *
 * @param {{ sessionId?: string, config?: object }} [options]
 * @returns {{ db: import('../../src/core/db.js').MemoryDatabase, store: import('../../src/memory/store.js').MemoryStore, sessionId: string, config: object }}
 */
export function createMemoryStore(options = {}) {
  const sessionId = options.sessionId ?? 'sess_test'
  const config = normalizeConfig(options.config ?? {})
  const db = openTestDatabase()
  const store = new MemoryStore(db, { config })
  store.ensureSession({ sessionId, cwd: os.tmpdir(), origin: 'user' })
  return { db, store, sessionId, config }
}

/**
 * Create a temporary directory that the caller must remove with `cleanup()`.
 *
 * @param {string} [prefix]
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function makeTempDir(prefix = 'dsh-sm-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort cleanup on Windows when a file is still open
      }
    },
  }
}
