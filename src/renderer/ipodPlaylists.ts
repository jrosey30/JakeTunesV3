// The playlists on each iPod — renderer store (2026-11-14). Jake: "default
// playlists are standard for each ipod, like it was back in the day"; "i also
// have the ability to create my own per ipod playlist, if i so choose".
//
// Per iPod (keyed 'top1000' for the Original, its list id otherwise):
//   - its DEFAULTS, worked out here from its songs with the sync's own code
//     (utils/ipodDeviceDefaults.ts), with homemini's verified BPMs;
//   - its On-The-Go lists and Jake's own, from main (main/ipc/ipod-playlists-ipc.ts):
//     homemini's last answer with what this Mac is still waiting to send laid over it.
// Shown in the one order: defaults, On-The-Go, then the rest A to Z.
//
// A write changes the store at once (it is on this Mac's disk when main answers),
// then asks main for a fresh read, which sends what is waiting to homemini.
// While an iPod is on screen it is asked again on focus, every 5 minutes and when
// the library-version poll moves (ipodPlaylistsLive.ts, Brief 250).
// Same module-store idiom as ipodLists.ts.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Track } from './types'
import type { IpodPlaylistRow, IpodPlaylistsAnswer } from '../common/ipod-playlists-view'
import { ipodDefaultPlaylists, type IpodDefaultPlaylist } from './utils/ipodDeviceDefaults'
import { createIpodPlaylistsLive } from './ipodPlaylistsLive'

export type { IpodPlaylistRow }

export interface IpodPlaylistsState {
  rows: IpodPlaylistRow[]
  from: 'homemini' | 'kept' | 'none'
  loaded: boolean
}

const EMPTY: IpodPlaylistsState = { rows: [], from: 'none', loaded: false }
const byDevice = new Map<string, IpodPlaylistsState>()
const inFlight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version++
  for (const l of listeners) l()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getVersion = (): number => version

function take(device: string, r: IpodPlaylistsAnswer | null | undefined): void {
  if (!r?.ok) return
  byDevice.set(device, { rows: r.playlists, from: r.from, loaded: true })
  emit()
}

/** Ask main for one iPod's playlists: the disk copy at once (first paint), then a fresh read. */
export function refreshIpodPlaylists(device: string, ipodName: string, fresh = true): Promise<void> {
  const api = window.electronAPI
  if (!api.ipodPlaylistsGet) return Promise.resolve()
  if (!byDevice.get(device)?.loaded) {
    void api.ipodPlaylistsGet(device, { fresh: false }).then((r) => { if (!byDevice.get(device)?.loaded) take(device, r) }).catch(() => undefined)
  }
  if (!fresh) return Promise.resolve()
  const running = inFlight.get(device)
  if (running) return running
  const p = api.ipodPlaylistsGet(device, { fresh: true, ipodName })
    .then((r) => take(device, r))
    .catch((err: unknown) => { console.warn('[ipod-playlists] read failed:', err instanceof Error ? err.message : err) })
    .finally(() => { inFlight.delete(device) })
  inFlight.set(device, p)
  return p
}

const live = createIpodPlaylistsLive({
  refresh: (device, ipodName) => refreshIpodPlaylists(device, ipodName),
  now: () => Date.now(),
  visible: () => document.visibilityState !== 'hidden',
  every: (fn, ms) => { const id = window.setInterval(fn, ms); return () => window.clearInterval(id) },
  onWake: (fn) => {
    const onVisible = (): void => { if (document.visibilityState === 'visible') fn() }
    window.addEventListener('focus', fn)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', fn)
      document.removeEventListener('visibilitychange', onVisible)
    }
  },
  // Replicas only (workmini): the canonical Mac runs no library-version poll.
  onLibraryMoved: (fn) => window.electronAPI.onHubCatalogUpdated?.(() => fn()) ?? (() => {}),
})

/** One iPod's stored playlists (On-The-Go, Jake's own, approved AI ones), in order. `enabled` false = don't ask yet.
 *  Kept fresh while mounted and enabled: focus, every 5 minutes, the library-version poll. */
export function useIpodPlaylists(device: string | null, ipodName: string, enabled = true): IpodPlaylistsState {
  useSyncExternalStore(subscribe, getVersion)
  useEffect(() => {
    if (!device || !enabled) return
    return live.watch(device, ipodName)
  }, [device, ipodName, enabled])
  return (device && byDevice.get(device)) || EMPTY
}

/** Without asking main (for menus: whatever is known now). */
export function ipodPlaylistsNow(device: string): IpodPlaylistsState {
  return byDevice.get(device) ?? EMPTY
}
export function useIpodPlaylistsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion)
}

// ── verified BPMs (for the BPM defaults) ─────────────────────────────────

const bpm = new Map<number, number>()
const bpmAsked = new Set<number>()
let bpmKnown = false

function askBpm(ids: readonly number[]): void {
  const want = ids.filter((id) => !bpmAsked.has(id))
  if (!want.length || !window.electronAPI.ipodPlaylistsBpm) return
  for (const id of want) bpmAsked.add(id)
  void window.electronAPI.ipodPlaylistsBpm(want).then((r) => {
    if (!r?.ok) return
    for (const [k, v] of Object.entries(r.bpm)) bpm.set(Number(k), v)
    bpmKnown = bpmKnown || r.known
    emit()
  }).catch(() => { for (const id of want) bpmAsked.delete(id) })
}

// ── the defaults ─────────────────────────────────────────────────────────

const defaultsMemo = new Map<string, { key: string; value: IpodDefaultPlaylist[] }>()

/**
 * The iPod's own list and its defaults, as its Sync would write them today. Worked
 * out only while `enabled` (an expanded sidebar row, an open page), and kept until
 * the library, the list or the BPMs change.
 */
export function useIpodDefaults(device: string | null, library: readonly Track[], ipodIds: readonly number[], setName: string, enabled = true): IpodDefaultPlaylist[] {
  const v = useSyncExternalStore(subscribe, getVersion)
  useEffect(() => { if (device && enabled) askBpm(ipodIds) }, [device, enabled, ipodIds])
  return useMemo(() => {
    if (!device || !enabled) return []
    const key = `${ipodIds.length}:${ipodIds[0] ?? ''}:${ipodIds[ipodIds.length - 1] ?? ''}:${setName}:${bpm.size}:${library.length}`
    const memo = defaultsMemo.get(device)
    if (memo && memo.key === key && memo.value) return memo.value
    const value = ipodDefaultPlaylists({ library: library as Track[], ipodIds, setName, original: device === 'top1000', verifiedBpm: bpm })
    defaultsMemo.set(device, { key, value })
    return value
    // `v` moves when the BPMs arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, enabled, library, ipodIds, setName, v])
}

export const bpmIsKnown = (): boolean => bpmKnown

// ── writes ───────────────────────────────────────────────────────────────

type WriteResult = { ok: true; id: string } | { ok: false; error: string }

function optimistic(device: string, change: (rows: IpodPlaylistRow[]) => IpodPlaylistRow[]): () => void {
  const before = byDevice.get(device) ?? EMPTY
  byDevice.set(device, { ...before, rows: change(before.rows), loaded: true })
  emit()
  return () => { byDevice.set(device, before); emit() }
}

async function afterWrite(device: string, ipodName: string, r: Awaited<ReturnType<NonNullable<typeof window.electronAPI.ipodPlaylistsSave>>> | undefined, undo: () => void): Promise<WriteResult> {
  if (!r?.ok) {
    undo()
    return { ok: false, error: r?.error ?? 'This build can’t save iPod playlists.' }
  }
  take(device, r.view)
  // Sends what is waiting to homemini, then reads its answer.
  void refreshIpodPlaylists(device, ipodName)
  return { ok: true, id: r.id }
}

/** A new playlist on this iPod (Jake's own). */
export async function createIpodPlaylist(input: { device: string; ipodName: string; name: string; trackIds: number[]; defaults: string[]; alsoOnIpod?: number[] }): Promise<WriteResult> {
  const r = await window.electronAPI.ipodPlaylistsSave?.({ device: input.device, name: input.name, trackIds: input.trackIds, defaults: input.defaults, ipodName: input.ipodName, alsoOnIpod: input.alsoOnIpod })
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t make the playlist' }))
  return afterWrite(input.device, input.ipodName, r, () => {})
}

/** Rename, or set the songs (add, remove, reorder: "these songs, in this order"). */
export async function saveIpodPlaylist(input: { device: string; ipodName: string; id: string; name?: string; trackIds?: number[]; defaults: string[]; alsoOnIpod?: number[] }): Promise<WriteResult> {
  const undo = optimistic(input.device, (rows) => rows.map((p) => p.id === input.id
    ? { ...p, ...(input.name !== undefined ? { name: input.name.replace(/\s+/g, ' ').trim() } : {}), ...(input.trackIds ? { trackIds: input.trackIds } : {}), waiting: true }
    : p))
  const r = await window.electronAPI.ipodPlaylistsSave?.({ device: input.device, id: input.id, name: input.name, trackIds: input.trackIds, defaults: input.defaults, ipodName: input.ipodName, alsoOnIpod: input.alsoOnIpod })
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t save the playlist' }))
  return afterWrite(input.device, input.ipodName, r, undo)
}

export async function deleteIpodPlaylist(input: { device: string; ipodName: string; id: string }): Promise<WriteResult> {
  const undo = optimistic(input.device, (rows) => rows.filter((p) => p.id !== input.id))
  const r = await window.electronAPI.ipodPlaylistsDelete?.({ device: input.device, id: input.id })
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t delete the playlist' }))
  return afterWrite(input.device, input.ipodName, r, undo)
}

/** Answer a playlist homemini held: put its songs on the iPod too, take them out, or rename it. */
export async function answerIpodPlaylist(input: { device: string; ipodName: string; id: string; choice: 'add' | 'drop' | 'rename'; name?: string; defaults?: string[] }): Promise<WriteResult> {
  const r = await window.electronAPI.ipodPlaylistsAnswer?.(input)
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t save the answer' }))
  return afterWrite(input.device, input.ipodName, r, () => {})
}

// ── which page is open ───────────────────────────────────────────────────

/** The iPod playlist 'ipod-playlist' shows: `${device}/${id}`. Module store, like mixtapes.ts's tape. */
let openKey: string | null = null
const openListeners = new Set<() => void>()
export function setOpenIpodPlaylist(device: string, id: string): void {
  openKey = `${device}/${id}`
  for (const l of openListeners) l()
}
export function setOpenIpodPlaylistKey(key: string | null): void {
  openKey = key
  for (const l of openListeners) l()
}
export function subscribeOpenIpodPlaylist(cb: () => void): () => void {
  openListeners.add(cb)
  return () => { openListeners.delete(cb) }
}
export const getOpenIpodPlaylistKey = (): string | null => openKey
export function useOpenIpodPlaylist(): { device: string; id: string } | null {
  const k = useSyncExternalStore(subscribeOpenIpodPlaylist, getOpenIpodPlaylistKey)
  if (!k) return null
  const at = k.indexOf('/')
  return at > 0 ? { device: k.slice(0, at), id: k.slice(at + 1) } : null
}

// ── the iPods the sidebar knows (for menus away from the sidebar) ─────────

export interface KnownIpod {
  device: string
  ipodName: string
  setName: string
  ipodIds: readonly number[]
  /** Its defaults' names once worked out (the row has been open); null = not yet. */
  defaultNames: readonly string[] | null
}
const known = new Map<string, KnownIpod>()
/** The sidebar's iPODS rows say which iPods there are, in their order. */
export function rememberIpod(k: KnownIpod): void {
  const was = known.get(k.device)
  known.set(k.device, { ...k, defaultNames: k.defaultNames ?? was?.defaultNames ?? null })
}
export function knownIpods(): KnownIpod[] {
  return [...known.values()]
}
export function knownIpod(device: string): KnownIpod | null {
  return known.get(device) ?? null
}
