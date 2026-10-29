# Architecture

This document describes how `dsh-session-memory` is put together: the modules,
the event flow, the SQLite schema, the memory write rules, and the budgeted
assembly pipeline. It documents what the source implements; approximate or
planned behaviour is labelled as such.

The plugin is a DSH (DeepSeek Harness) plugin written as plain ES modules. It has
no runtime dependencies beyond the DSH host and the Node.js standard library
(`node:sqlite`, `node:crypto`, `node:fs`, `node:path`).

## Module map

| Module | Responsibility |
| --- | --- |
| `src/index.js` | Plugin entry: normalizes config, opens the database, constructs services, binds host hooks, registers the `memory` command and exposes diagnostics. |
| `src/config.js` | Default configuration, deep merge, numeric clamps and the Schemastery schema. An empty `dataDir` resolves to `<DSH_HOME>/session-memory`. |
| `src/core/constants.js` | Shared vocabulary: memory kinds, evidence types, statuses, rule categories, captured event types, DSH event names, limits and token-estimation constants. |
| `src/core/schema.js` | SQL migrations (currently schema version 2: v2 adds `validation_logs`) and the list of report tables. |
| `src/core/db.js` | `MemoryDatabase`: a thin wrapper over `node:sqlite`'s `DatabaseSync` with WAL mode, a statement cache, parameter normalization, savepoint-based transactions and an integrity check. |
| `src/core/util.js` | Hashing, stable IDs, text normalization, tokenization (Latin + CJK), number extraction with units, token estimation and small text helpers. |
| `src/capture.js` | Turns committed host events into normalized `events` rows; owns idempotent insert-or-ignore, selective archival, and the `GENERATED_SOURCE_KINDS` vocabulary that downstream consumers use to tell user evidence apart from other plugins' generated context. |
| `src/memory/extraction.js` | Deterministic extraction of memory items, corrections and task state from user messages; retry queue for failed extractions. |
| `src/memory/store.js` | The storage API: events, memory items and their lifecycle, task state, checkpoints, skills/rules, assembly logs, archive, export, purge, stats. |
| `src/skills.js` | Skill ingestion: parses `SKILL.md` frontmatter and bodies into versioned rules, classifies rules into categories, extracts rule scopes, builds the resident core and selects task-relevant rules. |
| `src/retrieval.js` | Query-signal extraction and deterministic ranking of memory items and raw evidence; `expand()` for neighbouring events; `inspectItem()` for explainability. |
| `src/assembly.js` | Builds the injected evidence message under a token budget, in fixed priority order, producing provenance and omission reasons. The adapter is responsible for persisting the result with `Assembler.log()`. |
| `src/validation.js` | Optional deterministic checks (`required_terms`, `forbidden_terms`, `numbers_with_conditions`, `script`), file-operation preconditions, and a persisted validation audit trail used by `memory status` / `memory explain`. |
| `src/diagnostics.js` | `memory status` data: event/memory/rule/skill counts, checkpoint cursors, budget, latest assembly, latest validation run and the compatibility report. |
| `src/adapter/` | DSH integration: `agent/pre-step` waterfall (inject the memory message), live `session/event` capture, `tools/pre-execute` preconditions, command registration. |

Modules only depend downward: `adapter → assembly/validation/diagnostics →
retrieval/skills/extraction → store → db/schema`, with `core/util.js` available
everywhere. The assembler produces text and provenance only; the adapter is the
only module that turns it into a host message.

## Event flow

```
                    ┌─────────────────────────────── DSH host ───────────────────────────────┐
                    │  session events (durable append)        agent/pre-step (waterfall)    │
                    └───────────────┬──────────────────────────────────┬─────────────────────┘
                                    │                                  │
                          session/event + replay            pre-step: query, turn, step
                                    │                                  │
                                    ▼                                  ▼
                              capture.js                        retrieval.js
                        (events, archive)                 (memory items + evidence)
                                    │                                  │
                                    ▼                                  ▼
                        extraction.js (cursor)              assembly.js (budget,
                        skills.js (rules)                    fixed section order)
                                    │                                  │
                                    ▼                                  ▼
                        validation.js (optional)          user-role memory message
                        checks / preconditions            injected into this step
                                    │                                  │
                                    ▼                                  ▼
                              store.js ◄──────────────────── assembly_logs
                             (SQLite)
```

Step by step:

1. **Pre-step.** The adapter listens to the host's `agent/pre-step` waterfall and
   receives the step's messages and turn/step numbers. It asks the assembler to
   build a memory block from the latest committed state.
2. **Retrieve.** The task text of the step is tokenized into query signals
   (terms, exact terms, numbers, paths, quoted phrases). Memory items are ranked
   deterministically from FTS5 candidates.
3. **Assemble.** Sections are added in priority order until the soft budget is
   exhausted; everything that does not fit is recorded in `omitted` with a
   reason. The result is one user-role message labelled as evidence, not as
   instructions. Its section headers are short Chinese labels (for example
   `## 记忆: 当前任务状态`), while quoted content keeps its original language.
4. **Inject.** The adapter builds the user message itself (the plugin cannot
   import `@deepseek-ai/dsh-llm`; `host.buildMemoryMessage()` reproduces the
   verified `createUserMessage` shape `{id, role:'user', content:[{type:'text',
   text}], source}`), marks it with the plugin's own source kind/form, and
   returns a pre-step decision that inserts it right after the step's claimed
   user messages. The host stores that message in the session log like any other
   committed message; capture records the row for audit completeness but
   downstream consumers never treat it as user evidence (see trust boundaries).
5. **Capture.** After the host appends an event, the adapter observes it through
   the live `session/event` emit (listener signature `(session, event)`) and
   writes it through the capture service. Capture is idempotent by
   `(session_id, seq)`; events already present are ignored, which also makes a
   retried or replay-driven run harmless. The plugin does not read or mutate host
   session logs.
6. **Extract.** Newly captured user messages are processed incrementally from
   `checkpoints.last_extract_seq`. Extraction creates memory items and task-state
   patches; failures go to `pending_extraction` and are retried later. Raw events
   are never deleted on extraction failure.
7. **Validate.** If configured, deterministic checks run over produced artifacts
   and preconditions run before file tool operations. Validation results are
   advisory unless a configured blocking check applies and repair attempts are
   not exhausted.
8. **Log.** Each assembly is recorded in `assembly_logs` with budget, used
   tokens, token source, section/item/omission/error details, so
   `memory explain` can replay the decision afterwards.

Capture is **after the fact**: the plugin never sits on the host's write path and
never edits host session logs. The only modification it makes to a step is
appending its own labelled user-role message during `agent/pre-step`.

### Trust boundaries: the event log is complete, not the evidence policy

The `events` table is an audit/replay record: every committed host event the
plugin observes is stored, including messages other plugins inject (recognized by
`source.kind` in `GENERATED_SOURCE_KINDS`: `session-memory`, `runtime-context`,
`agent-instructions`, `skill-invocation`, `time-context`, `compaction-checkpoint`,
`compact-checkpoint`, `plan-mode`). Dropping rows would make event counts and
replay-based restores disagree with the host log, so completeness is enforced at
the storage layer and **evidence semantics are enforced at each consumer**:

- `src/memory/extraction.js` derives memory only from real user input
  (`user/message` whose `source.kind` is absent or one of `user`/`input`/
  `prompt`/`steer`).
- `src/retrieval.js` filters `GENERATED_SOURCE_KINDS` out of evidence hits, so a
  generated block can never be quoted back as a historical statement.
- `src/assembly.js` quotes raw events inline only for `assembly.evidenceTypes`
  (default `["user/message"]`). Tool output is untrusted input: it is stored and
  searchable, but not pasted into the request by default, because a tool result
  can contain injected instructions or poisoned numbers. Set
  `assembly.evidenceTypes: ["*"]` to quote every event type.
- The runtime's task-text fallback ignores generated messages, so the plugin
  never mistakes its own output for the user's latest instruction.

A consequence for tests and for `memory explain`: an omission with
`reason: "event type … is not inline-quotable (assembly.evidenceTypes)"` is the
expected, intentional behaviour, not a retrieval failure.

## Storage schema

Schema version 2 lives in `src/core/schema.js` (v1 created the core tables; v2
added `validation_logs`). One SQLite file per DSH home;
default `<DSH_HOME>/session-memory/memory.sqlite`. WAL, `synchronous=NORMAL`,
`busy_timeout=5000`.

### `events` — append-only raw evidence

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | TEXT | part of the primary key |
| `seq` | INTEGER | host event sequence; part of the primary key |
| `type` | TEXT | one of `CAPTURED_EVENT_TYPES`, e.g. `user/message`, `tool/result`, `compaction/summary` |
| `time`, `turn`, `step` | TEXT/INTEGER | host metadata when available |
| `role` | TEXT | `user`, `assistant`, `tool`, `command` |
| `text` | TEXT | normalized text, at most 20 000 chars (then `truncated = 1`) |
| `source_kind`, `source_form` | TEXT | provenance of message content |
| `tool_name`, `call_id` | TEXT | tool events |
| `store` | TEXT | `host` (replayable from host log), `archive` (also archived), `none` |
| `content_hash` | TEXT | SHA-256 of normalized text |
| `truncated`, `ingested_at` | INTEGER/TEXT | ingestion metadata |

Indexes: `(session_id, type, seq)`, `(session_id, turn)`, `(content_hash)`; FTS5
shadow table `events_fts` (`trigram` tokenizer, CJK-capable) for ranked search.

Primary key `(session_id, seq)` is the idempotency mechanism: `INSERT OR
IGNORE`, so retries, replays and duplicate event deliveries cannot duplicate
evidence.

### `memory_items` — derived, curated memory

| Column | Notes |
| --- | --- |
| `id` | stable id: `mem_<session-part>_<hash16>` |
| `session_id`, `kind`, `content` | `kind` ∈ `fact`, `decision`, `constraint`, `preference`, `proposal`, `open_question` |
| `conditions_json`, `scope_json`, `numbers_json` | qualifying conditions, applicability scope, numbers extracted with units |
| `source_refs_json` | `["seq:12", "seq:15"]` references into `events` |
| `evidence_type` | `user_explicit`, `skill`, `artifact_verified`, `assistant_proposal`, `inferred` |
| `status` | `active`, `superseded`, `disputed`, `retracted` |
| `supersedes_json`, `superseded_by` | supersession links (never deletion) |
| `content_hash`, `extractor`, `derived_from_seq` | dedupe and provenance |
| `created_at`, `updated_at` | timestamps |

A partial unique index `(session_id, content_hash) WHERE status='active'`
prevents duplicate active items; replaced values are linked, not overwritten.
FTS5 shadow table `memory_fts` provides the same trigram search.

### `memory_events` — lifecycle audit

`id`, `memory_id`, `session_id`, `event` (one of `created`, `revised`,
`superseded`, `retracted`, `disputed`, `reactivated`, `promoted`), `at`, `actor`,
`detail_json`. Every status transition is recorded here, so `memory inspect`
can explain how an item reached its current state.

### Other tables

| Table | Purpose |
| --- | --- |
| `sessions` | session metadata (`cwd`, `project`, `origin`, `dsh_version`, `memory_enabled`, timestamps). |
| `task_state` | one row per session: `goal`, `progress_json`, `blockers_json`, `open_items_json`, `superseded_json`, `updated_by_seq`. |
| `checkpoints` | one row per session: `last_event_seq`, `last_extract_seq`, `last_assembly_seq`. |
| `skill_versions` | every distinct skill content version (`name`, `source`, `path`, `content`, `content_hash`, `version`, `supersedes`). |
| `skill_files` | current skill state: latest version, enabled flag, description, when-to-use text, invocation. |
| `rules` | parsed rules: `rule_key`, `text`, `category`, `scope_json`, `source_path`, `source_line`, `active`, `content_hash`; unique per `(skill_name, rule_key)`. |
| `rule_overrides` | user overrides of category/active/scope for a rule id. |
| `assembly_logs` | one row per assembly attempt: trigger, budget/used tokens, `token_source`, content hash, `injected`, `message_seq`, section/item/omission/reason/error JSON. Retention is capped by `diagnostics.assemblyLogRetention`. |
| `validation_logs` | one row per deterministic validation run over committed assistant output: `event_seq`, target, `ok`, checked/skipped counts, `deterministic`, `blocked`, violation/error JSON. |
| `archive` | raw text for events the host log may not replay; keyed by `(session_id, ref)` where `ref` is `seq:<n>`, clamped to `archive.maxCharsPerEvent`. |
| `pending_extraction` | `(session_id, seq)` queue with `attempts` and `last_error` for failed extraction retries. |
| `meta` | plugin metadata (`schema`, etc.). |

`REPORT_TABLES` (used by diagnostics) lists `sessions`, `events`,
`memory_items`, `memory_events`, `task_state`, `checkpoints`, `skill_versions`,
`rules`, `assembly_logs`, `validation_logs`.

## Memory write principles

These rules are enforced in `src/memory/store.js` and `src/memory/extraction.js`,
not just documented:

1. **Raw evidence is immutable.** `events` are append-only; `archive` keeps text
   that the host may evict. Memory items reference events by sequence number, so
   any claim can be traced back to the original line.
2. **Proposals are never auto-promoted.** Assistant statements are stored with
   `evidence_type = 'assistant_proposal'` and a lower retrieval weight; only user
   statements are `user_explicit`. Promotion is a separate, explicit lifecycle
   event (`promoted`).
3. **Numbers keep their conditions.** Extracted numbers store the raw text, unit
   and the qualifying conditions that were in scope; assembly flags numbers
   without conditions (`⚠该数字缺少统计条件/单位…`) rather than silently using them.
4. **Conflicts keep both sides.** Competing claims can be marked `disputed`;
   both rows remain retrievable until a user decision resolves the conflict.
5. **Corrections supersede, they do not delete.** A correction creates a new item
   and marks the old one `superseded` with `superseded_by` plus a
   `memory_events` entry; historical values stay queryable.
6. **Writes are idempotent per event sequence.** Event inserts are
   `INSERT OR IGNORE` on `(session_id, seq)`; memory items dedupe on active
   content hash. Replays and restart recovery are therefore safe to repeat.

Retraction is a status change (`retracted`, excluded from retrieval, still in
the audit trail). Only `purge` deletes rows, and it is an explicit command.

## Retrieval design

Retrieval is determinant, local and model-free.

- Query signals come from the step's task text: tokens (Latin words of length ≥ 2
  plus CJK bigrams, at most 160), exact terms, numbers, filesystem paths and
  quoted phrases.
- Candidates are FTS5 `trigram` matches over active memory items; a LIKE fallback
  covers short queries that the trigram tokenizer cannot serve.
- **Score** for each candidate:

  ```
  score = KIND_WEIGHT[kind]
        + min(|ftsScore|, 10) / 10
        + exactMatchBoost * min(exactHits, 3) / 3
  score *= EVIDENCE_WEIGHT[evidence_type]
  ```

  where `KIND_WEIGHT` is 1.0 for `decision`/`constraint`, 0.95 for `fact`, 0.8 for
  `preference`/`open_question`, 0.5 for `proposal`; `EVIDENCE_WEIGHT` is 1.0 for
  `user_explicit`, 0.95 for `artifact_verified`, 0.9 for `skill`, 0.6 for
  `assistant_proposal`, 0.4 for `inferred`. A supersession link multiplies the
  score by 0.4. Recently ingested evidence (within 40 sequence numbers of the
  checkpoint) gets `recencyBoost`.
- Hits below `retrieval.minScore` (default 0.5) are returned as `omitted` with the
  reason, so explain output can show *why* something was not injected.
- Selection is capped by `retrieval.limit` (default 24, hard cap 100).

Raw evidence is retrieved separately: event rows referenced by selected memory
items (`source_refs`) plus exact matches for numbers, paths and quoted phrases
are resolved verbatim from `events` (`store = host`) or from `archive`
(`store = archive`). `Retriever.expand(seqs, { radius })` returns neighbouring
events for local inspection.

### The "insufficient evidence" contract

When the query has no support in committed evidence, `Retriever.insufficient()`
produces an explicit statement (in Chinese, matching the injected block) saying
that the session memory contains no committed evidence for the query and that
history must not be inferred or fabricated. The injected header repeats the
rule: *if no reliable evidence is found, answer "insufficient evidence", do not
invent history*. This is a behaviour contract for the model, not a guarantee
that the model obeys it.

## Assembly design

The assembler builds at most one message per step. Its priorities, in order:

1. **Task state** (`task` section) — goal, progress, blockers, open items.
2. **Resident skill core** (`rules-core`) — compact description + workflow lines
   from enabled skills.
3. **Task-relevant rules** (`rules`) — rule text with source path/line, scope
   notes, and an explicit warning for `current_state` rules (`[dynamic state:
   verify against current data; not a fixed check]`).
4. **Memory items** (`memory`) — kind/evidence label, conditions, scope, number
   warnings, proposal warnings and source references.
5. **Raw evidence** (`evidence`) — verbatim snippets for selected items and exact
   matches.
6. **Notice** — superseded historical values and disputed counts, when present.

The budget is `max(assembly.minBudgetTokens, assembly.softBudgetTokens)`
(defaults 600 / 3000). Each candidate costs its estimated token count; if it does
not fit in the remaining budget it is omitted with a reason. `assembly.skipWhenEmpty`
(default true) means an empty session injects nothing at all. Items whose source
events are all still visible in the current step (`checkpoints.lastAssemblySeq` +
visible-text matching) are excluded, so the block does not restate messages the
model can already see; after compaction those texts disappear from the visible
set and the items return.

Token accounting uses `estimateTokens()` (`ceil(cjkChars / 1.6 + otherChars / 4)`)
unless the host adapter can supply `ctx.tokenMeter`, in which case the measured
value is used and `token_source` is recorded as `exact`.

The assembled text is prefixed with a fixed header that states: this is derived
index plus raw evidence, **not** system instructions; the current user input and
system prompt take precedence; sources are labelled `[mem …]`, `[rule …]`,
`[ev seq:N]`. The result is deterministic for the same state and config.

Every assembly attempt is logged via `Assembler.log()` into `assembly_logs` with
sections, included ids, omissions and reasons. `memory explain` reads the latest
row; nothing is re-run at explain time.

## Compaction coordination

DSH's compaction removes old surface messages from the model's context. Because
the plugin keeps its own durable evidence, it does not need to patch or preserve
the host's compaction summary — it only needs to notice compaction and re-arm.

- `compaction/start`, `compaction/end`, `compaction/summary` and
  `compaction/prune` are captured events (`COMPACTION_EVENT_TYPES`). Large
  compaction summaries are additionally archived.
- After a compaction, the next `agent/pre-step` assembles from the local database
  rather than from the compacted surface, so early constraints and numbers
  survive. `compatibility.reinjectAfterCompaction` controls this.
- The plugin never edits host session logs, never rewrites the compaction
  summary, and never depends on a particular compaction plugin being installed.
- `compatibility.compactionPolicy` (`auto` by default) states what the plugin
  expects: `auto` detects from the event stream, `compaction-basic` assumes the
  serial pre-step listener model, `billion-context` assumes that a gating
  compressor may suppress ordinary pre-step assembly, `none` disables the
  assumption and reports a notice in the assembled block.
- Detection results and any unobservable configuration are reported by
  `memory status` (see [compatibility.md](compatibility.md)).

## Validation design

Validation is optional and deterministic. Checks are configured in
`validation.checks`; each may carry a `scope` (`body`, `quote`, `path`,
`explanation`) that is evaluated with the same scope semantics as skill rules.

| Check type | Semantics |
| --- | --- |
| `required_terms` | Terms that must appear (optionally with `minCount`). |
| `forbidden_terms` | Terms that must not appear; scope-aware (`quote`/`path` exceptions). |
| `numbers_with_conditions` | A configured number must carry its conditions within a character window; also checks a `forbiddenNumbers` list. |
| `script` | Dynamically imported user module exporting a check function; reported as non-deterministic unless `deterministic: true`. |

Preconditions (`validation.preconditions`) run before file tool operations in
`tools/pre-execute`: `mustExist` / `mustNotExist` over a glob-ish `pathPattern`,
with optional `tools` filter. They return a deny decision with a reason.

Blocking is conservative: a violation blocks only when it is deterministic,
configured to block (per-check `block` or global `blockOnViolation`), and repair
attempts (`maxRepairAttempts`, default 2) are not yet exhausted. Unknown check
types are reported as errors and skipped.

Validation runs after the host commits an assistant message: the adapter reads
new `assistant/message` events (deterministic checks only, no extra model call),
persists the run in `validation_logs`, and — for configured error-severity
violations that are not yet repaired — injects a bounded, clearly labelled repair
reminder (at most `maxRepairAttempts` times per conversation). A semantic
judgement is never treated as a deterministic failure: `script` checks report
`deterministic: false` unless declared otherwise, and only deterministic failures
may block. `memory status` and `memory explain` show the latest run.

## Extension points

Three seams are deliberately kept narrow:

1. **Semantic retrieval (reserved, not implemented).** The retriever is the only
   ranking path; a future semantic provider would implement the same
   `retrieve()`/`retrieveEvidence()` interface and be wired through config. v1
   ships keyword-only ranking; no embedding or network call exists in the code.
2. **Storage port.** `MemoryStore` + `MemoryDatabase` form the storage API. All
   other modules talk to `MemoryStore`, never to SQLite directly, so an
   alternative storage backend can implement the same methods.
3. **Validation scripts.** User-supplied `script` checks allow custom
   deterministic rules without changing the plugin.

Additionally, skill ingestion (`skills.include` / `skills.exclude` +
`SkillManager.ingestSkills`) is the path for adding rule sources, and
`rule_overrides` allows adjusting parsed rules without editing the skill file.

## Invariants and failure handling

- Capture never blocks the host: errors are logged, and the content hash /
  `(session_id, seq)` primary key keep repeated deliveries harmless. There is no
  log-tail replay: a listener that misses events while the process is down simply
  captures from the next live event on; the host's own session log remains the
  durable source the user can always quote from.
- Extraction failures queue in `pending_extraction` and retry; they never delete
  evidence.
- Assembly failures still return a result with `injected: false` and `errors`
  populated; diagnostics surfaces the last error.
- Validation failures are persisted in `validation_logs`; only configured,
  program-decidable failures may schedule a bounded repair reminder
  (`maxRepairAttempts`), and a semantic judgement is never labelled
  deterministic.
- The database is plugin-local. The plugin never writes the host session-query
  database, never modifies another plugin's storage, and never patches host
  logs.
- `MemoryDatabase.integrityCheck()` is available to diagnostics tooling; a
  failed check is reported, never auto-repaired.
