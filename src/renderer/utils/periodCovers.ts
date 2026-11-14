// The month and year playlists' covers come from homemini (2026-11-13,
// src/common/period-covers.ts): one picture for the desktop, the phone and
// Android. The covers that ship with the app (utils/playlistCovers.ts) show
// until main has homemini's ('period-cover:get'), and whenever it has none.
import { useEffect, useState } from 'react'
import { periodCoverRemoteId } from '../../common/period-covers'
import { BEST_OF_YEAR } from './smartPlaylists'

/** What main handed over, by homemini id: no flash on remount. */
const fetched = new Map<string, string>()
const askedAt = new Map<string, number>()
/** Main asks homemini at most every half hour; asking main more often than this buys nothing. */
const ASK_AGAIN_MS = 10 * 60_000

const listeners = new Set<() => void>()

/** Jake just approved, skipped or restored a cover: ask main again now, and repaint whoever shows it. */
export function refreshPeriodPlaylistCover(playlistId: string): void {
  const remoteId = periodCoverRemoteId(playlistId, BEST_OF_YEAR)
  if (!remoteId) return
  askedAt.set(remoteId, Date.now())
  void window.electronAPI.periodCoverGet?.(remoteId, true)
    .then((r) => { if (r?.url) { fetched.set(remoteId, r.url); for (const l of listeners) l() } })
    .catch(() => {})
}

/** homemini's cover for a month or year playlist; null for any other playlist, or before the first answer. */
export function usePeriodPlaylistCover(playlistId: string | null | undefined): string | null {
  const remoteId = periodCoverRemoteId(playlistId, BEST_OF_YEAR)
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  useEffect(() => {
    if (!remoteId) return
    const last = askedAt.get(remoteId)
    if (last !== undefined && Date.now() - last < ASK_AGAIN_MS) return
    askedAt.set(remoteId, Date.now())
    let live = true
    void window.electronAPI.periodCoverGet?.(remoteId)
      .then((r) => { if (r?.url && fetched.get(remoteId) !== r.url) { fetched.set(remoteId, r.url); if (live) bump((n) => n + 1) } })
      .catch(() => {})
    return () => { live = false }
  }, [remoteId])
  return remoteId ? fetched.get(remoteId) ?? null : null
}
