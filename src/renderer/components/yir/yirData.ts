/**
 * Year in Review, renderer side (2026-10-12): the nightly facts (yir:get),
 * the concerts the story can show, and the lookups that turn a fact's
 * artist + title into a real library song (to play it and show its cover).
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YearInReview.swift (YirStore) + YirImage.swift (YirLibrary).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { subscribeLiveSets, getLiveSetsSnapshot } from '../../liveSets'
import { canonicalArtist } from '../../utils/artistAlias'
import { sortAlbumTracks } from '../../utils/albumTrackOrder'
import type { YearInReview } from '../../../common/year-in-review'
import type { StoryConcert } from '../../../common/yir-story'
import type { Track } from '../../types'

export type YirFacts = YearInReview & { builtAt?: string }

let cached: { year: number; facts: YirFacts } | null = null

/** The facts for a year; shared by the Home card and the view. Asks again on
 *  every mount (the nightly build lands mid-session), and while this Mac has
 *  none yet (first launch: the mirror is still copying), every minute. */
export function useYirFacts(year: number): { facts: YirFacts | null; loading: boolean } {
  const [facts, setFacts] = useState<YirFacts | null>(cached?.year === year ? cached.facts : null)
  const [loading, setLoading] = useState(cached?.year !== year)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (): void => {
      void (window.electronAPI.yirGet?.(year) ?? Promise.resolve(null)).catch(() => null).then((f) => {
        if (!live) return
        if (f) { cached = { year, facts: f }; setFacts(f) } else timer = setTimeout(ask, 60_000)
        setLoading(false)
      })
    }
    ask()
    return () => { live = false; clearTimeout(timer) }
  }, [year])
  return { facts, loading }
}

/** Declared concerts with their display names and grounded meta. */
export function useStoryConcerts(tracks: Track[]): StoryConcert[] {
  const snap = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  return useMemo(() => {
    const byId = new Map(tracks.map((t) => [t.id, t]))
    return Object.entries(snap.sets).flatMap(([albumKey, e]) => {
      if (!byId.has(e.mergedTrackId)) return []
      const src = byId.get(e.cues[0]?.trackId ?? -1) ?? byId.get(e.mergedTrackId)
      const band = e.cues[0]?.artist || src?.artist || ''
      const show = src?.album?.replace(/\s*\(Live Set\)\s*$/i, '') || albumKey.split('|||')[1] || ''
      return [{ albumKey, band, show, venue: e.concert?.venue, date: e.concert?.date, notes: e.concert?.notes, poster: e.concert?.poster }]
    })
  }, [snap, tracks])
}

const fold = (s: string | undefined): string => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const artistKeys = (t: Track): string[] => [fold(t.artist), fold(t.albumArtist), fold(canonicalArtist(t.artist || ''))]

/** The library song a fact names: same title, same artist (feat. folded). */
export function findSong(tracks: Track[], artist: string, title: string): Track | undefined {
  const a = fold(artist), a2 = fold(canonicalArtist(artist)), ti = fold(title)
  return tracks.find((t) => fold(t.title) === ti && artistKeys(t).some((k) => k === a || k === a2))
}

/** An album's songs in play order (disc, then track number). */
export function albumSongs(tracks: Track[], artist: string, album: string): Track[] {
  const a = fold(artist), al = fold(album)
  return sortAlbumTracks(tracks.filter((t) => fold(t.album) === al && artistKeys(t).includes(a)))
}
