/**
 * Shared constants. Keeping them in one place makes the DSH adapter layer the
 * only file that needs to change when the host event vocabulary moves.
 *
 * @module dsh-long-memory/core/constants
 */

/** Message `source.kind` used for every memory context message we inject. */
export const MEMORY_SOURCE_KIND = 'long-memory'

/** Plugin version reported by diagnostics; `scripts/check.mjs` keeps it in sync with package.json. */
export const PLUGIN_VERSION = '0.1.0'

/** `source.form` values we emit (documented in assembly explain output). */
export const MEMORY_SOURCE_FORM = 'snapshot'

/** Prefix for stable memory identifiers: `mem_<session8>_<hash12>`. */
export const MEMORY_ID_PREFIX = 'mem'

/** Schema version written to `PRAGMA user_version`. */
export const SCHEMA_VERSION = 2

/** Kind values allowed on `memory_items.kind`. */
export const MEMORY_KINDS = Object.freeze([
  'fact',
  'decision',
  'constraint',
  'preference',
  'proposal',
  'open_question',
])

/** Evidence provenance values allowed on `memory_items.evidence_type`. */
export const EVIDENCE_TYPES = Object.freeze([
  'user_explicit',
  'skill',
  'artifact_verified',
  'assistant_proposal',
  'inferred',
])

/** Lifecycle values allowed on `memory_items.status`. */
export const MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'disputed', 'retracted'])

/** Skill rule categories (the four buckets from the design brief). */
export const RULE_CATEGORIES = Object.freeze(['stable_rule', 'data_convention', 'current_state', 'operational_lesson'])

/** Memory journal verbs written to `memory_events.event`. */
export const MEMORY_EVENT_TYPES = Object.freeze([
  'created',
  'revised',
  'superseded',
  'retracted',
  'disputed',
  'reactivated',
  'promoted',
])

/** DSH event names the plugin subscribes to (public harness events only). */
export const DSH_EVENTS = Object.freeze({
  agentPreStep: 'agent/pre-step',
  sessionEvent: 'session/event',
  sessionCreated: 'session/created',
  sessionDisposed: 'session/disposed',
  skillsChange: 'skills/change',
  toolsPreExecute: 'tools/pre-execute',
  commandsChange: 'commands/change',
})

/** DSH session-event types captured into the evidence table. */
export const CAPTURED_EVENT_TYPES = Object.freeze([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'request/header',
  'compaction/start',
  'compaction/end',
  'compaction/summary',
  'compaction/prune',
  'command/run',
  'command/done',
])

/** Session events after which the host surface may have been rewritten. */
export const COMPACTION_EVENT_TYPES = Object.freeze([
  'compaction/start',
  'compaction/end',
  'compaction/summary',
  'compaction/prune',
])

/** How a raw evidence row is recoverable. */
export const EVIDENCE_STORES = Object.freeze(['host', 'archive', 'none'])

/** Internal bounds that keep the database and messages small. */
export const LIMITS = Object.freeze({
  maxStoredTextChars: 20000,
  maxStoredArgsChars: 4000,
  maxRuleChars: 20000,
  maxAssemblySections: 40,
  maxSearchLimit: 200,
})

/** Token estimate constants (documented as estimates, never exact counts). */
export const TOKEN_ESTIMATE = Object.freeze({
  charsPerToken: 4,
  cjkCharsPerToken: 1.6,
})
