// Artist profile — renderer side (2026-10-20). homemini's pre-built profile
// for the artist page (bio, facts, members; src/common/artist-profile.ts).
//
// Main owns the network and the disk cache (src/main/artist-profile-client.ts).
// The page asks for the cached copy first — no network, so it paints at once —
// then for a refresh behind it. Answers are kept in memory per artist so a
// back-and-forth between pages never flashes.

import { useCallback, useEffect, useState } from 'react'
import { emptyProfileState, type ArtistProfileState } from '../common/artist-profile'

const memo = new Map<string, ArtistProfileState>()
const keyOf = (name: string) => name.trim().toLowerCase()

export interface ArtistProfileView {
  state: ArtistProfileState
  /** The cached copy has been read (or there is none): fallbacks may start. */
  cacheRead: boolean
  /** The refresh behind the cache is done (or failed). */
  settled: boolean
  /** Swap in a newer state (after Jake sets a member photo). */
  replace: (s: ArtistProfileState) => void
}

interface Entry { key: string; state: ArtistProfileState; cacheRead: boolean; settled: boolean }

function usable(s: unknown, name: string): s is ArtistProfileState {
  return !!s && typeof s === 'object' && 'source' in s && keyOf(String((s as ArtistProfileState).name ?? '')) === keyOf(name)
}

function freshEntry(name: string): Entry {
  const known = memo.get(keyOf(name))
  return { key: keyOf(name), state: known ?? emptyProfileState(name), cacheRead: !!known || !name.trim(), settled: !name.trim() }
}

export function useArtistProfile(name: string): ArtistProfileView {
  const [entry, setEntry] = useState<Entry>(() => freshEntry(name))
  // The page can move from one artist to another without remounting (a
  // member's "Solo artist" link): never hand back the previous artist's
  // profile for the render in between.
  const current = entry.key === keyOf(name) ? entry : freshEntry(name)

  useEffect(() => {
    const k = keyOf(name)
    let cancelled = false
    const start = freshEntry(name)
    setEntry(start)
    if (!name.trim()) return
    const api = window.electronAPI
    const put = (s: ArtistProfileState | undefined, patch: Partial<Entry>): void => {
      if (cancelled) return
      const ok = usable(s, name)
      if (ok) memo.set(k, s)
      setEntry((e) => (e.key !== k ? e : { ...e, ...(ok ? { state: s } : {}), ...patch }))
    }
    void (async () => {
      if (!start.cacheRead) {
        let got: ArtistProfileState | undefined
        try {
          const r = await api.artistProfileGet?.(name)
          if (r?.ok) got = r.state
        } catch (err) {
          console.warn('[artist-profile] cache read failed:', err instanceof Error ? err.message : err)
        }
        put(got, { cacheRead: true })
      }
      let fresh: ArtistProfileState | undefined
      try {
        const r = await api.artistProfileRefresh?.(name)
        if (r?.ok) fresh = r.state
      } catch (err) {
        console.warn('[artist-profile] refresh failed:', err instanceof Error ? err.message : err)
      }
      put(fresh, { cacheRead: true, settled: true })
    })()
    return () => { cancelled = true }
  }, [name])

  const replace = useCallback((s: ArtistProfileState) => {
    if (!usable(s, name)) return
    memo.set(keyOf(name), s)
    setEntry((e) => (e.key !== keyOf(name) ? e : { ...e, state: s }))
  }, [name])

  return { state: current.state, cacheRead: current.cacheRead, settled: current.settled, replace }
}
