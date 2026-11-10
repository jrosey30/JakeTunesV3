// Artist profile — renderer side (2026-10-20). homemini's pre-built profile
// for the artist page (bio, facts, members; src/common/artist-profile.ts).
//
// Main owns the network and the disk cache (src/main/artist-profile-client.ts).
// Since 2026-11-10 the cached copies are in the renderer's memory from boot
// (artistProfileStore.ts, seeded by artistPageSeed.ts), so the page has the
// profile on its FIRST frame; the refresh lands behind it, and each photo of
// the profile is pushed by main as it lands. Answers stay in memory per artist,
// so a back-and-forth between pages never flashes.

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ArtistProfileState } from '../common/artist-profile'
import { createArtistProfileStore, profileKey } from './artistProfileStore'
import { navDxSource } from './navDxDom'

export const artistProfileStore = createArtistProfileStore(() => window.electronAPI, undefined, navDxSource)

let pushWired = false
/** Main's "a photo of this profile landed" pushes → the store. Once per window. */
function wirePushes(): void {
  if (pushWired) return
  pushWired = true
  window.electronAPI.onArtistProfileUpdated?.((state) => artistProfileStore.apply(state))
}

export interface ArtistProfileView {
  state: ArtistProfileState
  /** The cached copy has been read (or there is none): fallbacks may start. */
  cacheRead: boolean
  /** homemini has answered (or failed to) at least once this session. */
  settled: boolean
  /** Swap in a newer state (after Jake sets a member photo). */
  replace: (s: ArtistProfileState) => void
}

export function useArtistProfile(name: string): ArtistProfileView {
  const entry = useSyncExternalStore(artistProfileStore.subscribe, () => artistProfileStore.peek(name))

  useEffect(() => {
    wirePushes()
    void artistProfileStore.open(name)
  }, [name])

  const replace = useCallback((s: ArtistProfileState) => {
    if (profileKey(s?.name) === profileKey(name)) artistProfileStore.apply(s)
  }, [name])

  return { state: entry.state, cacheRead: entry.cacheRead, settled: entry.settled, replace }
}
