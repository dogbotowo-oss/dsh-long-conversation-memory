/**
 * The synthetic skill used by every fixture session.
 *
 * The skill is deliberately written in the same shape a real DSH skill uses:
 * YAML frontmatter plus markdown sections whose headings map one-to-one onto
 * the rule categories the plugin distinguishes (`stable_rule`, `data_convention`,
 * `current_state`, `operational_lesson`). The answer key records the exact line
 * numbers and the distinctive fragments the harness uses to confirm that the
 * rule layer stored and assembled them; it never re-derives the rules from the
 * generated conversation.
 *
 * @module tests/fixtures/synthetic/skill
 */

/** Skill name used in fixture metadata and by the eval adapter. */
export const SKILL_NAME = 'synthetic-eval-runbook'

/** Repository-relative path of the generated skill file. */
export const SKILL_FILE = `skills/${SKILL_NAME}/SKILL.md`

/**
 * Rule catalogue. `match` is a short distinctive fragment used by the answer
 * key checks; the full `text` must be present in the generated skill file.
 *
 * @type {ReadonlyArray<{ key: string, category: string, text: string, match: string, section: string }>}
 */
export const SKILL_RULES = Object.freeze([
  {
    key: 'unit_and_condition',
    category: 'stable_rule',
    section: 'Stable rules',
    text: 'Every reported metric value must be written together with its unit and its statistical condition (split, decode setting, sample size and CI level). Never quote a bare number as a result.',
    match: 'unit and its statistical condition',
  },
  {
    key: 'correction_wins',
    category: 'stable_rule',
    section: 'Stable rules',
    text: 'When the user corrects a value, the corrected value is the current one. Never present a superseded value as current, and cite the correction turn as the source of truth.',
    match: 'Never present a superseded value as current',
  },
  {
    key: 'model_version_format',
    category: 'data_convention',
    section: 'Data conventions',
    text: 'Model versions use the form model-params-vMAJOR.MINOR (for example mimir-13b-v2.0); one comparison row keeps a single model version (naming convention).',
    match: 'one comparison row keeps a single model version',
  },
  {
    key: 'chinese_units',
    category: 'data_convention',
    section: 'Data conventions',
    text: 'Chinese units are kept exactly as written (分, 毫秒, 百分比): 分 is not converted to %, and the unit is retained in the answer (unit convention).',
    match: '分 is not converted to %, and the unit is retained',
  },
  {
    key: 'active_split',
    category: 'current_state',
    section: 'Current state',
    text: 'The active evaluation split for this project is test-clean as of the latest run; test-other and test-other-dev results are diagnostic and are labelled with their split name (current state).',
    match: 'diagnostic and are labelled with their split name',
  },
  {
    key: 'trust_evidence_after_compaction',
    category: 'operational_lesson',
    section: 'Operational lessons',
    text: 'After a compaction checkpoint, trust durable evidence over any summary; re-read corrected values from the raw turns before reporting them (operational lesson from a past pitfall).',
    match: 'trust durable evidence over any summary',
  },
])

/** Frontmatter description (kept generic: no personal or paper content). */
export const SKILL_DESCRIPTION =
  'Synthetic runbook for the deterministic long-conversation memory evaluation; safe sample data only.'

/** YAML frontmatter lines, in order. */
const FRONTMATTER = [
  '---',
  `name: ${SKILL_NAME}`,
  `description: ${SKILL_DESCRIPTION}`,
  'when_to_use: Use when running the synthetic mimir benchmark evaluation.',
  '---',
  '',
]

/**
 * Build the synthetic skill markdown and record the exact source line of every
 * rule bullet (1-based), so answer keys can carry the line numbers the plugin
 * is expected to index.
 *
 * @returns {{ content: string, rules: Array<{ key: string, category: string, text: string, match: string, sourceLine: number }> }}
 */
export function buildSkillMarkdown() {
  /** @type {string[]} */
  const lines = [...FRONTMATTER]
  const rules = []
  /** @type {string | null} */
  let section = null
  for (const rule of SKILL_RULES) {
    if (rule.section !== section) {
      section = rule.section
      lines.push(`## ${section}`)
      lines.push('')
    }
    const line = `- ${rule.text}`
    lines.push(line)
    rules.push({ key: rule.key, category: rule.category, text: rule.text, match: rule.match, sourceLine: lines.length })
    lines.push('')
  }
  return { content: `${lines.join('\n').trimEnd()}\n`, rules }
}

/**
 * Answer-key view of the skill rules (no generator internals leaked).
 *
 * @returns {Array<{ key: string, category: string, match: string, sourceLine: number }>}
 */
export function expectedSkillRules() {
  return buildSkillMarkdown().rules.map(({ key, category, match, sourceLine }) => ({ key, category, match, sourceLine }))
}
