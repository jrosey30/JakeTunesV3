// blurb-generator.ts — the line that hits (Brief 037 §3.2, Phase 1e)
//
// A blurb is what Music Man SAYS when the customer picks a record off
// the wall. It is NOT an album writeup. The whole feature lives or dies
// on §3.2: the blurb speaks to the user's RELATIONSHIP with this exact
// record —
//
//   "You played this 4 times in February then nothing. The back half
//    lands different now that you've been on the Kraut kick."
//
// not
//
//   "A landmark 1973 krautrock album."
//
// So the work here is mostly in buildItemRelationship(): mine the
// library + play log for how THIS user actually listens to THIS record
// (recent vs total plays, how cold it's gone, which tracks they skip,
// whether they own the whole thing, when in the day they reach for it),
// then hand that to a cheap Haiku call wearing the shop-clerk wrapper.
//
// Cached forever per (itemId, persona) by the caller (RecordStoreCache).
// SDK-decoupled like shelf-generator: the caller injects a RecordStoreLlm
// adapter over claudeCall (§3.6). LLM down → no blurb (null), never an
// error and never a fabricated one (§8).

import type { Blurb, Persona, ShelfItem } from './types'
import type { CandTrack } from './candidate-pool'
import type { PlayEvent, RecordStoreLlm } from './shelf-generator'
import { partOfDay } from './external-context'

const THIRTY_DAYS_MS = 30 * 86_400_000
const SEVEN_DAYS_MS = 7 * 86_400_000
const BLURB_MODEL = 'claude-haiku-4-5'
const BLURB_MAX_TOKENS = 160
/** Need at least this many logged plays before claiming a time-of-day
 *  habit — two plays is noise, not a pattern. */
const DAYPART_MIN_PLAYS = 3

type Daypart = 'morning' | 'afternoon' | 'evening' | 'late-night'

export interface ItemRelationship {
  title: string
  artist: string
  genre?: string
  year?: number | string
  /** Lifetime plays summed across the owned tracks of this album. */
  totalPlays: number
  /** Plays in the last 30 / 7 days from the event log. */
  plays30d: number
  plays7d: number
  /** Most recent play across the album, epoch ms; null if never. */
  lastPlayedAt: number | null
  daysSinceLastPlay: number | null
  /** Skips summed across the album's tracks. */
  skipCount: number
  /** Tracks the user reliably skips (skipCount ≥ playCount, both > 0). */
  heavySkipTracks: string[]
  ownedTrackCount: number
  /** Album's full track count from metadata; null if not known. */
  albumTrackCount: number | null
  ownsFullAlbum: boolean
  /** When in the day they reach for this record; null if too few plays. */
  dominantDaypart: Daypart | null
  /** Playlists this record sits in. Injected by the caller (the engine
   *  doesn't own playlist data); [] until that wiring lands. */
  playlists: string[]
}

export interface GenerateBlurbInput {
  item: ShelfItem
  /** Shelf the customer is browsing — "Deep Cuts" etc. Sets the scene. */
  shelfTitle: string
  persona: Persona
  relationship: ItemRelationship
  /** MUSIC_MAN_CORE (or the persona's core), injected by index.ts. */
  personaCore: string
  /** Injected LLM adapter; omit / let it throw → null (no blurb, §8). */
  llm?: RecordStoreLlm
}

// ── Relationship mining (pure; no I/O) ───────────────────────────────

function artistOf(t: CandTrack): string {
  return (t.albumArtist && t.albumArtist.trim()) || (t.artist || '').trim()
}

/** Mine how the user listens to one album item. Pure: the caller reads
 *  library.json + play-events.jsonl and passes parsed data in. */
export function buildItemRelationship(
  item: ShelfItem,
  tracksById: Map<number, CandTrack>,
  events: PlayEvent[],
  nowMs: number,
  playlists: string[] = [],
): ItemRelationship {
  const trackIds = (item.payload.trackIds ?? []).map((s) => Number(s)).filter((n) => Number.isFinite(n))
  const idSet = new Set(trackIds)
  const albumTracks = trackIds.map((id) => tracksById.get(id)).filter((t): t is CandTrack => !!t)

  let totalPlays = 0
  let skipCount = 0
  let lastPlayedAt = 0
  let albumTrackCount = 0
  let genre: string | undefined
  let year: number | string | undefined
  const heavySkipTracks: string[] = []
  for (const t of albumTracks) {
    totalPlays += Number(t.playCount) || 0
    const skips = Number(t.skipCount) || 0
    const plays = Number(t.playCount) || 0
    skipCount += skips
    if (typeof t.lastPlayedAt === 'number' && t.lastPlayedAt > lastPlayedAt) lastPlayedAt = t.lastPlayedAt
    const tc = Number((t as { trackCount?: number }).trackCount) || 0
    if (tc > albumTrackCount) albumTrackCount = tc
    if (!genre && t.genre) genre = t.genre
    if (year === undefined && t.year !== undefined) year = t.year
    if (skips > 0 && skips >= plays && t.title && heavySkipTracks.length < 3) {
      heavySkipTracks.push(t.title)
    }
  }

  // Windowed plays + time-of-day from the event log.
  let plays30d = 0
  let plays7d = 0
  const cutoff30 = nowMs - THIRTY_DAYS_MS
  const cutoff7 = nowMs - SEVEN_DAYS_MS
  const daypartCounts: Record<Daypart, number> = { morning: 0, afternoon: 0, evening: 0, 'late-night': 0 }
  let daypartTotal = 0
  for (const evt of events) {
    if (!idSet.has(evt.id)) continue
    if (evt.ts >= cutoff30) plays30d++
    if (evt.ts >= cutoff7) plays7d++
    daypartCounts[partOfDay(new Date(evt.ts).getHours())]++
    daypartTotal++
  }

  let dominantDaypart: Daypart | null = null
  if (daypartTotal >= DAYPART_MIN_PLAYS) {
    dominantDaypart = (Object.entries(daypartCounts) as Array<[Daypart, number]>)
      .sort((a, b) => b[1] - a[1])[0][0]
  }

  const daysSinceLastPlay = lastPlayedAt > 0 ? Math.round((nowMs - lastPlayedAt) / 86_400_000) : null

  return {
    title: item.title,
    artist: item.subtitle,
    genre,
    year,
    totalPlays,
    plays30d,
    plays7d,
    lastPlayedAt: lastPlayedAt || null,
    daysSinceLastPlay,
    skipCount,
    heavySkipTracks,
    ownedTrackCount: albumTracks.length,
    albumTrackCount: albumTrackCount || null,
    ownsFullAlbum: albumTrackCount > 0 ? albumTracks.length >= albumTrackCount : albumTracks.length > 1,
    dominantDaypart,
    playlists,
  }
}

// ── Prompt assembly ──────────────────────────────────────────────────

export function formatRelationshipForPrompt(r: ItemRelationship): string {
  const lines: string[] = []
  if (r.year || r.genre) {
    lines.push(`- It's ${[r.year, r.genre].filter(Boolean).join(' ')}.`)
  }
  // Play history — the heart of §3.2.
  if (r.totalPlays === 0) {
    lines.push('- They own it but have NEVER played it. A blind spot, or a record they bought on faith.')
  } else {
    const recency =
      r.daysSinceLastPlay === null ? ''
      : r.daysSinceLastPlay <= 7 ? ' last played this week'
      : r.daysSinceLastPlay <= 30 ? ` last played ${r.daysSinceLastPlay} days ago`
      : ` last played ${r.daysSinceLastPlay} days ago — gone cold`
    lines.push(`- ${r.totalPlays} lifetime plays${recency}.`)
    if (r.plays30d > 0) lines.push(`- ${r.plays30d} plays in the last 30 days (${r.plays7d} this week).`)
    else if (r.daysSinceLastPlay !== null && r.daysSinceLastPlay > 30) {
      lines.push('- Nothing in the last 30 days.')
    }
  }
  if (r.dominantDaypart) lines.push(`- They reach for it mostly in the ${r.dominantDaypart.replace('-', ' ')}.`)
  if (r.heavySkipTracks.length) {
    lines.push(`- They reliably SKIP: ${r.heavySkipTracks.join(', ')}.`)
  }
  if (r.albumTrackCount && !r.ownsFullAlbum) {
    lines.push(`- They only own ${r.ownedTrackCount} of ${r.albumTrackCount} tracks — selected cuts, not the full album.`)
  }
  if (r.playlists.length) lines.push(`- It's on their playlist(s): ${r.playlists.join(', ')}.`)
  return lines.join('\n')
}

function buildBlurbUserMessage(input: GenerateBlurbInput): string {
  const r = input.relationship
  return [
    `You're behind the counter of WJLR Records on Atlantic Ave. A regular just pulled ${r.artist} — ${r.title} off the ${input.shelfTitle} shelf.`,
    '',
    'Say something about THEIR relationship with this exact record — the notes below are how they actually listen to it. 1-3 sentences, your voice. No plot summary, no track-by-track recap — they own it. React to the listening pattern; do NOT just restate the numbers. If a fact isn\'t given, talk about the sound or your take — never invent one.',
    '',
    `How they listen to ${r.artist} — ${r.title}:`,
    formatRelationshipForPrompt(r),
  ].join('\n')
}

// ── Public entry point ───────────────────────────────────────────────

/** Generate Music Man's spoken take on one record, grounded in the
 *  user's relationship with it. Returns null (no blurb) when the LLM is
 *  unavailable or fails — never an error, never a fabricated take (§8).
 *  The caller owns the forever-cache (RecordStoreCache.putBlurb). */
export async function generateBlurb(input: GenerateBlurbInput): Promise<Blurb | null> {
  if (!input.llm) return null
  try {
    const text = (await input.llm({
      callKey: 'record-store:blurb',
      model: BLURB_MODEL,
      maxTokens: BLURB_MAX_TOKENS,
      system: input.personaCore,
      user: buildBlurbUserMessage(input),
    })).trim()
    if (!text) return null
    return {
      itemId: input.item.id,
      persona: input.persona,
      text,
      generatedAt: Date.now(),
      source: 'llm',
    }
  } catch (err) {
    console.warn('[record-store/blurb-generator] blurb LLM failed; no blurb:', err)
    return null
  }
}
