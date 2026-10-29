/**
 * Fixture I/O: write a generated fixture bundle to disk, read it back.
 *
 * The generated bundle is always written under
 * `tests/fixtures/generated/<profile>-<seed>/` (gitignored). The small `seed`
 * profile may also live at `tests/fixtures/synthetic/seed/` and is checked in.
 *
 * @module tests/fixtures/synthetic/fixture-io
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { MANIFEST_FORMAT } from './generator.mjs'
import { SESSION_FORMAT, ANSWER_KEY_FORMAT } from './conversation.mjs'

/** Manifest file name inside a fixture root. */
export const MANIFEST_FILE = 'manifest.json'

/**
 * Resolve a fixture root inside the repo, refusing absolute paths so the
 * public repo never embeds personal directory names in generated artifacts or
 * reports. Relative paths are resolved against the repository root.
 *
 * @param {string} repoRoot
 * @param {string} relative
 * @returns {string}
 */
export function resolveRepoRelative(repoRoot, relative) {
  if (path.isAbsolute(relative)) {
    throw new Error(`expected a repo-relative path, got absolute path: ${relative}`)
  }
  const resolved = path.resolve(repoRoot, relative)
  const root = path.resolve(repoRoot)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes the repository: ${relative}`)
  }
  return resolved
}

/**
 * Default generated fixture root for a given profile + seed.
 *
 * @param {string} repoRoot
 * @param {string} profile
 * @param {string} seed
 * @returns {string} absolute path
 */
export function generatedRootFor(repoRoot, profile, seed) {
  return resolveRepoRelative(repoRoot, path.posix.join('tests/fixtures/generated', `${profile}-${seed}`))
}

/**
 * Write a fixture bundle (manifest + files) under `rootDir`.
 *
 * @param {{ rootDir: string, manifest: object, files: { path: string, content: string }[] }} input
 * @returns {Promise<{ rootDir: string, manifestPath: string, fileCount: number, bytes: number }>}
 */
export async function writeFixtureBundle({ rootDir, manifest, files }) {
  await fs.mkdir(rootDir, { recursive: true })
  let bytes = 0
  for (const file of files) {
    const target = path.join(rootDir, ...file.path.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content, 'utf8')
    bytes += Buffer.byteLength(file.content)
  }
  const manifestPath = path.join(rootDir, MANIFEST_FILE)
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  await fs.writeFile(manifestPath, manifestText, 'utf8')
  bytes += Buffer.byteLength(manifestText)
  return { rootDir, manifestPath, fileCount: files.length + 1, bytes }
}

/**
 * @param {string} rootDir
 * @returns {Promise<object | null>} manifest or null when absent/incompatible
 */
export async function readManifest(rootDir) {
  try {
    const text = await fs.readFile(path.join(rootDir, MANIFEST_FILE), 'utf8')
    const manifest = JSON.parse(text)
    if (manifest.format !== MANIFEST_FORMAT) return null
    if (!Array.isArray(manifest.sessions)) return null
    return manifest
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Read a fixture bundle from disk.
 *
 * @param {string} rootDir
 * @returns {Promise<{ rootDir: string, manifest: object, sessions: object[], groups: object[], skillPath: string, skillContent: string }>}
 */
export async function readFixtureBundle(rootDir) {
  const manifest = await readManifest(rootDir)
  if (manifest === null) {
    throw new Error(`no fixture manifest found at ${path.join(rootDir, MANIFEST_FILE)}; run "node scripts/generate-fixtures.mjs --profile <profile>" first`)
  }

  const skillPath = path.join(rootDir, ...manifest.skill.path.split('/'))
  let skillContent = ''
  try {
    skillContent = await fs.readFile(skillPath, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }

  /** @type {object[]} */
  const sessions = []
  for (const descriptor of manifest.sessions) {
    const session = JSON.parse(await fs.readFile(path.join(rootDir, ...descriptor.files.session.split('/')), 'utf8'))
    const answerKey = JSON.parse(await fs.readFile(path.join(rootDir, ...descriptor.files.answerKey.split('/')), 'utf8'))
    if (session.format !== SESSION_FORMAT) throw new Error(`bad session format in ${descriptor.files.session}`)
    if (answerKey.format !== ANSWER_KEY_FORMAT) throw new Error(`bad answer-key format in ${descriptor.files.answerKey}`)
    if (session.sessionId !== answerKey.sessionId) throw new Error(`session/answer-key mismatch for ${session.sessionId}`)
    sessions.push({ descriptor, session, answerKey })
  }

  return { rootDir, manifest, sessions, groups: manifest.groups ?? [], skillPath, skillContent }
}

/**
 * Remove a fixture root if it exists (used by `--regenerate`).
 *
 * @param {string} rootDir
 * @returns {Promise<boolean>} true when something was removed
 */
export async function removeFixtureRoot(rootDir) {
  try {
    await fs.rm(rootDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Convert a fixture file path (POSIX, root-relative) to a native path.
 *
 * @param {string} rootDir
 * @param {string} relative
 * @returns {string}
 */
export function fixturePath(rootDir, relative) {
  return path.join(rootDir, ...relative.split('/'))
}
