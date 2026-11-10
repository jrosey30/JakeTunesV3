/**
 * How much script the artist page runs over the library before its first
 * frame: the walks it made on every mount until 2026-11-10, against the
 * per-library index that replaced them (src/renderer/artistLibraryIndex.ts).
 *
 *   node --experimental-strip-types scripts/bench-artist-page.ts [library.json]
 *
 * Read-only. Default library: this Mac's (~/Library/Application Support/JakeTunes/library.json).
 * The "before" functions are the page's old code, verbatim.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { artistLibraryIndex, tracksOfArtist, libraryAlbumFacts, albumTitleForKey } from '../src/renderer/artistLibraryIndex.ts'
import { canonicalArtist, isSameArtist, artistIdentityKey } from '../src/renderer/utils/artistAlias.ts'
import { albumKeyFromStrings } from '../src/renderer/utils/albumKey.ts'
import { collectAlbumFacts } from '../src/common/release-sections.ts'
import { nameKey } from '../src/common/fold-text.ts'
import type { Track } from '../src/renderer/types.ts'

const file = process.argv[2] || join(homedir(), 'Library', 'Application Support', 'JakeTunes', 'library.json')
const raw = JSON.parse(readFileSync(file, 'utf-8')) as { tracks?: Track[] } | Track[]
const tracks: Track[] = Array.isArray(raw) ? raw : (raw.tracks ?? [])

// The page's foldName: nameKey behind a string memo (renderer/releaseKinds.ts).
const folded = new Map<string, string>()
const foldName = (s: string): string => { let k = folded.get(s); if (k === undefined) { k = nameKey(s); folded.set(s, k) } return k }

const time = (fn: () => unknown): number => { const t = performance.now(); fn(); return performance.now() - t }
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const f1 = (n: number): string => n.toFixed(1).padStart(7)

// ── before: what every mount ran ──
const before = {
  allTracks: (artist: string) => { const c = canonicalArtist(artist); return tracks.filter((t) => isSameArtist(t.artist || '', c) || (t.contributingArtists || []).some((x) => isSameArtist(x || '', c))) },
  personas: (artist: string) => {
    const c = canonicalArtist(artist); let n = 0
    for (const t of tracks) {
      const directMatch = isSameArtist(t.artist || '', c)
      const collabMatch = (t.contributingArtists || []).find((x) => isSameArtist(x || '', c))
      if (!directMatch && !collabMatch) continue
      n++
    }
    return n
  },
  ownedKeys: () => { const s = new Set<string>(); for (const t of tracks) { const a = (t.artist || '').trim(); if (a) s.add(artistIdentityKey(canonicalArtist(a))) } return s },
  albumFacts: () => collectAlbumFacts(tracks, foldName),
  trackById: () => { const m = new Map<number, Track>(); for (const t of tracks) m.set(t.id, t); return m },
  backLabel: (key: string) => tracks.find((tk) => albumKeyFromStrings(tk.albumArtist || tk.artist, tk.album) === key)?.album || null,
}

// ── after: the same answers from the index ──
const after = {
  allTracks: (artist: string) => tracksOfArtist(tracks, canonicalArtist(artist)),
  personas: (artist: string) => { const c = canonicalArtist(artist); let n = 0; for (const t of tracksOfArtist(tracks, c)) { if (isSameArtist(t.artist || '', c) || (t.contributingArtists || []).find((x) => isSameArtist(x || '', c))) n++ } return n },
  ownedKeys: () => artistLibraryIndex(tracks).ownedArtistKeys,
  albumFacts: () => libraryAlbumFacts(tracks, foldName),
  trackById: () => artistLibraryIndex(tracks).trackById,
  backLabel: (key: string) => albumTitleForKey(tracks, key),
}

// Artists: the ten with the most tracks, and ten from the long tail.
const counts = new Map<string, number>()
for (const t of tracks) { const a = canonicalArtist(t.artist || ''); if (a) counts.set(a, (counts.get(a) ?? 0) + 1) }
const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([a]) => a)
const artists = [...ranked.slice(0, 10), ...ranked.filter((_, i) => i > 10 && i % Math.max(1, Math.floor(ranked.length / 10)) === 0).slice(0, 10)]
const lastAlbum = tracks[tracks.length - 1]
const backKey = albumKeyFromStrings(lastAlbum.albumArtist || lastAlbum.artist, lastAlbum.album)

const passes = ['allTracks', 'personas', 'ownedKeys', 'albumFacts', 'trackById', 'backLabel'] as const
const run = (impl: typeof before | typeof after, artist: string): Record<string, number> => ({
  allTracks: time(() => impl.allTracks(artist)),
  personas: time(() => impl.personas(artist)),
  ownedKeys: time(() => impl.ownedKeys()),
  albumFacts: time(() => impl.albumFacts()),
  trackById: time(() => impl.trackById()),
  backLabel: time(() => impl.backLabel(backKey)),
})

// Sanity: the two give the same answers.
for (const a of artists) {
  const x = before.allTracks(a).map((t) => t.id), y = after.allTracks(a).map((t) => t.id)
  if (x.length !== y.length || x.some((id, i) => id !== y[i])) throw new Error(`mismatch for ${a}`)
}

console.log(`library: ${tracks.length} tracks, ${counts.size} artists (${file})`)
for (let i = 0; i < 3; i++) for (const a of artists) run(before, a)          // warm the JIT for the old walks
const b = artists.map((a) => run(before, a))
// The index: its one build (in the app this runs in idle time, off the click), then lookups.
const buildMs = time(() => { artistLibraryIndex([...tracks]); })              // a fresh array = a cold build, JIT warm from above
const coldArr = [...tracks]
const cold = time(() => { artistLibraryIndex(coldArr); libraryAlbumFacts(coldArr, foldName); albumTitleForKey(coldArr, backKey) })
artistLibraryIndex(tracks); libraryAlbumFacts(tracks, foldName); albumTitleForKey(tracks, backKey)
const a = artists.map((x) => run(after, x))

console.log('\nper page open, median over 20 artists (ms)        before    after')
let tb = 0, ta = 0
for (const p of passes) {
  const mb = median(b.map((r) => r[p])), ma = median(a.map((r) => r[p]))
  tb += mb; ta += ma
  console.log(`  ${p.padEnd(44)} ${f1(mb)}  ${f1(ma)}`)
}
console.log(`  ${'TOTAL before first paint'.padEnd(44)} ${f1(tb)}  ${f1(ta)}`)
const totals = (rows: Array<Record<string, number>>): number[] => rows.map((r) => passes.reduce((s, p) => s + r[p], 0))
console.log(`  ${'worst artist'.padEnd(44)} ${f1(Math.max(...totals(b)))}  ${f1(Math.max(...totals(a)))}`)
console.log(`\nindex build, once per library change, in idle time: ${buildMs.toFixed(1)} ms (artists) / ${cold.toFixed(1)} ms (artists + album facts + album titles)`)
