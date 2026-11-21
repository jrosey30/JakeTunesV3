/**
 * iPod songs stay on this Mac (2026-11-08).
 *
 * Jake, after several syncs that had to fetch songs from homemini over a slow
 * Tailscale relay in the middle of the sync: "why cant we know and catch this
 * before it happens". The answer: a sync never depends on a live fetch. Every
 * song on any iPod's list is kept on the Mac Jake syncs from:
 *
 *   • the Original's Top 1000 (homemini GET /api/top1000), and
 *   • every list homemini keeps (GET /api/ipod-lists): the registered iPods'
 *     lists AND the lists planned for an iPod not set up yet ("Best of
 *     Bandcamp", "Y2K Revival", "Totally 80s").
 *
 * This module decides WHICH songs (the keep set) and answers the two eviction
 * routes on this Mac:
 *
 *   • pass-through eviction (library-eviction.ts sweepOnce: trash after
 *     homemini's md5 matches) asks by "F##/file";
 *   • the stream-convert queue (index.ts runStreamConvertPass → convert a real
 *     file to a link to homemini) asks by colon path.
 *
 * A song the keep set names is never evicted by either; it stays queued for
 * stream-convert, so a song that later leaves every list is offloaded as
 * before. Nothing here deletes or rewrites a library file: it only says "not
 * this one". Bringing evicted songs back is ipod-prefetch.ts.
 *
 * Which machine: only the one Jake syncs from, the hub (not a replica:
 * library.streamSource / streamRoot unset). That is the same test the "ready
 * for an updated sync" notice uses (ipod-sync-ready-start.ts). A replica
 * (workmini; homemini's own app) is untouched: its gate is 'off'.
 *
 * Fail closed. Until one clean read of BOTH sources has happened (none saved
 * either), the gate is 'hold': this Mac evicts nothing at all, because it
 * can't tell which songs an iPod needs. A later read where a source fails
 * never shrinks the set: the last saved songs stay kept until a clean read
 * says otherwise.
 *
 * No free-space floor on the keep set (2026-11-20, Brief 263). From 2026-11-13
 * to 11-20, under 30 GB free only the Top 1000 stayed kept and every other list
 * song could be offloaded. On 2026-11-20 the MacBook was 97% full and the
 * stream-convert pass offloaded 89 iPod list songs in one afternoon (Kraken,
 * on punkPod since 11-14, at 20:33Z); punkPod's next sync then stalled at Get
 * ready. Jake: "this shit needs to just work." A song on ANY iPod list is now
 * never offloaded, whatever the disk says. Room is made from songs on no list.
 *
 * Fresh or nothing. The keep set is the union of the last read from homemini
 * (this file) and the sidebar's copy of homemini's lists (ipod-lists-cache.json,
 * often newer): a list added there is kept before this file is re-read. When
 * the last clean read is older than KEEP_STALE_MS, the gate holds: nothing is
 * offloaded until homemini answers again (offloading needs homemini anyway).
 *
 * The background download (ipod-prefetch.ts) still brings a song back only when
 * that leaves IPOD_KEEP_FETCH_FLOOR_BYTES free (80 GB), Jake's Wait 60 GB, so
 * iPod songs never crowd his new music off this Mac. A song not on this Mac at
 * sync time is fetched by the sync itself (ipod-sync-fetch.ts).
 *
 * Electron-free; every effect is injected (__tests__/ipod-keep-local.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { ROOMY_ENTER_BYTES, ROOMY_FREE_BYTES } from './offload-keep-recent.ts'

export const KEEP_LOCAL_FILE = 'ipod-keep-local.json'
/** The last clean read of the lists older than this: the gate holds (nothing is offloaded). */
export const KEEP_STALE_MS = 6 * 60 * 60 * 1000
/** The background download never takes this Mac's free disk under this: the edge the
 *  recent-songs windows are entered at (80 GB), so they hold while iPod songs arrive. */
export const IPOD_KEEP_FETCH_FLOOR_BYTES = ROOMY_ENTER_BYTES
/** Jake's Wait (the Device page) may go this far: the edge those windows are left at (60 GB). */
export const IPOD_KEEP_ASKED_FLOOR_BYTES = ROOMY_FREE_BYTES
/** The floor one download pass runs with. `asked`: Jake asked for this pass. */
export const prefetchFloorFor = (asked: boolean): number => (asked ? IPOD_KEEP_ASKED_FLOOR_BYTES : IPOD_KEEP_FETCH_FLOOR_BYTES)
/** The Original's Top 1000 is never more than this many songs. */
export const IPOD_KEEP_ALWAYS = 1000

/**
 * The Original's Top 1000 as this doc knows it, by identity (carried across a
 * read where homemini didn't answer for it). null = this doc can't say.
 */
export function alwaysKeptIds(doc: KeepLocalDoc): number[] | null {
  if (Array.isArray(doc.top1000)) return doc.top1000.slice(0, IPOD_KEEP_ALWAYS)
  // An older doc from a clean read: the Top 1000 was added first, so it is the head.
  const first = doc.sources[0]
  if (doc.complete && first?.key === 'top1000') return doc.ids.slice(0, Math.min(first.count, IPOD_KEEP_ALWAYS))
  return null
}

export interface KeepSourceSummary {
  /** 'top1000', or an iPod list's marker id. */
  key: string
  name: string
  count: number
  /** An iPod registered on this Mac (the Original counts). */
  registered: boolean
}

export interface KeepLocalDoc {
  version: 1
  /** When the songs were last read from homemini. */
  at: string
  /** Every kept song id, in fetch priority: the Original's Top 1000 by rank,
   *  then each registered iPod's list, then the planned lists. No repeats. */
  ids: number[]
  sources: KeepSourceSummary[]
  /** false: some source didn't answer, so the previous songs were kept on. */
  complete: boolean
  /** The Original's Top 1000 as last read clean (2026-11-13). Absent on older docs. */
  top1000?: number[]
  /** When both sources last answered (2026-11-20): the gate's freshness. Absent on older docs (then `at` when complete). */
  cleanAt?: string
}

export interface KeepListInput { id: string; name: string; ids: readonly number[] }

function songId(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * The keep set from what homemini answered. `top1000` / `lists` null = that
 * source didn't answer. With no previous doc, anything short of both is null
 * (unknown → the gate holds). With one, a failed source keeps its previous
 * songs: the set never shrinks on a bad read.
 */
export function buildKeepDoc(input: {
  top1000: readonly number[] | null
  lists: readonly KeepListInput[] | null
  registered: ReadonlySet<string>
  previous: KeepLocalDoc | null
  now: string
}): KeepLocalDoc | null {
  const complete = input.top1000 !== null && input.lists !== null
  if (!complete && !input.previous) return null
  const ids: number[] = []
  const seen = new Set<number>()
  const add = (raw: unknown): void => {
    const id = songId(raw)
    if (id === null || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  const sources: KeepSourceSummary[] = []
  // The Top 1000 goes first whichever answer arrived: this read's, or the last
  // good copy when homemini didn't answer for it. (It used to go LAST on such
  // a read, and the floor then protected 1,000 list songs instead.)
  const lastTop = input.previous ? alwaysKeptIds(input.previous) : null
  const top: number[] | null = input.top1000
    ? input.top1000.map(songId).filter((n): n is number => n !== null)
    : lastTop
  if (top) for (const id of top) add(id)
  if (input.top1000) sources.push({ key: 'top1000', name: 'Top 1000', count: input.top1000.length, registered: true })
  else if (lastTop) {
    const was = input.previous!.sources.find((s) => s.key === 'top1000')
    sources.push(was ?? { key: 'top1000', name: 'Top 1000', count: lastTop.length, registered: true })
  }
  if (input.lists) {
    const ordered = [...input.lists].sort((a, b) => Number(input.registered.has(b.id)) - Number(input.registered.has(a.id)))
    for (const l of ordered) {
      for (const id of l.ids) add(id)
      sources.push({ key: l.id, name: l.name, count: l.ids.length, registered: input.registered.has(l.id) })
    }
  }
  if (!complete && input.previous) {
    for (const id of input.previous.ids) add(id)
    const have = new Set(sources.map((s) => s.key))
    for (const s of input.previous.sources) if (!have.has(s.key)) sources.push(s)
  }
  const cleanAt = complete ? input.now : lastCleanAt(input.previous)
  return { version: 1, at: input.now, ids, sources, complete, ...(top ? { top1000: top } : {}), ...(cleanAt ? { cleanAt } : {}) }
}

/** When homemini last answered for both sources, or null (never, as far as this doc says). */
export function lastCleanAt(doc: KeepLocalDoc | null): string | null {
  if (!doc) return null
  if (typeof doc.cleanAt === 'string') return doc.cleanAt
  return doc.complete ? doc.at : null
}

export function parseKeepDoc(raw: unknown): KeepLocalDoc | null {
  const r = raw as Partial<KeepLocalDoc> | null
  if (!r || typeof r !== 'object' || r.version !== 1 || !Array.isArray(r.ids) || typeof r.at !== 'string') return null
  const ids = r.ids.map(songId).filter((n): n is number => n !== null)
  const sources = Array.isArray(r.sources)
    ? r.sources.filter((s) => s && typeof s.key === 'string').map((s) => ({ key: s.key, name: String(s.name || s.key), count: Number(s.count) || 0, registered: s.registered === true }))
    : []
  const top1000 = Array.isArray(r.top1000) ? r.top1000.map(songId).filter((n): n is number => n !== null) : null
  const cleanAt = typeof r.cleanAt === 'string' && Number.isFinite(Date.parse(r.cleanAt)) ? r.cleanAt : null
  return { version: 1, at: r.at, ids, sources, complete: r.complete === true, ...(top1000 ? { top1000 } : {}), ...(cleanAt ? { cleanAt } : {}) }
}

export function sameKeepSongs(a: KeepLocalDoc | null, b: KeepLocalDoc | null): boolean {
  if (!a || !b) return a === b
  if (a.ids.length !== b.ids.length) return false
  for (let i = 0; i < a.ids.length; i++) if (a.ids[i] !== b.ids[i]) return false
  return true
}

/** ":iPod_Control:Music:F07:imported_1.m4a" → "F07/imported_1.m4a" (the eviction walk's shape). */
export function relOfColon(colon: string): string | null {
  const m = String(colon || '').match(/:iPod_Control:Music:(F\d\d):([^:]+)$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * What the eviction routes ask.
 *   off  — this Mac isn't the one Jake syncs from: nothing is exempted.
 *   hold — the songs aren't known yet: keep EVERYTHING (evict nothing).
 *   keep — keep exactly these paths.
 */
export type KeepGate =
  | { kind: 'off' }
  | { kind: 'hold'; why: string }
  | { kind: 'keep'; colons: ReadonlySet<string>; rels: ReadonlySet<string>; count: number }

export function gateFor(
  applies: boolean,
  doc: KeepLocalDoc | null,
  tracks: ReadonlyArray<{ id?: unknown; path?: unknown }>,
  opts: {
    /** Now, for freshness. Absent (pure callers, old tests): freshness isn't judged. */
    now?: number
    /** More songs on an iPod list from a newer copy of homemini's answer (ipod-lists-cache.json). */
    extraIds?: readonly number[] | null
  } = {},
): KeepGate {
  if (!applies) return { kind: 'off' }
  if (!doc) return { kind: 'hold', why: 'the iPod lists haven’t been read from homemini yet' }
  if (opts.now !== undefined) {
    const clean = lastCleanAt(doc)
    const cleanMs = clean ? Date.parse(clean) : Number.NaN
    if (!Number.isFinite(cleanMs)) return { kind: 'hold', why: 'homemini hasn’t answered for every iPod list yet' }
    if (opts.now - cleanMs > KEEP_STALE_MS) return { kind: 'hold', why: `the iPod lists were last read from homemini at ${clean}, over ${KEEP_STALE_MS / 3_600_000} hours ago` }
  }
  // Every song on any list, whatever the disk says (2026-11-20): never a lapse.
  const want = new Set<number>(doc.ids)
  for (const id of doc.top1000 ?? []) want.add(id)
  for (const raw of opts.extraIds ?? []) { const id = songId(raw); if (id !== null) want.add(id) }
  const colons = new Set<string>()
  const rels = new Set<string>()
  for (const t of tracks) {
    const id = songId(t?.id)
    if (id === null || !want.has(id)) continue
    const colon = String(t.path || '')
    if (!colon) continue
    colons.add(colon)
    const rel = relOfColon(colon)
    if (rel) rels.add(rel)
  }
  return { kind: 'keep', colons, rels, count: want.size }
}

/** The stream-convert route: true = leave this file local. */
export function keepsColon(gate: KeepGate, colon: string): boolean {
  if (gate.kind === 'off') return false
  if (gate.kind === 'hold') return true
  return gate.colons.has(colon)
}

/** The pass-through sweep: true = leave this file local. */
export function keepsRel(gate: KeepGate, rel: string): boolean {
  if (gate.kind === 'off') return false
  if (gate.kind === 'hold') return true
  return gate.rels.has(rel)
}

export interface KeepLocalHost {
  userDataDir: string
  /** true on the Mac Jake syncs from (not a replica). A throw reads as false. */
  applies: () => Promise<boolean>
  /** homemini's Top 1000 ids; null = no clean answer. */
  top1000: () => Promise<number[] | null>
  /** Every list homemini keeps; null = no clean answer. */
  lists: () => Promise<KeepListInput[] | null>
  /** Marker ids of the iPods registered on this Mac. */
  registered: () => Promise<Set<string>>
  libraryTracks: () => Promise<ReadonlyArray<{ id?: unknown; path?: unknown }>>
  /** Song ids of every list in the sidebar's copy of homemini's answer (ipod-lists-cache.json); null = none. */
  cachedListIds?: () => Promise<number[] | null>
  now?: () => number
  log?: (msg: string) => void
  /** Persisted (main.log): a hold, once per change. */
  warn?: (msg: string) => void
}

export interface IpodKeepLocal {
  /** Re-read the songs from homemini; saves and returns the doc (null = still unknown). */
  refresh(): Promise<{ doc: KeepLocalDoc | null; changed: boolean }>
  /** The doc as last saved (read from disk once). */
  current(): Promise<KeepLocalDoc | null>
  /** What the eviction routes ask right now. */
  gate(): Promise<KeepGate>
}

export function createIpodKeepLocal(host: KeepLocalHost): IpodKeepLocal {
  const file = join(host.userDataDir, KEEP_LOCAL_FILE)
  let doc: KeepLocalDoc | null | undefined
  const now = host.now ?? Date.now
  let lastGateWord = ''

  async function current(): Promise<KeepLocalDoc | null> {
    if (doc !== undefined) return doc
    try {
      doc = parseKeepDoc(JSON.parse(await readFile(file, 'utf-8')))
    } catch {
      doc = null   // never saved: the gate holds until the first clean read
    }
    return doc
  }

  async function refresh(): Promise<{ doc: KeepLocalDoc | null; changed: boolean }> {
    const previous = await current()
    const [top1000, lists, registered] = await Promise.all([
      host.top1000().catch(() => null),
      host.lists().catch(() => null),
      host.registered().catch(() => new Set<string>()),
    ])
    const next = buildKeepDoc({ top1000, lists, registered, previous, now: new Date(now()).toISOString() })
    if (!next) return { doc: previous, changed: false }
    const changed = !sameKeepSongs(previous, next)
    doc = next
    try {
      await writeJsonAtomic(file, next)
    } catch (err) {
      host.log?.(`[ipod-local] could not save the iPod songs list: ${err instanceof Error ? err.message : err}`)
    }
    return { doc: next, changed }
  }

  async function gate(): Promise<KeepGate> {
    const applies = await host.applies().catch(() => false)
    const d = applies ? await current() : null
    const tracks = applies && d ? await host.libraryTracks().catch(() => []) : []
    const extraIds = applies && d && host.cachedListIds ? await host.cachedListIds().catch(() => null) : null
    const g = gateFor(applies, d, tracks, { now: now(), extraIds })
    const word = g.kind === 'keep' ? `keep ${g.count}` : g.kind === 'hold' ? `hold: ${g.why}` : 'off'
    if (word !== lastGateWord) {
      lastGateWord = word
      if (g.kind === 'hold') (host.warn ?? host.log)?.(`[ipod-local] offloading nothing: ${g.why}`)
      else if (g.kind === 'keep') host.log?.(`[ipod-local] keeping ${g.count} iPod song(s) on this Mac`)
    }
    return g
  }

  return { refresh, current, gate }
}
