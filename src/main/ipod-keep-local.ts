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
 * Electron-free; every effect is injected (__tests__/ipod-keep-local.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'

export const KEEP_LOCAL_FILE = 'ipod-keep-local.json'

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
  if (input.top1000) {
    for (const id of input.top1000) add(id)
    sources.push({ key: 'top1000', name: 'Top 1000', count: input.top1000.length, registered: true })
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
  return { version: 1, at: input.now, ids, sources, complete }
}

export function parseKeepDoc(raw: unknown): KeepLocalDoc | null {
  const r = raw as Partial<KeepLocalDoc> | null
  if (!r || typeof r !== 'object' || r.version !== 1 || !Array.isArray(r.ids) || typeof r.at !== 'string') return null
  const ids = r.ids.map(songId).filter((n): n is number => n !== null)
  const sources = Array.isArray(r.sources)
    ? r.sources.filter((s) => s && typeof s.key === 'string').map((s) => ({ key: s.key, name: String(s.name || s.key), count: Number(s.count) || 0, registered: s.registered === true }))
    : []
  return { version: 1, at: r.at, ids, sources, complete: r.complete === true }
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
): KeepGate {
  if (!applies) return { kind: 'off' }
  if (!doc) return { kind: 'hold', why: 'the iPod lists haven’t been read from homemini yet' }
  const want = new Set(doc.ids)
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
  return { kind: 'keep', colons, rels, count: doc.ids.length }
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
  now?: () => number
  log?: (msg: string) => void
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
    const g = gateFor(applies, d, tracks)
    const word = g.kind === 'keep' ? `keep ${g.count}` : g.kind === 'hold' ? `hold: ${g.why}` : 'off'
    if (word !== lastGateWord) {
      lastGateWord = word
      if (g.kind === 'hold') host.log?.(`[ipod-local] evicting nothing: ${g.why}`)
      else if (g.kind === 'keep') host.log?.(`[ipod-local] keeping ${g.count} iPod song(s) on this Mac`)
    }
    return g
  }

  return { refresh, current, gate }
}
