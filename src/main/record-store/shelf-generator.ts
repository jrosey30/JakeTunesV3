// shelf-generator.ts — the brain (Brief 037 §3.1–§3.4, Phases 1c + 1d)
//
// Two pieces, building on each other:
//
// 1c — pickDayTheme(): pick ONE coherent musical thread for the day
//      before any record goes on the wall (§3.1). Standalone, still used
//      as the theme primitive + the heuristic fallback.
//
// 1d — generateShelves(): the headline call. Folds the day-theme pick
//      and the shelf population into ONE Sonnet call (§1d) so the theme
//      and the picks are chosen together. The model picks 5-7 items per
//      shelf FROM a balanced candidate pool (built by candidate-pool.ts
//      with the anti-repeat / diversity math, §3.4) — it never invents
//      items (§3.3 library-grounded). A validation pass drops anything
//      the model returns that isn't in the pool, enforces the per-day
//      artist cap across shelves, and tops shelves up from the pool if
//      they fall below the floor.
//
// Both receive: recent-listening summary (30d windowed plays + cold
// rediscover pool from play-events.jsonl), ExternalContext (shows /
// releases / press / calendar), the last 21 themes (§3.4 cooldown), and
// the Music Man persona core.
//
// SDK-DECOUPLED: this module never imports the Anthropic SDK. The caller
// (index.ts) injects a RecordStoreLlm adapter wrapping the existing
// claudeCall pipeline (§3.6 — no new SDK, no new keys). The verification
// probes inject their own adapter. If no llm is provided, or the call
// fails / returns junk, both paths fall back to a deterministic
// heuristic (§8 LLM-down behavior) — the store never shows an error.

import { buildCandidatePool, type AlbumCandidate, type CandTrack } from './candidate-pool'
import type { DayTheme, Persona, Shelf, ShelfBundle, ShelfId, ShelfItem } from './types'
import type { ExternalContext } from './external-context'
import { formatExternalContextForPrompt } from './external-context'

// ── Public types ─────────────────────────────────────────────────────

/** One play event from play-events.jsonl. Schema owned by index.ts's
 *  appendPlayEvent; we read it here for windowed analysis. */
export interface PlayEvent {
  id: number
  ts: number
}

export interface ListeningSummary {
  /** Plays in the last 30 days, rolled up by artist, most-played first. */
  recentTopArtists: Array<{ artist: string; plays: number }>
  /** Plays in the last 30 days, rolled up by genre, most-played first. */
  recentTopGenres: Array<{ genre: string; plays: number }>
  /** Owned albums gone cold (90+ days since last play, or never) — the
   *  "you forgot you owned this" rediscover pool (§3.4 long-tail). */
  rediscoverCandidates: Array<{ artist: string; album: string; daysCold: number }>
  /** All-time heavy-skip tracks (skipCount ≥ playCount, both > 0). The
   *  play-events log only records plays, not skips, so this is all-time
   *  not windowed — labeled honestly in the prompt. */
  heavySkips: Array<{ artist: string; title: string }>
  /** Total plays counted in the 30-day window. */
  totalRecentPlays: number
}

/** Per-shelf weighting hint the picker returns alongside the theme.
 *  Phase 1d feeds these into the candidate-pool themeScorer / item
 *  counts. 1.0 = neutral; >1 = lean into this shelf for today's theme. */
export type ShelfWeighting = {
  'mm-picks': number
  'new-arrivals': number
  'deep-cuts': number
}

export interface DayThemeResult {
  theme: DayTheme
  weighting: ShelfWeighting
  source: 'llm' | 'heuristic'
}

/** The injected LLM adapter. Mirrors what claudeCall needs but stays
 *  free of the Anthropic SDK types so this module never imports it.
 *  Returns the assistant's text. Throws on hard failure (the picker
 *  catches and falls back to heuristic). */
export interface RecordStoreLlmRequest {
  callKey: string
  model: string
  maxTokens: number
  system: string
  user: string
}
export type RecordStoreLlm = (req: RecordStoreLlmRequest) => Promise<string>

export interface PickDayThemeInput {
  /** YYYY-MM-DD local — the new theme's date + cache key. */
  todayISO: string
  summary: ListeningSummary
  external: ExternalContext
  /** Last 21 (date, theme) pairs from RecordStoreCache.getThemeHistory().
   *  The picker is told not to repeat any of these. */
  themeHistory: Array<{ date: string; theme: string }>
  /** MUSIC_MAN_CORE, injected by index.ts (which owns the persona). */
  personaCore: string
  /** Injected LLM adapter. Omit (or let it throw) to force heuristic. */
  llm?: RecordStoreLlm
}

const THIRTY_DAYS_MS = 30 * 86_400_000
const COLD_DAYS = 90
const DAY_THEME_MODEL = 'claude-sonnet-4-6'
const DAY_THEME_MAX_TOKENS = 700

// ── Listening summary (pure; no I/O) ─────────────────────────────────

/** Parse play-events.jsonl text into events. Tolerant of torn last
 *  lines (append-only file can be read mid-write). Lives here so the
 *  orchestrator and the probe share one parser. */
export function parsePlayEvents(raw: string): PlayEvent[] {
  const out: PlayEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const evt = JSON.parse(line) as { id?: number; ts?: number }
      if (typeof evt.id === 'number' && typeof evt.ts === 'number') {
        out.push({ id: evt.id, ts: evt.ts })
      }
    } catch {
      // Torn / malformed line — skip, same as get-windowed-play-counts.
    }
  }
  return out
}

function artistOf(t: CandTrack): string {
  return (t.albumArtist && t.albumArtist.trim()) || (t.artist || '').trim()
}

/** Build the recent-listening picture from the library + play log.
 *  Pure: the caller reads library.json + play-events.jsonl and passes
 *  parsed data in. nowMs is injectable for tests. */
export function buildListeningSummary(
  tracks: CandTrack[],
  events: PlayEvent[],
  nowMs: number,
): ListeningSummary {
  const byId = new Map<number, CandTrack>()
  for (const t of tracks) byId.set(t.id, t)

  // 30-day windowed play counts from the event log.
  const cutoff = nowMs - THIRTY_DAYS_MS
  const artistPlays = new Map<string, number>()
  const genrePlays = new Map<string, number>()
  let totalRecentPlays = 0
  for (const evt of events) {
    if (evt.ts < cutoff) continue
    const t = byId.get(evt.id)
    if (!t) continue
    totalRecentPlays++
    const a = artistOf(t)
    if (a) artistPlays.set(a, (artistPlays.get(a) ?? 0) + 1)
    const g = (t.genre || '').trim()
    if (g) genrePlays.set(g, (genrePlays.get(g) ?? 0) + 1)
  }

  const recentTopArtists = topEntries(artistPlays, 8).map(([artist, plays]) => ({ artist, plays }))
  const recentTopGenres = topEntries(genrePlays, 6).map(([genre, plays]) => ({ genre, plays }))

  // Rediscover pool: owned, played at least once, but cold for 90+ days.
  // Roll up to one entry per album so we don't list 12 tracks of the
  // same record. Sorted coldest-first.
  const coldByAlbum = new Map<string, { artist: string; album: string; daysCold: number }>()
  for (const t of tracks) {
    if ((Number(t.playCount) || 0) <= 0) continue
    if (!t.album) continue
    const last = typeof t.lastPlayedAt === 'number' ? t.lastPlayedAt : 0
    const daysCold = last > 0 ? (nowMs - last) / 86_400_000 : Infinity
    if (daysCold < COLD_DAYS) continue
    const artist = artistOf(t)
    if (!artist) continue
    const key = `${t.album}::${artist}`
    const prior = coldByAlbum.get(key)
    // Keep the warmest track's daysCold as the album's (most recent play
    // across the album); Infinity only if every track is never-played.
    const repDays = Number.isFinite(daysCold) ? daysCold : Infinity
    if (!prior || repDays < prior.daysCold) {
      coldByAlbum.set(key, { artist, album: t.album, daysCold: repDays })
    }
  }
  const rediscoverCandidates = Array.from(coldByAlbum.values())
    .sort((a, b) => b.daysCold - a.daysCold)
    .slice(0, 10)

  // Heavy skips (all-time): owned, skipped at least as often as played.
  const heavySkips: Array<{ artist: string; title: string }> = []
  for (const t of tracks) {
    const skips = Number(t.skipCount) || 0
    const plays = Number(t.playCount) || 0
    if (skips > 0 && skips >= plays && plays >= 0) {
      const artist = artistOf(t)
      if (artist && t.title) heavySkips.push({ artist, title: t.title })
    }
    if (heavySkips.length >= 6) break
  }

  return { recentTopArtists, recentTopGenres, rediscoverCandidates, heavySkips, totalRecentPlays }
}

function topEntries(m: Map<string, number>, n: number): Array<[string, number]> {
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

// ── Prompt assembly ──────────────────────────────────────────────────

export function formatListeningSummaryForPrompt(s: ListeningSummary): string {
  const lines: string[] = []
  if (s.recentTopArtists.length) {
    lines.push(
      `Last 30 days, most-played artists: ${s.recentTopArtists
        .map((a) => `${a.artist} (${a.plays})`)
        .join(', ')}.`,
    )
  } else {
    lines.push('No plays logged in the last 30 days (fresh log or quiet month).')
  }
  if (s.recentTopGenres.length) {
    lines.push(`Genres in rotation lately: ${s.recentTopGenres.map((g) => g.genre).join(', ')}.`)
  }
  if (s.rediscoverCandidates.length) {
    lines.push('Owned but gone cold (90+ days — rediscover material):')
    for (const r of s.rediscoverCandidates.slice(0, 8)) {
      const cold = Number.isFinite(r.daysCold) ? `${Math.round(r.daysCold)}d` : 'never played'
      lines.push(`  - ${r.artist} — ${r.album} (${cold})`)
    }
  }
  if (s.heavySkips.length) {
    lines.push(
      `Tracks the user reliably skips (all-time): ${s.heavySkips
        .map((h) => `${h.artist} – ${h.title}`)
        .join(', ')}.`,
    )
  }
  return lines.join('\n')
}

const THEME_INSTRUCTIONS = `You are stocking the wall of your record store for ONE day. Before you pick a single record, choose the DAY'S THEME — one coherent musical thread that ties the whole wall together. This is the most important decision; everything else hangs off it.

A theme is ONE of these kinds:
  - "era"        a specific year or stretch (e.g. "1971, the singer-songwriter peak")
  - "scene"      a place + moment (e.g. "Liverpool, late 70s")
  - "throughline" a thread across time (e.g. "records built in the studio as an instrument")
  - "mood"       only when the day/weather/time genuinely suggests it
  - "personal"   a thread pulled from what THIS user has been on lately
  - "cultural"   anchored to a real-world event from the context below (a show this week, a new release). When you pick this, set externalAnchor.

Rules:
  - The theme MUST connect to this user's actual library and recent listening. You are not a generic radio station; you know THIS collection.
  - Do NOT repeat any theme in the "recent themes" list — those are burned for now.
  - A "cultural" theme is the strongest when the context gives you a real hook (a library artist playing nearby, a new release). Prefer it when the hook is real; never invent a hook.
  - The rationale is 1-2 sentences, in your voice, why THIS thread TODAY. It is the line the user reads under the shop sign — make it land.
  - weighting tells the shelves how hard to lean in today: mm-picks / new-arrivals / deep-cuts each get a number from 0.5 to 1.5 (1.0 = normal). A nostalgic rediscover day weights deep-cuts up; a new-release day weights new-arrivals up.

Return ONLY a JSON object, no prose, no code fence:
{"theme": "...", "rationale": "...", "source": "era|scene|throughline|mood|personal|cultural", "externalAnchor": {"kind": "show|release|feature", "label": "...", "url": "..."} (omit unless source is cultural), "weighting": {"mm-picks": 1.0, "new-arrivals": 1.0, "deep-cuts": 1.0}}`

function buildUserMessage(input: PickDayThemeInput): string {
  const parts: string[] = []
  parts.push('OUTSIDE WORLD:')
  parts.push(formatExternalContextForPrompt(input.external))
  parts.push('')
  parts.push("THIS USER'S LISTENING:")
  parts.push(formatListeningSummaryForPrompt(input.summary))
  parts.push('')
  if (input.themeHistory.length) {
    parts.push(
      `RECENT THEMES (do NOT repeat any of these): ${input.themeHistory
        .map((h) => `"${h.theme}"`)
        .join(', ')}`,
    )
    parts.push('')
  }
  parts.push(THEME_INSTRUCTIONS)
  return parts.join('\n')
}

// ── LLM response parsing ─────────────────────────────────────────────

type RawTheme = {
  theme?: unknown
  rationale?: unknown
  source?: unknown
  externalAnchor?: { kind?: unknown; label?: unknown; url?: unknown }
  weighting?: { 'mm-picks'?: unknown; 'new-arrivals'?: unknown; 'deep-cuts'?: unknown }
}

const VALID_SOURCES: DayTheme['source'][] = [
  'era', 'scene', 'throughline', 'mood', 'personal', 'cultural',
]
const VALID_ANCHOR_KINDS = ['show', 'release', 'feature'] as const

function stripFence(text: string): string {
  // Models sometimes wrap JSON in ```json … ``` despite instructions.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fence ? fence[1] : text).trim()
}

function clampWeight(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 1.0
  return Math.min(1.5, Math.max(0.5, n))
}

/** Parse + validate the LLM JSON into a DayThemeResult. Throws on any
 *  shape problem so the caller falls back to heuristic. */
function parseThemeResponse(text: string, todayISO: string): DayThemeResult {
  const raw = JSON.parse(stripFence(text)) as RawTheme
  const theme = typeof raw.theme === 'string' ? raw.theme.trim() : ''
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : ''
  if (!theme || !rationale) throw new Error('missing theme/rationale')
  const source = VALID_SOURCES.includes(raw.source as DayTheme['source'])
    ? (raw.source as DayTheme['source'])
    : 'throughline'

  const dayTheme: DayTheme = { date: todayISO, theme, rationale, source }

  if (source === 'cultural' && raw.externalAnchor && typeof raw.externalAnchor.label === 'string') {
    const kind = VALID_ANCHOR_KINDS.includes(raw.externalAnchor.kind as 'show')
      ? (raw.externalAnchor.kind as 'show' | 'release' | 'feature')
      : 'feature'
    dayTheme.externalAnchor = {
      kind,
      label: raw.externalAnchor.label.trim(),
      ...(typeof raw.externalAnchor.url === 'string' && raw.externalAnchor.url
        ? { url: raw.externalAnchor.url }
        : {}),
    }
  }

  const w = raw.weighting ?? {}
  const weighting: ShelfWeighting = {
    'mm-picks': clampWeight(w['mm-picks']),
    'new-arrivals': clampWeight(w['new-arrivals']),
    'deep-cuts': clampWeight(w['deep-cuts']),
  }
  return { theme: dayTheme, weighting, source: 'llm' }
}

// ── Heuristic fallback (§8 LLM-down) ─────────────────────────────────
//
// No LLM, no theme to lean on — pick a long-tail artist the user owns
// and theme around their era. Deterministic, never throws, no blurbs.
// This is what stocks the wall when Claude is unreachable.

function decadeLabel(year?: number | string): string | null {
  const y = typeof year === 'number' ? year : parseInt(String(year ?? ''), 10)
  if (!Number.isFinite(y) || y < 1900 || y > 2100) return null
  const decade = Math.floor(y / 10) * 10
  return `${decade}s`
}

export function heuristicDayTheme(
  todayISO: string,
  summary: ListeningSummary,
  tracks: CandTrack[],
): DayThemeResult {
  // Prefer a cold rediscover album; fall back to a recent top artist.
  const seed = summary.rediscoverCandidates[0]
  if (seed) {
    // Find a year for the seed album to anchor a decade.
    const albumTrack = tracks.find(
      (t) => t.album === seed.album && artistOf(t) === seed.artist && t.year,
    )
    const decade = decadeLabel(albumTrack?.year)
    const theme = decade
      ? `Records you forgot you owned — ${seed.artist} and the ${decade}`
      : `Records you forgot you owned — starting with ${seed.artist}`
    return {
      theme: {
        date: todayISO,
        theme,
        rationale: `You haven't touched ${seed.album} in a while. The shop pulled it back to the front.`,
        source: 'personal',
      },
      weighting: { 'mm-picks': 1.0, 'new-arrivals': 0.8, 'deep-cuts': 1.4 },
      source: 'heuristic',
    }
  }
  const topArtist = summary.recentTopArtists[0]?.artist
  return {
    theme: {
      date: todayISO,
      theme: topArtist ? `Around ${topArtist} and the corners next to it` : "The shop's own picks",
      rationale: topArtist
        ? `You've been on ${topArtist} lately. The wall leans that way today.`
        : 'A clean wall — the shop picked from across your collection.',
      source: topArtist ? 'personal' : 'throughline',
    },
    weighting: { 'mm-picks': 1.2, 'new-arrivals': 1.0, 'deep-cuts': 1.0 },
    source: 'heuristic',
  }
}

// ── Public entry point ───────────────────────────────────────────────

/** Pick the day's theme. Tries the injected LLM; on any failure (no
 *  adapter, API error, junk JSON, repeated theme) falls back to the
 *  deterministic heuristic. Never throws. */
export async function pickDayTheme(
  input: PickDayThemeInput,
  tracks: CandTrack[],
): Promise<DayThemeResult> {
  if (input.llm) {
    try {
      const text = await input.llm({
        callKey: 'record-store:day-theme',
        model: DAY_THEME_MODEL,
        maxTokens: DAY_THEME_MAX_TOKENS,
        system: input.personaCore,
        user: buildUserMessage(input),
      })
      const result = parseThemeResponse(text, input.todayISO)
      // Cooldown guard: if the model repeated a recent theme verbatim
      // despite the instruction, treat it as a miss and fall back.
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
      const repeated = input.themeHistory.some((h) => norm(h.theme) === norm(result.theme.theme))
      if (repeated) {
        console.warn('[record-store/shelf-generator] LLM repeated a cooldown theme; using heuristic')
        return heuristicDayTheme(input.todayISO, input.summary, tracks)
      }
      return result
    } catch (err) {
      console.warn('[record-store/shelf-generator] day-theme LLM failed; using heuristic:', err)
    }
  }
  return heuristicDayTheme(input.todayISO, input.summary, tracks)
}

// ═════════════════════════════════════════════════════════════════════
// Phase 1d — shelf generator
// ═════════════════════════════════════════════════════════════════════

const SHELF_DEFS: Array<{ id: ShelfId; curator: Persona | 'house'; title: string }> = [
  { id: 'mm-picks', curator: 'music-man', title: "Music Man's Picks" },
  { id: 'new-arrivals', curator: 'house', title: 'New Arrivals' },
  { id: 'deep-cuts', curator: 'music-man', title: 'Deep Cuts' },
]
const SHELF_IDS = SHELF_DEFS.map((s) => s.id)

/** How many candidates per shelf to SHOW the model. The pool is built
 *  to 50 (§3.3) but a combined 3-shelf prompt at 50×3 is wasteful; 24
 *  each is plenty for the model to pick 5-7 from and keeps the prompt
 *  tight. */
const CANDIDATES_SHOWN = 24
/** Target items per shelf (§9: 5 real items). Brief allows 5-7; we ask
 *  for 5-7 and accept what validates, flooring at MIN. */
const SHELF_TARGET = 5
const SHELF_MAX = 7
/** Below this after validation, top up from the pool (§8). */
const SHELF_MIN = 3
/** Max items per artist across the whole day's wall (§3.4). */
const PER_DAY_ARTIST_CAP = 2
const SHELF_GEN_MODEL = 'claude-sonnet-4-6'
const SHELF_GEN_MAX_TOKENS = 2000

export type ShelfPools = Record<'mm-picks' | 'new-arrivals' | 'deep-cuts', AlbumCandidate[]>

/** Build the per-shelf balanced candidate pools (§3.4 math) the LLM will
 *  pick from. Sequential so the per-day artist cap is threaded across
 *  shelves via artistsUsedToday — the same pattern the pool probe uses.
 *  Single home for "how the three pools get built". */
export function buildShelfPools(
  tracks: CandTrack[],
  todayISO: string,
  recentlyPickedIds: Set<string>,
): ShelfPools {
  const artistsUsedToday = new Map<string, number>()
  const pools = {} as ShelfPools
  for (const id of SHELF_IDS) {
    const pool = buildCandidatePool({ tracks, shelfId: id, todayISO, recentlyPickedIds, artistsUsedToday, limit: 50 })
    pools[id as keyof ShelfPools] = pool
    // Reserve the top picks' artists so the next shelf leans elsewhere.
    for (const c of pool.slice(0, SHELF_TARGET)) {
      artistsUsedToday.set(c.artist, (artistsUsedToday.get(c.artist) ?? 0) + 1)
    }
  }
  return pools
}

export interface GenerateShelvesInput {
  todayISO: string
  summary: ListeningSummary
  external: ExternalContext
  themeHistory: Array<{ date: string; theme: string }>
  personaCore: string
  pools: ShelfPools
  /** Injected LLM adapter; omit to force the heuristic bundle. */
  llm?: RecordStoreLlm
}

// ── Candidate refs ───────────────────────────────────────────────────
//
// The model picks by a SHORT ref ("a3"), never by echoing the long
// `album::artist` key — that's both token-cheap and the library-grounded
// guarantee (§3.3): a ref the model returns either maps to a real
// candidate or is dropped. No free-text id can survive validation.

const SHELF_REF_PREFIX: Record<keyof ShelfPools, string> = {
  'mm-picks': 'a',
  'new-arrivals': 'b',
  'deep-cuts': 'c',
}

function candidateMeta(c: AlbumCandidate): string {
  const bits = [c.album, '—', c.artist]
  const tail: string[] = []
  if (c.year) tail.push(String(c.year))
  if (c.genre) tail.push(c.genre)
  tail.push(`${c.totalPlays} plays`)
  if (Number.isFinite(c.daysSinceLastPlay)) tail.push(`${Math.round(c.daysSinceLastPlay)}d cold`)
  else tail.push('never played')
  return `${bits.join(' ')} (${tail.join(', ')})`
}

function buildShelfUserMessage(input: GenerateShelvesInput, refMap: Map<string, AlbumCandidate>): string {
  const parts: string[] = []
  parts.push('OUTSIDE WORLD:')
  parts.push(formatExternalContextForPrompt(input.external))
  parts.push('')
  parts.push("THIS USER'S LISTENING:")
  parts.push(formatListeningSummaryForPrompt(input.summary))
  parts.push('')
  if (input.themeHistory.length) {
    parts.push(`RECENT THEMES (do NOT repeat any): ${input.themeHistory.map((h) => `"${h.theme}"`).join(', ')}`)
    parts.push('')
  }
  parts.push('CANDIDATE RECORDS — you may ONLY pick from these, by their [ref]. Each shelf has its own list:')
  for (const def of SHELF_DEFS) {
    const pool = input.pools[def.id as keyof ShelfPools] ?? []
    const prefix = SHELF_REF_PREFIX[def.id as keyof ShelfPools]
    parts.push('')
    parts.push(`${def.title} (id "${def.id}") — pick ${SHELF_TARGET}-${SHELF_MAX}:`)
    pool.slice(0, CANDIDATES_SHOWN).forEach((c, i) => {
      const ref = `${prefix}${i + 1}`
      refMap.set(ref, c)
      parts.push(`  [${ref}] ${candidateMeta(c)}`)
    })
  }
  parts.push('')
  parts.push(SHELF_INSTRUCTIONS)
  return parts.join('\n')
}

const SHELF_INSTRUCTIONS = `Stock the wall for ONE day. Two steps, ONE response.

STEP 1 — pick the day's THEME: one coherent thread tying the whole wall together (an era, a scene, a throughline, a mood, a personal thread from this user's listening, or a cultural hook from the context above). It MUST connect to this collection and must not repeat a recent theme. The rationale is 1-2 sentences in your voice — the line under the shop sign.

STEP 2 — fill the three shelves. For EACH shelf, pick ${SHELF_TARGET}-${SHELF_MAX} records that serve the theme, choosing ONLY from that shelf's [ref] list. For each pick write a one-line "placement" — why THIS record is on the wall today, in your voice, tied to the theme or the user's relationship to it. Each shelf gets a one-line "tagline" in your voice. Don't put the same artist on more than two shelves.

Return ONLY this JSON, no prose, no code fence:
{"theme":"...","rationale":"...","source":"era|scene|throughline|mood|personal|cultural","externalAnchor":{"kind":"show|release|feature","label":"...","url":"..."} (omit unless cultural),"weighting":{"mm-picks":1.0,"new-arrivals":1.0,"deep-cuts":1.0},"shelves":[{"id":"mm-picks","tagline":"...","items":[{"ref":"a3","placement":"..."}]},{"id":"new-arrivals","tagline":"...","items":[{"ref":"b1","placement":"..."}]},{"id":"deep-cuts","tagline":"...","items":[{"ref":"c5","placement":"..."}]}]}`

// ── Response parsing ─────────────────────────────────────────────────

type RawShelf = { id?: unknown; tagline?: unknown; items?: Array<{ ref?: unknown; placement?: unknown }> }
type RawShelvesResponse = RawTheme & { shelves?: RawShelf[] }

function candidateToShelfItem(c: AlbumCandidate, placement: string): ShelfItem {
  return {
    id: `lib:album:${c.albumKey}`,
    kind: 'library-album',
    coverUrl: null, // art arrives in Phase 2
    title: c.album,
    subtitle: c.artist,
    placement,
    payload: { trackIds: c.trackIds.map(String) },
  }
}

function defaultPlacement(shelfId: ShelfId): string {
  switch (shelfId) {
    case 'new-arrivals': return 'Recently through the door.'
    case 'deep-cuts': return 'Owned, overlooked, worth another spin.'
    default: return 'A staple of your collection.'
  }
}

/** Convert validated picks to a Shelf, enforcing the per-day artist cap
 *  and topping up from the pool to the floor. dayArtistCount is mutated
 *  as items are committed so the cap holds across shelves. */
function assembleShelf(
  def: { id: ShelfId; curator: Persona | 'house'; title: string },
  tagline: string,
  picked: Array<{ cand: AlbumCandidate; placement: string }>,
  pool: AlbumCandidate[],
  dayArtistCount: Map<string, number>,
): Shelf {
  const items: ShelfItem[] = []
  const usedKeys = new Set<string>()

  const tryAdd = (cand: AlbumCandidate, placement: string): boolean => {
    if (usedKeys.has(cand.albumKey)) return false
    if ((dayArtistCount.get(cand.artist) ?? 0) >= PER_DAY_ARTIST_CAP) return false
    items.push(candidateToShelfItem(cand, placement))
    usedKeys.add(cand.albumKey)
    dayArtistCount.set(cand.artist, (dayArtistCount.get(cand.artist) ?? 0) + 1)
    return true
  }

  for (const p of picked) {
    if (items.length >= SHELF_MAX) break
    tryAdd(p.cand, p.placement)
  }
  // Top up from the pool (score order) if the model under-filled or its
  // picks were dropped by the diversity cap (§8 top-up).
  if (items.length < SHELF_TARGET) {
    for (const cand of pool) {
      if (items.length >= SHELF_TARGET) break
      tryAdd(cand, defaultPlacement(def.id))
    }
  }
  return { id: def.id, curator: def.curator, title: def.title, tagline, items }
}

function parseShelvesResponse(
  text: string,
  input: GenerateShelvesInput,
  refMap: Map<string, AlbumCandidate>,
): ShelfBundle {
  const raw = JSON.parse(stripFence(text)) as RawShelvesResponse
  const themeStr = typeof raw.theme === 'string' ? raw.theme.trim() : ''
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : ''
  if (!themeStr || !rationale) throw new Error('missing theme/rationale')

  const source = VALID_SOURCES.includes(raw.source as DayTheme['source'])
    ? (raw.source as DayTheme['source'])
    : 'throughline'
  const dayTheme: DayTheme = { date: input.todayISO, theme: themeStr, rationale, source }
  if (source === 'cultural' && raw.externalAnchor && typeof raw.externalAnchor.label === 'string') {
    const kind = VALID_ANCHOR_KINDS.includes(raw.externalAnchor.kind as 'show')
      ? (raw.externalAnchor.kind as 'show' | 'release' | 'feature')
      : 'feature'
    dayTheme.externalAnchor = {
      kind,
      label: raw.externalAnchor.label.trim(),
      ...(typeof raw.externalAnchor.url === 'string' && raw.externalAnchor.url ? { url: raw.externalAnchor.url } : {}),
    }
  }

  // Index the model's shelves by id so we render in our fixed order
  // regardless of what order the model returned them.
  const byId = new Map<string, RawShelf>()
  for (const s of raw.shelves ?? []) {
    if (typeof s.id === 'string') byId.set(s.id, s)
  }

  const dayArtistCount = new Map<string, number>()
  const shelves: Shelf[] = SHELF_DEFS.map((def) => {
    const rawShelf = byId.get(def.id)
    const tagline = typeof rawShelf?.tagline === 'string' && rawShelf.tagline.trim()
      ? rawShelf.tagline.trim()
      : def.title
    const picked: Array<{ cand: AlbumCandidate; placement: string }> = []
    for (const it of rawShelf?.items ?? []) {
      const ref = typeof it.ref === 'string' ? it.ref.trim() : ''
      const cand = refMap.get(ref)
      if (!cand) continue // hallucinated / out-of-pool ref → drop (§3.3)
      const placement = typeof it.placement === 'string' && it.placement.trim()
        ? it.placement.trim()
        : defaultPlacement(def.id)
      picked.push({ cand, placement })
    }
    return assembleShelf(def, tagline, picked, input.pools[def.id as keyof ShelfPools] ?? [], dayArtistCount)
  })

  const droppedAShelf = shelves.some((s) => s.items.length < SHELF_MIN)
  if (droppedAShelf) {
    // A shelf couldn't reach the floor even after top-up — the pool was
    // too thin (small / heavily filtered library). Not an error; log it.
    console.warn('[record-store/shelf-generator] a shelf is below the floor after top-up (thin pool)')
  }

  const generatedAt = Date.now()
  return {
    date: input.todayISO,
    generatedAt,
    validUntil: generatedAt + 24 * 60 * 60 * 1000,
    theme: dayTheme,
    shelves,
    source: 'llm',
  }
}

// ── Heuristic bundle (§8 LLM-down) ───────────────────────────────────

/** Build a full ShelfBundle from the pools alone — no LLM. Theme from
 *  heuristicDayTheme; each shelf filled from the top of its pool. */
export function heuristicShelfBundle(input: GenerateShelvesInput, tracks: CandTrack[]): ShelfBundle {
  const themeResult = heuristicDayTheme(input.todayISO, input.summary, tracks)
  const dayArtistCount = new Map<string, number>()
  const shelves: Shelf[] = SHELF_DEFS.map((def) =>
    assembleShelf(def, def.title, [], input.pools[def.id as keyof ShelfPools] ?? [], dayArtistCount),
  )
  const generatedAt = Date.now()
  return {
    date: input.todayISO,
    generatedAt,
    validUntil: generatedAt + 24 * 60 * 60 * 1000,
    theme: themeResult.theme,
    shelves,
    source: 'heuristic',
  }
}

// ── Public entry point ───────────────────────────────────────────────

/** The headline call: pick the theme and stock all three shelves in ONE
 *  Sonnet call (§1d), validated library-ground (§3.3) with diversity +
 *  top-up (§3.4 / §8). Falls back to the heuristic bundle on any
 *  failure. Never throws. */
export async function generateShelves(input: GenerateShelvesInput, tracks: CandTrack[]): Promise<ShelfBundle> {
  if (input.llm) {
    try {
      const refMap = new Map<string, AlbumCandidate>()
      const user = buildShelfUserMessage(input, refMap)
      const text = await input.llm({
        callKey: 'record-store:shelves',
        model: SHELF_GEN_MODEL,
        maxTokens: SHELF_GEN_MAX_TOKENS,
        system: input.personaCore,
        user,
      })
      const bundle = parseShelvesResponse(text, input, refMap)
      // Cooldown guard: a repeated theme means the model ignored the
      // instruction — fall back rather than serve a stale wall.
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
      if (input.themeHistory.some((h) => norm(h.theme) === norm(bundle.theme.theme))) {
        console.warn('[record-store/shelf-generator] LLM repeated a cooldown theme; using heuristic bundle')
        return heuristicShelfBundle(input, tracks)
      }
      return bundle
    } catch (err) {
      console.warn('[record-store/shelf-generator] shelf-gen LLM failed; using heuristic bundle:', err)
    }
  }
  return heuristicShelfBundle(input, tracks)
}
