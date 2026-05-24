// record-store-pool-probe.ts — verification script for Brief 037 §9 1a.
//
// Loads the live library.json from this Mac's user-data dir and runs
// buildCandidatePool() against it for each shelf type. Prints the top
// N per shelf with their score breakdown so a human can eyeball
// whether the anti-repeat math is producing a sensible pool.
//
// Run:
//   npx tsx scripts/record-store-pool-probe.ts
//   npx tsx scripts/record-store-pool-probe.ts 10        # top 10 per shelf
//
// This is a one-off introspection tool — not part of the app build.

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  buildCandidatePool,
  TUNING,
  type CandTrack,
  type AlbumCandidate,
} from '../src/main/record-store/candidate-pool'
import type { ShelfId } from '../src/main/record-store/types'

const N_PER_SHELF = Number(process.argv[2] || 8)

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIBRARY_PATH = join(APP_SUPPORT, 'library.json')
const OVERRIDES_PATH = join(APP_SUPPORT, 'metadata-overrides.json')

if (!existsSync(LIBRARY_PATH)) {
  console.error(`library.json not found at ${LIBRARY_PATH} — run JakeTunes once to seed it`)
  process.exit(1)
}

const raw = readFileSync(LIBRARY_PATH, 'utf-8')
const parsed = JSON.parse(raw) as { tracks?: CandTrack[] }
const baseTracks = Array.isArray(parsed.tracks) ? parsed.tracks : []

// Listening-history signals (lastPlayedAt, skipCount, bpm/key, etc.)
// live in metadata-overrides.json — NOT in library.json. Merge them in
// so the rediscover boost can actually fire. This is the same merge
// the engine call site will need to do in Phase 1d.
interface OverridesShape {
  [trackId: string]: Partial<CandTrack>
}
let overrides: OverridesShape = {}
if (existsSync(OVERRIDES_PATH)) {
  try {
    const rawOv = readFileSync(OVERRIDES_PATH, 'utf-8')
    const parsedOv = JSON.parse(rawOv) as OverridesShape | { overrides?: OverridesShape }
    overrides = (parsedOv as { overrides?: OverridesShape }).overrides ?? (parsedOv as OverridesShape)
  } catch (err) {
    console.warn('overrides parse failed; continuing without:', err)
  }
}
const tracks: CandTrack[] = baseTracks.map((t) => {
  const ov = overrides[String(t.id)]
  return ov ? { ...t, ...ov } : t
})
const withLastPlay = tracks.filter((t) => typeof t.lastPlayedAt === 'number' && t.lastPlayedAt > 0).length
console.log(`tracks w/ lastPlayedAt: ${withLastPlay} of ${tracks.length}`)
const todayISO = new Date().toISOString().slice(0, 10)

console.log('=== record-store candidate-pool probe ===')
console.log(`library:    ${LIBRARY_PATH}`)
console.log(`tracks:     ${tracks.length}`)
console.log(`today:      ${todayISO}`)
console.log(`tuning:     `, TUNING)
console.log('')

const artistsUsedToday = new Map<string, number>()

const shelves: ShelfId[] = ['mm-picks', 'new-arrivals', 'deep-cuts']
for (const shelfId of shelves) {
  console.log(`──── ${shelfId} (top ${N_PER_SHELF}) ────`)
  const pool = buildCandidatePool({
    tracks,
    shelfId,
    todayISO,
    artistsUsedToday,
    limit: 50,
  })
  console.log(`pool size: ${pool.length}`)
  if (pool.length === 0) {
    console.log('  (empty — check tracks have playCount/dateAdded set)')
    continue
  }
  for (const [i, c] of pool.slice(0, N_PER_SHELF).entries()) {
    const cold =
      c.daysSinceLastPlay === Infinity ? 'never' : `${c.daysSinceLastPlay.toFixed(0)}d cold`
    console.log(
      `  ${String(i + 1).padStart(2)}. score=${c.score.toFixed(3)}  plays=${c.totalPlays
        .toString()
        .padStart(4)}  ${cold.padStart(8)}  ${trunc(c.artist, 22)} — ${trunc(c.album, 35)}`,
    )
  }
  // Mutate the day-level counter so the NEXT shelf sees fewer artists
  // available. The orchestration loop in Phase 1d does this for real.
  for (const p of pool.slice(0, 5)) {
    artistsUsedToday.set(p.artist, (artistsUsedToday.get(p.artist) ?? 0) + 1)
  }
  console.log('')
}

console.log('=== sanity stats ===')
console.log(`unique artists used across day:    ${artistsUsedToday.size}`)
const maxDup = Math.max(0, ...Array.from(artistsUsedToday.values()))
console.log(`max picks per artist across day:   ${maxDup} (cap: ${TUNING.PER_DAY_ARTIST_CAP})`)
if (maxDup > TUNING.PER_DAY_ARTIST_CAP) {
  console.error(`FAIL: per-day diversity cap violated`)
  process.exit(2)
}
console.log('all diversity caps respected ✓')

function trunc(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + '…'
}

// Mark unused param OK for TS strict
void ({} as AlbumCandidate)
