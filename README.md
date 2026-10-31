# dsh-long-memory

Long-conversation memory for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

## Summary

`dsh-long-memory` gives a DSH session a durable, evidence-first
memory across 100–1000+ turns: it records committed conversation events,
extracts facts, decisions, corrections and the current task state with
deterministic rules, indexes enabled skills as versioned rules, and injects a
small, evidence-labelled context block before each model step under a token
budget. It never calls a model of its own, never edits host session logs, and
stores everything locally in SQLite. It is built for sessions where early
instructions, exact numbers, corrections and open threads would otherwise be
lost to compaction, summarization or a restart — and it is measured against
two baselines by an offline long-session evaluation harness (see
[Evaluation results](#evaluation-results-measured)).

Verified against **DSH 0.2.1-rc.3**. Runs entirely on your machine.

## What it does

- **Captures** committed session events (user/assistant messages, tool calls and
  results, compaction events, commands) into an append-only local SQLite
  evidence table. Capture is idempotent per event sequence number, so retries,
  restarts and replays cannot duplicate data.
- **Extracts** memory items from user messages with deterministic rules — no
  model calls. Facts, decisions, constraints, preferences and open questions are
  stored separately; numbers are stored together with their unit and qualifying
  conditions; assistant statements are stored only as *proposals*.
- **Indexes skill rules** into four categories — stable rule, data convention,
  current state, operational lesson — and keeps "current state" dynamic: it is
  context, never a hard-coded validation rule.
- **Retrieves** relevant evidence and memory items with SQLite FTS5 (trigram) plus
  a LIKE fallback, ranked by exact-match, scope and recency boosts, scoped to the
  current session.
- **Assembles** one user-role evidence message under a token budget, in a
  deterministic order, and records exactly which sections were included,
  truncated or omitted, and why (`memory explain`).
- **Validates** optional deterministic checks and preconditions, with a bounded
  number of repair reminders. Validation is off by default and never guesses.
- **Coordinates with compaction**: after the host compacts the surface, memory is
  re-assembled from local evidence on the next step. The plugin never rewrites
  host session logs.

## Design priority: accuracy over token savings

Token efficiency matters, but it is not the first goal. The plugin prefers:

- a correct, verifiable memory over a shorter summary;
- raw evidence preserved over a derived claim that cannot be audited;
- an explicit "unknown / not retrieved" over a fabricated recollection;
- both sides kept on a conflict, with a recorded supersession, over silently
  picking a winner;
- a verified host interface over one that merely looks right.

The injected memory message is deliberately budgeted (default soft budget 3000
estimated tokens), but the budget reduces *how much* is injected, not whether
evidence is stored.

## How it works

```
DSH step boundary
  agent/pre-step ──► retrieve ──► assemble ──► inject user-role evidence message
                                                        │
session/event (committed) ──► capture ──► extract ──► validate (optional)
                                                        │
                                                   assembly log
```

1. **Capture** (`src/capture.js`) turns committed host events into `events` rows:
   normalized text, source kind, turn/step, tool name, content hash, and an
   `store` column describing whether the raw text is replayable from the host log.
   Large tool results and compaction summaries are additionally archived when
   the host may not replay them.
2. **Extract** (`src/memory/extraction.js`) runs incrementally from the
   `checkpoints.last_extract_seq` cursor. It creates memory items, detects
   explicit corrections, and merges labelled task-state lines (`Goal:`,
   `Progress:`, `TODO:` …). Failed extraction is queued in `pending_extraction`
   and retried; raw evidence is never dropped.
3. **Skills** (`src/skills.js`) snapshots skill content into versioned rows and
   parses rule files into categorised `rules`.
4. **Retrieve** (`src/retrieval.js`) ranks active memory items, rules and evidence
   for the current step.
5. **Assemble** (`src/assembly.js`) builds the injected message: a stable header,
   the resident rule core, task state, relevant rules/items and evidence snippets,
   fitted to the budget. `memory explain` reports the decision for each section.
6. **Validate** (`src/validation.js`) applies configured deterministic checks to
   committed assistant output and, optionally, preconditions before dispatch.
7. **Diagnostics** (`src/diagnostics.js`) reports schema, counts, checkpoint lag,
   compatibility and integrity.

See [docs/architecture.md](docs/architecture.md) for the module table, storage
schema and the write principles.

## Requirements

- **DSH 0.2.1-rc.3** (`@deepseek-ai/cordis` 4.x).
- **Node.js 22.15+ or 24+** for `node:sqlite`; the FTS5 `trigram` tokenizer used
  for CJK-capable search requires Node >= 22.5. The package declares
  `^22.15.0 || >=24.0.0`.
- Windows, macOS or Linux. No native build step is required for the plugin
  itself: SQLite comes from the Node runtime (`node:sqlite`).

## Install

From a checkout of this repository:

```sh
dsh plugin --profile <profile> add <path-to-plugin>
```

For example, pass the path where this repository is checked out as
`<path-to-plugin>`. The package ships a `cordis.patch.yml` bundle patch and a
`dsh.bundle.patch` entry in `package.json`, so adding the package is enough —
there is no separate build step. The same package can be installed straight
from GitHub:

```sh
dsh plugin --profile <profile> add github:dogbotowo-oss/dsh-long-memory
```

After installing, open a session and run:

```
memory status
```

to confirm the plugin loaded, the database opened and the schema version matches.

## Configuration

Every key is optional; omitted keys use the defaults in
[`src/config.js`](src/config.js). A complete sample lives in
[`examples/config.json`](examples/config.json).

```json
{
  "enabled": true,
  "dataDir": "",
  "dbFile": "memory.sqlite",
  "includeSubagents": false,
  "assembly": {
    "enabled": true,
    "softBudgetTokens": 3000,
    "minBudgetTokens": 600,
    "maxMemoryItems": 40,
    "maxRules": 12,
    "maxEvidence": 8,
    "evidenceTypes": ["user/message"],
    "skipWhenEmpty": true,
    "reinjectUnchangedTurns": 0,
    "includeTaskState": true
  },
  "extraction": {
    "enabled": true,
    "immediateCorrections": true,
    "scanUserMessages": true,
    "recordAssistantProposals": true
  },
  "retrieval": {
    "limit": 24,
    "exactMatchBoost": 3,
    "scopeBoost": 2,
    "recencyBoost": 0.5,
    "minScore": 0.5
  },
  "compatibility": {
    "compactionPolicy": "auto",
    "reinjectAfterCompaction": true,
    "reportUnknownCompatibility": true
  }
}
```

Key groups:

| Group | Purpose |
| --- | --- |
| `enabled`, `dataDir`, `dbFile` | Master switch and database location. Empty `dataDir` means `<DSH_HOME>/long-memory/`. |
| `assembly` | Injected-message budget (`softBudgetTokens`), section limits and re-injection policy. `evidenceTypes` decides which raw event types may be quoted inline; the default `["user/message"]` keeps tool output (untrusted, possibly injected) searchable but not pasted into the request. |
| `extraction` | Deterministic extraction switches; `recordAssistantProposals` controls whether assistant proposals are stored. |
| `retrieval` | Candidate limit and ranking boosts; `minScore` filters weak hits. |
| `validation` | Deterministic `checks` / `preconditions`, `maxRepairAttempts`, `blockOnViolation`. |
| `commands` | Slash-command registration, name (default `memory`) and optional model tool. |
| `compatibility` | Compaction coordination policy (`auto` / `compaction-basic` / `billion-context` / `none`). |
| `diagnostics` | Verbose logging and assembly-log retention. |
| `archive` | Selective archival of raw text the host log may not replay. |
| `skills` | Skill inclusion/exclusion, resident-core size and rule-size limits. |

Unknown keys are preserved, and numeric values are clamped to safe ranges
(for example `softBudgetTokens` to 200–20000) so a typo cannot produce a
degenerate budget.

## Commands

The plugin registers a `memory` slash command (configurable via
`commands.name`; disable registration with `commands.register: false`).

| Command | What it shows or does |
| --- | --- |
| `memory status` | Database path, session id, event/memory/rule/skill counters, checkpoints, soft budget, last assembly, and the compaction-compatibility line. |
| `memory inspect <id>` | One memory item: kind, evidence level, status, content, conditions, scope, source refs, supersession links, numbers, revision history and the original evidence text. |
| `memory search <query>` | Keyword search over memory items and captured evidence, with scores, conditions and source event references. |
| `memory explain` | Why the last injected memory message looked the way it did: trigger, step, budget, token source, section breakdown, included/omitted items and reasons. |
| `memory retract <id> [reason]` | Retract a memory item: it becomes `retracted`, disappears from retrieval, and stays in the audit trail. |
| `memory export [--events]` | Print the session's memory as JSON; `--events` additionally includes captured raw events. |
| `memory purge` | Irreversibly delete **this session's** memory from the local database (indexes and derived data included). Host session logs are untouched. |
| `memory help` | Print the command help text. |

Exact output is intentionally plain text so it can be copied into bug reports.
`memory status` is also the compatibility check: it reports which compaction
policy the plugin detected and warns when compatibility could not be confirmed.

## Data and storage

- One SQLite file per DSH home: `<DSH_HOME>/long-memory/memory.sqlite`
  (override with `dataDir`/`dbFile`). Opened through `node:sqlite` with WAL mode.
- Tables: `events`, `memory_items`, `memory_events`, `task_state`, `checkpoints`,
  `skill_versions`, `skill_files`, `rules`, `rule_overrides`, `assembly_logs`,
  `validation_logs`, `archive`, `pending_extraction`, `sessions`, `meta`, plus
  two FTS5 indexes.
- `events` is a complete audit record: every committed host event is stored,
  including generated context injected by other plugins (distinguished by
  `source.kind`). "What counts as evidence" is enforced by each consumer:
  extraction derives only from real user input, retrieval filters generated
  context, and assembly quotes only `assembly.evidenceTypes` (default
  `user/message`). Tool output is therefore searchable but not pasted into the
  request by default.
- Raw evidence is append-only. Derived indexes can be rebuilt; memory rows are
  never deleted by revision flows (retraction is a status change; purge is an
  explicit, irreversible command).
- No telemetry. No network calls. The plugin does not call a model of its own,
  and no memory content is ever sent anywhere by this plugin.
- The plugin never writes to the host session-persistence database, never edits
  host session logs, and never touches another plugin's storage.

## Memory write principles

1. Raw evidence is immutable: summaries are indexes, not replacements.
2. Proposals are never auto-promoted to decisions.
3. Numbers are stored with their unit and qualifying conditions.
4. Corrections create a new item and supersede the old one; suppression is
   recorded, never erased.
5. Conflicts keep both sides visible until a user decision resolves them.
6. Writes are idempotent per session event sequence number.

These are enforced in the store (`src/memory/store.js`) and described in
[docs/architecture.md](docs/architecture.md#memory-write-principles).

## Evaluation results (measured)

The offline harness (`node scripts/eval.mjs --profile full`) compares three
baselines on seeded synthetic sessions with an independent answer key:
`skill-only`, `skill + rolling summary`, and this plugin. Metrics are reported
separately, never merged into one score. Measured on 2026-10-31, Node v24.19.0,
seed `dsh-long-memory-eval-v1` (6 sessions, 100/200/500/1000 turns, 68
questions):

| Metric | Skill only | Skill + rolling summary | This plugin |
| --- | --- | --- | --- |
| Storage correctness (answer-key assertions) | n/a | n/a | **100.0%** (338/338) |
| Retrieval recall / rank-1 | n/a | n/a | **84.0% / 76.5%** |
| Assembly coverage | 46.0% | 46.0% | **86.2%** |
| Extra tokens per query (estimate) | 352.0 | 546.7 | 1154.8 |
| Latency mean / p95 | 0.0 / 0.0 ms | 0.0 / 0.0 ms | 14.1 / 37.6 ms |
| Rule coverage / task-state accuracy | 100.0% / n/a | 100.0% / n/a | 100.0% / 100.0% |
| Guard pass rate (forbidden/required terms) | 100.0% | 100.0% | 100.0% |
| Hard invariants | n/a | n/a | **9/9 pass** |

The plugin injects roughly 2.1–3.3× the baseline token count while covering about
1.9× more answer-key items, at tens of milliseconds of local latency and with no
extra model calls. Token counts are character-based estimates, and there is no
LLM answer-quality claim by default (see
[docs/evaluation.md](docs/evaluation.md) for the exact protocol, per-size
breakdown and the optional LLM answerer). Long-session behaviour at 1000 turns
is covered by the `full` profile: assembly coverage stays at 85.4% at every size
from 100 to 1000 turns, while the baselines stay flat at 46.3%.

## Known limitations

- **No zero-forgetting promise.** This is a memory aid, not a proof system: a
  claim that was never stated, never captured, or pruned by the host before the
  plugin saw it cannot be recovered. Retrieval can also miss a relevant item.
- **Semantic retrieval is reserved, not implemented.** v1 retrieval is keyword
  based (FTS5 trigram + LIKE) with deterministic ranking boosts. The semantic
  provider seam exists but ships disabled.
- **Deterministic extraction only.** Extraction uses markers and patterns; it
  will store some statements you consider noise and miss some paraphrases.
- **Token counts are estimates.** The assembler estimates tokens from character
  counts (CJK-aware), not from the model tokenizer. `assembly_logs` records
  `token_source: estimate`.
- **Validation is opt-in and conservative.** It only applies checks you
  configure, and by default reports rather than blocks.
- **Compaction behaviour depends on the host policy in use** — see
  [docs/compatibility.md](docs/compatibility.md). A proxy that rewrites the
  request body outside DSH's event model cannot be observed and is reported as
  unverified rather than guessed.

## Privacy

- All data stays local: SQLite file under your DSH home (or your configured
  `dataDir`).
- No telemetry, no analytics, no network traffic, no model calls.
- Memory content is never sent anywhere by this plugin; it is only injected into
  the current session's own model context, exactly like any other DSH message.
- Export/purge are local commands. `memory purge` is irreversible for the plugin
  database but does not modify host session logs.

## Compatibility

- Verified against DSH **0.2.1-rc.3**.
- Works alongside `compaction-basic`; the plugin re-assembles after compaction
  events and never patches host logs.
- When `billion-context`-style compressors disable the serial pre-step listener
  or gate compaction, the plugin detects the policy from the event stream and
  reports it in `memory status`. See
  [docs/compatibility.md](docs/compatibility.md) for the exact public APIs used
  and what is intentionally left unverified.

## Development

```sh
node --test "tests/unit/*.test.mjs" "tests/integration/*.test.mjs" "tests/replay/*.test.mjs"  # all tests
node scripts/check.mjs                     # 8 structural/behaviour checks, including a full e2e smoke
node scripts/eval.mjs --profile full       # offline long-session evaluation harness
```

Node 24's `node --test <directory>` treats the directory as a module on some
platforms, so the glob form above is the supported invocation (the npm scripts
`npm test` / `npm run check` already use it).

The evaluation protocol (three baselines, 100/200/500/1000-turn sessions,
separate storage/retrieval/assembly/answer/token/latency metrics) is documented
in [docs/evaluation.md](docs/evaluation.md). The synthetic skill used by tests
and examples is
[`examples/synthetic-skill/SKILL.md`](examples/synthetic-skill/SKILL.md).

## License

MIT — see [LICENSE](LICENSE).
