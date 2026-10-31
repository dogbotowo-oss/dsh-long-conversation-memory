---
name: synthetic-report-skill
description: "Synthetic, self-contained example skill for dsh-long-memory. It exercises the four rule categories (stable rule, data convention, current state, operational lesson) plus an abbreviation ban whose scope is deliberately narrow. It describes no real project, paper, dataset or person."
when_to_use: Use when trying the skill-rule ingestion examples in this repository.
---

# synthetic-report-skill

A deliberately small skill that shows how `dsh-long-memory` indexes a `SKILL.md`
into categorised rules. Every rule below is fictional; the file exists so examples
and tests can exercise categorisation, dynamic state handling and scoped rules
without depending on a real project skill.

Categorisation is a deterministic heuristic over small marker lists, so each
bullet below is kept on one physical line and phrased to be unambiguous. See
[`docs/architecture.md`](../../docs/architecture.md) for the rule pipeline.

## Stable rules

- Every report must end with a single line that starts with `Status:` followed by one of `draft`, `review` or `final`.
- Do not rename a release that has already been sent to a reviewer; create a new release identifier instead.
- Source files use UTF-8 without a byte-order mark.

## Data conventions

- Dates use ISO 8601 (`YYYY-MM-DD`); the `MM/DD/YY` format is rejected.
- Concentrations use the `mg/L` unit with exactly one decimal place (for example `12.4 mg/L`).
- Stored numbers keep full precision; presentation rounds the displayed number format.
- The unit is separated from the number by one space, and `%` is written without a space: `37.2 mg/L`, `41%`.

## Current state

- The release currently under review is `v2.3.1`; re-check it from the project before use.
- As of today the `legacy-2019` data set is deprecated but still imported for regression comparison.
- The active output directory is currently `<project>/out/review`; it changes between quarters.
- Treat the current-state bullets above as hints to re-check, not as fixed validation rules.

## Operational lessons

- When the export command fails with `EACCES`, close the open output file and retry the export once; re-running the whole pipeline is the common pitfall.
- Operational lesson: when the generator prints `warning: duplicate heading`, fix the source heading rather than deleting the duplicate line.
- Gotcha: a run that reads a stale cache prints the cache timestamp on the second line; read it before trusting any numbers.

## Abbreviation ban (scoped)

- The abbreviation ban applies to report body text only; quotes, file paths, code blocks and explanations of old names may keep the original abbreviations.
- 缩写禁令：在正文中使用 `approximately` 和 `minimum` 等完整词汇，不得使用 `approx.` 或 `min.`；引文例外；路径不受限制。
- Quotes and paths being discussed or explained are acceptable, for example the old column name `min.` or the file `legacy/min_report.csv`.

## Style

- Use the active voice in the summary paragraph.
- Prefer one sentence per bullet.
