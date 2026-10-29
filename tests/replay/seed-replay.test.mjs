/**
 * Replay tests over the committed seed fixtures.
 *
 * These tests do not use the fake host at all: they read the exact event arrays
 * that were committed under `tests/fixtures/synthetic/seed/`, feed them to the
 * capture service as if the host had emitted them live, and then check that the
 * stored state matches the fixture's independent answer key.
 *
 * The point is reproducibility: a published seed fixture plus the extractor and
 * store should always produce the same memory state, and replaying the same
 * backlog must not duplicate anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeConfig } from '../../src/config.js';
import { openTestDatabase } from '../../src/core/db.js';
import { MemoryStore } from '../../src/memory/store.js';
import { CaptureService } from '../../src/capture.js';
import { SessionExtractor } from '../../src/memory/extraction.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '../fixtures/synthetic/seed/sessions');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function loadSeedSessions() {
  return fs
    .readdirSync(SEED_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(SEED_DIR, entry.name);
      const session = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
      const answerKey = JSON.parse(fs.readFileSync(path.join(dir, 'answer-key.json'), 'utf8'));
      return { dir, session, answerKey };
    })
    .sort((a, b) => a.session.sessionId.localeCompare(b.session.sessionId));
}

function boot() {
  const config = normalizeConfig({});
  const db = openTestDatabase();
  const store = new MemoryStore(db, { config });
  const capture = new CaptureService(store, { config, logger: silentLogger });
  const extractor = new SessionExtractor(store, { config, logger: silentLogger });
  return { config, store, capture, extractor };
}

function activeTexts(store, sessionId) {
  return store
    .listMemoryItems(sessionId, { status: 'active', limit: 500 })
    .map((item) => `${item.content}\n${(item.conditions || []).join('\n')}`);
}

for (const { session, answerKey } of loadSeedSessions()) {
  const id = session.sessionId;
  test(`seed replay ${id}: events are captured once and match the documented count`, () => {
    const { store, capture } = boot();
    try {
      store.ensureSession({ sessionId: id, cwd: session.cwd, project: session.project, dshVersion: session.dshVersion });
      const first = capture.captureEvents(id, session.events);
      assert.ok(first.inserted > 0, 'first replay must insert events');
      assert.equal(first.inserted, session.meta.uniqueEvents, 'every unique event is stored (duplicate seq swallowed by primary key)');

      const checkpoint = store.getCheckpoint(id);
      const maxSeq = Math.max(...session.events.map((event) => event.seq));
      assert.equal(checkpoint.lastEventSeq, maxSeq, 'event checkpoint advances to the final seq');

      // Replaying the identical backlog must be a no-op.
      const second = capture.captureEvents(id, session.events);
      assert.equal(second.inserted, 0, 'replay is idempotent');
      assert.equal(store.listEvents(id, { limit: 5000 }).length, session.meta.uniqueEvents);
    } finally {
      store.close();
    }
  });

  test(`seed replay ${id}: extraction is deterministic and does not duplicate`, () => {
    const { store, capture, extractor } = boot();
    try {
      store.ensureSession({ sessionId: id, cwd: session.cwd, project: session.project, dshVersion: session.dshVersion });
      capture.captureEvents(id, session.events);
      const first = extractor.extractPending(id, { limit: 5000 });
      assert.deepEqual(first.errors, [], 'no extraction errors');
      assert.ok(first.processed > 0, 'extraction processed committed events');

      const counts = activeTexts(store, id);
      const second = extractor.extractPending(id, { limit: 5000 });
      assert.equal(second.processed, 0, 'nothing new to extract on rerun');
      assert.equal(second.created, 0, 'rerun creates no duplicate items');
      assert.deepEqual(activeTexts(store, id), counts, 'active memory content is unchanged by rerun');

      const items = store.listMemoryItems(id, { status: 'active', limit: 500 });
      assert.ok(items.length > 0, 'replay produced active memory items');
    } finally {
      store.close();
    }
  });

  test(`seed replay ${id}: answer-key values are respected by the stored state`, () => {
    const { store, capture, extractor } = boot();
    try {
      store.ensureSession({ sessionId: id, cwd: session.cwd, project: session.project, dshVersion: session.dshVersion });
      capture.captureEvents(id, session.events);
      extractor.extractPending(id, { limit: 5000 });

      const active = store.listMemoryItems(id, { status: 'active', limit: 500 });
      const superseded = store.listMemoryItems(id, { status: 'superseded', limit: 500 });
      const blob = active.map((item) => item.content).join('\n');
      const supersededBlob = superseded.map((item) => item.content).join('\n');

      for (const fact of answerKey.facts || []) {
        if (!fact.value && !fact.initialValue) continue;
        if (fact.finalValue) {
          assert.ok(blob.includes(fact.finalValue), `${fact.key}: corrected value ${fact.finalValue} must be active`);
          const hadOld = fact.initialValue && fact.initialValue !== fact.finalValue;
          if (hadOld) {
            assert.ok(!blob.includes(fact.initialValue), `${fact.key}: superseded value ${fact.initialValue} must not stay active`);
            assert.ok(supersededBlob.includes(fact.initialValue), `${fact.key}: old value must be retained as superseded`);
          }
        } else if (fact.value) {
          assert.ok(blob.includes(fact.value), `${fact.key}: value ${fact.value} must be active`);
        }
      }
    } finally {
      store.close();
    }
  });
}

test('seed replay across sessions keeps sessions isolated', () => {
  const { store, capture, extractor } = boot();
  try {
    const sessions = loadSeedSessions();
    for (const { session } of sessions) {
      store.ensureSession({ sessionId: session.sessionId, cwd: session.cwd, project: session.project, dshVersion: session.dshVersion });
      capture.captureEvents(session.sessionId, session.events);
      extractor.extractPending(session.sessionId, { limit: 5000 });
    }

    // Sessions in the same fixture group deliberately use conflicting values for
    // the same metric; each session may only store its own.
    for (const { session, answerKey } of sessions) {
      const own = store.listMemoryItems(session.sessionId, { limit: 500 });
      const ownSeqs = new Set(own.map((item) => item.id));
      for (const other of sessions) {
        if (other.session.sessionId === session.sessionId) continue;
        const foreign = new Set(store.listMemoryItems(other.session.sessionId, { limit: 500 }).map((item) => item.id));
        for (const item of own) {
          assert.ok(!foreign.has(item.id), 'memory item ids are session-scoped');
        }
        assert.ok(ownSeqs.size > 0);
      }
      assert.ok(answerKey.sessionId === session.sessionId);
    }
  } finally {
    store.close();
  }
});
