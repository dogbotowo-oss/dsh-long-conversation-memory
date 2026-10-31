# Evaluation protocol

This document defines how `dsh-long-memory` is measured. The protocol is
deliberately conservative: it separates **storage correctness**, **retrieval**,
**assembly**, **token cost** and **latency**, and never merges them into a single
headline score. A plugin that scores well on one axis may score poorly on
another, and the report must make that visible.

Because the project has no model dependency, the default path is fully
deterministic and offline. An optional LLM answerer can measure answer accuracy
when credentials are explicitly provided.

## Baselines

Three baselines run over the same fixtures, seeds and questions:

| Baseline id | Display name | What it represents |
| --- | --- | --- |
| `skill-only` | Skill only | The session surface plus the skill text; no memory, no summarization. |
| `rolling-summary` | Skill + rolling summary | A fixed rolling summary of the last N turns kept in the prompt. |
| `memory` | Memory plugin | This plugin's injection pipeline. |

All three see identical conversation fixtures and queries. `skill-only` and
`rolling-summary` have no local storage, so storage-only metrics are `null` for
them 鈥?never fabricated as `0`.

## Session sizes and profiles

| Profile | Session sizes (turns) | Intended use |
| --- | --- | --- |
| `smoke` | 100, 200 | Default. Fast (~seconds); what `npm run eval` runs. |
| `standard` | 100, 200, 500 | Deeper runs for release notes. |
| `full` | 100, 200, 500, 1000 | Long-session behaviour, repeated compaction stress. |
| `seed` | committed tiny fixtures | Replays `tests/fixtures/synthetic/seed/`; CI sanity only. |

Smaller fixture profiles never replace a `full` claim in release notes: a
limitation that only shows up at 1000 turns is still a limitation.

## Scenario matrix

Each scenario is generated from a seed and instrumented with questions whose
answers are known. The same logical scenario is exercised at every applicable
size.

| Behaviour under test | How it is exercised |
| --- | --- |
| Early rule adherence | A rule stated in the first turns is queried late; the answer must cite it. |
| Number + condition recall | A number with a unit and statistical condition is stated once, then queried after compaction; deleting the condition or the unit counts as wrong. |
| Corrections (old/new) | A value is corrected; questions ask for the new value and separately verify the old value is `superseded`, not active. |
| Task recovery after a side quest | A long unrelated detour is inserted, then the original task state is queried. |
| Repeated compaction | Compaction events fire multiple times; after each, the same evidence questions are re-asked. |
| Restart / resume | The session is closed and reopened; questions are asked against the resumed session. |
| Cancel / retry / duplicate events | Duplicate or retried event sequences are injected; storage must not duplicate evidence. |
| Multi-session isolation | Two interleaved sessions (`iso-alpha-*`, `iso-beta-*`) with conflicting values; each must only recall its own. |
| Instruction pollution in tool output | Tool results contain text that looks like user instructions; it must not be captured as user evidence or override rules. |
| Chinese retrieval | Chinese questions over Chinese evidence (bigram/trigram search path). |
| Long-haul retention | 100鈥?000 turn sessions where early facts are queried at the end. |

Harness-level scenario ids currently reported are `long-haul` (all sizes) and
`multi-session` (the isolation group). Questions carry a `kind` of `fact`,
`rule`, `evidence`, `pollution` or `isolation` and a `lang` of `en` or `zh`.

## Answer key requirement

The harness may only score scenarios that ship an answer key:

- every question has an id and a known answer or expected evidence reference;
- expected memory assertions are written independently of the plugin's output
  (never derived by running the plugin and recording what it returned);
- a scenario without a key fails fixture validation instead of scoring `null`;
- questions are answered by a deterministic reference answerer by default; the
  optional LLM answerer (`--answerer=llm`, requires
  `DSH_EVAL_LLM_API_KEY`) is scored against the same key and its metrics are
  reported separately.

This prevents circular evaluation: the plugin cannot define its own ground
truth.

## Metrics

Metrics are defined per question/per session and then aggregated (mean, or
fraction). Formulas:

| Metric | Formula | Axis |
| --- | --- | --- |
| `storageCorrectness` | matched expected memory assertions / total expected assertions (active item present, superseded item inactive, numbers carry conditions) | storage |
| `retrievalRecall` | mean over questions of `|relevant items retrieved| / |relevant items|` | retrieval |
| `retrievalRank1` | fraction of questions whose top-ranked retrieved item is relevant | retrieval |
| `assemblyCoverage` | mean over questions of `|relevant items present in the injected message| / |relevant items|` | assembly |
| `extraTokensEstimate` | mean estimated injected tokens per query (`estimateTokens`, CJK-aware) | cost |
| `latencyMs` | `p50`, `p95` and `totalMs` per baseline over all operations | cost |
| `ruleCoverage` | fraction of questions whose governing skill rule reached the answer context | rules |
| `taskStateAccuracy` | fraction of task-state assertions (goal/progress/blockers/open items) that match the answer key | task state |
| `guardPassRate` | fraction of validation expectations met (forbidden/required terms, scoped bans); `null` where a baseline has no storage to guard | validation |
| `llmAnswerAccuracy` | fraction of answers judged correct against the key (optional LLM answerer only; `null` by default) | answer quality |

The default deterministic path reports **no** answer-accuracy number and says so
in the report notes. Token counts are estimates from character counts
(`ceil(cjkChars / 1.6 + otherChars / 4)`), not model tokenizer counts; reports
must label them accordingly.

## Hard invariants

The harness also checks correctness invariants that any run must satisfy. A run
with a failed invariant exits non-zero even if all metrics look good:

- `superseded_not_active` 鈥?a corrected value is `superseded`, and the new value
  is the only active item for that key;
- evidence is never duplicated by retried/duplicate events (sequence idempotency);
- a session never retrieves another session's items (isolation);
- injected content is evidence-labelled, never injected as instructions;
- no absolute personal paths or session credentials appear in exported data.

## Running the harness

```sh
# default: smoke profile (100 + 200 turns), all three baselines
node scripts/eval.mjs

# explicit profile / sizes
node scripts/eval.mjs --profile smoke|standard|full|seed
node scripts/eval.mjs --profile full --turns=100,200,500,1000

# other options
--seed=<string>            # deterministic fixture generation seed
--fixtures=<dir>           # default tests/fixtures/generated
--out=<dir>                # default eval-results
--baselines=skill-only,rolling-summary,memory
--regenerate               # force fixture regeneration
--answerer=deterministic|llm   # llm needs DSH_EVAL_LLM_API_KEY
--json                     # print the report JSON instead of the human table
--verbose
```

Fixtures are generated separately (and automatically when missing or stale):

```sh
node scripts/generate-fixtures.mjs --profile smoke|standard|full
```

Generated fixtures go to `tests/fixtures/generated/` (gitignored). The committed
seed fixtures under `tests/fixtures/synthetic/seed/` are small and replayable by
`--profile seed`.

Exit codes: `0` all hard invariants pass; `1` a hard invariant failed;
`2` usage error or missing prerequisites (for example plugin modules missing, or
`--answerer=llm` without a key).

## Output

The harness writes `eval-results/<timestamp>.json` (gitignored) and prints a
human-readable table. The JSON report has this shape:

```jsonc
{
  "format": "dsh-long-memory-eval-report",
  "version": 1,
  "generatedAt": "鈥?,
  "profile": "smoke|standard|full|seed",
  "seed": "鈥?,
  "answerer": "deterministic|llm",
  "environment": {
    "node": "鈥?, "platform": "鈥?,
    "plugin": { "available": true, "missingModules": [] }
  },
  "fixtures": { "dir": "鈥?, "regenerated": false, "sessions": 6, "groups": ["鈥?] },
  "metricOrder": ["storageCorrectness", "retrievalRecall", "retrievalRank1",
                  "assemblyCoverage", "extraTokensEstimate", "latencyMs",
                  "ruleCoverage", "taskStateAccuracy", "guardPassRate",
                  "llmAnswerAccuracy"],
  "metrics": {
    "storageCorrectness": { "skill-only": null, "rolling-summary": null, "memory": 0.0 },
    "retrievalRecall":    { "skill-only": 0.0, "rolling-summary": 0.0, "memory": 0.0 },
    "latencyMs":          { "skill-only": { "p50": 0, "p95": 0, "totalMs": 0 }, "鈥?: {} },
    "llmAnswerAccuracy":  null
  },
  "hardInvariants": [ { "id": "superseded_not_active", "status": "pass|fail", "detail": "鈥? } ],
  "perScenario": [ { "scenario": "long-haul", "size": 100, "sessionIds": ["鈥?],
                     "metrics": { "memory": "鈥? }, "storage": "鈥?, "invariants": ["鈥?] } ],
  "perSize":   [ { "size": 100, "metrics": { "鈥?: "鈥? } } ],
  "questions": [ { "sessionId": "鈥?, "scenario": "鈥?, "id": "鈥?, "kind": "fact",
                   "lang": "en", "query": "鈥?,
                   "results": { "memory": { "retrievalRecall": 0.0, "retrievalRank1": 0.0,
                                            "assemblyCoverage": 0.0,
                                            "extraTokensEstimate": 0, "latencyMs": 0 } } } ],
  "notes": ["Tokens are estimates鈥?, "No LLM answer accuracy claimed鈥?,
            "Storage, retrieval, assembly, tokens and latency are deliberately reported separately and never merged into one score."]
}
```

Only `memory`-baseline storage metrics exist; `null` means "not applicable to this
baseline", never "zero".

## Reporting measured results

The tables below are copied from real `eval-results/*.json` runs of this
repository. Copy a new table only from a run on the commit you are publishing:
never mix numbers from a different commit, seed or profile.

Run metadata (both tables):

- plugin version 0.1.0, code commit `912ca83` (the `dsh-long-memory`
  unification commit these numbers were measured on);
- DSH target: 0.2.1-rc.3 (interfaces verified; the harness is host-independent);
- OS: Windows 10/11 x64, Node.js v24.19.0 (`node:sqlite` with FTS5);
- answerer: `deterministic` (no model calls), seed `dsh-long-memory-eval-v1`;
- date: 2026-10-31; wall clock: standard 2.2 s, full 5.1 s;
- reports: `eval-results/2026-10-31T04-31-44-709Z-standard.json`,
  `eval-results/2026-10-31T04-31-25-881Z-full.json` (gitignored; regenerate with
  the commands above).

### `standard` profile 鈥?5 sessions, 860 turns, 52 questions

| Metric | `skill-only` | `rolling-summary` | `memory` (this plugin) |
| --- | --- | --- | --- |
| `storageCorrectness` | n/a | n/a | 100.0% (270/270) |
| `retrievalRecall` | n/a | n/a | 84.2% (32/38) |
| `retrievalRank1` | n/a | n/a | 76.9% (20/26) |
| `assemblyCoverage` | 45.9% | 45.9% | 86.5% |
| `extraTokensEstimate` (mean) | 352.0 | 542.5 | 1151.6 |
| `latencyMs` mean / p95 | 0.0 / 0.0 | 0.0 / 0.0 | 8.3 / 18.8 |
| `ruleCoverage` | 100.0% | 100.0% | 100.0% |
| `taskStateAccuracy` | n/a | n/a | 100.0% (20/20) |
| `guardPassRate` | 100.0% | 100.0% | 100.0% |
| `llmAnswerAccuracy` | n/a | n/a | n/a (deterministic answerer) |

### `full` profile 鈥?6 sessions, 1880 turns (100/200/500/1000), 68 questions

| Metric | `skill-only` | `rolling-summary` | `memory` (this plugin) |
| --- | --- | --- | --- |
| `storageCorrectness` | n/a | n/a | 100.0% (338/338) |
| `retrievalRecall` | n/a | n/a | 84.0% (42/50) |
| `retrievalRank1` | n/a | n/a | 76.5% (26/34) |
| `assemblyCoverage` | 46.0% | 46.0% | 86.2% |
| `extraTokensEstimate` (mean) | 352.0 | 546.7 | 1154.8 |
| `latencyMs` mean / p95 | 0.0 / 0.0 | 0.0 / 0.0 | 14.1 / 37.6 |
| `ruleCoverage` | 100.0% | 100.0% | 100.0% |
| `taskStateAccuracy` | n/a | n/a | 100.0% (24/24) |
| `guardPassRate` | 100.0% | 100.0% | 100.0% |
| `llmAnswerAccuracy` | n/a | n/a | n/a (deterministic answerer) |

Hard invariants: 9/9 pass in both profiles (`superseded_not_active`,
`evidence_survives_restart_compaction`, `cross_session_isolation`,
`pollution_not_extracted`, `retry_no_duplicate`, `no_duplicate_active_content`,
`restart_idempotent_event_count`, `checkpoint_advanced`, `no_pipeline_errors`).

Assembly coverage by session size (`full`, `memory` vs `skill-only`): 40 turns
100.0% vs 40.0%; 100 turns 85.4% vs 46.3%; 200 turns 85.4% vs 46.3%; 500 turns
85.4% vs 46.3%; 1000 turns 85.4% vs 46.3%. Multi-session isolation scenario:
100.0% vs 40.0%. The plugin's injected context is therefore roughly 2.1鈥?.3脳 the
baseline token cost while covering ~1.9脳 more answer-key items; latency stays at
tens of milliseconds because retrieval is local SQLite and no model is called.

These numbers are the deterministic harness's view of *storage, retrieval and
assembly*. They are **not** an LLM answer-quality claim; run
`node scripts/eval.mjs --answerer=llm` with your own key if you want that axis,
and report it separately.

## Interpreting results honestly

- Report each axis separately; no single headline score exists.
- State the profile and seed; a `smoke` result does not describe 1000-turn
  behaviour.
- `null` is "not applicable", not a win.
- Token counts are estimates and must be labelled as such.
- If a hard invariant fails, the run is a failure regardless of metric values.
- Do not claim zero forgetting. Metrics measure the sampled questions, not all
  possible conversations.
