// Top 1000 — renderer store (2026-11-02). Jake: "why isnt the top 1000 a
// playlist i can listen to on my jaketunes devices????" homemini owns the quiz
// and its ranked list (GET /api/top1000 → { list: [{ id, rank, pIn }] },
// contract src/common/top1000-doc.ts); main's top1000 client fetches it
// (src/main/top1000-client.ts, no cache: the list moves with every answer).
// This store holds the song ids in RANK ORDER for the sidebar's Top 1000
// playlist. Same module-store idiom as listenMoreWeekly.ts.
//
// ⚠️ TWIN: JakeTunesMobile backend/src/util/builtInPlaylists.ts
// `jaketunes-top-1000` — the phone's copy of the same list, same order.
import { useEffect, useSyncExternalStore } from 'react'

export interface Top1000ListState {
  /** song ids, rank 1 first; null until homemini has answered once */
  ids: number[] | null
  /** the quiz's rank per song id (String(id) → rank), every song on the list,
   *  in the library here or not; null until homemini has answered once */
  ranks: Record<string, number> | null
  fetchedAt: number | null
}

let snap: Top1000ListState = { ids: null, ranks: null, fetchedAt: null }
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): Top1000ListState => snap

function put(ids: number[], ranks: Record<string, number>): void {
  snap = { ids, ranks, fetchedAt: Date.now() }
  for (const l of listeners) l()
}

/** Ask homemini for the list once per call; overlapping asks share one fetch. */
export function refreshTop1000List(): Promise<void> {
  if (inFlight) return inFlight
  const api = window.electronAPI
  inFlight = (api.top1000List?.() ?? Promise.resolve({ ok: false as const, error: 'no bridge' }))
    .then((r) => {
      if (!r.ok) { console.warn('[top1000-list] unavailable:', r.error); return }
      const rows = [...r.value.list]
        .sort((a, b) => a.rank - b.rank)
        .map((e) => ({ id: Number(e.id), rank: Number(e.rank) }))
        .filter((e) => Number.isInteger(e.id) && e.id > 0)
      const ranks: Record<string, number> = {}
      for (const e of rows) if (Number.isFinite(e.rank) && e.rank > 0) ranks[String(e.id)] = e.rank
      put(rows.map((e) => e.id), ranks)
    })
    .catch((err: unknown) => { console.warn('[top1000-list] read failed:', err instanceof Error ? err.message : err) })
    .finally(() => { inFlight = null })
  return inFlight
}

/** The Top 1000's song ids in rank order (rank 1 first), or null when homemini
 *  has never answered. Mounting asks for a fresh list — it moves with every
 *  quiz answer, so a view always opens on the current ranking. */
export function useTop1000List(): number[] | null {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => { void refreshTop1000List() }, [])
  return s.ids
}

/** The quiz's rank per song id (String(id) → rank) for the '#' column, or null
 *  when homemini has never answered. Shares the list's fetch. */
export function useTop1000Ranks(): Record<string, number> | null {
  return useSyncExternalStore(subscribe, getSnapshot).ranks
}
