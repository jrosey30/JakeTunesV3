/**
 * The launch page's spotlight (Jake, 2026-10-18 — launch page "G": art-soaked
 * Apple Music Now Playing + classic iTunes + Letterboxd). One rulebook for
 * desktop and phone:
 *
 *  - livingInAlbum: the album you're living in — most plays in the last 14
 *    days (≥ 5), else the last 30 days (≥ 5), ties → the most recent play.
 *    Its cover becomes the blurred page backdrop.
 *  - artistSpotlight: that album's artist — plays in 30 days, top song in
 *    30 days, and when they first came into your life (first play or first
 *    add, whichever is earlier).
 *  - nowDigging: up to 5 NEW, NOT-LEGACY artists you're playing — first heard
 *    within 180 days, ≥ 3 plays in 30 days, and a debut year within the last
 *    10 years (MusicBrainz-grounded debut year injected by the caller; the
 *    library's earliest album year is only a fallback). Ranked by 30-day
 *    plays. Each carries 30 daily play counts (oldest → newest) for its graph.
 *  - headline / statsLine: deterministic copy from those facts only. The
 *    Music Man's line is generated elsewhere and must use only these facts.
 *
 * Plays are the MERGED history (desktop + phone). Pure and import-free.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/homeSpotlight.ts — keep the
 * rules, thresholds and copy byte-for-byte in step (the phone backend is a
 * leaf-module test runner; this file must stay import-free).
 */

export interface SpotTrack {
  id: number | string
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  dateAdded?: string
  year?: number | string
}

export interface SpotPlay {
  id: number | string
  /** ms since epoch */
  ts: number
}

export const DAY_MS = 86_400_000
const VARIOUS = /^various( artists)?$/i
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function primaryArtist(t: SpotTrack): string {
  return String(t.albumArtist || t.artist || '').trim()
}

function index(tracks: readonly SpotTrack[]): Map<string, SpotTrack> {
  const m = new Map<string, SpotTrack>()
  for (const t of tracks) m.set(String(t.id), t)
  return m
}

export interface AlbumSpotlight {
  artist: string
  album: string
  plays: number
  windowDays: 14 | 30
  lastPlayTs: number
}

export function livingInAlbum(tracks: readonly SpotTrack[], plays: readonly SpotPlay[], now: number): AlbumSpotlight | null {
  const byId = index(tracks)
  for (const windowDays of [14, 30] as const) {
    const since = now - windowDays * DAY_MS
    const tally = new Map<string, AlbumSpotlight>()
    for (const p of plays) {
      if (p.ts < since || p.ts > now) continue
      const t = byId.get(String(p.id))
      if (!t || !t.album) continue
      const artist = primaryArtist(t)
      if (!artist || VARIOUS.test(artist)) continue
      const key = artist.toLowerCase() + '\u0000' + String(t.album).toLowerCase()
      const cur = tally.get(key) || { artist, album: String(t.album), plays: 0, windowDays, lastPlayTs: 0 }
      cur.plays += 1
      cur.lastPlayTs = Math.max(cur.lastPlayTs, p.ts)
      tally.set(key, cur)
    }
    const best = [...tally.values()].sort((a, b) => b.plays - a.plays || b.lastPlayTs - a.lastPlayTs)[0]
    if (best && best.plays >= 5) return best
  }
  return null
}

export interface ArtistFacts {
  artist: string
  plays30: number
  topSong: { title: string; plays: number } | null
  /** ms since epoch, or null when unknown */
  firstHeardTs: number | null
  /** 30 daily play counts, oldest → newest */
  days: number[]
}

function dateAddedMs(t: SpotTrack): number | null {
  if (!t.dateAdded) return null
  const ms = Date.parse(t.dateAdded)
  return Number.isFinite(ms) ? ms : null
}

export function artistFacts(tracks: readonly SpotTrack[], plays: readonly SpotPlay[], now: number, artist: string): ArtistFacts {
  const byId = index(tracks)
  const want = artist.trim().toLowerCase()
  const since = now - 30 * DAY_MS
  const days = new Array<number>(30).fill(0)
  const songs = new Map<string, number>()
  let plays30 = 0
  let firstHeardTs: number | null = null
  for (const t of tracks) {
    if (primaryArtist(t).toLowerCase() !== want) continue
    const added = dateAddedMs(t)
    if (added != null && (firstHeardTs == null || added < firstHeardTs)) firstHeardTs = added
  }
  for (const p of plays) {
    const t = byId.get(String(p.id))
    if (!t || primaryArtist(t).toLowerCase() !== want) continue
    if (firstHeardTs == null || p.ts < firstHeardTs) firstHeardTs = p.ts
    if (p.ts < since || p.ts > now) continue
    plays30 += 1
    const ago = Math.floor((now - p.ts) / DAY_MS)
    if (ago >= 0 && ago < 30) days[29 - ago]! += 1
    const title = String(t.title || '').trim()
    if (title) songs.set(title, (songs.get(title) || 0) + 1)
  }
  const top = [...songs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return { artist: artist.trim(), plays30, topSong: top ? { title: top[0], plays: top[1] } : null, firstHeardTs, days }
}

export interface DiggingOptions {
  /** MusicBrainz-grounded debut year for an artist, if known. */
  debutYear?: (artist: string) => number | null | undefined
  maxNewDays?: number
  minPlays?: number
  legacyYears?: number
  limit?: number
}

export interface DiggingEntry extends ArtistFacts {
  debutYear: number | null
  /** where debutYear came from */
  debutSource: 'musicbrainz' | 'library' | 'unknown'
}

export function nowDigging(tracks: readonly SpotTrack[], plays: readonly SpotPlay[], now: number, opts: DiggingOptions = {}): DiggingEntry[] {
  const maxNewDays = opts.maxNewDays ?? 180
  const minPlays = opts.minPlays ?? 3
  const legacyYears = opts.legacyYears ?? 10
  const limit = opts.limit ?? 5
  const byId = index(tracks)
  const since = now - 30 * DAY_MS
  const recent = new Map<string, number>()
  for (const p of plays) {
    if (p.ts < since || p.ts > now) continue
    const t = byId.get(String(p.id))
    if (!t) continue
    const a = primaryArtist(t)
    if (!a || VARIOUS.test(a)) continue
    recent.set(a, (recent.get(a) || 0) + 1)
  }
  const thisYear = new Date(now).getUTCFullYear()
  const libraryYear = new Map<string, number>()
  for (const t of tracks) {
    const y = Number(t.year)
    if (!Number.isFinite(y) || y < 1900) continue
    const a = primaryArtist(t)
    libraryYear.set(a, Math.min(libraryYear.get(a) ?? 9999, y))
  }
  const out: DiggingEntry[] = []
  for (const [artist, n] of recent) {
    if (n < minPlays) continue
    const facts = artistFacts(tracks, plays, now, artist)
    if (facts.firstHeardTs == null || now - facts.firstHeardTs > maxNewDays * DAY_MS) continue
    const mb = opts.debutYear?.(artist)
    let debutYear: number | null = null
    let debutSource: DiggingEntry['debutSource'] = 'unknown'
    if (mb != null && Number.isFinite(mb)) { debutYear = mb; debutSource = 'musicbrainz' }
    else if (libraryYear.has(artist) && libraryYear.get(artist)! < 9999) { debutYear = libraryYear.get(artist)!; debutSource = 'library' }
    if (debutYear != null && debutYear < thisYear - legacyYears) continue
    out.push({ ...facts, debutYear, debutSource })
  }
  return out
    .sort((a, b) => b.plays30 - a.plays30 || (b.firstHeardTs ?? 0) - (a.firstHeardTs ?? 0))
    .slice(0, limit)
}

export function headlineFor(artist: string, plays30: number): string {
  if (plays30 >= 40) return `${artist} has your attention.`
  if (plays30 >= 15) return `You can't stop playing ${artist}.`
  return `Lately, it's ${artist}.`
}

export function shortDate(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export function statsLine(f: ArtistFacts): string {
  const parts = [`${f.plays30} ${f.plays30 === 1 ? 'play' : 'plays'} in 30 days`]
  if (f.topSong && f.topSong.plays >= 2) parts.push(`“${f.topSong.title}” on repeat`)
  if (f.firstHeardTs != null) parts.push(`with you since ${shortDate(f.firstHeardTs)}`)
  return parts.join(' · ')
}
