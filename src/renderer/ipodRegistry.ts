// iPod registry — renderer store (2026-11-07). Every iPod this Mac has met
// (main: ipod-devices.json via 'ipod-registry:list'), for the sidebar's iPODS
// section: one row per iPod, plugged in or not. Re-read on a plug-in, a
// rename or register (ipod-device-changed), and on window focus. Same
// module-store idiom as ipodLists.ts.
import { useEffect, useSyncExternalStore } from 'react'
import type { SidebarIpodDevice } from '../common/sidebar-ipods'

let snap: SidebarIpodDevice[] = []
let inFlight: Promise<void> | null = null
let watching = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): SidebarIpodDevice[] => snap

export function refreshIpodRegistry(): Promise<void> {
  if (inFlight) return inFlight
  const api = window.electronAPI
  if (!watching) {
    watching = true
    api.onIpodDeviceChanged?.(() => { void refreshIpodRegistry() })
    window.addEventListener('jaketunes-ipod-mounted', () => { void refreshIpodRegistry() })
    window.addEventListener('focus', () => { void refreshIpodRegistry() })
  }
  inFlight = (api.ipodRegistryList?.() ?? Promise.resolve({ ok: false as const, devices: [] }))
    .then((r) => {
      if (!r?.ok || !Array.isArray(r.devices)) return
      const next = r.devices
        .filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string')
        .map((d) => ({ id: d.id, name: d.name, color: d.color ?? null, primary: d.primary === true }))
      // Same content: keep the old array so the sidebar doesn't redraw on every focus.
      if (JSON.stringify(next) === JSON.stringify(snap)) return
      snap = next
      for (const l of listeners) l()
    })
    .catch((err: unknown) => { console.warn('[ipod-registry] read failed:', err instanceof Error ? err.message : err) })
    .finally(() => { inFlight = null })
  return inFlight
}

/** Every iPod this Mac has met, in the order it met them. */
export function useIpodRegistry(): SidebarIpodDevice[] {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => { void refreshIpodRegistry() }, [])
  return s
}
