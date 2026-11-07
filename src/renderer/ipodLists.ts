// iPod lists — renderer store (2026-11-07). Jake: "the evil ipod gets a playlist
// like the top 1000 ipod does". Every iPod but the Original carries a list that
// homemini writes (contract src/common/ipod-list-doc.ts); main reads it
// (src/main/ipc/ipod-lists-ipc.ts, falling back to that iPod's pool file) and
// this store holds each list's song ids in LIST ORDER (newest first) for the
// sidebar's playlist per iPod. Sidebar only: never synced to the Original.
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
  source: 'homemini' | 'local'
  note: string | null
}

let snap: IpodListEntry[] = []
let inFlight: Promise<void> | null = null
let deviceWatch = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): IpodListEntry[] => snap

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
      snap = r.lists.map((l) => ({
        id: String(l.id),
        name: String(l.name),
        color: l.color ?? null,
        purpose: l.purpose ?? null,
        ids: (Array.isArray(l.ids) ? l.ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0),
        source: l.source === 'homemini' ? 'homemini' : 'local',
        note: typeof l.note === 'string' && l.note ? l.note : null,
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
