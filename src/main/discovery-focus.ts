/**
 * The Record Shop's view of Jake's taste profile (2026-10-10, Rocksurgence
 * step 1). One object, loaded once per feed generation, that the generator in
 * index.ts asks four questions:
 *   - dropExceptions(anchors): his all-time anchors minus exception artists
 *   - anchors(day): focus-playlist artists (Rocksurgence) that also seed digging
 *   - exemplars(tracks): what the brain may learn "taste" from (no exceptions)
 *   - blocks(card): the genre gate (math rock out, unless it's Angine)
 * prefetchTags(cards) fills the MusicBrainz tag cache the gate reads.
 * With no taste-profile.json every answer is a no-op — discovery as before.
 *
 * Rock DNA (2026-10-11, step 2) adds two things, both from rock-dna.json:
 *   - dnaLine: his quiz profile in words, appended to the picking prompts
 *     (soft context — the owned/Not-for-me filters stay hard and win)
 *   - blocks(card) also keeps out artists he marked Dislike — unless they
 *     are on a focus playlist (what he put on Rocksurgence beats the quiz)
 * Respect never blocks and never steers. No quiz answers = no-op.
 */
import { join } from 'path'
import { readFile } from 'fs/promises'
import { loadTasteProfile, dropExceptionAnchors, exemplarPool, focusAnchors, genreBlocked, normName, type TasteProfile } from './taste-profile.ts'
import { normalizeDnaState, buildProfile, dnaPromptLine, dislikedArtists, type DnaState } from '../common/rock-dna.ts'
import { loadTagCache, saveTagCache, ensureArtistTags, cachedTags, musicBrainzTags } from './artist-tags.ts'

export const TASTE_PROFILE_FILE = 'taste-profile.json'
export const ARTIST_TAGS_FILE = 'artist-tags.json'
export const ROCK_DNA_FILE = 'rock-dna.json'

/** Missing or unreadable = an empty quiz: discovery behaves exactly as before. */
export async function loadRockDna(dir: string): Promise<DnaState> {
  try { return normalizeDnaState(JSON.parse(await readFile(join(dir, ROCK_DNA_FILE), 'utf8'))) } catch { return normalizeDnaState(null) }
}
/** Only the artist's most-voted tags count — one stray "math rock" vote
 *  among eight tags must not shut a band out. */
const GATE_TAGS = 4

export interface DiscoveryFocus {
  profile: TasteProfile
  dropExceptions<T extends { artist: string }>(anchors: T[]): T[]
  anchors(dayNumber: number): string[]
  exemplars<T extends { artist?: string; albumArtist?: string }>(tracks: T[]): T[]
  prefetchTags(cards: Array<{ artist: string }>): Promise<void>
  blocks(card: { artist: string; genre?: string }): boolean
  /** Rock DNA in words for the picking prompts ('' before the quiz). */
  dnaLine: string
}

export async function loadDiscoveryFocus(
  stateDir: string,
  tracks: Array<{ id?: number; artist?: string; albumArtist?: string; playCount?: number }>,
  opts: {
    /** The app's MusicBrainz identity and shared throttle (index.ts mbThrottle). */
    userAgent?: string
    throttle?: () => Promise<void>
    /** Tests inject this instead. */
    fetchTags?: (artist: string) => Promise<string[] | null>
    now?: number
  },
): Promise<DiscoveryFocus> {
  const now = opts.now ?? Date.now()
  const fetchTags = opts.fetchTags ?? (async (a: string) => { await opts.throttle?.(); return musicBrainzTags(a, opts.userAgent ?? 'JakeTunes') })
  const profile = await loadTasteProfile(join(stateDir, TASTE_PROFILE_FILE))
  let playlists: Array<{ id?: string; name?: string; trackIds?: unknown[] }> = []
  if (profile.focusPlaylists.length) {
    try {
      const raw = JSON.parse(await readFile(join(stateDir, 'playlists.json'), 'utf8')) as unknown
      playlists = Array.isArray(raw) ? raw : ((raw as { playlists?: typeof playlists })?.playlists ?? [])
    } catch { /* no playlists file — no focus anchors */ }
  }
  const dna = await loadRockDna(stateDir)
  const dnaLine = dnaPromptLine(buildProfile(dna, profile.exceptions))
  const disliked = new Set(dislikedArtists(dna).map(normName))
  const byId = new Map(tracks.filter((t) => typeof t.id === 'number').map((t) => [t.id as number, t]))
  const wanted = new Set(profile.focusPlaylists.map(normName))
  const onFocus = new Set(playlists.filter((pl) => wanted.has(normName(pl.id)) || wanted.has(normName(pl.name)))
    .flatMap((pl) => (pl.trackIds ?? []).map((id) => { const t = byId.get(Number(id)); return normName(t?.albumArtist || t?.artist) })).filter(Boolean))
  const dislikedOut = (artist: string): boolean => { const k = normName(artist); return disliked.has(k) && !onFocus.has(k) }
  const tagFile = join(stateDir, ARTIST_TAGS_FILE)
  const cache = profile.lowGenres.length ? await loadTagCache(tagFile) : {}
  return {
    profile,
    dropExceptions: (anchors) => dropExceptionAnchors(anchors, profile),
    anchors: (dayNumber) => focusAnchors(profile, playlists, tracks, dayNumber),
    exemplars: (ts) => exemplarPool(ts, profile),
    prefetchTags: async (cards) => {
      if (!profile.lowGenres.length) return
      const looked = await ensureArtistTags(cards.map((c) => c.artist), cache, { fetchTags, now, sleepMs: opts.throttle || opts.fetchTags ? 0 : 1100 })
      if (looked > 0) await saveTagCache(tagFile, cache).catch(() => { /* cache is a convenience */ })
    },
    blocks: (card) => dislikedOut(card.artist) || genreBlocked(profile, card.artist, [card.genre, ...(cachedTags(cache, card.artist, now) ?? []).slice(0, GATE_TAGS)]),
    dnaLine,
  }
}
