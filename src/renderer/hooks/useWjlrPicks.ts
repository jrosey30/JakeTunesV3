/**
 * WJLR staff picks for the Record Shop wall (2026-08-22, Jake: "move these
 * into a row for each person on the record store page").
 *
 * Same weekly persona picks the sidebar section used to open — same
 * ui-state keys, same schema, same Friday-week freshness rule — imported
 * from SmartPlaylistView so there is exactly ONE definition of what a
 * valid picks blob is (twin discipline). This hook only READS + fills:
 * fresh blobs hydrate instantly; stale/missing ones regenerate through
 * the same per-persona IPC the old view called, then persist onto a
 * FRESHLY-READ ui-state (merge-onto-fresh — the snapshot-merge rollback
 * lesson).
 */
import { useEffect, useRef, useState } from 'react'
import { PICKS_SCHEMA_V, getWeekStartFriday, type PicksData } from '../views/SmartPlaylistView'

export interface PersonaShelf {
  id: 'musicman-picks' | 'megan-picks' | 'dj-hands-picks'
  label: string
  accent: 'mm' | 'megan' | 'djhands'
  name: string
  commentary: string
  trackIds: number[]
}

const PERSONAS: Array<{ id: PersonaShelf['id']; label: string; accent: PersonaShelf['accent']; apiCall: 'musicmanPicks' | 'meganPicks' | 'djHandsPicks' }> = [
  { id: 'musicman-picks', label: 'The Music Man', accent: 'mm', apiCall: 'musicmanPicks' },
  { id: 'megan-picks', label: 'Megan', accent: 'megan', apiCall: 'meganPicks' },
  { id: 'dj-hands-picks', label: 'DJ Stephen Hands', accent: 'djhands', apiCall: 'djHandsPicks' },
]

function validThisWeek(raw: unknown): PicksData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as PicksData
  if (p.v !== PICKS_SCHEMA_V) return null
  if (typeof p.name !== 'string' || typeof p.commentary !== 'string' || !Array.isArray(p.trackIds) || typeof p.date !== 'string') return null
  if (!p.trackIds.every((id) => typeof id === 'number')) return null
  if (getWeekStartFriday(new Date(p.date)).getTime() !== getWeekStartFriday(new Date()).getTime()) return null
  return p
}

export function useWjlrPicks(
  libTracks: Array<{ id: number; title: string; artist: string; album: string; genre: string; year: string | number }>,
): PersonaShelf[] | null {
  const [shelves, setShelves] = useState<PersonaShelf[] | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current || libTracks.length === 0) return
    startedRef.current = true
    let cancelled = false
    void (async () => {
      const out = new Map<PersonaShelf['id'], PersonaShelf>()
      const publish = (): void => {
        if (cancelled) return
        const ready = PERSONAS.filter((p) => out.has(p.id)).map((p) => out.get(p.id) as PersonaShelf)
        if (ready.length) setShelves(ready)
      }
      // Envelope is { ok, state } — unwrap or the picks never hydrate AND
      // a later save would spread the envelope itself into ui-state.
      const loaded = await window.electronAPI.loadUiState().catch(() => null)
      const state: Record<string, unknown> = (loaded?.ok && loaded.state) ? loaded.state : {}
      const payload = libTracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, genre: t.genre, year: t.year }))
      for (const persona of PERSONAS) {
        const cached = validThisWeek(state[persona.id])
        if (cached) {
          out.set(persona.id, { id: persona.id, label: persona.label, accent: persona.accent, name: cached.name, commentary: cached.commentary, trackIds: cached.trackIds })
          publish()
          continue
        }
        // Stale/missing → same generation call the sidebar view used.
        // Sequential on purpose: three Claude calls stampeding in parallel
        // helps nobody, and the shelves appear one by one as they land.
        try {
          const r = await window.electronAPI[persona.apiCall]?.(payload)
          if (!r?.ok || !Array.isArray(r.trackIds)) continue
          const blob: PicksData = { v: PICKS_SCHEMA_V, name: r.name || `${persona.label} Picks`, commentary: r.commentary || '', trackIds: r.trackIds, date: new Date().toISOString() }
          out.set(persona.id, { id: persona.id, label: persona.label, accent: persona.accent, name: blob.name, commentary: blob.commentary, trackIds: blob.trackIds })
          publish()
          // Merge onto FRESH state — never onto the boot snapshot.
          const freshLoad = await window.electronAPI.loadUiState().catch(() => null)
          const fresh: Record<string, unknown> = (freshLoad?.ok && freshLoad.state) ? freshLoad.state : {}
          void window.electronAPI.saveUiState({ ...fresh, [persona.id]: blob })
        } catch (err) {
          console.warn(`[shop] ${persona.label} picks generation failed:`, err)
        }
      }
    })()
    return () => { cancelled = true }
  }, [libTracks])

  return shelves
}
