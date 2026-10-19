/**
 * Launch page "G" — the document the desktop Home draws (2026-10-18).
 *
 *   GET {MOBILE_BACKEND_URL}/api/home-spotlight   (ETag; If-None-Match → 304)
 *   → { version: 1, generatedAt,
 *       livingIn:  { artist, album, artworkHash, plays, windowDays } | null,
 *       spotlight: { artist, plays30, topSong, firstHeard, days[30], headline, statsLine } | null,
 *       musicMan:  { line, generatedAt, source: 'ai' | 'fallback' } | null,
 *       nowDigging: [{ artist, plays30, days[30], firstHeard, topSong, debutYear, debutSource }] }
 *
 * homemini computes it from the MERGED history (desktop + phone) with the
 * shared rulebook (./home-spotlight.ts). When homemini can't be reached and
 * nothing is cached, the desktop builds the same document from its own play
 * history with the same rulebook (localSpotlightDoc) — musicMan is null then:
 * the Music Man's line is only ever his, never made up here.
 *
 * Contract as the backend ships it (JakeTunesMobile backend/src/util/
 * homeSpotlightDoc.ts + routes/homeSpotlightLive.ts): topSong is an object
 * { title, plays } | null; livingIn.artworkHash is the /api/albums cover hash
 * (md5 of "artist|||album" — the desktop's own artwork file names); the ETag
 * ignores generatedAt, so an unchanged document is a 304.
 *
 * parseHomeSpotlight is strict about meaning — an unknown version, a missing
 * artist or album, or a non-number count is dropped, never guessed — and
 * tolerant of one old shape (a bare-string topSong reads as { title, plays: null }).
 *
 * Pure and import-light (the rulebook only) — main, preload and renderer share it.
 */
import {
  livingInAlbum, artistFacts, nowDigging, headlineFor, statsLine,
  type SpotTrack, type SpotPlay, type DiggingEntry,
} from './home-spotlight.ts'

export interface LivingIn {
  artist: string
  album: string
  /** homemini's cover hash for the album, when it sent one. The desktop's own
   *  artwork map is asked first; this is the fallback. */
  artworkHash: string | null
  plays: number
  windowDays: 14 | 30
}

export interface TopSong {
  title: string
  /** null only when an old reply sent the title alone */
  plays: number | null
}

export interface Spotlight {
  artist: string
  plays30: number
  topSong: TopSong | null
  /** ISO, or null when unknown */
  firstHeard: string | null
  /** 30 daily play counts, oldest → newest ([] when not sent) */
  days: number[]
  headline: string
  statsLine: string
}

export interface MusicManLine {
  line: string
  generatedAt: string | null
  source: 'ai' | 'fallback'
}

export interface DiggingCard {
  artist: string
  plays30: number
  days: number[]
  firstHeard: string | null
  topSong: TopSong | null
  debutYear: number | null
  debutSource: 'musicbrainz' | 'library' | 'unknown'
}

export interface HomeSpotlightDoc {
  version: 1
  generatedAt: string | null
  livingIn: LivingIn | null
  spotlight: Spotlight | null
  musicMan: MusicManLine | null
  nowDigging: DiggingCard[]
}

/** Where the drawn document came from. */
export type SpotlightSource = 'homemini' | 'cache' | 'local' | 'none'

/** What main hands the renderer. */
export interface HomeSpotlightState {
  doc: HomeSpotlightDoc | null
  source: SpotlightSource
  /** Last network verdict this session: true = answered, false = didn't, null = not tried. */
  reachable: boolean | null
  /** ms epoch homemini last confirmed the drawn document (200 or 304); null for local/none. */
  fetchedAt: number | null
}

export const NOW_DIGGING_MAX = 5

// ── tolerant field readers ─────────────────────────────────────────────
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)
const isoOrNull = (v: unknown): string | null => {
  const s = text(v)
  return s && Number.isFinite(Date.parse(s)) ? s : null
}
/** Exactly 30 non-negative counts, or [] — a graph is drawn from real days or not at all. */
const days30 = (v: unknown): number[] => {
  if (!Array.isArray(v) || v.length !== 30) return []
  const out = v.map(count)
  return out.every((n): n is number => n !== null) ? out as number[] : []
}
/** topSong is { title: "Taxes", plays: 7 } (an old reply: "Taxes"). */
function song(v: unknown): TopSong | null {
  const s = text(v)
  if (s) return { title: s, plays: null }
  const o = obj(v)
  const t = o ? text(o.title) : null
  return t ? { title: t, plays: count(o!.plays) } : null
}

function parseLivingIn(v: unknown): LivingIn | null {
  const o = obj(v)
  if (!o) return null
  const artist = text(o.artist)
  const album = text(o.album)
  const plays = count(o.plays)
  if (!artist || !album || plays === null) return null
  return { artist, album, artworkHash: text(o.artworkHash), plays, windowDays: o.windowDays === 14 ? 14 : 30 }
}

function parseSpotlight(v: unknown): Spotlight | null {
  const o = obj(v)
  if (!o) return null
  const artist = text(o.artist)
  const plays30 = count(o.plays30)
  if (!artist || plays30 === null) return null
  const top = song(o.topSong)
  const firstHeard = isoOrNull(o.firstHeard)
  const days = days30(o.days)
  // headline / statsLine are deterministic copy from these facts (the
  // rulebook's own functions) — rebuilt the same way if a field is missing.
  const headline = text(o.headline) ?? headlineFor(artist, plays30)
  const stats = text(o.statsLine) ?? statsLine({
    artist,
    plays30,
    topSong: top && top.plays !== null ? { title: top.title, plays: top.plays } : null,
    firstHeardTs: firstHeard ? Date.parse(firstHeard) : null,
    days,
  })
  return { artist, plays30, topSong: top, firstHeard, days, headline, statsLine: stats }
}

function parseMusicMan(v: unknown): MusicManLine | null {
  const o = obj(v)
  const line = o ? text(o.line) : null
  if (!line) return null
  return { line, generatedAt: isoOrNull(o!.generatedAt), source: o!.source === 'ai' ? 'ai' : 'fallback' }
}

function parseDigging(v: unknown): DiggingCard | null {
  const o = obj(v)
  if (!o) return null
  const artist = text(o.artist)
  const plays30 = count(o.plays30)
  if (!artist || plays30 === null) return null
  const debut = count(o.debutYear)
  const src = o.debutSource
  return {
    artist,
    plays30,
    days: days30(o.days),
    firstHeard: isoOrNull(o.firstHeard),
    topSong: song(o.topSong),
    debutYear: debut && debut >= 1900 ? debut : null,
    debutSource: src === 'musicbrainz' || src === 'library' ? src : 'unknown',
  }
}

/** The backend's reply → the document, or null when it isn't one (wrong
 *  version, not an object). Bad sub-sections drop to null / [] on their own. */
export function parseHomeSpotlight(raw: unknown): HomeSpotlightDoc | null {
  const o = obj(raw)
  if (!o || o.version !== 1) return null
  const digging = Array.isArray(o.nowDigging) ? o.nowDigging.map(parseDigging).filter((d): d is DiggingCard => d !== null) : []
  return {
    version: 1,
    generatedAt: isoOrNull(o.generatedAt),
    livingIn: parseLivingIn(o.livingIn),
    spotlight: parseSpotlight(o.spotlight),
    musicMan: parseMusicMan(o.musicMan),
    nowDigging: digging.slice(0, NOW_DIGGING_MAX),
  }
}

/** Nothing to draw: no album you're living in and nobody new. */
export function isEmptySpotlight(doc: HomeSpotlightDoc | null): boolean {
  return !doc || (!doc.livingIn && doc.nowDigging.length === 0)
}

const toIso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString())

function diggingCard(e: DiggingEntry): DiggingCard {
  return {
    artist: e.artist,
    plays30: e.plays30,
    days: e.days,
    firstHeard: toIso(e.firstHeardTs),
    topSong: e.topSong,
    debutYear: e.debutYear,
    debutSource: e.debutSource,
  }
}

/**
 * The offline fallback: the same document from THIS Mac's own play history
 * (play-events.jsonl {id, ts} + library.json tracks), the same rulebook.
 * No MusicBrainz here, so Now Digging's legacy test uses the library's
 * earliest album year (the rulebook's own fallback). musicMan is null —
 * his line is generated on homemini or not at all.
 */
export function localSpotlightDoc(tracks: readonly SpotTrack[], plays: readonly SpotPlay[], now: number): HomeSpotlightDoc {
  const living = livingInAlbum(tracks, plays, now)
  let spotlight: Spotlight | null = null
  if (living) {
    const f = artistFacts(tracks, plays, now, living.artist)
    spotlight = {
      artist: f.artist,
      plays30: f.plays30,
      topSong: f.topSong,
      firstHeard: toIso(f.firstHeardTs),
      days: f.days,
      headline: headlineFor(f.artist, f.plays30),
      statsLine: statsLine(f),
    }
  }
  return {
    version: 1,
    generatedAt: toIso(now),
    livingIn: living ? { artist: living.artist, album: living.album, artworkHash: null, plays: living.plays, windowDays: living.windowDays } : null,
    spotlight,
    musicMan: null,
    nowDigging: nowDigging(tracks, plays, now).map(diggingCard),
  }
}

/** play-events.jsonl text → plays. Torn or foreign lines are skipped. */
export function parsePlayEvents(text: string): SpotPlay[] {
  const out: SpotPlay[] = []
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as { id?: unknown; ts?: unknown }
      if ((typeof e.id === 'number' || typeof e.id === 'string') && typeof e.ts === 'number' && Number.isFinite(e.ts)) out.push({ id: e.id, ts: e.ts })
    } catch { /* torn last line of an append-only log — skipped by design */ }
  }
  return out
}

/** library.json tracks (unknown[]) → the rulebook's track shape. */
export function spotTracksOf(raw: readonly unknown[]): SpotTrack[] {
  const out: SpotTrack[] = []
  for (const r of raw) {
    const t = obj(r)
    if (!t || (typeof t.id !== 'number' && typeof t.id !== 'string')) continue
    out.push({
      id: t.id as number | string,
      title: typeof t.title === 'string' ? t.title : undefined,
      artist: typeof t.artist === 'string' ? t.artist : undefined,
      albumArtist: typeof t.albumArtist === 'string' ? t.albumArtist : undefined,
      album: typeof t.album === 'string' ? t.album : undefined,
      dateAdded: typeof t.dateAdded === 'string' ? t.dateAdded : undefined,
      year: typeof t.year === 'number' || typeof t.year === 'string' ? t.year : undefined,
    })
  }
  return out
}
