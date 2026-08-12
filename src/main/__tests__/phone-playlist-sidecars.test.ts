/**
 * Lock the single-writer contract for phone playlist sidecars.
 *
 * 2026-08-12: macbook→homemini SYNC_FILES included mobile-playlists.json and
 * playlist-additions.json. The iOS backend owns those files; every desktop
 * save-playlists / safety-net sync overwrote homemini's live copies with a
 * stale MacBook mirror — "I can't add songs to playlists. At all."
 *
 * Same shape as recommendations.json (Brief 125): pull/mirror only, never
 * blunt-push from desktop.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const PHONE_PLAYLIST_FILES = ['mobile-playlists.json', 'playlist-additions.json'] as const

test('homemini sync does not push phone playlist sidecars in SYNC_FILES', () => {
  const src = readFileSync(join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh'), 'utf-8')
  const syncLine = src.split('\n').find((l) => /^SYNC_FILES=\(/.test(l))
  assert.ok(syncLine, 'SYNC_FILES assignment must exist')
  for (const f of PHONE_PLAYLIST_FILES) {
    assert.doesNotMatch(
      syncLine!,
      new RegExp(f.replace('.', '\\.')),
      `${f} must not be in SYNC_FILES push list`,
    )
  }
  assert.match(src, /PHONE_PLAYLIST_SIDECARS=\(/)
  // Must pull them homemini → local instead.
  assert.match(src, /pulling phone playlist sidecars/)
  for (const f of PHONE_PLAYLIST_FILES) {
    assert.match(src, new RegExp(f.replace('.', '\\.')))
  }
})

test('STATE_FILE_NAMES omits phone playlist sidecars (no LOCAL→NAS clobber)', () => {
  const src = readFileSync(join(repoRoot, 'src', 'main', 'index.ts'), 'utf-8')
  const start = src.indexOf('const STATE_FILE_NAMES = [')
  assert.ok(start >= 0, 'STATE_FILE_NAMES must exist')
  const end = src.indexOf('] as const', start)
  assert.ok(end > start, 'STATE_FILE_NAMES must close')
  const block = src.slice(start, end)
  for (const f of PHONE_PLAYLIST_FILES) {
    assert.doesNotMatch(
      block,
      new RegExp(`['"]${f.replace('.', '\\.')}['"]`),
      `${f} must not be in STATE_FILE_NAMES (reconcile/auto-backup push)`,
    )
  }
  // Still mirrored for desktop reads.
  assert.match(src, /PHONE_AUTHORED_FILES/)
  for (const f of PHONE_PLAYLIST_FILES) {
    assert.match(src, new RegExp(`['"]${f.replace('.', '\\.')}['"]`))
  }
})
