#!/usr/bin/env node
/**
 * Deterministic fixture generator CLI.
 *
 * Usage:
 *   node scripts/generate-fixtures.mjs --profile seed
 *   node scripts/generate-fixtures.mjs --profile smoke
 *   node scripts/generate-fixtures.mjs --profile full --seed my-seed
 *   node scripts/generate-fixtures.mjs --profile smoke --turns 100,200
 *   node scripts/generate-fixtures.mjs --check --profile seed
 *
 * Generated bundles live under `tests/fixtures/generated/` (gitignored), except
 * the tiny `seed` profile which is checked in at `tests/fixtures/synthetic/seed/`
 * so the evaluation can be replayed without generating data first.
 *
 * Write targets are repo-relative and contain no absolute paths; the generator
 * itself is pure (seeded PRNG, logical clock), so the same arguments always
 * produce the same bytes.
 *
 * @module scripts/generate-fixtures
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PROFILE,
  DEFAULT_SEED,
  PROFILE_IDS,
  generateFixtures,
} from '../tests/fixtures/synthetic/generator.mjs'
import {
  fixturePath,
  generatedRootFor,
  readManifest,
  writeFixtureBundle,
} from '../tests/fixtures/synthetic/fixture-io.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED_FIXTURE_ROOT = 'tests/fixtures/synthetic/seed'

/**
 * @param {string[]} argv
 * @returns {{ profile: string, seed: string, turns: number[], out: string | null, check: boolean, force: boolean, json: boolean, quiet: boolean, help: boolean }}
 */
function parseArguments(argv) {
  /** @type {Record<string, any>} */
  const options = {
    profile: DEFAULT_PROFILE,
    seed: DEFAULT_SEED,
    turns: [],
    out: null,
    check: false,
    force: false,
    json: false,
    quiet: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--profile':
        options.profile = argv[++index]
        break
      case '--seed':
        options.seed = argv[++index]
        break
      case '--turns':
        options.turns = String(argv[++index] ?? '')
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value) && value > 0)
        break
      case '--out':
        options.out = argv[++index]
        break
      case '--check':
        options.check = true
        break
      case '--force':
        options.force = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument "${argument}"; try --help`)
    }
  }
  if (!PROFILE_IDS.includes(options.profile)) {
    throw new Error(`unknown profile "${options.profile}"; expected one of ${PROFILE_IDS.join(', ')}`)
  }
  if (typeof options.seed !== 'string' || options.seed.length === 0) {
    throw new Error('--seed must be a non-empty string')
  }
  return options
}

/**
 * @param {string} out
 * @returns {string} absolute path
 */
function resolveOut(out) {
  return path.isAbsolute(out) ? out : path.join(REPO_ROOT, out)
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Compare a freshly generated bundle against an on-disk bundle.
 *
 * @param {string} rootDir
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Promise<{ missing: string[], changed: string[] }>}
 */
async function compareBundle(rootDir, files) {
  /** @type {string[]} */
  const missing = []
  /** @type {string[]} */
  const changed = []
  for (const file of files) {
    const absolute = fixturePath(rootDir, file.path)
    let existing
    try {
      existing = await fs.readFile(absolute, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        missing.push(file.path)
        continue
      }
      throw error
    }
    if (existing !== file.content) changed.push(file.path)
  }
  return { missing, changed }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/generate-fixtures.mjs [--profile seed|smoke|standard|full] [--seed <seed>] [--turns 100,200] [--out <dir>] [--check] [--force] [--json] [--quiet]')
    return 0
  }
  const startedAt = Date.now()
  const generated = generateFixtures({ profile: options.profile, seed: options.seed, turns: options.turns.length > 0 ? options.turns : undefined })
  const defaultRoot = options.profile === 'seed' ? SEED_FIXTURE_ROOT : generatedRootFor(REPO_ROOT, options.profile, options.seed)
  const rootDir = resolveOut(options.out ?? defaultRoot)

  if (options.check) {
    const comparison = await compareBundle(rootDir, generated.files)
    if (comparison.missing.length === 0 && comparison.changed.length === 0) {
      if (!options.quiet) console.log(`fixtures are up to date and deterministic: ${path.relative(REPO_ROOT, rootDir)} (${generated.files.length} files)`)
      return 0
    }
    const details = [
      comparison.missing.length > 0 ? `${comparison.missing.length} missing` : null,
      comparison.changed.length > 0 ? `${comparison.changed.length} changed` : null,
    ].filter(Boolean).join(', ')
    console.error(`fixtures are stale (${details}): run "node scripts/generate-fixtures.mjs --profile ${options.profile}${options.force ? ' --force' : ''}"`)
    for (const file of [...comparison.missing, ...comparison.changed].slice(0, 10)) console.error(`  - ${file}`)
    return 1
  }

  const existing = await readManifest(rootDir).catch(() => null)
  const sameShape = existing !== null &&
    existing.profile === options.profile &&
    existing.seed === options.seed &&
    existing.generatorVersion === generated.manifest.generatorVersion &&
    JSON.stringify(existing.longHaulTurns) === JSON.stringify(generated.manifest.longHaulTurns) &&
    JSON.stringify(existing.groupProfile) === JSON.stringify(generated.manifest.groupProfile)
  if (sameShape && !options.force) {
    if (!options.quiet) console.log(`fixtures already exist and match (${path.relative(REPO_ROOT, rootDir)}); pass --force to rewrite`)
    if (options.json) console.log(JSON.stringify(generated.manifest, null, 2))
    return 0
  }

  const written = await writeFixtureBundle({ rootDir, manifest: generated.manifest, files: generated.files })
  if (options.json) {
    console.log(JSON.stringify(generated.manifest, null, 2))
    return 0
  }
  if (!options.quiet) {
    const totals = generated.manifest.totals ?? {}
    console.log(`generated ${options.profile} fixtures in ${Date.now() - startedAt} ms`)
    console.log(`  root:       ${path.relative(REPO_ROOT, rootDir)}`)
    console.log(`  seed:       ${options.seed}`)
    console.log(`  sessions:   ${totals.sessions} (turns: ${generated.manifest.longHaulTurns.join(', ')})`)
    console.log(`  events:     ${totals.uniqueEvents} unique / ${totals.rawEventEntries} raw`)
    console.log(`  questions:  ${totals.questions}`)
    console.log(`  files:      ${written.fileCount} (${formatBytes(written.bytes)})`)
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
