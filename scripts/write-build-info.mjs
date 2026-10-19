#!/usr/bin/env node
/**
 * Brief 192 — stamp the build with its provenance.
 *
 * Writes `out/main/build-info.json` after `electron-vite build`:
 *   { sha, commit, dirty, builtAt, version }
 * `sha` is the full git commit the build was made from (`commit` is the
 * same value under the plainer name); `dirty` is true when tracked files
 * differed from that commit or src/ held untracked files, i.e. the build
 * contains code the commit does not (null when git could not tell);
 * `builtAt` is an ISO timestamp; `version` is package.json's version.
 *
 * `dirty` exists for the workmini deploy's subset proof (2026-10-19): a
 * sha alone cannot prove an installed app is a subset of main, because a
 * build from uncommitted edits on top of a main commit carries main's sha.
 *
 * The consumer is `src/main/build-provenance.ts` (Brief 192, desktop
 * provenance half): it reads `sha` + `builtAt` from the build-info.json
 * beside the bundled main and degrades to version + "dev" when the
 * file is absent or damaged — so this script must never fail a build
 * over a missing git checkout; it stamps "unknown" instead.
 *
 * Brief 195's version-parity script reads the same file (including
 * from inside app.asar) to tell two same-version installs apart.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let sha = 'unknown'
try {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() || 'unknown'
} catch { /* not a git checkout — stamp unknown rather than fail the build */ }

let dirty = null
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  dirty = git('status', '--porcelain', '--untracked-files=no') !== '' ||
    git('ls-files', '--others', '--exclude-standard', '--', 'src') !== ''
} catch { /* not a git checkout — dirty stays null (unknown) */ }

let version = 'unknown'
try {
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? 'unknown'
} catch { /* keep unknown */ }

const info = { sha, commit: sha, dirty, builtAt: new Date().toISOString(), version }
const outDir = join(root, 'out', 'main')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n')
console.log(`[build-info] stamped out/main/build-info.json — ${version} @ ${sha.slice(0, 12)}${dirty ? ' +uncommitted edits' : ''} (${info.builtAt})`)
