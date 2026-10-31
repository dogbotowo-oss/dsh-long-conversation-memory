/**
 * Skills: load plain `SKILL.md` files, keep their original content, derive a
 * versioned rule index and build the two-layer view used at assembly time.
 *
 * Two layers:
 * - resident core: a short, always-included slice (execution flow, current
 *   important constraints, evidence requirements);
 * - task-related entries: full rule text with source reference, selected for
 *   the current task.
 *
 * The original skill file is never modified. Categories/scope are a *derived
 * index*; users can override them (`ctx.store.setRuleOverride`) and the
 * override is preserved across skill revisions for the same rule key.
 *
 * @module dsh-long-memory/skills
 */

import { RULE_CATEGORIES } from './core/constants.js'
import { clampText, normalizeText, oneLine, sha256, tokenize, uniqueBy } from './core/util.js'

const MAX_RULE_CHARS = 20000
const MAX_PARSED_RULES = 400

/**
 * @typedef {object} ParsedRule
 * @property {string} key stable per skill + section + index
 * @property {string} text rule text (original, trimmed)
 * @property {string} category one of RULE_CATEGORIES
 * @property {string[]} scope explicit applicability scope labels
 * @property {string} sectionPath heading path the rule belongs to
 * @property {number} sourceLine 1-based line in SKILL.md
 * @property {boolean} dynamic current-state-like content (never a fixed check)
 */

/**
 * @typedef {object} ParsedSkill
 * @property {Record<string, string>} frontmatter
 * @property {{ level: number, title: string, path: string, line: number }[]} sections
 * @property {ParsedRule[]} rules
 * @property {string} residentCore short always-on slice
 * @property {string} description
 * @property {string} whenToUse
 */

/**
 * Parse a minimal YAML frontmatter block (`---` fenced, `key: value` lines).
 *
 * @param {string} content
 * @returns {{ frontmatter: Record<string, string>, body: string, bodyStartLine: number }}
 */
export function parseFrontmatter(content) {
  const lines = String(content ?? '').split('\n')
  /** @type {Record<string, string>} */
  const frontmatter = {}
  if (lines[0]?.trim() !== '---') return { frontmatter, body: String(content ?? ''), bodyStartLine: 1 }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) return { frontmatter, body: String(content ?? ''), bodyStartLine: 1 }
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line.trim())
    if (match === null) continue
    frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2 }
}

/**
 * Classify a rule into the four documented categories. Auto-classification is a
 * derived guess; it must stay inspectable and overridable.
 *
 * @param {string} text
 * @param {{ autoClassify?: boolean }} [options]
 * @returns {string}
 */
export function classifyRule(text, options = {}) {
  if (options.autoClassify === false) return 'stable_rule'
  const lower = text.toLowerCase()
  const normative = ['必须', '务必', '不得', '禁止', '不要', '不能', '只能', '仅限', '严禁', '一律', '必须', 'must', 'never', 'do not', "don't", 'shall', 'always', 'only']
  if (normative.some((marker) => lower.includes(marker))) return 'stable_rule'
  const convention = ['口径', '统计', '单位', '小数', '保留', '格式', '命名', '版本号', 'dataset', 'unit', 'format', 'decimal', 'naming', 'convention']
  if (convention.some((marker) => lower.includes(marker))) return 'data_convention'
  const lesson = ['坑', '经验', '注意', '踩过', '教训', 'lesson', 'gotcha', 'pitfall', 'tip', 'previous attempt']
  if (lesson.some((marker) => lower.includes(marker))) return 'operational_lesson'
  const state = ['当前', '目前', '现在', '最新', '截止', '当前版本', 'current', 'currently', 'status', 'as of', 'today']
  if (state.some((marker) => lower.includes(marker))) return 'current_state'
  return 'stable_rule'
}

/**
 * Extract explicit applicability scope from a rule. This is the mechanism that
 * keeps "no abbreviation in body text" from being applied to quotes, file
 * paths or explanations of old names.
 *
 * @param {string} text
 * @returns {string[]} scope labels, e.g. `['body', 'not:quote']`
 */
export function extractRuleScope(text) {
  const scope = []
  const positivePatterns = [
    { pattern: /(?:仅|只)(?:适用于|用于|限(?:于)?)\s*([^。；;\n]{1,60})/gu, prefix: 'only' },
    { pattern: /(?:在|针对)\s*(正文|引文|目录|文件名|路径|图注|表格|摘要|标题)[^。；;\n]{0,40}/gu, prefix: 'in' },
  ]
  for (const { pattern, prefix } of positivePatterns) {
    for (const match of String(text).matchAll(pattern)) {
      const value = oneLine(match[1], 60)
      if (value.length > 0) scope.push(`${prefix}: ${value}`)
    }
  }
  if (/正文/u.test(text) && /(?:不|禁止|不要|不得)/u.test(text)) scope.push('body')
  if (/(?:引文|引用|历史引用|原文)/u.test(text) && /(?:可以|允许|不适用|例外)/u.test(text)) scope.push('exceptions: quote')
  if (/(?:路径|文件名|目录名)/u.test(text) && /(?:可以|允许|例外|不受)/u.test(text)) scope.push('exceptions: path')
  return [...new Set(scope)].slice(0, 6)
}

/**
 * Parse a `SKILL.md`. Works with ordinary Markdown: headings, bullet lists and
 * short normative paragraphs. No rewrite of the user file is required.
 *
 * @param {string} content raw skill file content
 * @param {{ name?: string, sourcePath?: string | null, autoClassify?: boolean }} [options]
 * @returns {ParsedSkill}
 */
export function parseSkillMarkdown(content, options = {}) {
  const { frontmatter, body, bodyStartLine } = parseFrontmatter(content)
  const lines = body.split('\n')

  /** @type {{ level: number, title: string, path: string, line: number }[]} */
  const sections = []
  /** @type {{ level: number, title: string, path: string, line: number }[]} */
  const headingStack = []
  /** @type {ParsedRule[]} */
  const rules = []
  let ruleIndex = 0

  /** @param {string} text @param {number} line @param {string} sectionPath */
  const pushRule = (text, line, sectionPath) => {
    const trimmed = text.trim()
    if (trimmed.length < 4 || rules.length >= MAX_PARSED_RULES) return
    const category = classifyRule(trimmed, { autoClassify: options.autoClassify })
    const dynamic = category === 'current_state' || /(?:当前|目前|最新|截止|当前有|currently)/u.test(trimmed)
    const keySource = `${sectionPath}|${trimmed}`
    rules.push({
      key: `r${ruleIndex}_${sha256(keySource).slice(0, 8)}`,
      text: clampText(trimmed, MAX_RULE_CHARS),
      category,
      scope: extractRuleScope(trimmed),
      sectionPath,
      sourceLine: line,
      dynamic,
    })
    ruleIndex += 1
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const lineNumber = bodyStartLine + index
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(rawLine)
    if (heading !== null) {
      const level = heading[1].length
      const title = heading[2].trim()
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) headingStack.pop()
      headingStack.push({ level, title, path: '', line: lineNumber })
      const path = headingStack.map((entry) => entry.title).join(' > ')
      for (const entry of headingStack) entry.path = path
      sections.push({ level, title, path, line: lineNumber })
      continue
    }
    const sectionPath = headingStack.length > 0 ? headingStack[headingStack.length - 1].path : '(root)'
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(rawLine)
    if (bullet !== null) {
      pushRule(bullet[1], lineNumber, sectionPath)
      continue
    }
    const tableRow = /^\s*\|(.+)\|\s*$/u.exec(rawLine)
    if (tableRow !== null) {
      const cells = tableRow[1].split('|').map((cell) => cell.trim()).filter(Boolean)
      if (cells.length >= 2 && !cells.every((cell) => /^:?-{2,}:?$/u.test(cell))) {
        pushRule(cells.join(' — '), lineNumber, sectionPath)
      }
      continue
    }
    // Short normative paragraphs outside lists are rules too.
    const paragraph = rawLine.trim()
    if (paragraph.length >= 8 && classifyRule(paragraph, { autoClassify: options.autoClassify }) !== 'stable_rule') {
      pushRule(paragraph, lineNumber, sectionPath)
    } else if (paragraph.length >= 8 && /(?:必须|不得|禁止|不要|只能|严禁|一律)/u.test(paragraph)) {
      pushRule(paragraph, lineNumber, sectionPath)
    }
  }

  const evidenceRules = rules.filter((rule) => /(?:取证|证据|原文|source|evidence|cite|引用来源)/iu.test(rule.text))
  const flowSections = sections.filter((section) => /(?:流程|步骤|执行|workflow|process|procedure|how to)/iu.test(section.title))
  const coreLines = []
  if (flowSections.length > 0) coreLines.push(`流程: ${flowSections.map((section) => section.path).join('；')}`)
  for (const rule of rules.filter((entry) => entry.category === 'stable_rule').slice(0, 6)) coreLines.push(`- ${oneLine(rule.text, 220)}`)
  for (const rule of evidenceRules.slice(0, 3)) coreLines.push(`- 取证: ${oneLine(rule.text, 180)}`)
  if (frontmatter.description !== undefined) coreLines.unshift(`说明: ${oneLine(frontmatter.description, 200)}`)

  return {
    frontmatter,
    sections,
    rules,
    residentCore: coreLines.join('\n'),
    description: frontmatter.description ?? frontmatter.title ?? options.name ?? '',
    whenToUse: frontmatter.when_to_use ?? frontmatter.whenToUse ?? frontmatter.use_when ?? '',
  }
}

/**
 * Does a rule's scope apply to the current target surface? A rule scoped to
 * `body` does not apply to quotes/paths, which is exactly the documented
 * behaviour for abbreviation bans.
 *
 * @param {string[]} scope
 * @param {'body'|'quote'|'path'|'explanation'} target
 * @returns {boolean}
 */
export function scopeApplies(scope, target) {
  if (!Array.isArray(scope) || scope.length === 0) return true
  const labels = scope.join(' ')
  if (target === 'body') return !/exceptions:\s*(?:quote|path|explanation)/.test(labels) || /body/.test(labels) || labels.includes('正文')
  if (target === 'quote') return !/only:\s*正文|body/u.test(labels) || /exceptions: quote/.test(labels)
  if (target === 'path') return !/only:\s*正文|body/u.test(labels) || /exceptions: path/.test(labels)
  return true
}

/**
 * Manages skill discovery, versioning and the derived rule index.
 */
export class SkillManager {
  /**
   * @param {import('./memory/store.js').MemoryStore} store
   * @param {{ config?: object, logger?: { warn: Function, debug: Function }, version?: string }} [options]
   */
  constructor(store, options = {}) {
    this.store = store
    this.config = options.config ?? {}
    this.logger = options.logger ?? null
    this.version = options.version ?? '0.0.0'
  }

  /**
   * @returns {{ name: string, path: string | null, description: string, whenToUse: string, invocation: string | null, content: string, enabled: boolean }[]}
   */
  listIndexedSkills() {
    const files = this.store.listSkillFiles()
    return files.map((file) => {
      const version = this.store.getSkillContent(String(file.name))
      return {
        name: String(file.name),
        path: file.path === null || file.path === undefined ? null : String(file.path),
        description: String(file.description ?? ''),
        whenToUse: String(file.when_to_use ?? ''),
        invocation: file.invocation === null || file.invocation === undefined ? null : String(file.invocation),
        content: version === undefined ? '' : String(version.content),
        enabled: Number(file.enabled) === 1,
      }
    })
  }

  /**
   * Register one skill snapshot. Returns whether the content changed (a new
   * version was created) and the number of derived rules.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string} input.content raw SKILL.md content
   * @param {string | null} [input.path]
   * @param {string | null} [input.source]
   * @param {string} [input.description]
   * @param {string} [input.whenToUse]
   * @param {string | null} [input.invocation]
   * @returns {{ changed: boolean, versionId: string, version: number, rules: number, enabled: boolean }}
   */
  registerSkill(input) {
    const parsed = parseSkillMarkdown(input.content, {
      name: input.name,
      sourcePath: input.path ?? null,
      autoClassify: this.config.skills?.autoClassify !== false,
    })
    const result = this.store.upsertSkill({
      name: input.name,
      source: input.source ?? null,
      path: input.path ?? null,
      content: input.content,
      description: input.description ?? parsed.description,
      whenToUse: input.whenToUse ?? parsed.whenToUse,
      invocation: input.invocation ?? null,
    })
    let rules = 0
    if (result.changed) {
      rules = this.store.replaceSkillRules(input.name, result.versionId, parsed.rules)
    } else {
      const existing = this.store.listRules({ skillNames: [input.name] })
      rules = existing.length
      if (existing.length === 0) rules = this.store.replaceSkillRules(input.name, result.versionId, parsed.rules)
    }
    const file = this.store.getSkillFile(input.name)
    return {
      changed: result.changed,
      versionId: result.versionId,
      version: result.version,
      rules,
      enabled: file === undefined || Number(file.enabled) === 1,
    }
  }

  /**
   * Ingest a list of skills discovered by the host adapter.
   *
   * @param {{ name: string, content: string, path?: string | null, source?: string | null, description?: string, whenToUse?: string, invocation?: string | null }[]} skills
   * @returns {{ registered: number, changed: number, skipped: number }}
   */
  ingestSkills(skills) {
    const include = this.config.skills?.include ?? []
    const exclude = this.config.skills?.exclude ?? []
    let registered = 0
    let changed = 0
    let skipped = 0
    for (const skill of skills) {
      if (include.length > 0 && !include.includes(skill.name)) {
        skipped += 1
        continue
      }
      if (exclude.includes(skill.name)) {
        skipped += 1
        continue
      }
      if (typeof skill.content !== 'string' || skill.content.trim().length === 0) {
        skipped += 1
        continue
      }
      const result = this.registerSkill(skill)
      registered += 1
      if (result.changed) changed += 1
    }
    return { registered, changed, skipped }
  }

  /**
   * Resident core of the enabled skills: short flow, important constraints and
   * evidence requirements. Always injected, so it is capped hard.
   *
   * @returns {{ text: string, skills: string[], chars: number }}
   */
  getResidentCore() {
    const maxChars = this.config.skills?.residentCoreMaxChars ?? 1600
    const skills = this.listIndexedSkills().filter((skill) => skill.enabled && skill.content.length > 0)
    /** @type {string[]} */
    const lines = []
    for (const skill of skills) {
      const parsed = parseSkillMarkdown(skill.content, { autoClassify: false })
      if (parsed.residentCore.trim().length > 0) {
        lines.push(`[skill: ${skill.name}]`)
        lines.push(parsed.residentCore.trim())
      }
    }
    let text = lines.join('\n').trim()
    if (text.length > maxChars) text = `${clampText(text, maxChars)}`
    return { text, skills: skills.map((skill) => skill.name), chars: text.length }
  }

  /**
   * Select task-related rules (full text + source reference) for a task.
   *
   * @param {{ taskText?: string, limit?: number, categories?: string[] }} [input]
   * @returns {{ rules: { ruleId: string, skillName: string, text: string, category: string, scope: string[], dynamic: boolean, sourcePath: string | null, sourceLine: number | null, reason: string }[], omitted: { ruleId: string, reason: string }[] }}
   */
  getTaskRules(input = {}) {
    const maxRules = input.limit ?? this.config.assembly?.maxRules ?? 12
    const maxChars = this.config.skills?.maxRuleChars ?? 1200
    const skillNames = this.listIndexedSkills().filter((skill) => skill.enabled).map((skill) => skill.name)
    const candidates = this.store.listRules({ skillNames, categories: input.categories })
    const taskTokens = new Set(tokenize(input.taskText ?? '', { maxTokens: 120 }))
    /** @type {Record<string, number>} */
    const categoryWeight = { stable_rule: 3, data_convention: 2, operational_lesson: 1.5, current_state: 1 }
    const scored = candidates.map((rule) => {
      let score = categoryWeight[rule.category] ?? 1
      const ruleTokens = tokenize(rule.text, { maxTokens: 80 })
      let overlap = 0
      for (const token of ruleTokens) if (taskTokens.has(token)) overlap += 1
      score += overlap * 0.5
      if (rule.scope.length > 0 && overlap > 0) score += 1
      return { rule, score, overlap }
    })
    scored.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id))
    const selected = scored.slice(0, maxRules)
    // Render in a stable order (by id) so an unrelated follow-up with a
    // different keyword overlap does not reshuffle the same rule set and
    // invalidate the injected block's content hash every step.
    selected.sort((a, b) => a.rule.id.localeCompare(b.rule.id))
    const omitted = scored.slice(maxRules).map((entry) => ({ ruleId: entry.rule.id, reason: 'maxRules budget' }))
    return {
      rules: selected.map((entry) => ({
        ruleId: entry.rule.id,
        skillName: entry.rule.skillName,
        text: clampText(entry.rule.text, maxChars),
        category: entry.rule.category,
        scope: entry.rule.scope,
        dynamic: entry.rule.category === 'current_state' || /(?:当前|目前|最新|截止)/u.test(entry.rule.text),
        sourcePath: entry.rule.sourcePath,
        sourceLine: entry.rule.sourceLine,
        reason: entry.overlap > 0 ? `task keyword overlap (${entry.overlap})` : 'stable rule priority',
      })),
      omitted,
    }
  }

  /**
   * @param {string} skillName
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setSkillEnabled(skillName, enabled) {
    return this.store.setSkillEnabled(skillName, enabled)
  }

  /**
   * @param {string} ruleId
   * @param {{ category?: string, active?: boolean, scope?: string[], note?: string }} override
   * @returns {{ ok: boolean, message: string }}
   */
  overrideRule(ruleId, override) {
    const row = this.store.db.get('SELECT id FROM rules WHERE id = ?', [ruleId])
    if (row === undefined) return { ok: false, message: `unknown rule: ${ruleId}` }
    if (override.category !== undefined && !RULE_CATEGORIES.includes(override.category)) {
      return { ok: false, message: `category must be one of ${RULE_CATEGORIES.join(', ')}` }
    }
    this.store.setRuleOverride(ruleId, override)
    return { ok: true, message: `updated ${ruleId}` }
  }

  /**
   * Rule lookup for diagnostics: include derived/ignored metadata.
   *
   * @returns {Record<string, unknown>[]}
   */
  inspectRules() {
    return this.store.listRules({ includeInactive: true })
  }

  /**
   * @returns {string} stable hash of the whole rule index (diagnostics)
   */
  indexHash() {
    const rows = this.store.listRules({ includeInactive: true })
    return sha256(rows.map((row) => `${row.id}:${row.text}:${row.category}`).join('\n'))
  }
}

/**
 * @param {string[]} names
 * @returns {string[]} names after trimming and dedupe
 */
export function uniqueNames(names) {
  return uniqueBy(names.map((name) => String(name).trim()).filter(Boolean), (name) => name)
}

/** @returns {string} timestamp helper for tests */
export function skillsTimestamp() {
  return new Date().toISOString()
}
