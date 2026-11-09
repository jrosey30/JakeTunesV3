// iPod lists — renderer store (2026-11-07). Jake: "the evil ipod gets a playlist
// like the top 1000 ipod does". Every iPod but the Original carries a list that
// homemini writes (contract src/common/ipod-list-doc.ts); main reads them
// (src/main/ipod-lists-gather.ts: every list homemini keeps, registered here or
// not, its last answer kept for when it can't answer; on the hub a registered
// iPod's list falls back to its pool file) and this store holds each list's song
// ids in LIST ORDER (newest first) for the sidebar's iPODS section. `role` says
// whether this Mac is the hub (syncs iPods) or a replica (plain playlists).
// Sidebar only: never synced to the Original.
// Same module-store idiom as top1000List.ts.
import { useEffect, useSyncExternalStore } from 'react'
import { isIpodModel, normalizeIpodColor, IPOD_DEFAULT_COLOR, type IpodModel } from '../common/ipod-covers'

export interface IpodListEntry {
  /** The iPod's marker id. */
  id: string
  name: string
  /** The cover's iPod colour (a named iPod colour or '#rrggbb'), resolved by main. */
  color: string | null
  /** The cover's iPod model; 'default' when the list has none. */
  model: IpodModel
  purpose: string | null
  /** Song ids, newest first. */
  ids: number[]
  source: 'homemini' | 'local' | 'cache'
  note: string | null
  /** An iPod in this Mac's registry carries it (hub). */
  registered: boolean
}

export type IpodListsRole = 'hub' | 'replica'

let snap: IpodListEntry[] = []
let role: IpodListsRole | null = null
let inFlight: Promise<void> | null = null
let deviceWatch = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): IpodListEntry[] => snap
const getRole = (): IpodListsRole | null => role

/** Ask main for every list once per call; overlapping asks share one read. */
export function refreshIpodLists(): Promise<void> {
  if (inFlight) return inFlight
  const api = window.electronAPI
  if (!deviceWatch && api.onIpodDeviceChanged) {
    deviceWatch = true
    api.onIpodDeviceChanged(() => { void refreshIpodLists() })
  }
  inFlight = (api.ipodListsGet?.() ?? Promise.resolve({ ok: false as const }))
    .then((r) => {
      if (!r?.ok || !Array.isArray(r.lists)) return
      role = r.role === 'hub' ? 'hub' : r.role === 'replica' ? 'replica' : null
      snap = r.lists.map((l) => ({
        id: String(l.id),
        name: String(l.name),
        color: normalizeIpodColor(l.color),
        model: isIpodModel(l.model) ? l.model : 'default',
        purpose: l.purpose ?? null,
        ids: (Array.isArray(l.ids) ? l.ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0),
        source: l.source === 'homemini' ? 'homemini' : l.source === 'cache' ? 'cache' : 'local',
        note: typeof l.note === 'string' && l.note ? l.note : null,
        registered: l.registered === true,
      }))
      for (const l of listeners) l()
    })
    .catch((err: unknown) => { console.warn('[ipod-lists] read failed:', err instanceof Error ? err.message : err) })
    .finally(() => { inFlight = null })
  return inFlight
}

/** Every non-Original iPod's list. Mounting asks for fresh lists: homemini adds
 *  to them on its own (Claude, the brain), so a view opens on the current one. */
export function useIpodLists(): IpodListEntry[] {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => { void refreshIpodLists() }, [])
  return s
}

/** 'hub' (the MacBook, which syncs iPods) or 'replica' (homemini's and workmini's
 *  apps: the lists are plain playlists); null until main has answered once. */
export function useIpodListsRole(): IpodListsRole | null {
  const r = useSyncExternalStore(subscribe, getRole)
  useEffect(() => { void refreshIpodLists() }, [])
  return r
}

/**
 * "iPod color…" (2026-11-09): the cover changes at once, then main keeps the
 * colour and tells homemini (or holds it until homemini answers). On a refusal
 * the old colour comes back.
 */
export async function setIpodListColor(deviceId: string, color: string): Promise<{ ok: true; homemini: 'saved' | 'later' } | { ok: false; error: string }> {
  const c = normalizeIpodColor(color)
  if (!c) return { ok: false, error: 'That isn’t a colour JakeTunes knows.' }
  const before = snap
  snap = snap.map((l) => (l.id === deviceId ? { ...l, color: c } : l))
  for (const l of listeners) l()
  const r = await (window.electronAPI.ipodListSetColor?.({ deviceId, color: c }) ?? Promise.resolve({ ok: false as const, error: 'not available' }))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t save the colour' }))
  if (!r.ok) {
    snap = before
    for (const l of listeners) l()
    return r
  }
  void refreshIpodLists()
  return { ok: true, homemini: r.homemini }
}

/**
 * Rename… (2026-11-09): the list's new name shows at once everywhere it is drawn, then main
 * keeps it and tells homemini (or holds it until homemini answers). The iPod keeps its own name.
 * On a refusal the old name comes back and the reason is returned.
 */
export async function renameIpodList(deviceId: string, name: string): Promise<{ ok: true; name: string; homemini: 'saved' | 'later' } | { ok: false; error: string }> {
  const trimmed = name.trim()
  const before = snap
  snap = snap.map((l) => (l.id === deviceId ? { ...l, name: trimmed } : l))
  for (const l of listeners) l()
  const r = await (window.electronAPI.ipodListRename?.({ deviceId, name: trimmed }) ?? Promise.resolve({ ok: false as const, error: 'not available' }))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t rename the list' }))
  if (!r.ok) {
    snap = before
    for (const l of listeners) l()
    return r
  }
  void refreshIpodLists()
  return r
}

/** The colour the cover shows for an entry (its model's default when none). */
export function entryColor(e: Pick<IpodListEntry, 'model' | 'color'>): string {
  return e.color ?? IPOD_DEFAULT_COLOR[e.model]
}

/** The lists as they are now, without asking main again (covers: one per sidebar row). */
export function useIpodListsSnapshot(): IpodListEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}
