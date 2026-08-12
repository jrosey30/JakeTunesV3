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
 *
 * Lists come from @jaketunes/contracts (vendored at
 * vendor/jaketunes-contracts/contracts.json). If this file fails after a
 * contracts bump, the desktop fence drifted — decide on purpose.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  desktopOwned,
  mobileWritable,
  phonePlaylistSidecarsNeverPushFromDesktop,
  notes,
  JAKETUNES_CONTRACTS_VERSION,
  isNeverBluntPushFromDesktop,
  assertNoDesktopBluntPush,
} from '../sidecar-contracts.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const vendorJsonPath = join(repoRoot, 'vendor', 'jaketunes-contracts', 'contracts.json')

function parseBashArray(src: string, name: string): string[] {
  const match = src.match(new RegExp(`${name}=\\(([^)]*)\\)`))
  assert.ok(match, `${name}=(...) assignment must exist`)
  return match![1].trim().split(/\s+/).filter(Boolean)
}

function stateFileNamesBlock(src: string): string {
  const start = src.indexOf('const STATE_FILE_NAMES = [')
  assert.ok(start >= 0, 'STATE_FILE_NAMES must exist')
  const end = src.indexOf('] as const', start)
  assert.ok(end > start, 'STATE_FILE_NAMES must close')
  return src.slice(start, end)
}

const vendor = JSON.parse(readFileSync(vendorJsonPath, 'utf-8')) as {
  version?: string
  sidecars: {
    desktopOwned: string[]
    mobileWritable: string[]
    phonePlaylistSidecarsNeverPushFromDesktop: string[]
  }
  notes?: { recommendationsSingleWriter?: string }
}

test('vendored contracts.json matches sidecar-contracts.ts (twin lock)', () => {
  assert.equal(JAKETUNES_CONTRACTS_VERSION, vendor.version)
  assert.deepEqual([...desktopOwned], vendor.sidecars.desktopOwned)
  assert.deepEqual([...mobileWritable], vendor.sidecars.mobileWritable)
  assert.deepEqual(
    [...phonePlaylistSidecarsNeverPushFromDesktop],
    vendor.sidecars.phonePlaylistSidecarsNeverPushFromDesktop,
  )
  assert.equal(notes.recommendationsSingleWriter, vendor.notes?.recommendationsSingleWriter)
})

test('phone playlist never-push list is mobileWritable and not desktopOwned', () => {
  assert.ok(phonePlaylistSidecarsNeverPushFromDesktop.length > 0, 'never-push list must not be empty')
  for (const f of phonePlaylistSidecarsNeverPushFromDesktop) {
    assert.ok(
      (mobileWritable as readonly string[]).includes(f),
      `${f} must be in sidecars.mobileWritable`,
    )
    assert.ok(
      !(desktopOwned as readonly string[]).includes(f),
      `${f} must not be in sidecars.desktopOwned`,
    )
    assert.equal(isNeverBluntPushFromDesktop(f), true)
  }
})

test('homemini sync does not push phone playlist sidecars in SYNC_FILES', () => {
  const src = readFileSync(join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh'), 'utf-8')
  const syncFiles = parseBashArray(src, 'SYNC_FILES')
  const pulled = parseBashArray(src, 'PHONE_PLAYLIST_SIDECARS')
  assert.deepEqual(
    pulled,
    [...phonePlaylistSidecarsNeverPushFromDesktop],
    'PHONE_PLAYLIST_SIDECARS must equal sidecars.phonePlaylistSidecarsNeverPushFromDesktop',
  )
  for (const f of phonePlaylistSidecarsNeverPushFromDesktop) {
    assert.ok(!syncFiles.includes(f), `${f} must not be in SYNC_FILES push list`)
  }
  assert.match(src, /pulling phone playlist sidecars/)
})

test('STATE_FILE_NAMES omits phone playlist sidecars (no LOCAL→NAS clobber)', () => {
  const src = readFileSync(join(repoRoot, 'src', 'main', 'index.ts'), 'utf-8')
  const block = stateFileNamesBlock(src)
  for (const f of phonePlaylistSidecarsNeverPushFromDesktop) {
    assert.doesNotMatch(
      block,
      new RegExp(`['"]${f.replace('.', '\\.')}['"]`),
      `${f} must not be in STATE_FILE_NAMES (reconcile/auto-backup push)`,
    )
  }
  assert.match(src, /assertNoDesktopBluntPush\(STATE_FILE_NAMES/)
  assert.match(src, /PHONE_AUTHORED_FILES/)
  assert.match(src, /\.\.\.phonePlaylistSidecarsNeverPushFromDesktop/)
})

test('workmini deploy PHONE_PLAYLIST_SIDECARS matches the shared contract', () => {
  const src = readFileSync(join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-workmini-deploy.sh'), 'utf-8')
  const pulled = parseBashArray(src, 'PHONE_PLAYLIST_SIDECARS')
  assert.deepEqual(
    pulled,
    [...phonePlaylistSidecarsNeverPushFromDesktop],
    'workmini-deploy PHONE_PLAYLIST_SIDECARS must equal the shared never-push list',
  )
})

test('assertNoDesktopBluntPush throws on phone playlist sidecars and ignores desktopOwned', () => {
  assert.doesNotThrow(() => assertNoDesktopBluntPush([...desktopOwned], 'desktopOwned'))
  assert.throws(
    () => assertNoDesktopBluntPush([...phonePlaylistSidecarsNeverPushFromDesktop], 'probe'),
    /must not blunt-push/,
  )
})

test('recommendations.json is never blunt-pushed (contract single-writer note)', () => {
  assert.match(
    notes.recommendationsSingleWriter,
    /recommendations\.json/,
    'contracts notes must name recommendations.json as single-writer',
  )
  const syncSrc = readFileSync(join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh'), 'utf-8')
  const syncFiles = parseBashArray(syncSrc, 'SYNC_FILES')
  assert.ok(!syncFiles.includes('recommendations.json'), 'recommendations.json must not be in SYNC_FILES')
  const block = stateFileNamesBlock(
    readFileSync(join(repoRoot, 'src', 'main', 'index.ts'), 'utf-8'),
  )
  assert.doesNotMatch(
    block,
    /['"]recommendations\.json['"]/,
    'recommendations.json must not be in STATE_FILE_NAMES',
  )
})
