/**
 * Diagnostics: human/model readable views over the memory store. Implements the
 * `memory <subcommand>` surface documented in the README; the DSH command
 * adapter only routes raw input here so the formatting stays testable without a
 * host.
 *
 * Subcommands: status, inspect <id>, search <query>, explain, retract <id>,
 * export, purge, help.
 *
 * @module dsh-session-memory/diagnostics
 */

import { estimateTokens, oneLine } from './core/util.js'
import { COMPACTION_EVENT_TYPES } from './core/constants.js'

const USAGE = `memory <subcommand>

  status                记忆库、任务状态、skill/规则、检查点与兼容性概览
  inspect <id>          某条记忆的来源、修订历史与原文证据
  search <query>        全文检索记忆（中文 n-gram / 精确数字与路径）
  explain               最近一次请求装配了哪些规则/记忆、为什么、哪些因预算省略
  retract <id> [原因]   撤回一条记忆（保留审计，退出有效检索）
  export [--events]     导出本会话记忆为 JSON
  purge                 彻底清除本会话记忆（含索引与派生数据）
  help                  显示本帮助`

export class Diagnostics {
  /**
   * @param {import('./memory/store.js').MemoryStore} store
   * @param {{ config?: any, skills?: import('./skills.js').SkillManager | null, retriever?: import('./retrieval.js').Retriever | null, compatibility?: any, version?: string, dbFile?: string | null }} [options]
   */
  constructor(store, options = {}) {
    this.store = store
    this.config = options.config ?? {}
    this.skills = options.skills ?? null
    this.retriever = options.retriever ?? null
    this.compatibility = options.compatibility ?? {}
    this.version = options.version ?? '0.0.0'
    this.dbFile = options.dbFile ?? null
    this.sessionId = options.sessionId ?? null
  }

  /**
   * @param {string} rawInput full raw input after the command name
   * @param {{ sessionId?: string }} [context]
   * @returns {{ kind: 'success', text: string } | { kind: 'error', text: string } | { kind: 'none' }}
   */
  handle(rawInput, context = {}) {
    const sessionId = context.sessionId ?? this.sessionId
    const parsed = parseMemoryCommand(rawInput)
    if (parsed === null) return { kind: 'none' }
    if (sessionId === null || sessionId === undefined || String(sessionId).length === 0) {
      return { kind: 'error', text: 'session-memory: no active session id (memory command unavailable outside an agent session)' }
    }
    const sid = String(sessionId)
    try {
      switch (parsed.subcommand) {
        case 'status':
          return { kind: 'success', text: this.status(sid) }
        case 'inspect':
          return parsed.args.length === 0
            ? { kind: 'error', text: 'usage: memory inspect <id>' }
            : { kind: 'success', text: this.inspect(parsed.args[0]) }
        case 'search':
          return parsed.args.length === 0
            ? { kind: 'error', text: 'usage: memory search <query>' }
            : { kind: 'success', text: this.search(sid, parsed.args.join(' ')) }
        case 'explain':
          return { kind: 'success', text: this.explain(sid) }
        case 'retract':
          return parsed.args.length === 0
            ? { kind: 'error', text: 'usage: memory retract <id> [reason]' }
            : { kind: 'success', text: this.retract(sid, parsed.args[0], parsed.args.slice(1).join(' ')) }
        case 'export':
          return { kind: 'success', text: this.exportText(sid, { includeEvents: parsed.flags.includes('--events') }) }
        case 'purge':
          return { kind: 'success', text: this.purge(sid) }
        case 'help':
        default:
          return { kind: 'success', text: USAGE }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { kind: 'error', text: `session-memory: ${message}` }
    }
  }

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  status(sessionId) {
    const stats = this.store.stats(sessionId)
    const breakdown = this.store.memoryBreakdown(sessionId)
    const checkpoint = this.store.getCheckpoint(sessionId)
    const taskState = this.store.getTaskState(sessionId)
    const skills = this.skills?.listIndexedSkills?.() ?? []
    const rules = this.skills?.inspectRules?.() ?? []
    const latest = this.store.latestAssembly(sessionId)
    const compatibility = this.describeCompatibility()
    /** @type {string[]} */
    const lines = [
      `session-memory v${this.version} — status`,
      `数据库: ${this.dbFile ?? '(in-memory)'}`,
      `会话: ${sessionId}`,
      `事件: ${stats.events} 条 | 记忆: ${breakdown.active} active / ${breakdown.total} total | 规则: ${rules.length} | skill: ${skills.length}`,
      `检查点: lastEventSeq=${checkpoint.lastEventSeq} lastExtractSeq=${checkpoint.lastExtractSeq} lastAssemblySeq=${checkpoint.lastAssemblySeq}`,
      `装配预算: ${this.config.assembly?.softBudgetTokens ?? 3000} tokens (soft)`,
    ]
    if (breakdown.total > 0) {
      lines.push(`记忆分布: ${Object.entries(breakdown.byKind).map(([kind, count]) => `${kind}=${count}`).join(' ')}`)
      lines.push(`状态分布: ${Object.entries(breakdown.byStatus).map(([status, count]) => `${status}=${count}`).join(' ')}`)
    }
    if (taskState.goal !== null || taskState.openItems.length > 0 || taskState.blockers.length > 0) {
      lines.push(`目标: ${taskState.goal === null ? '(未记录)' : oneLine(taskState.goal, 240)}`)
      if (taskState.blockers.length > 0) lines.push(`阻塞: ${taskState.blockers.map((entry) => oneLine(entry, 120)).join('；')}`)
      if (taskState.openItems.length > 0) lines.push(`未完成: ${taskState.openItems.map((entry) => oneLine(entry, 120)).join('；')}`)
    }
    if (latest !== undefined) {
      lines.push(`最近装配: step=${latest.step ?? '?'} injected=${latest.injected === 1 || latest.injected === true} ${latest.usedTokens}/${latest.budgetTokens} tokens (${latest.tokenSource}) sections=${latest.sections.length} omitted=${latest.omitted.length}`)
    } else {
      lines.push('最近装配: (尚未装配)')
    }
    const checks = Array.isArray(this.config.validation?.checks) ? this.config.validation.checks : []
    if (checks.length === 0) {
      lines.push('校验: (未配置确定性检查)')
    } else {
      const validation = this.store.latestValidationLog(sessionId)
      if (validation === undefined) {
        lines.push(`校验: 已配置 ${checks.length} 项检查，尚无记录`)
      } else {
        const failed = Array.isArray(validation.violations) ? validation.violations.length : 0
        const attempts = this.config.validation?.maxRepairAttempts ?? 2
        lines.push(
          `校验: ${validation.ok ? '通过' : '未通过'} target=${validation.target} seq=${validation.eventSeq ?? '?'} ` +
            `${validation.deterministic ? '程序判定' : '非确定性'} 失败项=${failed} 修复上限=${attempts}`,
        )
        if (!validation.ok) {
          for (const violation of (validation.violations ?? []).slice(0, 3)) {
            lines.push(`  - [${violation.checkId ?? 'check'}] ${oneLine(String(violation.message ?? ''), 160)}`)
          }
        }
      }
    }
    lines.push(`压缩兼容: ${compatibility}`)
    const compactionEvents = this.store.listEvents(sessionId, { types: COMPACTION_EVENT_TYPES, limit: 200 }).length
    if (compactionEvents > 0) {
      lines.push(`压缩事件: 已观察 ${compactionEvents} 条（记忆库独立于压缩摘要；压缩后本插件会重新装配有效规则与任务状态）`)
    }
    if (stats.pendingExtraction > 0) lines.push(`⚠ 待重试抽取: ${stats.pendingExtraction} 条（原文已保留）`)
    return lines.join('\n')
  }

  /**
   * @returns {string}
   */
  describeCompatibility() {
    const compatibility = this.compatibility ?? {}
    const policy = compatibility.compactionPolicy ?? compatibility.configured ?? this.config.compatibility?.compactionPolicy ?? 'unknown'
    const parts = [`policy=${policy}`]
    if (compatibility.billionContext === true) parts.push('billion-context=detected')
    if (compatibility.compactionBasic === true) parts.push('compaction-basic=detected')
    if (compatibility.compactionService === true) parts.push('compaction-service=present')
    if (compatibility.reinjectAfterCompaction === false) parts.push('post-compaction reinjection=disabled')
    if (compatibility.status === 'confirmed') {
      parts.push(`compaction=confirmed(${Number(compatibility.observedEvents ?? 0)} events observed)`)
    } else if (this.config.compatibility?.reportUnknownCompatibility !== false) {
      parts.push('⚠ 无法确认压缩兼容性：注入的消息可能在压缩后被移出活动上下文；记忆库本身仍完整，可用 memory search 恢复')
    }
    if (typeof compatibility.note === 'string' && compatibility.note.length > 0) parts.push(`说明: ${compatibility.note}`)
    if (Array.isArray(compatibility.warnings)) parts.push(...compatibility.warnings.map((warning) => `⚠ ${warning}`))
    return parts.join(' | ')
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  inspect(id) {
    const inspected = this.retriever?.inspectItem?.(id)
    if (inspected === undefined || inspected === null) return `未找到记忆条目: ${id}`
    if ('error' in inspected) return inspected.error
    const { item, events, evidence, tokens } = inspected
    /** @type {string[]} */
    const lines = [
      `记忆 ${item.id}`,
      `  类型: ${item.kind} | 证据级别: ${item.evidenceType} | 状态: ${item.status} | 提取器: ${item.extractor ?? '?'}`,
      `  内容: ${oneLine(item.content, 600)}`,
      `  限定条件: ${(item.conditions ?? []).length === 0 ? '(无)' : item.conditions.join('；')}`,
      `  适用范围: ${(item.scope ?? []).length === 0 ? '(未限定)' : item.scope.join('；')}`,
      `  来源引用: ${(item.sourceRefs ?? []).join(', ') || '(无)'}`,
      `  替代: supersedes=${(item.supersedes ?? []).join(', ') || '无'} supersededBy=${item.supersededBy ?? '无'}`,
      `  数字: ${(item.numbers ?? []).length === 0 ? '(无)' : item.numbers.map((number) => `${number.raw}${number.unit ? ` ${number.unit}` : ''}`).join(', ')}`,
      `  估算 token: ${tokens}`,
      `  创建: ${item.createdAt} | 更新: ${item.updatedAt}`,
      `修订历史 (${events.length}):`,
    ]
    for (const event of events) lines.push(`  - ${event.at} ${event.event} by ${event.actor ?? '-'} ${event.detail === null ? '' : oneLine(JSON.stringify(event.detail), 200)}`)
    lines.push(`原文证据 (${evidence.length}):`)
    for (const entry of evidence) {
      lines.push(`  - [seq:${entry.seq ?? entry.ref}] ${oneLine(entry.text ?? '(无原文，只有引用)', 500)}`)
    }
    return lines.join('\n')
  }

  /**
   * @param {string} sessionId
   * @param {string} query
   * @returns {string}
   */
  search(sessionId, query) {
    const result = this.retriever?.retrieve?.(sessionId, { query, limit: 12 }) ?? { items: [], omitted: [] }
    const evidence = this.retriever?.retrieveEvidence?.(sessionId, { query, limit: 6 }) ?? { evidence: [] }
    /** @type {string[]} */
    const lines = [`检索「${query}」: 命中记忆 ${result.items.length} 条`]
    if (result.items.length === 0) lines.push('  (无记忆命中)')
    for (const entry of result.items) {
      lines.push(`  - [${entry.item.id}] (${entry.item.kind}, ${entry.item.status}, score=${entry.score}) ${oneLine(entry.item.content, 240)}`)
      if ((entry.item.conditions ?? []).length > 0) lines.push(`      条件: ${entry.item.conditions.map((condition) => oneLine(condition, 80)).join('；')}`)
    }
    lines.push(`原文证据 ${evidence.evidence.length} 条:`)
    for (const entry of evidence.evidence) lines.push(`  - [seq:${entry.seq}/${entry.eventType}] ${oneLine(entry.text, 240)}`)
    if (result.items.length === 0 && evidence.evidence.length === 0) lines.push('结论: 证据不足 — 不能据此补造历史')
    return lines.join('\n')
  }

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  explain(sessionId) {
    const latest = this.store.latestAssembly(sessionId)
    if (latest === undefined) return '尚未发生装配（本会话还没有模型步骤，或装配被禁用）'
    const reasons = latest.reasons ?? {}
    /** @type {string[]} */
    const lines = [
      `最近一次请求装配 (assembly id=${latest.id}, ${latest.createdAt})`,
      `  触发: ${latest.trigger} | 步骤: turn=${latest.turn ?? '?'} step=${latest.step ?? '?'} | 注入: ${latest.injected === 1 || latest.injected === true}`,
      `  预算: ${latest.usedTokens}/${latest.budgetTokens} tokens (${latest.tokenSource}${latest.tokenSource === 'estimate' ? ' — 估算值，非精确 token 数' : ''})`,
      `  内容哈希: ${latest.contentHash ?? '-'}`,
      `加载的分段:`,
    ]
    for (const section of latest.sections) {
      const ids = Array.isArray(section.ids) && section.ids.length > 0 ? ` ids=${section.ids.slice(0, 8).join(',')}` : ''
      lines.push(`  - ${section.name}: ${section.tokens} tokens${ids}`)
    }
    if (latest.sections.length === 0) lines.push('  (无分段)')
    lines.push(`选中的记忆 (${latest.items.length}):`)
    for (const id of latest.items) lines.push(`  - ${id}: ${reasons[id] ?? '(no reason recorded)'}`)
    if (latest.items.length === 0) lines.push('  (无)')
    lines.push(`因预算/规则省略 (${latest.omitted.length}):`)
    for (const entry of latest.omitted) lines.push(`  - ${entry.kind}${entry.id ? ` ${entry.id}` : ''}: ${entry.reason}`)
    if (latest.omitted.length === 0) lines.push('  (无)')
    if (latest.errors.length > 0) lines.push(`装配错误: ${latest.errors.join('；')}`)
    const validation = this.store.latestValidationLog(sessionId)
    if (validation !== undefined) {
      lines.push(
        `最近一次校验: ${validation.ok ? '通过' : '未通过'} (id=${validation.id}, seq=${validation.eventSeq ?? '?'}, ` +
          `${validation.deterministic ? '程序判定' : '非确定性'}, 修复上限=${this.config.validation?.maxRepairAttempts ?? 2})`,
      )
      for (const violation of (validation.violations ?? []).slice(0, 5)) {
        lines.push(`  - [${violation.checkId ?? 'check'}] ${violation.severity ?? 'warn'}: ${oneLine(String(violation.message ?? ''), 160)}`)
      }
    }
    return lines.join('\n')
  }

  /**
   * @param {string} sessionId
   * @param {string} id
   * @param {string} [reason]
   * @returns {string}
   */
  retract(sessionId, id, reason) {
    const item = this.store.getMemoryItem(id)
    if (item === undefined) return `未找到记忆条目: ${id}`
    if (item.sessionId !== sessionId) return `记忆条目 ${id} 属于其他会话，拒绝操作`
    if (item.status === 'retracted') return `记忆条目 ${id} 已经处于撤回状态`
    this.store.retractItem(id, { actor: 'user-command', reason: reason ?? 'retracted via memory retract' })
    return `已撤回 ${id}（保留修订历史与原文；已从有效检索与装配缓存排除）`
  }

  /**
   * @param {string} sessionId
   * @param {{ includeEvents?: boolean }} [options]
   * @returns {string}
   */
  exportText(sessionId, options = {}) {
    const data = this.store.exportSession(sessionId, options)
    return JSON.stringify(data, null, 2)
  }

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  purge(sessionId) {
    const result = this.store.purgeSession(sessionId)
    const tables = Object.entries(result.deleted).map(([table, count]) => `${table}=${count}`).join(' ')
    return `已彻底清除会话 ${sessionId} 的记忆、事件索引与派生数据: ${tables}`
  }

  /**
   * Compact diagnostics snapshot (for `memory explain` and tests).
   *
   * @param {string} sessionId
   * @returns {Record<string, unknown>}
   */
  snapshot(sessionId) {
    const latest = this.store.latestAssembly(sessionId)
    const stats = this.store.stats(sessionId)
    return {
      version: this.version,
      sessionId,
      stats,
      compatibility: this.compatibility,
      latestAssembly: latest === undefined ? null : { id: latest.id, summary: latestSummary(latest), tokens: estimateTokens(latest.contentHash ?? '') },
    }
  }
}

/**
 * @param {string} rawInput
 * @returns {{ subcommand: string, args: string[], flags: string[] } | null}
 */
export function parseMemoryCommand(rawInput) {
  const raw = String(rawInput ?? '').trim()
  if (raw.length === 0) return { subcommand: 'help', args: [], flags: [] }
  const tokens = raw.split(/\s+/u)
  const [first, ...rest] = tokens
  if (!['status', 'inspect', 'search', 'explain', 'retract', 'export', 'purge', 'help'].includes(first)) {
    if (first === 'memory') {
      const [second, ...remainder] = rest
      if (second === undefined) return { subcommand: 'help', args: [], flags: [] }
      return { subcommand: second, args: remainder.filter((token) => !token.startsWith('--')), flags: remainder.filter((token) => token.startsWith('--')) }
    }
    return null
  }
  return { subcommand: first, args: rest.filter((token) => !token.startsWith('--')), flags: rest.filter((token) => token.startsWith('--')) }
}

/**
 * @param {any} latest
 * @returns {string}
 */
function latestSummary(latest) {
  return `injected=${latest.injected} used=${latest.usedTokens}/${latest.budgetTokens} sections=${latest.sections.length} items=${latest.items.length} omitted=${latest.omitted.length}`
}

/** @returns {string} command help text */
export function commandUsage() {
  return USAGE
}

/** @returns {string} command description used for the DSH command registration */
export function commandDescription() {
  return 'Long-session memory: status / inspect / search / explain / retract / export / purge'
}
