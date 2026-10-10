/**
 * One listening history across every device — the ground truth Year in
 * Review is built on (2026-10-10, Jake: "ensure that year in review 2026 is
 * going to be a hit"; step 1 = "count every listen, once").
 *
 * Measured the same day, the listens were scattered and the KPI report saw
 * only one slice of them:
 *   laptop    listening-log.jsonl          May 25 →   2,674 plays   894 skips
 *   workmini  its own listening-log.jsonl  Jun 1 →    4,101 plays 2,795 skips
 *             (reaches homemini as replicas/workmini/ since the replica-safe sync)
 *   phone     mobile-listening-log.jsonl   Aug 7 →      369 plays 2,964 skips
 *             (homemini's NAS state dir)
 *   iPod      ipod-roundtrip-ledger.jsonl  offline plays, each with its time
 * The device logs are disjoint (no shared event, none even within 2 min), so
 * the history is their union. 4,428 of the 6,653 "skips" were mechanical —
 * runs of 8+ at ~0% played, under 20 s apart (398 in 8 minutes on the phone,
 * Sept 12) — playback failing or the queue being flicked through, not a
 * verdict on any song. They are kept, labelled, and never count as skips.
 *
 * Pure: no I/O. scripts/listening-history.mts feeds it the files.
 */
import { foldAccents } from './fold-text.ts'

export type Device = 'laptop' | 'workmini' | 'phone' | 'ipod'

/** A row from any listening-log.jsonl (desktop, workmini or phone). */
export interface RawListen {
  t: 'p' | 's'
  ts: string
  ar?: string
  ti?: string
  al?: string
  g?: string
  pct?: number
  src?: string
}

/** play = listened; skip = left early on purpose; glance = moved on before
 *  5% (flicking past, not a verdict); mechanical = part of a burst. */
export type ListenKind = 'play' | 'skip' | 'glance' | 'mechanical'

export interface Listen {
  ts: string
  device: Device
  kind: ListenKind
  pct: number
  artist: string
  title: string
  album: string
  genre: string
  trackId?: number
}

/** Under this share of a song, leaving it is a glance, not a skip. */
export const GLANCE_PCT = 5
/** A run of this many skips… */
export const BURST_MIN = 8
/** …each within this many seconds of the last, is mechanical. */
export const BURST_GAP_S = 20

const ms = (iso: string): number => Date.parse(iso)

/** Classify one device's log: sort, find bursts, label every row. Rows with
 *  an unreadable timestamp are dropped (they cannot be placed in a year). */
export function classifyDevice(rows: readonly RawListen[], device: Device): Listen[] {
  const clean = rows
    .filter((r) => (r.t === 'p' || r.t === 's') && Number.isFinite(ms(r.ts)))
    .slice()
    .sort((a, b) => ms(a.ts) - ms(b.ts))
  const mechanical = new Set<number>()
  let runStart = -1
  const closeRun = (end: number): void => {
    if (runStart >= 0 && end - runStart >= BURST_MIN) for (let i = runStart; i < end; i++) mechanical.add(i)
  }
  for (let i = 0; i < clean.length; i++) {
    const r = clean[i]
    if (r.t !== 's') { closeRun(i); runStart = -1; continue }
    const joins = runStart >= 0 && (ms(r.ts) - ms(clean[i - 1].ts)) / 1000 <= BURST_GAP_S
    if (!joins) { closeRun(i); runStart = i }
  }
  closeRun(clean.length)
  return clean.map((r, i): Listen => {
    const pct = Math.max(0, Math.min(100, Number(r.pct) || (r.t === 'p' ? 100 : 0)))
    const kind: ListenKind = r.t === 'p' ? 'play' : mechanical.has(i) ? 'mechanical' : pct < GLANCE_PCT ? 'glance' : 'skip'
    return { ts: new Date(ms(r.ts)).toISOString(), device, kind, pct, artist: r.ar ?? '', title: r.ti ?? '', album: r.al ?? '', genre: r.g ?? '' }
  })
}

/** One iPod round-trip ledger entry: songs played offline since the last sync. */
export interface IpodLedgerEntry {
  kind?: string
  when?: string
  plays?: Array<{ id: number; delta?: number; lastPlayedMs?: number }>
}

/** iPod plays become listens at the time the iPod recorded. A delta above 1
 *  means the song played more than once; only the latest time is known, so
 *  every copy carries it. Titles come from the library by id. */
export function fromIpodLedger(
  entries: readonly IpodLedgerEntry[],
  trackById: (id: number) => { artist?: string; title?: string; album?: string; genre?: string } | undefined,
): Listen[] {
  const out: Listen[] = []
  for (const e of entries) {
    if (e.kind && e.kind !== 'roundtrip') continue
    for (const p of e.plays ?? []) {
      const when = Number.isFinite(p.lastPlayedMs) ? p.lastPlayedMs! : ms(e.when ?? '')
      if (!Number.isFinite(when)) continue
      const t = trackById(p.id)
      for (let n = 0; n < Math.max(1, Math.round(p.delta ?? 1)); n++) {
        out.push({ ts: new Date(when).toISOString(), device: 'ipod', kind: 'play', pct: 100, artist: t?.artist ?? '', title: t?.title ?? '', album: t?.album ?? '', genre: t?.genre ?? '', trackId: p.id })
      }
    }
  }
  return out
}

/** Identity of a song for joining and counting: folded artist + title. */
export function songKey(artist: string, title: string): string {
  const f = (s: string): string => foldAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return `${f(artist)}|${f(title)}`
}

/** Union of the device histories, exact duplicates dropped, in time order. */
export function mergeHistories(lists: readonly Listen[][]): Listen[] {
  const seen = new Set<string>()
  const out: Listen[] = []
  for (const l of lists.flat()) {
    const k = `${l.device}|${l.ts}|${songKey(l.artist, l.title)}|${l.kind}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(l)
  }
  return out.sort((a, b) => ms(a.ts) - ms(b.ts))
}

/** Attach library ids by artist + title. A key two library rows share stays
 *  unattached unless one of them is the only copy with plays — never a guess. */
export function attachTrackIds<L extends Listen>(
  listens: L[],
  library: ReadonlyArray<{ id: number; artist?: string; albumArtist?: string; title?: string; playCount?: number }>,
): L[] {
  const byKey = new Map<string, number[]>()
  for (const t of library) {
    for (const a of new Set([t.artist ?? '', t.albumArtist ?? ''])) {
      if (!a) continue
      const k = songKey(a, t.title ?? '')
      const arr = byKey.get(k) ?? []
      if (!arr.includes(t.id)) arr.push(t.id)
      byKey.set(k, arr)
    }
  }
  const played = new Set(library.filter((t) => (t.playCount ?? 0) > 0).map((t) => t.id))
  return listens.map((l) => {
    if (l.trackId !== undefined) return l
    const ids = byKey.get(songKey(l.artist, l.title)) ?? []
    const pick = ids.length === 1 ? ids[0] : ids.filter((id) => played.has(id)).length === 1 ? ids.find((id) => played.has(id)) : undefined
    return pick === undefined ? l : { ...l, trackId: pick }
  })
}

export interface HistorySummary {
  year: number
  byDeviceMonth: Record<string, Record<string, Record<ListenKind, number>>>
  totals: Record<ListenKind, number>
  minutesListened: number
  minutesKnownFor: number
  topArtists: Array<{ artist: string; plays: number }>
  topSongs: Array<{ artist: string; title: string; plays: number }>
  firstListen: string | null
  lastListen: string | null
}

const zero = (): Record<ListenKind, number> => ({ play: 0, skip: 0, glance: 0, mechanical: 0 })

/** The year at a glance. Minutes count plays only (duration × share played)
 *  where the song's length is known; minutesKnownFor says how many plays
 *  that covers, so the number never pretends to be complete. */
export function summarize(listens: readonly Listen[], year: number, durationMsOf: (l: Listen) => number | undefined, top = 25): HistorySummary {
  const byDeviceMonth: HistorySummary['byDeviceMonth'] = {}
  const totals = zero()
  let minutes = 0
  let known = 0
  const artists = new Map<string, { name: string; n: number }>()
  const songs = new Map<string, { artist: string; title: string; n: number }>()
  let first = null as string | null
  let last = null as string | null
  for (const l of listens) {
    if (new Date(l.ts).getUTCFullYear() !== year) continue
    const month = l.ts.slice(5, 7)
    const dev = (byDeviceMonth[l.device] ??= {})
    const cell = (dev[month] ??= zero())
    cell[l.kind]++
    totals[l.kind]++
    if (l.kind !== 'play') continue
    first = first === null || l.ts < first ? l.ts : first
    last = last === null || l.ts > last ? l.ts : last
    const d = durationMsOf(l)
    if (d && d > 0) { minutes += (d * l.pct) / 100 / 60000; known++ }
    const ak = songKey(l.artist, '')
    if (ak !== '|') {
      const a = artists.get(ak) ?? { name: l.artist, n: 0 }
      a.n++
      artists.set(ak, a)
    }
    const sk = songKey(l.artist, l.title)
    const s = songs.get(sk) ?? { artist: l.artist, title: l.title, n: 0 }
    s.n++
    songs.set(sk, s)
  }
  return {
    year,
    byDeviceMonth,
    totals,
    minutesListened: Math.round(minutes),
    minutesKnownFor: known,
    topArtists: [...artists.values()].sort((a, b) => b.n - a.n).slice(0, top).map((a) => ({ artist: a.name, plays: a.n })),
    topSongs: [...songs.values()].sort((a, b) => b.n - a.n).slice(0, top).map((s) => ({ artist: s.artist, title: s.title, plays: s.n })),
    firstListen: first,
    lastListen: last,
  }
}

export interface WindowStats {
  since: string
  until: string
  totals: Record<ListenKind, number>
  byDevice: Record<string, Record<ListenKind, number>>
  /** skips ÷ (plays + skips) — glances and mechanical bursts are not verdicts. */
  realSkipRate: number | null
  /** plays ÷ (plays + skips). */
  completionRate: number | null
}

/** The honest skip numbers for a window (the weekly KPI's 28 days): every
 *  device, real skips only. The old report read one device and counted the
 *  bursts — 75.7% "skip rate" on 2026-10-10 when the real one was 6.8%. */
export function windowStats(listens: readonly Listen[], sinceMs: number, untilMs: number): WindowStats {
  const totals = zero()
  const byDevice: WindowStats['byDevice'] = {}
  for (const l of listens) {
    const t = ms(l.ts)
    if (!(t >= sinceMs && t < untilMs)) continue
    totals[l.kind]++
    ;(byDevice[l.device] ??= zero())[l.kind]++
  }
  const verdicts = totals.play + totals.skip
  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    totals,
    byDevice,
    realSkipRate: verdicts ? Math.round((totals.skip / verdicts) * 10000) / 10000 : null,
    completionRate: verdicts ? Math.round((totals.play / verdicts) * 10000) / 10000 : null,
  }
}
