/**
 * The library, as described to the AI.
 *
 * Two different facts about Jake's collection, kept together because they
 * answer the same question — what do the personas know about it?
 *
 *  1. The DIGEST is structural, computed from library.json: what he OWNS.
 *     Eclectic or deep, era-spread or era-focused, indie-heavy or major.
 *     That is a different thing from the listener profile, which is what he
 *     has PLAYED. A record bought and never played still says something.
 *  2. The CONTEXT is whatever the renderer last pushed over IPC, a fuller
 *     description used by chat.
 *
 * The digest is cached because it is recomputed on every library save and read
 * on the hot path of every character call. Measured 2026-08-09 against the real
 * library: 9,324 tracks -> 5,608 characters in 5ms. (The original note here
 * said "bounded output ~1KB" — that was true when it was written and has not
 * been for a while. It is roughly 1.5k tokens of every prompt now, which is
 * affordable but worth knowing before adding another section to it.)
 *
 * Extracted from index.ts 2026-08-09, unchanged. State and the functions that
 * touch it moved together, so no caller can hold a stale binding.
 */

import { readFile } from 'fs/promises'

let libraryPath = ''

/** library.json's location, for the throttled refresh. Called once at startup. */
export function initLibraryDigest(deps: { libraryPath: string }): void {
  libraryPath = deps.libraryPath
}

// 4.5: structural library digest. Computed from the loaded library.json
// (what the user OWNS) rather than listener-profile (what they've
// PLAYED). Two different facts: ownership tells the characters the
// shape of the user's taste (eclectic vs deep, era-spread vs era-
// focused, indie-heavy vs major-label), and play behavior tells them
// what's loved vs unplayed. Inject BOTH into every character call so
// Music Man / Megan / Stephen know the whole collection, not just what
// the user's listened to recently.
//
// Cached at module level; recomputed at app start + after save-library.
// Cheap (~5-30ms on 6000 tracks), bounded output ~1KB.
let cachedLibraryDigest: string = ''

export interface DigestTrack {
  artist?: string
  album?: string
  genre?: string
  year?: number | string
  playCount?: number
  rating?: number
}

function computeLibraryDigest(tracks: DigestTrack[]): string {
  if (!Array.isArray(tracks) || tracks.length === 0) return ''
  const artistCounts = new Map<string, number>()
  const genreCounts = new Map<string, number>()
  const eraBuckets: Record<string, number> = { '<70': 0, '70s': 0, '80s': 0, '90s': 0, '00s': 0, '10s': 0, '20s': 0, 'unk': 0 }
  // For "signature albums": rank by (plays + rating-weight) so an
  // album the user plays a lot OR rates highly surfaces, regardless of
  // which signal alone they used. Dedup to one per artist so a fan-
  // favorite artist doesn't crowd 4 of their albums into the list.
  const albumScore = new Map<string, { artist: string; album: string; score: number; tracks: number }>()
  // 4.5.0-68 — per-artist album breakdown. Old digest told the AI
  // "Drake is in top 30 artists (58 tracks)" but didn't tell it WHICH
  // 5 Drake albums the user owns. So when the user asked "what Drake
  // do I own" the model had to guess from training knowledge. Now we
  // surface the actual album titles + track counts for the top 15
  // artists by track count — enough depth that the model can ground
  // answers in the real library shape.
  const albumsByArtist = new Map<string, Map<string, number>>()
  // 4.5.0-86 — per-decade artist breakdown. Old digest gave just bucket
  // counts ("80s: 1200, 90s: 900"); the AI couldn't answer "what era do
  // you lean toward" with grounded specifics — only with the gross
  // distribution. New: track which artists carry each era so the model
  // can say "the 80s lean is anchored on New Order, Talking Heads, and
  // The Cure; the 90s is heavier on hip-hop with Wu-Tang and Outkast."
  const artistsByEra = new Map<string, Map<string, number>>()
  const eraOf = (yr: number): string =>
    yr < 1970 ? '<70' :
    yr < 1980 ? '70s' :
    yr < 1990 ? '80s' :
    yr < 2000 ? '90s' :
    yr < 2010 ? '00s' :
    yr < 2020 ? '10s' : '20s'
  for (const t of tracks) {
    const artist = (t.artist || '').trim()
    if (artist) artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1)
    const genre = (t.genre || '').trim()
    if (genre) genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1)
    const yr = parseInt(`${t.year || ''}`)
    if (!yr || isNaN(yr)) eraBuckets['unk']++
    else {
      const era = eraOf(yr)
      eraBuckets[era]++
      if (artist) {
        let m = artistsByEra.get(era)
        if (!m) { m = new Map(); artistsByEra.set(era, m) }
        m.set(artist, (m.get(artist) || 0) + 1)
      }
    }

    const album = (t.album || '').trim()
    if (album && artist) {
      const key = `${artist}|||${album}`
      const plays = Number(t.playCount) || 0
      const rating = Number(t.rating) || 0
      const inc = plays + (rating > 0 ? rating * 2 : 0)
      const cur = albumScore.get(key)
      if (cur) {
        cur.score += inc
        cur.tracks++
      } else {
        albumScore.set(key, { artist, album, score: inc, tracks: 1 })
      }
      // Per-artist album track counts.
      let m = albumsByArtist.get(artist)
      if (!m) { m = new Map(); albumsByArtist.set(artist, m) }
      m.set(album, (m.get(album) || 0) + 1)
    }
  }

  const topArtistsList = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
  const topArtists = topArtistsList.map(([a, n]) => `${a} (${n})`)

  const topGenres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([g, n]) => `${g} (${n})`)

  const eras = Object.entries(eraBuckets)
    .filter(([, n]) => n > 0)
    .map(([e, n]) => `${e}: ${n}`)

  // Signature albums: top 15 by combined plays+rating score, dedup'd
  // to one per artist so one obsession doesn't fill the list.
  const seenArtist = new Set<string>()
  const sigAlbums: string[] = []
  for (const a of [...albumScore.values()].sort((x, y) => y.score - x.score)) {
    if (seenArtist.has(a.artist)) continue
    if (a.score < 1) continue  // ignore unplayed unrated noise
    seenArtist.add(a.artist)
    sigAlbums.push(`"${a.album}" by ${a.artist}`)
    if (sigAlbums.length >= 15) break
  }

  // Per-top-artist album lists for the top 15 artists. Format:
  // `Drake: "Take Care" (14), "Nothing Was The Same" (12), ...`
  // Each artist capped at 12 albums so a Beatles-tier completionist
  // doesn't blow the token budget alone. Truncated with "+N more" so
  // the model knows the list is partial.
  const artistDeepLines: string[] = []
  for (const [artist] of topArtistsList.slice(0, 15)) {
    const m = albumsByArtist.get(artist)
    if (!m) continue
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1])
    const shown = sorted.slice(0, 12).map(([al, n]) => `"${al}" (${n})`)
    const tail = sorted.length > 12 ? ` +${sorted.length - 12} more` : ''
    artistDeepLines.push(`    ${artist}: ${shown.join(', ')}${tail}`)
  }

  const lines: string[] = []
  lines.push(`LIBRARY DIGEST (the SHAPE of what the user owns — not behaviour, ownership):`)
  lines.push(`  Total tracks: ${tracks.length}`)
  if (topArtists.length) lines.push(`  Top ${topArtists.length} artists by track count: ${topArtists.join(', ')}`)
  if (topGenres.length) lines.push(`  Top genres by track count: ${topGenres.join(', ')}`)
  if (eras.length) lines.push(`  Era spread (year of release): ${eras.join(' · ')}`)
  // 4.5.0-86 — per-decade top artists. Only emit for eras with ≥40
  // tracks (anything thinner is noise — a single album doesn't tell
  // the model "you lean toward the 70s"). Top 5 artists per qualifying
  // era. Format: `  70s anchors: Steely Dan, Eagles, Fleetwood Mac...`
  const eraOrder = ['<70', '70s', '80s', '90s', '00s', '10s', '20s']
  const eraAnchors: string[] = []
  for (const era of eraOrder) {
    if ((eraBuckets[era] || 0) < 40) continue
    const m = artistsByEra.get(era)
    if (!m) continue
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a} (${n})`)
    if (top.length > 0) eraAnchors.push(`    ${era}: ${top.join(', ')}`)
  }
  if (eraAnchors.length > 0) {
    lines.push(`  Era anchors (top artists per decade with ≥40 tracks — use these to answer "what era do you lean toward" with grounded specifics):`)
    lines.push(...eraAnchors)
  }
  if (sigAlbums.length) lines.push(`  Signature albums (highest plays + ratings, deduped to one per artist): ${sigAlbums.join(', ')}`)
  if (artistDeepLines.length) {
    lines.push(`  Per-artist album breakdown for top 15 artists (use these EXACT titles when discussing what the user owns — DON'T invent or substitute):`)
    lines.push(...artistDeepLines)
  }
  lines.push(`  Use this to speak as someone who knows the WHOLE collection — when the user asks about a specific artist in this list, you have ground truth on which of their albums are actually here. Don't recite the list; pull from it.`)
  return lines.join('\n')
}

export function refreshLibraryDigest(tracks: DigestTrack[]): void {
  try {
    cachedLibraryDigest = computeLibraryDigest(tracks)
  } catch (err) {
    console.warn('[taste-digest] compute failed:', err)
    cachedLibraryDigest = ''
  }
}

export function getLibraryDigest(): string {
  return cachedLibraryDigest
}

// 4.5.0-68 — throttled out-of-band digest refresh. Called from
// save-metadata-override when a stat field changes so the digest
// reflects the user's actual current state for the next AI call,
// without thrashing on rapid star-everything sequences.
let digestRefreshTimer: NodeJS.Timeout | null = null
export function scheduleLibraryDigestRefresh(): void {
  if (digestRefreshTimer) return
  digestRefreshTimer = setTimeout(async () => {
    digestRefreshTimer = null
    try {
      const raw = await readFile(libraryPath, 'utf-8')
      const lib = JSON.parse(raw) as { tracks?: DigestTrack[] }
      refreshLibraryDigest(lib.tracks || [])
    } catch (err) {
      console.warn('[taste-digest] scheduled refresh failed:', err)
    }
  }, 1500)
}

// ── Library context ──
//
// Pushed from the renderer via the set-library-context IPC handler, which
// still lives in index.ts. Only the state lives here.

let libraryContext = ''

export function setLibraryContext(ctx: string): void {
  libraryContext = ctx
}

export function getLibraryContext(): string {
  return libraryContext
}
