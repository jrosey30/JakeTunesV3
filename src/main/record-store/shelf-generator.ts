// shelf-generator.ts — the brain (Brief 037 §3.1, Phase 1c)
//
// PHASE 1c SCOPE: the DAY-THEME PICKER only. Before any shelf is
// populated, the store picks ONE coherent musical thread for the day
// (§3.1). Without this, the store is a Spotify Daily Mix in a wood
// frame. Phase 1d adds generateShelves() to this same file and may fold
// both into a single Sonnet call (§1d).
//
// The picker is a single Sonnet call that receives:
//   - a summary of the user's RECENT listening (last 30d plays, cold
//     rediscover candidates, heavy-skip tracks) — buildListeningSummary
//   - the outside world (shows, releases, press, weather, calendar) —
//     ExternalContext from external-context.ts
//   - the last 21 day-themes, so it cannot repeat one (§3.4 cooldown)
//   - the Music Man persona core, so the thread reflects HIS taste
// and returns { theme, rationale, source, per-shelf weighting }.
//
// SDK-DECOUPLED: this module never imports the Anthropic SDK. The caller
// (index.ts, Phase 1d) injects a DayThemeLlm adapter wrapping the
// existing claudeCall pipeline (§3.6 — no new SDK, no new keys). The
// verification probe injects its own adapter (real or stub). If no llm
// is provided, or the call fails / returns junk, we fall back to a
// deterministic heuristic theme (§8 LLM-down behavior) — the store
// never shows an error.

import type { CandTrack } from './candidate-pool'
import type { DayTheme } from './types'
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
export interface DayThemeLlmRequest {
  callKey: string
  model: string
  maxTokens: number
  system: string
  user: string
}
export type DayThemeLlm = (req: DayThemeLlmRequest) => Promise<string>

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
  llm?: DayThemeLlm
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
