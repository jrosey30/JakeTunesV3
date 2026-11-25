// Adding songs to one of Jake's iPod playlists (2026-11-14): from a drop on its
// sidebar row, from "Add to <iPod> Playlist ▸" on any song's right-click, and on
// its own page. One path, so the question is asked the same way everywhere.
//
// A playlist for an iPod holds that iPod's songs. A song the iPod doesn't hold is
// never added silently (the plan Jake approved): "“Holiday” isn’t on punkPod. Add
// it to punkPod too?" Yes puts it on the iPod's list first (homemini's list route,
// which may say the iPod is full; that is said plainly on the playlist), then in
// the playlist. No adds the rest. The Original carries the Top 1000 only, so there
// it is never offered.
import type { MenuEntry } from './components/ContextMenu'
import type { Track } from './types'
import { setNotice } from './activity'
import { notOnIpodQuestion, type IpodPlaylistRow } from '../common/ipod-playlists-view'
import { ipodPlaylistsNow, knownIpods, saveIpodPlaylist } from './ipodPlaylists'
import { ipodPlaylistMenuEntry } from './utils/songTableRules'

export interface IpodQuestion {
  message: string
  detail: string
  confirmLabel: string
  cancelLabel: string
  /** Only one button: nothing to choose (the Original). */
  inform: boolean
  answer: (yes: boolean) => void
}

let question: IpodQuestion | null = null
const listeners = new Set<() => void>()
export function subscribeIpodQuestion(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export const getIpodQuestion = (): IpodQuestion | null => question
function ask(q: IpodQuestion | null): void {
  question = q
  for (const l of listeners) l()
}

const titleIn = (library: readonly Track[]) => {
  const byId = new Map(library.map((t) => [t.id, t.title || 'this song']))
  return (id: number): string => byId.get(id) ?? 'this song'
}
const songs = (n: number): string => (n === 1 ? 'song' : `${n} songs`)

/** Add `trackIds` to one of Jake's playlists on an iPod, asking about any song the iPod doesn't hold. */
export async function askToAddToIpodPlaylist(input: {
  device: string
  ipodName: string
  ipodIds: readonly number[]
  playlist: Pick<IpodPlaylistRow, 'id' | 'name' | 'trackIds' | 'source'>
  trackIds: readonly number[]
  library: readonly Track[]
}): Promise<void> {
  const { device, ipodName, playlist } = input
  if (playlist.source !== 'jake') { setNotice('Only your own playlists take songs.', { kind: 'error' }); return }
  const have = new Set(playlist.trackIds)
  const fresh = [...new Set(input.trackIds)].filter((id) => !have.has(id))
  if (!fresh.length) {
    setNotice(input.trackIds.length === 1 ? `Already in “${playlist.name}”.` : `All ${input.trackIds.length} songs are already in “${playlist.name}”.`)
    return
  }
  const onIpod = new Set(input.ipodIds)
  const notOn = fresh.filter((id) => !onIpod.has(id))
  const title = titleIn(input.library)
  const save = async (ids: number[], also: number[]): Promise<void> => {
    if (!ids.length) return
    const r = await saveIpodPlaylist({ device, ipodName, id: playlist.id, trackIds: [...playlist.trackIds, ...ids], defaults: [], alsoOnIpod: also })
    if (!r.ok) { setNotice(r.error, { kind: 'error', durationMs: 5000 }); return }
    setNotice(`Added ${songs(ids.length)} to “${playlist.name}” on ${ipodName}.`, { kind: 'success' })
  }
  if (!notOn.length) { await save(fresh, []); return }
  const q = notOnIpodQuestion(device, ipodName, notOn.map(title))
  const rest = fresh.filter((id) => onIpod.has(id))
  if (!q.canAdd) {
    ask({
      message: q.message,
      detail: rest.length ? `The other ${songs(rest.length)} go in “${playlist.name}”.` : `Nothing was added to “${playlist.name}”.`,
      confirmLabel: 'OK',
      cancelLabel: 'OK',
      inform: true,
      answer: () => { ask(null); void save(rest, []) },
    })
    return
  }
  ask({
    message: q.message,
    detail: `${notOn.length === 1 ? 'It goes' : 'They go'} on ${ipodName}’s list first, then in “${playlist.name}”, at the next sync.`,
    confirmLabel: `Add to ${ipodName}`,
    cancelLabel: rest.length ? 'Leave it out' : 'Don’t add',
    inform: false,
    answer: (yes) => {
      ask(null)
      void (yes ? save(fresh, notOn) : save(rest, []))
    },
  })
}

/**
 * "Add to iPod Playlist ▸" for a song's right-click: the iPods that have playlists
 * of Jake's (the sidebar's iPODS order), each with its playlists.
 */
export function addToIpodPlaylistEntries(tracks: readonly Track[], library: readonly Track[]): MenuEntry[] {
  // V7: ONE "Add to iPod Playlist ▸" whose flyout names each iPod with its
  // playlists under it (utils/songTableRules.ts ipodPlaylistMenuEntry) — it
  // was one entry per iPod. Greyed until a playlist is made under an iPod.
  const ids = tracks.map((t) => t.id)
  return [ipodPlaylistMenuEntry(knownIpods().map((k) => ({
    ipodName: k.ipodName,
    playlists: ipodPlaylistsNow(k.device).rows.filter((p) => p.source === 'jake').map((p) => ({
      name: p.name,
      onClick: () => { void askToAddToIpodPlaylist({ device: k.device, ipodName: k.ipodName, ipodIds: k.ipodIds, playlist: p, trackIds: ids, library }) },
    })),
  })))]
}
