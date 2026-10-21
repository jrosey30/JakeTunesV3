/**
 * The Listening Memory quote — the one line of the memory block Jake kept.
 *
 * Jake on the phone's memory block (2026-06-09, JakeTunesMobile #115): "i liked
 * the stats as it was... no need for those new cards but i like the quote."
 * The phone dropped its stat cards and kept the Music Man's one-line
 * observation; the desktop still showed six cards and no quote. This is the
 * phone's line, so the desktop can show the same thing:
 *
 *   • homemini's GET /api/listening-memory answers with the phone's own
 *     `observation`, computed over BOTH devices' plays — read it with
 *     hubListeningQuote(), and the desktop says exactly what the phone says;
 *   • while homemini is away, listeningQuote(listeningQuoteFacts(...)) says it
 *     from this Mac's own log, by the same rule.
 *
 * The rule (most interesting fact first; deterministic, no AI call):
 *   comeback → binge → golden hour → streak → this week's artist,
 * and nothing at all until the log holds 10 plays (the phone hides the quote
 * below that).
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/playLog.ts computeListeningMemory
 *    (the facts + the `observation` templates) and
 *    ios/JakeTunesMobile/HomeView.swift memorySection (the ≥ 10 gate).
 *    Change one, change both.
 *
 * Pure: no imports, no IPC.
 */

export const QUOTE_MIN_PLAYS = 10

export interface QuoteEvent {
  /** When it happened, epoch ms. */
  ms: number
  artist?: string | null
}

export interface QuoteFacts {
  totalLoggedPlays: number
  currentStreakDays: number
  /** 0–23, local time; null with no plays. */
  goldenHour: number | null
  /** Plays in the golden hour. */
  goldenMax: number
  bingePlays: number
  comebackArtist: string | null
  comebackGapDays: number
  topArtistThisWeek: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n) }
/** Local YYYY-MM-DD (the phone's toLocaleDateString('en-CA')). */
function dayKey(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }

export function hourLabel(h: number): string {
  if (h === 0) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

/** The facts the quote reads, by the phone backend's definitions. */
export function listeningQuoteFacts(events: readonly QuoteEvent[], now: Date): QuoteFacts {
  const nowMs = now.getTime()
  const dayCounts = new Map<string, number>()
  const hourCounts = new Array<number>(24).fill(0)
  const weekArtistCounts = new Map<string, number>()
  const artistTimes = new Map<string, number[]>()
  let total = 0
  for (const e of events) {
    const ms = e.ms
    if (!Number.isFinite(ms)) continue
    total++
    const d = new Date(ms)
    const day = dayKey(d)
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
    hourCounts[d.getHours()]++
    const artist = (e.artist || '').trim()
    if (artist) {
      if (nowMs - ms <= 7 * DAY_MS) weekArtistCounts.set(artist, (weekArtistCounts.get(artist) ?? 0) + 1)
      const times = artistTimes.get(artist)
      if (times) times.push(ms)
      else artistTimes.set(artist, [ms])
    }
  }

  // Current streak: alive through today, or through yesterday.
  const cursor = new Date(nowMs)
  if (!dayCounts.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let currentStreak = 0
  while (dayCounts.has(dayKey(cursor))) {
    currentStreak++
    cursor.setDate(cursor.getDate() - 1)
  }

  let goldenHour: number | null = null
  let goldenMax = 0
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h] > goldenMax) { goldenMax = hourCounts[h]; goldenHour = h }
  }
  let bingePlays = 0
  for (const count of dayCounts.values()) if (count > bingePlays) bingePlays = count

  let topArtist: string | null = null
  let topArtistPlays = 0
  for (const [artist, count] of weekArtistCounts) {
    if (count > topArtistPlays) { topArtistPlays = count; topArtist = artist }
  }

  // Comeback: the latest play is recent (≤ 14 days) after a long silence
  // (≥ 21 days since the play before it). Biggest gap wins.
  let comebackArtist: string | null = null
  let comebackGap = 0
  for (const [artist, times] of artistTimes) {
    if (times.length < 2) continue
    times.sort((a, b) => a - b)
    const latest = times[times.length - 1]
    const prior = times[times.length - 2]
    const gapDays = Math.floor((latest - prior) / DAY_MS)
    if (nowMs - latest <= 14 * DAY_MS && gapDays >= 21 && gapDays > comebackGap) {
      comebackGap = gapDays
      comebackArtist = artist
    }
  }

  return {
    totalLoggedPlays: total,
    currentStreakDays: currentStreak,
    goldenHour,
    goldenMax,
    bingePlays,
    comebackArtist,
    comebackGapDays: comebackGap,
    topArtistThisWeek: topArtist,
  }
}

/** The Music Man's line, or null (too few plays, or nothing worth saying). */
export function listeningQuote(f: QuoteFacts): string | null {
  if (f.totalLoggedPlays < QUOTE_MIN_PLAYS) return null
  if (f.comebackArtist) return `${f.comebackArtist}, back after ${f.comebackGapDays} days away. Welcome home.`
  if (f.bingePlays >= 15) return `${f.bingePlays} spins in one day. That wasn't background music.`
  if (f.goldenHour !== null && f.goldenMax >= 8) return `${hourLabel(f.goldenHour)} is your golden hour. The needle knows.`
  if (f.currentStreakDays >= 3) return `${f.currentStreakDays} days straight. The streak is alive.`
  if (f.topArtistThisWeek) return `This week belongs to ${f.topArtistThisWeek}.`
  return null
}

/** homemini's /api/listening-memory reply → the phone's quote, or null when
 *  the reply isn't that document or the phone would hide it. */
export function hubListeningQuote(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { totalLoggedPlays?: unknown; observation?: unknown }
  if (typeof b.totalLoggedPlays !== 'number' || b.totalLoggedPlays < QUOTE_MIN_PLAYS) return null
  if (typeof b.observation !== 'string') return null
  const text = b.observation.trim()
  return text ? text : null
}
