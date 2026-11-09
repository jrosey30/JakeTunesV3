// The Top 1000's display name — renderer store (2026-11-09, Jake: "allow me to
// rename the ipod playlists too!! if i want"). homemini keeps it so the phone
// and every Mac match (src/main/top1000-name.ts); "Top 1000" until Jake renames
// it. Same module-store idiom as top1000List.ts.
import { useEffect, useSyncExternalStore } from 'react'
import { TOP_1000_DEFAULT_NAME } from '../common/ipod-list-name'

let name = TOP_1000_DEFAULT_NAME
let inFlight: Promise<void> | null = null
let asked = false
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): string => name
function put(next: string): void {
  if (next === name) return
  name = next
  for (const l of listeners) l()
}

/** Ask main once per call; overlapping asks share one read. */
export function refreshTop1000Name(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (window.electronAPI.top1000NameGet?.() ?? Promise.resolve({ ok: false as const, error: 'no bridge' }))
    .then((r) => { if (r.ok && typeof r.name === 'string' && r.name.trim()) put(r.name) })
    .catch((err: unknown) => { console.warn('[top1000-name] read failed:', err instanceof Error ? err.message : err) })
    .finally(() => { inFlight = null })
  return inFlight
}

/** What the Top 1000 is called now. The first view to mount asks main. */
export function useTop1000Name(): string {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (asked) return
    asked = true
    void refreshTop1000Name()
  }, [])
  return s
}

/** Rename the Top 1000: shown at once; the old name comes back on a refusal. Empty = "Top 1000". */
export async function renameTop1000(next: string): Promise<{ ok: true; name: string; homemini: 'saved' | 'later' } | { ok: false; error: string }> {
  const before = name
  put(next.trim() || TOP_1000_DEFAULT_NAME)
  const r = await (window.electronAPI.top1000NameSet?.(next.trim() || null) ?? Promise.resolve({ ok: false as const, error: 'not available' }))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t rename the Top 1000' }))
  if (!r.ok) {
    put(before)
    return r
  }
  put(r.name)
  return { ok: true, name: r.name, homemini: r.homemini }
}
