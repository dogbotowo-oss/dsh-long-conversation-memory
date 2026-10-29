# Compatibility

This page records what `dsh-long-conversation-memory` expects from the DSH host, how those
expectations were verified, how the plugin coordinates with context-compaction
plugins, and what is deliberately left unverified. It separates "verified in the
shipped runtime" from "assumed to keep working".

## Verified host

| Item | Value |
| --- | --- |
| DSH version | `0.2.1-rc.3` (desktop distribution; read from the bundled `package.json`) |
| Host runtime | Electron desktop bundle that ships the `@deepseek-ai/dsh-*` packages |
| Node.js | `^22.15.0 || >=24.0.0` (declared in `engines`); `node:sqlite` with the FTS5 `trigram` tokenizer needs Node ≥ 22.5 |
| Verified against | The JavaScript shipped inside the desktop `app.asar`, not only the package documentation |
| Plugin dependencies | none — the plugin imports no `@deepseek-ai/*` package (see below) |

Only 0.2.1-rc.3 is verified. DSH is young and its plugin surface is still
moving; treat any other version as unverified until the checks below pass.

## Why the interfaces were verified from shipped source

DSH does not publish a versioned "public plugin API" contract separate from the
code that ships in the desktop application. Package documentation can lag the
runtime, and some useful APIs are already marked deprecated in their own types.
To avoid documenting guesses, every interface this plugin binds to was checked
against the shipped sources of the relevant packages. The checks focused on:

- the actual event names, payload shapes and listener ordering;
- the decision types listeners must return, and the type of the `next()`
  continuation;
- what the host does with a returned value versus what a helper merely
  constructs;
- deprecation markers, so the plugin can avoid interfaces that are already
  marked "new calls are prohibited";
- which package owns a service (`skills`, `commands`, `tokenMeter`, `tools`) and
  what registration/disposal means.

A second decision follows from the same constraint: **the plugin does not
import host packages at all.** A plugin installed from a public repository does
not share the host's module resolution, and pinning `@deepseek-ai/*` imports
would force every user onto one host build. The adapter
([`src/adapter/host.js`](../src/adapter/host.js)) therefore reproduces the two
small host helpers it needs — message construction and home-path resolution —
from their verified behaviour, and talks to everything else through the public
Cordis context (`ctx.on`, `ctx.get`, `ctx.commands.register`). The core modules
(`capture`, `skills`, `memory`, `retrieval`, `assembly`, `validation`,
`diagnostics`) contain no host-specific code at all.

## Verified interfaces

| Package | What was verified | How the plugin uses it |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-loop` | `agent/pre-step` waterfall dispatch, decision handling, turn/step order | Listener via `ctx.on('agent/pre-step', ...)` |
| `@deepseek-ai/dsh-llm` | `createUserMessage` / `createMessage` shape and message identity | Locally reproduced in `host.js` (`buildMemoryMessage`) |
| `@deepseek-ai/dsh-session` | `session/event` publication, `session.deriveMessages()`, session header fields, event record shape | `session/event` listener; `deriveMessages()` for visibility dedupe |
| `@deepseek-ai/dsh-home-paths` | default DSH home resolution | Locally reproduced in `host.js` (`resolveDataDir`) |
| `@deepseek-ai/dsh-skill` | `skills` service: `list`, `get`, `skills/change` | Optional service read through `ctx.get('skills')` |
| `@deepseek-ai/dsh-commands` | `commands` service: `register`, handler invocation shape, result contract, `command/run` / `command/done` log events | Optional registration through `ctx.get('commands')` |
| `@deepseek-ai/dsh-token-meter` | `tokenMeter` service: text/message estimation | Optional through `ctx.get('tokenMeter')` |
| `@deepseek-ai/dsh-tools` | `tools/pre-execute` waterfall and its decisions | Optional listener when preconditions are configured |
| `@deepseek-ai/dsh-compaction-basic` | serial `agent/pre-step` compaction listener, `compaction/*` log events | Observation only (events captured); no code import |

## Plugin entry contract

The plugin is a plain Cordis plugin:

```js
export const name = 'long-conversation-memory'
export const version = '0.1.0'
export const inject = []            // loads on any profile
export function apply(ctx, config) { /* normalize, create runtime, ctx.effect(...) */ }
```

Verified behaviour:

- Cordis calls `apply(ctx, config)` and disposes the plugin through
  `ctx.effect(...)`; everything the plugin owns (listeners, database handle,
  command registration) is created inside that effect and closed on unload;
- `inject` is intentionally empty, so a profile without skills or compaction
  still loads the plugin. Optional services are read lazily with `ctx.get(name)`
  and degrade to "memory without that source" instead of a failed load;
- the plugin guards every host hook: an error inside memory handling is logged
  and the host pipeline continues. Memory never fails a turn. The one exception
  is a configured file precondition, which may deny a tool call by design.

## `agent/pre-step` waterfall

The plugin injects its memory message from inside the pre-step waterfall:

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const prepared = prepareFromLocalStore(payload)   // read-only; no host mutation
  const decision = await next()
  if (decision === null || decision.kind === 'reject') return decision
  if (prepared === null) return decision           // nothing to inject this step
  return { ...decision, messages: insertAfterClaimed(decision.messages, prepared.message) }
})
```

Verified behaviour:

- listeners receive `{ agent, messages, turn, step, signal }` and a `next()`
  continuation; `messages` are the user messages claimed for the proposed step;
- the decision is an object with `kind: 'enter' | 'reject'` and a `messages`
  array; returning `kind: 'reject'` opens no step;
- a plugin injects context by **appending a message to `decision.messages`** — a
  message constructor alone is not an injection API;
- listeners are ordered: earlier listeners (for example a pressure compactor
  registered before this plugin) run before this one gets control, so state
  changes they commit via session events are already captured when the memory
  block is assembled;
- the plugin assembles from the local database *before* continuing the
  waterfall and appends the message to the decision returned by `next()`. It
  returns a new decision object rather than mutating the one it received;
- the loop re-runs pre-step per step, but **retries reuse the same rendered
  assembly**; the plugin does not rely on a retry producing another pre-step.

### Duplicate suppression

A memory block identical to one the model can already see is not injected again.
The adapter reads the visible (non-compacted) history with
`session.deriveMessages()` and compares the plugin's `source.contentHash` on
memory messages:

- identical block still visible → skip injection;
- block no longer visible (a compaction removed it, or it was never there) →
  inject it again.

`assembly.reinjectUnchangedTurns` (default `0` = never) can additionally force a
refresh after N turns.

## Message construction (`createUserMessage` equivalent)

`createUserMessage` lives in `@deepseek-ai/dsh-llm`, but the plugin cannot import
host packages (see above). `host.js` reproduces the verified behaviour with
`buildMemoryMessage`:

```js
{
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'long-conversation-memory', form: 'snapshot', contentHash, sessionId, turn?, step? },
}
```

The shipped `createUserMessage` returns a deep-frozen clone with a fresh id; the
object above is JSON-serializable and satisfies the same session-append
validation, which is structural. Verified points the plugin depends on:

- messages are plain structurally-validated records, so a locally built user
  message is accepted by the session log;
- the `source.kind` label is how a later step recognizes the plugin's own
  injection. It is also why the capture layer never treats these messages as
  user evidence;
- `source.contentHash` is what makes visibility dedupe and post-compaction
  re-injection checkable.

Because this is reproduced rather than imported, a future host that tightens
message validation could reject the message; the failure mode is a step without
memory context, not corrupted session data.

## `session/event` and `session.deriveMessages()`

Committed events are captured through the public emit:

```js
ctx.on('session/event', (session, event) => { /* { seq, time, type, data } */ })
```

Verified behaviour:

- events are published **after** the session log accepted them, so capture is
  after the fact and never blocks or rewrites the durable log;
- event records are deep-frozen typed objects with `seq`, `time`, `type`,
  `data`;
- the plugin captures a selective set of event types (see
  [`src/capture.js`](../src/capture.js)) and normalizes them into its own
  `events` table with `(session_id, seq)` idempotency;
- session identity and metadata come from the session header
  (`header.id`, `header.cwd`, `header.origin`, `header.project`); sessions with
  `origin === 'subagent'` are skipped unless `includeSubagents: true`;
- `session.deriveMessages()` returns the visible message list used for duplicate
  suppression. The plugin only reads it.

### Deprecated reads that are deliberately not used

In 0.2.1-rc.3 the synchronous history reads `session.eventAt()` and
`session.snapshotEvents()` are marked deprecated in the shipped source ("new
calls are prohibited"). The adapter does not use them: capture is live-only and
history visibility comes from `deriveMessages()`.

Consequence, stated plainly: if an event happens while the plugin is not
listening (for example a crash between the host append and the listener), it is
not replayed into the memory index automatically. The host session log is
unaffected and remains the source of truth; a derived index entry may be
missing. The capture service does support batch intake (used by the test
harness's fake host), but the runtime does not replay host history.

## `ctx.skills`

The `skills` service owns the host's skill catalog (filesystem providers,
embedded packs and runtime registrations). The plugin uses it read-only:

- on a throttled basis (and whenever `skills/change` fires), it lists the
  effective skills and reads each skill's full `SKILL.md` content;
- content is indexed into versioned `skill_versions` rows and parsed into
  categorised rules in the plugin's own database;
- the plugin never registers providers, never mutates host skill state and never
  caches host objects beyond the sync;
- a profile without the service simply has no skill rules; memory otherwise
  works.

## `ctx.commands`

The `memory` command is registered when the host exposes a `commands` service:

```js
ctx.commands.register({
  name: 'memory',
  description: '…',
  input: { hint: 'status | inspect <id> | search <query> | …' },
  handler: (invocation) => ({ kind: 'success', text: diagnostics.handle(invocation.rawInput) }),
})
```

Verified behaviour:

- a definition needs a kebab-case name (`/^[a-z][a-z0-9_-]*$/`), a non-empty
  `description` and a `handler`; registration returns an effect disposer that
  removes exactly that definition;
- the handler receives one frozen invocation object with `commandId`, `agent`,
  `rawInput`, `attachments` and `signal`, and must resolve to
  `{ kind: 'success', text? }` or `{ kind: 'error', text }`;
- the host appends `command/run` before the handler runs and `command/done`
  after settlement. Both are session events, so this plugin captures its own
  command invocations as evidence too.

Command output formatting lives in [`src/diagnostics.js`](../src/diagnostics.js),
testable without a host. If command registration fails, the plugin still works
without the slash command.

## `ctx.tokenMeter`

When the host exposes a token meter, the adapter tries to price the injected text
with it; the measured value is used for the assembly budget and the record says
`token_source: exact`. If no attributable measurement is available, the
assembler falls back to its deterministic estimate (`ceil(cjkChars / 1.6 +
otherChars / 4)`) and records `token_source: estimate`. `memory explain` shows
which one was used, so an estimate is never presented as an exact count.

## `ctx.tools` — `tools/pre-execute`

Configured file preconditions run before tool execution:

```js
ctx.on('tools/pre-execute', async (exec, next) => {
  const decision = evaluatePreconditions(exec)   // mustExist / mustNotExist
  if (decision?.allow === false) return { kind: 'deny', reason: decision.reason, info: decision.info }
  return next()
})
```

Verified behaviour:

- the waterfall's default decision is `allow`; listeners may return `deny`
  (with reason), `ask` (resolved by the host's approval seam) or `cancel`;
- a denial becomes a tool error result with the reason text, and the tool does
  not run; guards run after an allow;
- this plugin only produces `allow`/`deny`, only for configured path
  preconditions, and only when the `tools/pre-execute` listener is registered
  (preconditions non-empty). It never rewrites tool results or arguments.

## Data directory resolution

The plugin keeps its own directory under the DSH home:

1. `dataDir` config value, if set (with `~` and simple `$VAR` expansion);
2. otherwise `$DSH_HOME`, or `~/.dsh` when the variable is unset, plus
   `long-conversation-memory/`;
3. the database file is `dbFile` (default `memory.sqlite`) inside that
   directory.

The plugin never writes into the host's session-persistence database, never
patches host session logs and never touches another plugin's storage.

## Compaction coordination

DSH compaction removes old surface messages from the model's context. The plugin
keeps its own durable evidence, so it coordinates by observing and re-assembling,
never by patching the host:

- `compaction/start`, `compaction/end`, `compaction/summary` and
  `compaction/prune` are captured events; the runtime also tracks, per session,
  how many compaction events were observed and when the last one happened;
- each step's assembly is built from the local database, so a number or
  constraint stated before a compaction is available after it;
- duplicate suppression uses visible history: when a compaction removes the
  memory block, the next step re-injects it; when it is still visible, it is not
  duplicated. This is the post-compaction re-injection path, controlled by
  `compatibility.reinjectAfterCompaction`;
- `compatibility.compactionPolicy` (`auto` by default) states what the user
  expects: `auto` accepts whatever the host does and reports what cannot be
  confirmed; `compaction-basic` documents the shipped serial pre-step listener;
  `billion-context` documents a gating compressor that may suppress ordinary
  pre-step assembly; `none` marks compaction coordination as not applicable.
- the adapter also derives a compatibility note from what is observable through
  the public context: whether a `compaction` service exists, whether compaction
  events were observed for the session, and the last compaction sequence. The
  plugin cannot see another plugin's internal listener order, so this is
  reported as confirmed (events observed) or unconfirmed, never guessed.

What the plugin knows about the shipped backend: `compaction-basic` registers a
serial `agent/pre-step` listener that runs before ordinary downstream listeners
and appends `compaction/*` events; it never patches the log outside session
appends. Third-party compressors are not shipped with DSH and their internals are
not assumed.

The plugin never edits host session logs, never rewrites a compaction summary,
never writes the host session-query database and never mutates another plugin's
storage. If an injected message disappears because another component replaced
the surface, the durable evidence is still complete and `memory search` can
recover it.

## Checking compatibility at runtime

`memory status` prints a compatibility line whose baseline form is:

```text
压缩兼容: policy=auto
```

When the adapter can supply detection state, the line additionally carries
`billion-context=detected`, `compaction-basic=detected`,
`post-compaction reinjection=disabled` and, for unconfirmed configurations, a
`⚠ 无法确认压缩兼容性…` warning. The warning text states the practical
consequence: an injected message may be evicted from the active context after a
compaction, while the memory store itself remains complete and recoverable with
`memory search`.

`memory status` also prints the database path, session counters, checkpoints,
the soft budget and the last assembly — enough to attach to a bug report.

## What is unverified

- **Proxy-style request-body rewriting.** A component that rewrites the
  outbound model request outside the DSH event model (for example an HTTP proxy
  that strips or rewrites messages) is invisible to an in-process plugin. The
  plugin does not intercept requests and cannot guarantee its injected block
  survives. It reports compatibility as unknown rather than guessing; the local
  memory is never lost, only the current turn may miss the block.
- **Third-party compressor internals.** `billion-context`-style plugins are not
  shipped with DSH. The plugin detects what it can from events and reports the
  rest; it does not import or patch compressor code.
- **Deprecated host reads.** `snapshotEvents()` / `eventAt()` are deprecated in
  the verified version and are not used; replay-based recovery is therefore not
  available (see above).
- **Reproduced host helpers.** Message construction and home-path resolution are
  reimplemented from verified behaviour, not imported. A host change in append
  validation or home resolution would need a code update.
- **Versions other than 0.2.1-rc.3.** Newer or older DSH releases may rename
  events, change decision shapes or move services.
- **Network proxies, model-side summarizers and provider routing** are outside
  this plugin entirely; see the privacy notes in the README.

## Verifying an upgrade

1. Run `npm test` and `node scripts/check.mjs`, then load the plugin in a
   disposable DSH profile.
2. Run `memory status`: the plugin must report counters and a compatibility line.
3. Send a short conversation, run `memory explain`, and confirm the injected
   message reports sections and a budget.
4. Compact the session once (`compaction-basic` or your compressor), then ask a
   question about a fact stated before the compaction. The answer should cite the
   stored evidence; `memory search` should find it even without injection.
5. If an API moved, the interface table above is the shortest path to re-verify
   the affected behaviour in the shipped sources.
