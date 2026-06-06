// Remove library.json entries whose audio file does not exist on disk.
// Identity check: the track's exact colon path must resolve to a real file
// under AT LEAST ONE known music root (default / legacy / explicit setting).
// A track is only "dead" when its file is absent from EVERY root — a library
// that spans or migrated between ~/Music and ~/Music2 must not lose entries
// just because one root is missing the file.
//
//   node scripts/remove-dead-tracks.mjs           # dry run
//   node scripts/remove-dead-tracks.mjs --commit  # write library.json
//   node scripts/remove-dead-tracks.mjs --commit --force  # bypass safety guard
//
// ⚠️ TWIN: src/main/reconcile-guard.ts (assessDeadTrackRemoval) + the
// 'remove-dead-tracks' IPC handler in src/main/index.ts. The safety guard
// thresholds and reasons below MUST stay in lockstep with that module — change
// both in the same commit. The guard refuses to prune when the "missing"
// signal is untrustworthy (no/empty/incomplete music root, or a flood of
// dead tracks), which is what silently dropped 265 tracks on workmini.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import {
  LIBRARY_PATH,
  APP_SETTINGS_PATH,
  LEGACY_MUSIC_DIR,
  DEFAULT_MUSIC_DIR,
  walkAudioFiles,
} from './lib-orphan-shared.mjs'

// ── Safety guard constants — keep in lockstep with reconcile-guard.ts ──
const MAX_SAFE_ONE_SHOT_REMOVAL = 100
const MIN_ROOT_COMPLETENESS = 0.5
const MAX_REMOVAL_FRACTION = 0.5

const commit = process.argv.includes('--commit')
const force = process.argv.includes('--force')

const stripSuffix = (p) => p.replace(/[/\\]iPod_Control[/\\]Music$/, '')

// All music ROOT mounts that currently hold an iPod_Control/Music tree.
function candidateMusicMounts() {
  const roots = [stripSuffix(DEFAULT_MUSIC_DIR), stripSuffix(LEGACY_MUSIC_DIR)]
  try {
    const settings = JSON.parse(readFileSync(APP_SETTINGS_PATH, 'utf8'))
    const musicRoot = settings?.library?.musicRoot
    if (musicRoot && typeof musicRoot === 'string') roots.push(musicRoot)
  } catch { /* no settings — auto-detect roots still apply */ }
  const seen = new Set()
  const out = []
  for (const r of roots) {
    if (!r || seen.has(r)) continue
    seen.add(r)
    if (existsSync(join(r, 'iPod_Control', 'Music'))) out.push(r)
  }
  return out
}

// ⚠️ TWIN: assessDeadTrackRemoval in src/main/reconcile-guard.ts
function assessDeadTrackRemoval({ totalTracks, deadCount, mountsChecked, diskAudioCount }) {
  if (deadCount <= 0) return { safe: true, reason: 'nothing-to-remove', message: 'No dead tracks to remove.' }
  if (mountsChecked <= 0) return { safe: false, reason: 'no-music-root', message: 'No music root found on disk (drive/NAS disconnected?).' }
  if (diskAudioCount <= 0) return { safe: false, reason: 'music-root-empty', message: 'Music root present but empty (still syncing or wrong location?).' }
  if (totalTracks > 0 && diskAudioCount < totalTracks * MIN_ROOT_COMPLETENESS) {
    return { safe: false, reason: 'music-root-incomplete', message: `Only ${diskAudioCount} files on disk for ${totalTracks} tracks — mirror looks incomplete.` }
  }
  if (totalTracks > 0 && deadCount > totalTracks * MAX_REMOVAL_FRACTION) {
    return { safe: false, reason: 'catastrophic-fraction', message: `Would drop ${deadCount}/${totalTracks} tracks (over half).` }
  }
  if (deadCount > MAX_SAFE_ONE_SHOT_REMOVAL) {
    return { safe: false, reason: 'over-cap', message: `${deadCount} dead tracks exceeds the safe one-shot cap (${MAX_SAFE_ONE_SHOT_REMOVAL}).` }
  }
  return { safe: true, reason: 'ok', message: `Safe to remove ${deadCount} dead track(s).` }
}

const mounts = candidateMusicMounts()
const lib = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'))
const tracks = Array.isArray(lib.tracks) ? lib.tracks : []

console.log(`music roots checked: ${mounts.length ? mounts.join(', ') : '(none found)'}`)

function existsUnderAnyMount(colonPath) {
  if (!colonPath) return false
  const rel = colonPath.replace(/:/g, '/')
  for (const m of mounts) {
    if (existsSync(join(m, rel))) return true
  }
  return false
}

const dead = []
for (const t of tracks) {
  const colon = String(t.path || '')
  if (!existsUnderAnyMount(colon)) dead.push(t)
}

console.log(`library: ${tracks.length} tracks | dead (missing on every root): ${dead.length}`)
if (dead.length === 0) {
  console.log('Nothing to remove.')
  process.exit(0)
}

for (const t of dead.slice(0, 50)) {
  console.log(`  ${commit ? 'REMOVE' : 'would remove'}  #${t.id}  ${t.artist || '?'} — ${t.title || '?'}  (${basename(String(t.path || '').replace(/:/g, '/'))})`)
}
if (dead.length > 50) console.log(`  …and ${dead.length - 50} more`)

// ── Safety guard ──
let diskAudioCount = 0
for (const m of mounts) {
  diskAudioCount += (await walkAudioFiles(join(m, 'iPod_Control', 'Music'))).length
}
const guard = assessDeadTrackRemoval({
  totalTracks: tracks.length,
  deadCount: dead.length,
  mountsChecked: mounts.length,
  diskAudioCount,
})
if (!guard.safe && !force) {
  console.error(`\nREFUSED (${guard.reason}): ${guard.message}`)
  console.error('This usually means a drive/mirror is incomplete or the wrong music folder is in use.')
  console.error('Verify your music location, or pass --force to override (a backup is still written).')
  process.exit(3)
}

if (!commit) {
  console.log('\nRe-run with --commit to update library.json.')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
try { copyFileSync(LIBRARY_PATH, `${LIBRARY_PATH}.pre-dead-remove-${stamp}.bak`) } catch { /* best effort */ }
const deadIds = new Set(dead.map((t) => t.id))
lib.tracks = tracks.filter((t) => !deadIds.has(t.id))
writeFileSync(LIBRARY_PATH, JSON.stringify(lib, null, 2))
console.log(`\nRemoved ${dead.length} dead track(s). Library now has ${lib.tracks.length} tracks.${force && !guard.safe ? ' (--force used)' : ''}`)
