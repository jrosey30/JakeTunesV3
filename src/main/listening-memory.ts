/** Pure listening-memory analytics — append-only play-log parsing + habit
 *  insights (streaks, clock heatmap, rising/comeback artists, binges).
 *  Consumed by the get-listening-memory IPC; unit-tested in
 *  __tests__/listening-memory.test.ts. No Node/Electron imports — keep this
 *  module pure so the tests stay hermetic. */

export type PlayEvent = {
  t: 'p' | 's' // play | skip
  ts: string // ISO timestamp
  ar?: string // artist
  al?: string // album
  g?: string // genre
  ti?: string // title
  // How far into the track this happened, 0-100. 'p' (natural end) is always
  // 100 by definition; 's' (skip) is position/duration at the moment of skip —
  // a 50%/75%/etc. completion signal, richer than the binary play-vs-skip.
  pct?: number
}

export interface ListeningMemoryInsights {
  totals: {
    plays: number
    skips: number
    skipRatePct: number
    distinctArtists: number
    daysActive: number
    sinceTs: string | null
  }
  streak: { currentDays: number; bestDays: number; bestEndedOn: string | null }
  clock: {
    byHour: number[] // 24 buckets, local time
    byWeekday: number[] // 7 buckets, 0=Sunday
    peakHourLabel: string | null
    peakWeekdayLabel: string | null
  }
  topArtists7d: Array<{ artist: string; plays: number }>
  topArtists30d: Array<{ artist: string; plays: number }>
  rising: { artist: string; plays7d: number } | null
  comeback: { artist: string; gapDays: number } | null
  binge: { artist: string; plays: number; date: string } | null
}

/** Parse a JSONL log. Tolerates a torn final line (append-only logs can tear
 *  on hard shutdown) and skips anything that doesn't look like an event. */
export function parseLogLines(text: string): PlayEvent[] {
  const out: PlayEvent[] = []
  for (const line of (text || '').split('\n')) {
    const l = line.trim()
    if (!l) continue
    try {
      const e = JSON.parse(l) as PlayEvent
      if ((e.t === 'p' || e.t === 's') && typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts))) {
        out.push(e)
      }
    } catch {
      /* torn/corrupt line — skip */
    }
  }
  return out
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Local-clock day key — habits are local-time phenomena. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function hourLabel(h: number): string {
  if (h === 0) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

const DAY_MS = 24 * 60 * 60 * 1000

export function computeListeningMemory(events: PlayEvent[], now: Date): ListeningMemoryInsights {
  const plays = events.filter((e) => e.t === 'p')
  const skips = events.filter((e) => e.t === 's')

  // ── Totals ──
  const artistSet = new Set<string>()
  for (const p of plays) if (p.ar) artistSet.add(p.ar.toLowerCase())
  let sinceTs: string | null = null
  for (const e of events) {
    if (!sinceTs || e.ts < sinceTs) sinceTs = e.ts
  }
  const denom = plays.length + skips.length

  // ── Day set (plays only — a skip isn't listening) ──
  const daySet = new Set<string>()
  for (const p of plays) daySet.add(dayKey(new Date(p.ts)))

  // ── Streaks ──
  // Current: walk back from today; a streak is "alive" if it includes today
  // OR ended yesterday (you haven't broken it until a full day passes).
  let currentDays = 0
  {
    const todayKey = dayKey(now)
    const yesterdayKey = dayKey(new Date(now.getTime() - DAY_MS))
    let cursor: Date | null = null
    if (daySet.has(todayKey)) cursor = new Date(now.getTime())
    else if (daySet.has(yesterdayKey)) cursor = new Date(now.getTime() - DAY_MS)
    while (cursor && daySet.has(dayKey(cursor))) {
      currentDays++
      cursor = new Date(cursor.getTime() - DAY_MS)
    }
  }
  // Best: longest consecutive run across all active days.
  let bestDays = 0
  let bestEndedOn: string | null = null
  {
    const sortedDays = Array.from(daySet).sort()
    let run = 0
    let prevMs = 0
    for (const k of sortedDays) {
      const ms = Date.parse(`${k}T12:00:00`) // noon dodges DST edges
      run = prevMs && Math.round((ms - prevMs) / DAY_MS) === 1 ? run + 1 : 1
      prevMs = ms
      if (run > bestDays) {
        bestDays = run
        bestEndedOn = k
      }
    }
  }

  // ── Clock heatmap (plays only, local time) ──
  const byHour = new Array<number>(24).fill(0)
  const byWeekday = new Array<number>(7).fill(0)
  for (const p of plays) {
    const d = new Date(p.ts)
    byHour[d.getHours()]++
    byWeekday[d.getDay()]++
  }
  // Don't claim a "peak" off a handful of plays.
  const enoughForPeaks = plays.length >= 10
  const peakHour = byHour.indexOf(Math.max(...byHour))
  const peakWeekday = byWeekday.indexOf(Math.max(...byWeekday))
  const peakHourLabel = enoughForPeaks && byHour[peakHour] > 0 ? hourLabel(peakHour) : null
  const peakWeekdayLabel = enoughForPeaks && byWeekday[peakWeekday] > 0 ? WEEKDAYS[peakWeekday] : null

  // ── Windowed artist tallies ──
  const t7 = now.getTime() - 7 * DAY_MS
  const t30 = now.getTime() - 30 * DAY_MS
  const tally7 = new Map<string, number>()
  const tally30 = new Map<string, number>()
  const tallyPrev23 = new Map<string, number>() // days 8–30, for "rising"
  for (const p of plays) {
    if (!p.ar) continue
    const ms = Date.parse(p.ts)
    if (ms >= t30) {
      tally30.set(p.ar, (tally30.get(p.ar) || 0) + 1)
      if (ms >= t7) tally7.set(p.ar, (tally7.get(p.ar) || 0) + 1)
      else tallyPrev23.set(p.ar, (tallyPrev23.get(p.ar) || 0) + 1)
    }
  }
  const topOf = (m: Map<string, number>, n: number) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([artist, count]) => ({ artist, plays: count }))
  const topArtists7d = topOf(tally7, 5)
  const topArtists30d = topOf(tally30, 5)

  // ── Rising: this week's artist clearly outpacing their own prior 23 days ──
  let rising: ListeningMemoryInsights['rising'] = null
  for (const { artist, plays: p7 } of topArtists7d) {
    const prev = tallyPrev23.get(artist) || 0
    if (p7 >= 3 && p7 > prev) {
      rising = { artist, plays7d: p7 }
      break
    }
  }

  // ── Comeback: played this week after a 60+ day silence ──
  let comeback: ListeningMemoryInsights['comeback'] = null
  {
    const lastTwo = new Map<string, [number, number]>() // artist -> [latest, previous]
    for (const p of plays) {
      if (!p.ar) continue
      const ms = Date.parse(p.ts)
      const cur = lastTwo.get(p.ar)
      if (!cur) lastTwo.set(p.ar, [ms, 0])
      else if (ms > cur[0]) lastTwo.set(p.ar, [ms, cur[0]])
      else if (ms > cur[1]) lastTwo.set(p.ar, [cur[0], ms])
    }
    let bestGap = 0
    for (const [artist, [latest, prev]] of lastTwo) {
      if (!prev || latest < t7) continue
      const gapDays = Math.floor((latest - prev) / DAY_MS)
      if (gapDays >= 60 && gapDays > bestGap) {
        bestGap = gapDays
        comeback = { artist, gapDays }
      }
    }
  }

  // ── Binge record: most plays of one artist in one local day ──
  let binge: ListeningMemoryInsights['binge'] = null
  {
    const perArtistDay = new Map<string, number>()
    for (const p of plays) {
      if (!p.ar) continue
      const k = `${p.ar}|${dayKey(new Date(p.ts))}`
      perArtistDay.set(k, (perArtistDay.get(k) || 0) + 1)
    }
    let best = 0
    for (const [k, count] of perArtistDay) {
      if (count > best) {
        best = count
        const sep = k.lastIndexOf('|')
        binge = { artist: k.slice(0, sep), plays: count, date: k.slice(sep + 1) }
      }
    }
    if (binge && binge.plays < 5) binge = null // 4 plays isn't a binge
  }

  return {
    totals: {
      plays: plays.length,
      skips: skips.length,
      skipRatePct: denom ? Math.round((skips.length / denom) * 100) : 0,
      distinctArtists: artistSet.size,
      daysActive: daySet.size,
      sinceTs,
    },
    streak: { currentDays, bestDays, bestEndedOn },
    clock: { byHour, byWeekday, peakHourLabel, peakWeekdayLabel },
    topArtists7d,
    topArtists30d,
    rising,
    comeback,
    binge,
  }
}
