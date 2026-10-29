/**
 * Validation: configurable, deterministic checks over produced artifacts and
 * tool operations. Only explicitly configured, program-decidable conditions can
 * block an operation. Semantic checks are possible through user scripts but are
 * reported as non-deterministic.
 *
 * Check types (v1):
 * - `required_terms`  — terms that must appear (optionally with min counts);
 * - `forbidden_terms` — terms that must not appear, scope-aware;
 * - `numbers_with_conditions` — a number must carry its statistical
 *   conditions/unit within a window;
 * - `file_precondition` — a file operation must satisfy existence/size rules
 *   (used in DSH `tools/pre-execute`), not a text check;
 * - `script` — user module exporting a default check function.
 *
 * @module dsh-session-memory/validation
 */

import fs from 'node:fs'
import path from 'node:path'
import { scopeApplies } from './skills.js'
import { clampText, containsCjk, extractNumbers, oneLine } from './core/util.js'

const MAX_VIOLATION_TEXT = 500

/**
 * @typedef {object} Violation
 * @property {string} checkId
 * @property {string} type
 * @property {'error'|'warn'} severity
 * @property {string} message
 * @property {string} [excerpt] evidence snippet (never a model claim)
 * @property {boolean} deterministic
 * @property {boolean} [blocked] whether this violation blocks the operation
 */

/**
 * @typedef {object} ValidationRun
 * @property {boolean} ok
 * @property {Violation[]} violations
 * @property {number} checked
 * @property {number} skipped
 * @property {string[]} errors non-fatal check errors (e.g. script import failure)
 * @property {boolean} blocked
 * @property {Record<string, unknown>} details
 */

export class Validator {
  /**
   * @param {import('./memory/store.js').MemoryStore} store
   * @param {{ config?: any, logger?: any }} [options]
   */
  constructor(store, options = {}) {
    this.store = store
    this.config = options.config ?? {}
    this.logger = options.logger ?? null
    /** @type {Map<string, Function>} */
    this.scriptCache = new Map()
  }

  /**
   * Run all configured text checks over a produced artifact.
   *
   * @param {{ sessionId?: string, text: string, target?: 'body'|'quote'|'path'|'explanation'|'all', attempts?: number, artifactPath?: string | null, context?: Record<string, unknown> }} input
   * @returns {Promise<ValidationRun>}
   */
  async runTextChecks(input) {
    const text = String(input.text ?? '')
    const target = input.target ?? 'body'
    const checks = Array.isArray(this.config.validation?.checks) ? this.config.validation.checks : []
    /** @type {Violation[]} */
    const violations = []
    /** @type {string[]} */
    const errors = []
    let checked = 0
    let skipped = 0
    for (const check of checks) {
      if (check === null || typeof check !== 'object') continue
      const type = String(check.type ?? '')
      const id = String(check.id ?? `${type}-${checked}`)
      if (check.enabled === false) continue
      const checkScope = Array.isArray(check.scope) ? check.scope : []
      if (checkScope.length > 0 && !scopeApplies(checkScope, target === 'all' ? 'body' : target)) {
        skipped += 1
        continue
      }
      try {
        let result = []
        if (type === 'required_terms') result = checkRequiredTerms(check, text, target)
        else if (type === 'forbidden_terms') result = checkForbiddenTerms(check, text, target)
        else if (type === 'numbers_with_conditions') result = checkNumbersWithConditions(check, text)
        else if (type === 'script') {
          result = await this.runScriptCheck(check, text, { target, sessionId: input.sessionId, artifactPath: input.artifactPath ?? null, context: input.context ?? {} })
        } else {
          skipped += 1
          errors.push(`unknown check type: ${type} (check ${id})`)
          continue
        }
        checked += 1
        for (const violation of result) violations.push({ ...violation, checkId: id })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`check ${id} failed to run: ${message}`)
        this.logger?.warn?.(`session-memory: validation check ${id} failed: ${message}`)
      }
    }
    const deterministic = violations.every((violation) => violation.deterministic)
    const blocking = violations.filter((violation) => violation.severity === 'error' && violation.deterministic && (violation.blocked === true || this.config.validation?.blockOnViolation === true))
    const blocked = blocking.length > 0 && (input.attempts ?? 0) < (this.config.validation?.maxRepairAttempts ?? 2)
    return {
      ok: violations.filter((violation) => violation.severity === 'error').length === 0,
      violations,
      checked,
      skipped,
      errors,
      blocked,
      deterministic,
      details: { target, attempts: input.attempts ?? 0, maxRepairAttempts: this.config.validation?.maxRepairAttempts ?? 2 },
    }
  }

  /**
   * Evaluate configured file-operation preconditions. Returns a DSH
   * `PreToolDecision`-compatible object (or null when nothing applies).
   *
   * A precondition only denies when its configured condition is actually
   * violated, and every decision comes from a filesystem check — never from a
   * semantic judgement. Supported fields:
   * - `tools`: tool names the rule applies to (`'*'` for all);
   * - `pathPattern`: glob-ish pattern the tool's path argument must match;
   * - `pathArg`: tool argument that carries the path (default `file_path`/`path`);
   * - `mustExist` / `mustNotExist`: existence conditions;
   * - `minSizeBytes` / `maxSizeBytes`: size conditions for existing files;
   * - `mustBeDirectory`: when true the path must be an existing directory.
   *
   * @param {{ toolName: string, args: Record<string, unknown>, agentId?: string | null, cwd?: string | null }} input
   * @returns {{ kind: 'deny', reason: string, info?: Record<string, unknown> } | { kind: 'allow' } | null}
   */
  evaluatePreconditions(input) {
    const preconditions = Array.isArray(this.config.validation?.preconditions) ? this.config.validation.preconditions : []
    const rawPath = typeof input.args?.file_path === 'string' ? input.args.file_path : typeof input.args?.path === 'string' ? input.args.path : null
    for (const precondition of preconditions) {
      if (precondition === null || typeof precondition !== 'object') continue
      if (precondition.enabled === false) continue
      const tools = Array.isArray(precondition.tools) ? precondition.tools : []
      if (tools.length > 0 && !tools.includes(input.toolName) && !tools.includes('*')) continue
      if (rawPath === null) continue
      const pattern = typeof precondition.pathPattern === 'string' ? precondition.pathPattern : null
      if (pattern !== null && !globishMatch(pattern, rawPath)) continue
      const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(input.cwd ?? process.cwd(), rawPath)
      const deny = (reason) => ({
        kind: 'deny',
        reason: `session-memory precondition: ${precondition.message ?? reason}`,
        info: { checkId: precondition.id ?? null, path: rawPath, resolvedPath: resolved, deterministic: true },
      })
      const exists = fs.existsSync(resolved)
      let stat = null
      if (exists) {
        try {
          stat = fs.statSync(resolved)
        } catch {
          stat = null
        }
      }
      if (precondition.mustExist === true && !exists) return deny(`file must exist before ${input.toolName}: ${rawPath}`)
      if (precondition.mustNotExist === true && exists) return deny(`file must not exist before ${input.toolName}: ${rawPath}`)
      if (precondition.mustBeDirectory === true && exists && stat !== null && !stat.isDirectory()) return deny(`path must be a directory before ${input.toolName}: ${rawPath}`)
      if (stat !== null && typeof precondition.minSizeBytes === 'number' && stat.size < precondition.minSizeBytes) return deny(`file smaller than ${precondition.minSizeBytes} bytes before ${input.toolName}: ${rawPath}`)
      if (stat !== null && typeof precondition.maxSizeBytes === 'number' && stat.size > precondition.maxSizeBytes) return deny(`file larger than ${precondition.maxSizeBytes} bytes before ${input.toolName}: ${rawPath}`)
    }
    return null
  }

  /**
   * Run a user script check. The script module must export default
   * `(text, ctx) => ({ok, message, excerpt?} | array)`.
   *
   * @param {Record<string, any>} check
   * @param {string} text
   * @param {Record<string, unknown>} context
   * @returns {Promise<Violation[]>}
   */
  async runScriptCheck(check, text, context) {
    const modulePath = String(check.module ?? '')
    if (modulePath.length === 0) throw new Error('script check requires "module" path')
    let fn = this.scriptCache.get(modulePath)
    if (fn === undefined) {
      const mod = await import(pathToFileUrl(modulePath))
      fn = mod.default ?? mod.check ?? mod.run
      if (typeof fn !== 'function') throw new Error(`script check module has no default function: ${modulePath}`)
      this.scriptCache.set(modulePath, fn)
    }
    const raw = await fn(text, { ...context, check })
    const deterministic = check.deterministic === true
    const severity = check.severity === 'error' ? 'error' : 'warn'
    const list = Array.isArray(raw) ? raw : [raw]
    /** @type {Violation[]} */
    const violations = []
    for (const entry of list) {
      if (entry === null || entry === undefined) continue
      if (entry === true || entry.ok === true) continue
      const message = typeof entry === 'string' ? entry : String(entry.message ?? 'script check failed')
      violations.push({
        checkId: String(check.id ?? 'script'),
        type: 'script',
        severity: typeof entry.severity === 'string' && (entry.severity === 'error' || entry.severity === 'warn') ? entry.severity : severity,
        message: clampText(message, MAX_VIOLATION_TEXT),
        excerpt: typeof entry.excerpt === 'string' ? clampText(entry.excerpt, MAX_VIOLATION_TEXT) : undefined,
        deterministic,
        blocked: check.block === true,
      })
    }
    return violations
  }

  /**
   * Persist a validation run in the session database so `memory status` and
   * `memory explain` can report what was checked, what failed, and whether the
   * run was deterministic. Validation never gates the model by itself: only a
   * configured program-decidable `blocked` failure can do that.
   *
   * @param {string} sessionId
   * @param {ValidationRun} run
   * @param {{ seq?: number, kind?: string, turn?: number, step?: number, target?: string }} [meta]
   * @returns {number} validation log id
   */
  record(sessionId, run, meta = {}) {
    return this.store.addValidationLog({
      sessionId,
      turn: meta.turn ?? null,
      step: meta.step ?? null,
      eventSeq: meta.seq ?? null,
      trigger: meta.kind ?? 'assistant/message',
      target: meta.target ?? 'body',
      run,
    })
  }
}

/**
 * @param {Record<string, any>} check
 * @param {string} text
 * @param {string} target
 * @returns {Violation[]}
 */
export function checkRequiredTerms(check, text, target) {
  const terms = toStringList(check.terms)
  const minCount = Number.isInteger(check.minCount) ? check.minCount : 1
  /** @type {Violation[]} */
  const violations = []
  for (const term of terms) {
    const count = countOccurrences(text, term)
    if (count < minCount) {
      violations.push({ checkId: '', type: 'required_terms', severity: 'error', message: `required term missing: ${term} (found ${count}, need ${minCount})`, deterministic: true, blocked: check.block !== false })
    }
  }
  return violations
}

/**
 * @param {Record<string, any>} check
 * @param {string} text
 * @param {string} target
 * @returns {Violation[]}
 */
export function checkForbiddenTerms(check, text, target) {
  const terms = toStringList(check.terms)
  /** @type {Violation[]} */
  const violations = []
  for (const term of terms) {
    const index = text.indexOf(term)
    if (index === -1) continue
    const excerpt = clampText(text.slice(Math.max(0, index - 60), index + term.length + 60), MAX_VIOLATION_TEXT)
    violations.push({ checkId: '', type: 'forbidden_terms', severity: 'error', message: `forbidden term present: ${term}`, excerpt, deterministic: true, blocked: check.block !== false })
  }
  return violations
}

/**
 * @param {Record<string, any>} check
 * @param {string} text
 * @returns {Violation[]}
 */
export function checkNumbersWithConditions(check, text) {
  const expected = Array.isArray(check.numbers) ? check.numbers : []
  const window = Number.isInteger(check.window) ? check.window : 160
  const requireConditions = check.requireConditions !== false
  /** @type {Violation[]} */
  const violations = []
  const found = extractNumbers(text)
  for (const entry of expected) {
    const raw = String(entry?.raw ?? entry?.value ?? '')
    if (raw.length === 0) continue
    const occurrences = [...text.matchAll(new RegExp(escapeRegExp(raw), 'gu'))]
    if (occurrences.length === 0) {
      if (entry.mustAppear === true) violations.push({ checkId: '', type: 'numbers_with_conditions', severity: 'error', message: `expected number not found: ${raw}`, deterministic: true, blocked: check.block !== false })
      continue
    }
    const conditions = toStringList(entry.conditions)
    if (requireConditions && conditions.length > 0) {
      for (const occurrence of occurrences) {
        const start = Math.max(0, (occurrence.index ?? 0) - window / 2)
        const snippet = text.slice(start, start + window)
        const missing = conditions.filter((condition) => !snippet.includes(condition))
        if (missing.length > 0) {
          violations.push({ checkId: '', type: 'numbers_with_conditions', severity: 'error', message: `number ${raw} appears without conditions: ${missing.join(', ')}`, excerpt: clampText(snippet, MAX_VIOLATION_TEXT), deterministic: true, blocked: check.block !== false })
          break
        }
      }
    }
    if (entry.unit !== undefined && entry.unit !== null) {
      const near = text.slice(Math.max(0, (occurrences[0].index ?? 0) - 20), (occurrences[0].index ?? 0) + raw.length + 20)
      if (!near.includes(String(entry.unit))) {
        violations.push({ checkId: '', type: 'numbers_with_conditions', severity: 'warn', message: `number ${raw} may be missing unit ${entry.unit}`, deterministic: true, blocked: false })
      }
    }
  }
  const foundValues = new Set(found.map((entry) => entry.raw))
  for (const forbidden of toStringList(check.forbiddenNumbers)) {
    if (foundValues.has(forbidden)) {
      violations.push({ checkId: '', type: 'numbers_with_conditions', severity: 'error', message: `superseded/forbidden number present: ${forbidden}`, deterministic: true, blocked: check.block !== false })
    }
  }
  return violations
}

/**
 * Tiny glob matcher for file preconditions (`*`, `**`, `?`).
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function globishMatch(pattern, value) {
  const normalized = String(value).replaceAll('\\', '/')
  const escaped = String(pattern).replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('?', '[^/]').replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`, 'iu').test(normalized)
}

/**
 * @param {string} text
 * @param {string} term
 * @returns {number}
 */
export function countOccurrences(text, term) {
  if (term.length === 0) return 0
  let count = 0
  let index = 0
  for (;;) {
    const found = text.indexOf(term, index)
    if (found === -1) return count
    count += 1
    index = found + term.length
  }
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function toStringList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

/**
 * @param {string} text
 * @returns {boolean} whether any configured check is non-deterministic
 */
export function hasSemanticChecks(config) {
  const checks = Array.isArray(config?.validation?.checks) ? config.validation.checks : []
  return checks.some((check) => check?.type === 'script' && check?.deterministic !== true)
}

/**
 * @param {string} filePath
 * @returns {string} file URL for dynamic import
 */
export function pathToFileUrl(filePath) {
  const path = String(filePath)
  if (/^file:/iu.test(path)) return path
  const normalized = path.replaceAll('\\', '/')
  return /^[A-Za-z]:\//u.test(normalized) ? `file:///${normalized}` : `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`
}

/** @returns {string} human label for a validation run (for diagnostics/explain) */
export function describeRun(run) {
  const deterministic = run.violations.every((violation) => violation.deterministic)
  return `${run.checked} checks, ${run.violations.length} violations, ${run.errors.length} errors (${deterministic ? 'deterministic' : 'includes non-deterministic checks'})`
}

/** @returns {string[]} supported check types */
export function checkTypes() {
  return ['required_terms', 'forbidden_terms', 'numbers_with_conditions', 'file_precondition', 'script']
}

/**
 * A check never applies semantic judgements unless the user wrote a script for
 * it; `oneLine` is only used to keep diagnostics small.
 *
 * @param {Violation[]} violations
 * @returns {string}
 */
export function summarizeViolations(violations) {
  return violations.map((violation) => `${violation.severity}:${violation.type}:${oneLine(violation.message, 160)}${containsCjk(violation.message) ? '' : ''}`).join('\n')
}
