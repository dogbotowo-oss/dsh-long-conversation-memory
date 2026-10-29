---
name: synthetic-eval-runbook
description: Synthetic runbook for the deterministic long-conversation memory evaluation; safe sample data only.
when_to_use: Use when running the synthetic mimir benchmark evaluation.
---

## Stable rules

- Every reported metric value must be written together with its unit and its statistical condition (split, decode setting, sample size and CI level). Never quote a bare number as a result.

- When the user corrects a value, the corrected value is the current one. Never present a superseded value as current, and cite the correction turn as the source of truth.

## Data conventions

- Model versions use the form model-params-vMAJOR.MINOR (for example mimir-13b-v2.0); one comparison row keeps a single model version (naming convention).

- Chinese units are kept exactly as written (分, 毫秒, 百分比): 分 is not converted to %, and the unit is retained in the answer (unit convention).

## Current state

- The active evaluation split for this project is test-clean as of the latest run; test-other and test-other-dev results are diagnostic and are labelled with their split name (current state).

## Operational lessons

- After a compaction checkpoint, trust durable evidence over any summary; re-read corrected values from the raw turns before reporting them (operational lesson from a past pitfall).
