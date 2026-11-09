// The iPod covers (2026-11-09, src/common/ipod-covers.ts). Jake: "the playlist
// photos should be their respective ipods. so silver ipod mini is the top 1000.
// red ipod mini is the punkpod."
//
// Every model in every named colour ships with the app
// (assets/ipod-covers/<model>-<colour>.jpg, drawn by JakeTunesMobile
// tools/make-playlist-covers.py --ipod-set). A custom colour shows its nearest
// named colour until main has homemini's exact picture ('ipod-cover:get').
// ⚠️ TWIN: JakeTunesMobile backend/assets/ipod-covers — the same art the phone shows.
import { useEffect, useState } from 'react'
import { ipodCoverChoice, ipodLook, top1000Look, type IpodLook } from '../../common/ipod-covers'
import { parseIpodListPlaylistId } from '../../common/ipod-list-doc'
import { TOP_1000_PLAYLIST_ID } from '../../common/sidebar-ipods'
import { useIpodListsSnapshot } from '../ipodLists'
import { useIpodRegistry } from '../ipodRegistry'
import top1000Cover from '../assets/playlist-covers/top-1000.jpg'

const BUNDLED = import.meta.glob('../assets/ipod-covers/*.jpg', { eager: true, import: 'default' }) as Record<string, string>

export function bundledIpodCover(key: string): string | null {
  return BUNDLED[`../assets/ipod-covers/${key}.jpg`] ?? null
}

/** Custom covers main already handed over, by key: no second ask, no flash on remount. */
const fetched = new Map<string, string>()

/** The picture for a look: bundled now, homemini's exact one when a custom colour arrives. */
export function useIpodCover(look: IpodLook | null): string | null {
  const choice = look ? ipodCoverChoice(look) : null
  const fetchKey = choice?.fetchKey ?? null
  const [, bump] = useState(0)
  useEffect(() => {
    if (!fetchKey || fetched.has(fetchKey)) return
    let live = true
    void window.electronAPI.ipodCoverGet?.(fetchKey)
      .then((r) => { if (r?.url) { fetched.set(fetchKey, r.url); if (live) bump((n) => n + 1) } })
      .catch(() => {})
    return () => { live = false }
  }, [fetchKey])
  if (!choice) return null
  return (fetchKey && fetched.get(fetchKey)) || bundledIpodCover(choice.bundledKey)
}

/** The look of an iPODS playlist: Top 1000 (the Original's mini) or an iPod list. null = neither, or a list not known yet. */
export function useIpodPlaylistLook(playlistId: string | null | undefined): IpodLook | null {
  const lists = useIpodListsSnapshot()
  const registry = useIpodRegistry()
  if (playlistId === TOP_1000_PLAYLIST_ID) return top1000Look(registry.find((d) => d.primary)?.color)
  const dev = parseIpodListPlaylistId(playlistId)
  if (!dev) return null
  const entry = lists.find((l) => l.id === dev)
  return entry ? ipodLook({ model: entry.model, listColor: entry.color }) : ipodLook({})
}

/** The cover of an iPODS playlist; null for every other playlist (smartPlaylistCover covers those). */
export function useIpodPlaylistCover(playlistId: string | null | undefined): string | null {
  const look = useIpodPlaylistLook(playlistId)
  const src = useIpodCover(look)
  // The Original's silver mini is the bundled top-1000.jpg (full size, the same art).
  if (playlistId === TOP_1000_PLAYLIST_ID && look?.color === 'silver') return top1000Cover
  return src
}
