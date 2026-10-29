/**
 * Baseline context builders for the three-way evaluation.
 *
 * Baselines are intentionally simple in-harness simulators: they never touch
 * the real memory database. They answer the question "what would the model see
 * without durable session memory?" so the report can compare:
 *
 * 1. `skill-only`       - the synthetic skill rules are always present; no
 *                         session facts, no retrieval, no task state.
 * 2. `rolling-summary`  - a slim rolling summary window: it keeps the last few
 *                         turns and drops everything older (the classic
 *                         long-conversation failure mode). Repeated compaction
 *                         events reset the window further.
 * 3. `memory`           - the real plugin pipeline (see `plugin-runner.mjs`).
 *
 * Both simulators are deterministic and read only `session.events` as input;
 * the answer key is used by the scorer, never to build the context.
 *
 * @module tests/fixtures/synthetic/baselines
 */

import { performance } from 'node:perf_hooks'

import { estimateTokens } from './metrics.mjs'

/** Baseline ids used in reports. */
export const BASELINE_IDS = Object.freeze(['skill-only', 'rolling-summary', 'memory'])

/** Default number of turns a rolling summary keeps. */
export const ROLLING_WINDOW_TURNS = 8

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function oneLine(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Concatenate user content blocks from a captured session event.
 *
 * @param {object} event
 * @returns {string}
 */
export function eventText(event) {
  const data = event?.data ?? {}
  const blocks = Array.isArray(data.content) ? data.content : Array.isArray(data.message?.content) ? data.message.content : []
  /** @type {string[]} */
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  if (parts.length === 0 && typeof data.summary === 'string') parts.push(data.summary)
  return parts.join('\n')
}

/**
 * Baseline 1: the skill is loaded (rules always present), nothing is remembered.
 *
 * @param {{ session: object, answerKey: object, skillContent: string }} input
 * @returns {{ id: string, notes: string[], sessions: Array<{ sessionId: string, contexts: Array<{ questionId: string, context: string, tokens: number, latencyMs: number }> }> }}
 */
export function runSkillOnlyBaseline({ session, answerKey, skillContent }) {
  const contexts = []
  for (const question of answerKey.questions) {
    const started = performance.now()
    const context = [
      '## 已加载的 skill 规则（始终生效，无会话记忆）',
      String(skillContent ?? '').trim(),
    ].join('\n\n')
    const latencyMs = performance.now() - started
    contexts.push({
      questionId: question.id,
      context,
      tokens: estimateTokens(context),
      latencyMs,
    })
  }
  return {
    id: 'skill-only',
    notes: ['skill rules are always present; no durable session memory, no retrieval, no task state'],
    sessions: [{ sessionId: session.sessionId, contexts }],
  }
}

/**
 * Baseline 2: a slim rolling summary that keeps only the last few turns and
 * loses early facts. A compaction summary event resets the rolling window.
 *
 * @param {{
 *   session: object,
 *   answerKey: object,
 *   skillContent: string,
 *   windowTurns?: number,
 * }} input
 * @returns {{ id: string, notes: string[], sessions: Array<{ sessionId: string, contexts: Array<{ questionId: string, context: string, tokens: number, latencyMs: number }> }> }}
 */
export function runRollingSummaryBaseline({ session, answerKey, skillContent, windowTurns = ROLLING_WINDOW_TURNS }) {
  const window = Math.max(1, windowTurns)
  /** @type {{ turn: number, role: string, text: string }[]} */
  let rolling = []
  let compactions = 0
  for (const event of session.events ?? []) {
    if (event.type === 'compaction/summary') {
      compactions += 1
      // The compaction keeps a very short recap and discards the older window.
      rolling = rolling.slice(-2)
      continue
    }
    const text = eventText(event)
    if (text.length === 0) continue
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : ''
    if (role === '') continue
    const turn = Number(event.data?.turn ?? event.data?.message?.turn ?? 0)
    rolling.push({ turn, role, text })
    if (rolling.length > window) rolling = rolling.slice(-window)
  }

  const summaryLines = rolling.map((entry) => `- [turn ${entry.turn}] ${entry.role}: ${oneLine(entry.text, 220)}`)
  const recent = rolling.slice(-3).map((entry) => `### turn ${entry.turn} ${entry.role}\n${oneLine(entry.text, 600)}`)
  const contexts = []
  for (const question of answerKey.questions) {
    const started = performance.now()
    const context = [
      '## 已加载的 skill 规则（始终生效）',
      String(skillContent ?? '').trim(),
      `## 滚动摘要（仅保留最近 ${window} 条消息；更早内容已丢弃；压缩次数 ${compactions}）`,
      summaryLines.join('\n'),
      '## 最近轮次原文',
      recent.join('\n\n'),
    ].join('\n\n')
    const latencyMs = performance.now() - started
    contexts.push({
      questionId: question.id,
      context,
      tokens: estimateTokens(context),
      latencyMs,
    })
  }
  return {
    id: 'rolling-summary',
    notes: [
      `keeps only the last ${window} messages plus the last 3 turns verbatim; older facts (and corrections older than the window) are lost`,
      'a compaction summary event truncates the rolling window further',
    ],
    sessions: [{ sessionId: session.sessionId, contexts }],
  }
}
