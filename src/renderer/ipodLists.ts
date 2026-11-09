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

export interface IpodListEntry {
  /** The iPod's marker id. */
  id: string
  name: string
  color: string | null
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
        color: l.color ?? null,
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
