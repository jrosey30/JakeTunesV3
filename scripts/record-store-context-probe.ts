// record-store-context-probe.ts — verification script for Brief 037 §9 1b.
//
// Loads the live library.json from this Mac's user-data dir, ranks the
// top artists, gathers the external-context snapshot (real network
// fetches: Bandsintown / MusicBrainz / Pitchfork RSS need no key;
// Last.fm / weather need LASTFM_API_KEY / OPENWEATHER_API_KEY in env —
// missing keys just yield empty feeds, which is the point of fail-soft).
// Prints the snapshot and the prompt block the day-theme picker will
// read.
//
// Run:
//   npx tsx scripts/record-store-context-probe.ts
//   LASTFM_API_KEY=… OPENWEATHER_API_KEY=… npx tsx scripts/record-store-context-probe.ts
//
// This is a one-off introspection tool — not part of the app build. It
// writes a real cache file to the user-data dir; a second run inside 6h
// should report "served from cache".

import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  gatherExternalContext,
  topLibraryArtists,
  formatExternalContextForPrompt,
  type ArtistTrack,
} from '../src/main/record-store/external-context'

const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIBRARY_PATH = join(APP_SUPPORT, 'library.json')

if (!existsSync(LIBRARY_PATH)) {
  console.error(`library.json not found at ${LIBRARY_PATH} — run JakeTunes once to seed it`)
  process.exit(1)
}

async function main(): Promise<void> {
const parsed = JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8')) as { tracks?: ArtistTrack[] }
const tracks = Array.isArray(parsed.tracks) ? parsed.tracks : []
const artists = topLibraryArtists(tracks)

console.log('=== record-store external-context probe ===')
console.log(`library:       ${LIBRARY_PATH}`)
console.log(`tracks:        ${tracks.length}`)
console.log(`top artists:   ${artists.length} (querying feeds for: ${artists.slice(0, 8).join(', ')}…)`)
console.log('')

const t0 = Date.now()
const ctx = await gatherExternalContext({ artists, userDataDir: APP_SUPPORT, forceRefresh: true })
console.log(`gathered in ${Date.now() - t0}ms\n`)

console.log('── calendar ──')
console.log(' ', ctx.calendar)
console.log(`── weather ──\n  ${ctx.weather ? `${ctx.weather.tempF}°F ${ctx.weather.description}` : '(no key / unavailable)'}`)
console.log(`── last.fm chart (${ctx.lastFmChart.length}) ──`)
ctx.lastFmChart.slice(0, 6).forEach((c) => console.log('  -', c))
console.log(`── NYC shows next 14d (${ctx.shows.length}) ──`)
ctx.shows.slice(0, 10).forEach((s) => console.log(`  - ${s.artist} @ ${s.venue}, ${s.city} (${s.date.slice(0, 10)})`))
console.log(`── upcoming releases (${ctx.upcomingReleases.length}) ──`)
ctx.upcomingReleases.slice(0, 10).forEach((r) => console.log(`  - ${r.artist} — ${r.title} (${r.releaseDate})`))
console.log(`── notable releases / Pitchfork BNA (${ctx.notableReleases.length}) ──`)
ctx.notableReleases.slice(0, 6).forEach((p) => console.log(`  - ${p.title}`))
console.log(`── press (${ctx.press.length}) ──`)
ctx.press.slice(0, 6).forEach((p) => console.log(`  - [${p.source}] ${p.title}`))

console.log('\n=== formatted prompt block (what 1c feeds Sonnet) ===')
console.log(formatExternalContextForPrompt(ctx))

// Second gather should hit the 6h disk cache.
const c2t0 = Date.now()
const ctx2 = await gatherExternalContext({ artists, userDataDir: APP_SUPPORT })
const cacheHit = Date.now() - c2t0 < 100 && ctx2.fetchedAt === ctx.fetchedAt
console.log(`\n=== cache check ===`)
console.log(cacheHit ? '✓ second gather served from 6h disk cache' : '✗ second gather did NOT hit cache (investigate)')
if (!cacheHit) process.exit(2)
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(1)
})
