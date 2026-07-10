import { useSyncExternalStore, useMemo } from 'react'
import { subscribeLiveSets, getLiveSetsSnapshot, libraryHiddenTrackIds } from '../liveSets'
import type { Track } from '../types'

// Live Concert Mode — the "regular library" projection. A declared full
// concert (its merged "Full Set" track + its constituent songs) does NOT count
// as songs in the regular library: it lives only in the Full Live Concerts
// section. This hook returns library tracks minus everything a concert hides,
// and recomputes when the live-sets sidecar changes (so newly-declared concerts
// drop out live, and reimported songs re-appear live).
//
// Deliberately OUTSIDE LibraryContext (do-not-touch) — a pure view-layer
// projection every list/count wraps its source tracks in.
export function useRegularLibraryTracks(tracks: Track[]): Track[] {
  const snap = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  return useMemo(() => {
    if (!snap.loaded || Object.keys(snap.sets).length === 0) return tracks
    const liveIds = new Set(tracks.map((t) => t.id))
    const hidden = libraryHiddenTrackIds(liveIds)
    if (hidden.size === 0) return tracks
    return tracks.filter((t) => !hidden.has(t.id))
  }, [tracks, snap])
}
