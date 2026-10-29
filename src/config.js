/**
 * Plugin configuration: defaults, normalization and documentation anchors.
 *
 * This module is dependency free on purpose: the plugin entry point may run
 * inside a host that does not have `@deepseek-ai/schemastery` available in the
 * test environment, so configuration validation happens here in plain JS and
 * the schemastery schema is built only when the host package can be imported.
 *
 * @module dsh-session-memory/config
 */

/** Stable plugin identity used in patch files, logs and diagnostics. */
export const PLUGIN_ID = 'session-memory'

/** Default soft budget for the injected memory context, in tokens (estimate). */
export const DEFAULT_SOFT_BUDGET_TOKENS = 3000

/**
 * @typedef {object} SessionMemoryConfig
 * @property {boolean} enabled master switch (default true)
 * @property {string} dataDir absolute directory for the memory database, `''` = `<DSH_HOME>/session-memory`
 * @property {string} dbFile database file name inside dataDir
 * @property {boolean} includeSubagents capture subagent sessions too (default false)
 * @property {object} assembly context assembly budget and limits
 * @property {object} extraction deterministic memory extraction switches
 * @property {object} retrieval retrieval limits and ranking weights
 * @property {object} validation deterministic validation checks
 * @property {object} commands slash-command registration switches
 * @property {object} compatibility host-plugin compatibility behaviour
 * @property {object} diagnostics logging switches
 * @property {object} archive raw evidence archiving behaviour
 * @property {object} skills skill indexing and two-layer loading
 */

/** @type {SessionMemoryConfig} */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  dataDir: '',
  dbFile: 'memory.sqlite',
  includeSubagents: false,
  assembly: Object.freeze({
    enabled: true,
    /** Soft budget for the whole memory message; hard-clamped above. */
    softBudgetTokens: DEFAULT_SOFT_BUDGET_TOKENS,
    /** Never spend less than this when a budget is configured. */
    minBudgetTokens: 600,
    maxMemoryItems: 40,
    maxRules: 12,
    maxEvidence: 8,
    /**
     * Event types that may be quoted verbatim in the injected context.
     * Defaults to the user's own messages: tool output is untrusted evidence
     * (prompt-injection risk) and stays stored/searchable but is not pasted
     * into the model request. Set to ['*'] to quote every stored event.
     */
    evidenceTypes: Object.freeze(['user/message']),
    /** Skip a model step without injecting anything when nothing is relevant. */
    skipWhenEmpty: true,
    /** Re-inject the same content only after this many turns. */
    reinjectUnchangedTurns: 0,
    /** Header lines are always emitted even under budget pressure. */
    includeTaskState: true,
  }),
  extraction: Object.freeze({
    enabled: true,
    /** Corrections in the current step input apply before assembly. */
    immediateCorrections: true,
    /** Only user messages are scanned for new memories. */
    scanUserMessages: true,
    /** Assistant proposals are stored as proposals (never as decisions). */
    recordAssistantProposals: true,
  }),
  retrieval: Object.freeze({
    limit: 24,
    /** Weight for exact number / identifier matches. */
    exactMatchBoost: 3,
    /** Weight for items whose scope matches the current task. */
    scopeBoost: 2,
    /** Weight for recency (0 disables). */
    recencyBoost: 0.5,
    /** Minimum score for a hit to be assembled. */
    minScore: 0.5,
  }),
  validation: Object.freeze({
    enabled: true,
    /** Deterministic term checks, applied to committed assistant output. */
    checks: Object.freeze([]),
    /** Express preconditions for file operations, applied pre-dispatch. */
    preconditions: Object.freeze([]),
    /** Max times a single validation reminder is re-injected. */
    maxRepairAttempts: 2,
    /** Block the configured operation only when the check is decidable. */
    blockOnViolation: false,
  }),
  commands: Object.freeze({
    register: true,
    name: 'memory',
    exposeModelTool: false,
  }),
  compatibility: Object.freeze({
    /**
     * 'auto' detects the active compaction policy; 'compaction-basic' and
     * 'billion-context' force the documented behaviour.
     */
    compactionPolicy: 'auto',
    /** Re-assemble after a compaction event replaces surface nodes. */
    reinjectAfterCompaction: true,
    /** Report unconfirmed compatibility in diagnostics instead of guessing. */
    reportUnknownCompatibility: true,
  }),
  diagnostics: Object.freeze({
    verbose: false,
    /** Keep at most this many assembly logs per session. */
    assemblyLogRetention: 200,
  }),
  archive: Object.freeze({
    /**
     * Raw evidence lives in the host session log by default; archive a copy
     * only for content the host log cannot reliably replay (compaction,
     * prune) when this is enabled.
     */
    enabled: true,
    maxCharsPerEvent: 4000,
    /** Event types whose raw text is archived eagerly. */
    archiveTypes: Object.freeze(['tool/result', 'compaction/summary']),
  }),
  skills: Object.freeze({
    enabled: true,
    /** Names of skills to index; empty = every enabled skill. */
    include: Object.freeze([]),
    exclude: Object.freeze([]),
    /** Max characters of skill rule text kept for the resident core. */
    residentCoreMaxChars: 1600,
    /** Max characters of a single rule entry injected per step. */
    maxRuleChars: 1200,
    /** Auto-classification is a derived index; users can override categories. */
    autoClassify: true,
  }),
})

/**
 * Deep-merge a user configuration over the defaults. Unknown keys survive so
 * forward-compatible host configs do not break, and numbers are clamped.
 *
 * @param {object | undefined} input raw plugin config
 * @returns {SessionMemoryConfig} normalized configuration
 */
export function normalizeConfig(input) {
  const merged = merge(DEFAULT_CONFIG, isPlainObject(input) ? input : {})
  const soft = clampInt(merged.assembly.softBudgetTokens, 200, 20000, DEFAULT_SOFT_BUDGET_TOKENS)
  merged.assembly = {
    ...merged.assembly,
    softBudgetTokens: soft,
    minBudgetTokens: clampInt(merged.assembly.minBudgetTokens, 100, soft, Math.min(600, soft)),
    maxMemoryItems: clampInt(merged.assembly.maxMemoryItems, 1, 200, 40),
    maxRules: clampInt(merged.assembly.maxRules, 0, 100, 12),
    maxEvidence: clampInt(merged.assembly.maxEvidence, 0, 100, 8),
    reinjectUnchangedTurns: clampInt(merged.assembly.reinjectUnchangedTurns, 0, 1000, 0),
  }
  merged.retrieval = {
    ...merged.retrieval,
    limit: clampInt(merged.retrieval.limit, 1, 200, 24),
    exactMatchBoost: clampNumber(merged.retrieval.exactMatchBoost, 0, 20, 3),
    scopeBoost: clampNumber(merged.retrieval.scopeBoost, 0, 20, 2),
    recencyBoost: clampNumber(merged.retrieval.recencyBoost, 0, 5, 0.5),
    minScore: clampNumber(merged.retrieval.minScore, 0, 100, 0.5),
  }
  merged.diagnostics = {
    ...merged.diagnostics,
    assemblyLogRetention: clampInt(merged.diagnostics.assemblyLogRetention, 10, 5000, 200),
  }
  merged.archive = {
    ...merged.archive,
    maxCharsPerEvent: clampInt(merged.archive.maxCharsPerEvent, 200, 100000, 4000),
  }
  merged.skills = {
    ...merged.skills,
    residentCoreMaxChars: clampInt(merged.skills.residentCoreMaxChars, 200, 20000, 1600),
    maxRuleChars: clampInt(merged.skills.maxRuleChars, 200, 20000, 1200),
  }
  merged.validation = {
    ...merged.validation,
    maxRepairAttempts: clampInt(merged.validation.maxRepairAttempts, 0, 10, 2),
    checks: Array.isArray(merged.validation.checks) ? merged.validation.checks : [],
    preconditions: Array.isArray(merged.validation.preconditions) ? merged.validation.preconditions : [],
  }
  merged.dbFile = typeof merged.dbFile === 'string' && merged.dbFile.length > 0 ? merged.dbFile : 'memory.sqlite'
  merged.dataDir = typeof merged.dataDir === 'string' ? merged.dataDir : ''
  merged.includeSubagents = merged.includeSubagents === true
  merged.compatibility = {
    ...merged.compatibility,
    compactionPolicy: ['auto', 'compaction-basic', 'billion-context', 'none'].includes(merged.compatibility.compactionPolicy)
      ? merged.compatibility.compactionPolicy
      : 'auto',
  }
  return merged
}

/**
 * @param {object} schema schemastery module namespace (`{ default: z }`)
 * @returns {object} schemastery schema for the plugin entry point
 */
export function buildSchemasterySchema(schema) {
  const z = schema?.default ?? schema
  const number = (fallback) => z.number().default(fallback)
  const bool = (fallback) => z.boolean().default(fallback)
  return z.object({
    enabled: bool(true),
    dataDir: z.string().default(''),
    dbFile: z.string().default('memory.sqlite'),
    includeSubagents: bool(false),
    assembly: z.object({
      enabled: bool(true),
      softBudgetTokens: number(DEFAULT_SOFT_BUDGET_TOKENS),
      minBudgetTokens: number(600),
      maxMemoryItems: number(40),
      maxRules: number(12),
      maxEvidence: number(8),
      skipWhenEmpty: bool(true),
      reinjectUnchangedTurns: number(0),
      includeTaskState: bool(true),
    }),
    extraction: z.object({
      enabled: bool(true),
      immediateCorrections: bool(true),
      scanUserMessages: bool(true),
      recordAssistantProposals: bool(true),
    }),
    retrieval: z.object({
      limit: number(24),
      exactMatchBoost: number(3),
      scopeBoost: number(2),
      recencyBoost: number(0.5),
      minScore: number(0.5),
    }),
    validation: z.object({
      enabled: bool(true),
      checks: z.array(z.any()).default([]),
      preconditions: z.array(z.any()).default([]),
      maxRepairAttempts: number(2),
      blockOnViolation: bool(false),
    }),
    commands: z.object({
      register: bool(true),
      name: z.string().default('memory'),
      exposeModelTool: bool(false),
    }),
    compatibility: z.object({
      compactionPolicy: z.string().default('auto'),
      reinjectAfterCompaction: bool(true),
      reportUnknownCompatibility: bool(true),
    }),
    diagnostics: z.object({
      verbose: bool(false),
      assemblyLogRetention: number(200),
    }),
    archive: z.object({
      enabled: bool(true),
      maxCharsPerEvent: number(4000),
      archiveTypes: z.array(z.string()).default(['tool/result', 'compaction/summary']),
    }),
    skills: z.object({
      enabled: bool(true),
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      residentCoreMaxChars: number(1600),
      maxRuleChars: number(1200),
      autoClassify: bool(true),
    }),
  })
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursive plain-object merge; arrays are replaced, not concatenated.
 *
 * @param {unknown} base
 * @param {unknown} override
 * @returns {any} merged clone
 */
export function merge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return Array.isArray(override) ? [...override] : base
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override
  }
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? merge(out[key], value) : value
  }
  return out
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}
