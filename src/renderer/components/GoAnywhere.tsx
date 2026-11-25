/**
 * ⌘K "Go anywhere" (V7). Type a name: a page, artist, album, playlist, iPod,
 * concert or setting. Return opens it, ⌘Return plays it, ↑/↓ move, Escape
 * closes (it's the top-most surface on the keyboard host). The list and the
 * ranking: ../goAnywhere.ts.
 */
import { useMemo, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { useEscape } from '../hooks/useKeyboard'
import { buildIndex } from '../utils/searchIndex'
import { albumKeyOf } from '../utils/albumKey'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import { artistIdentityKey } from '../utils/artistAlias'
import { BUILTIN_SMART_PLAYLISTS, evaluateSmartPlaylist } from '../utils/smartPlaylists'
import { useIpodLists } from '../ipodLists'
import { useTop1000List } from '../top1000List'
import { useTop1000Name } from '../top1000Name'
import { subscribeLiveSets, getLiveSetsSnapshot } from '../liveSets'
import { setConcertKey } from '../concertNav'
import { declaredConcerts } from '../../common/concert-meta'
import { ipodListPlaylistId } from '../../common/ipod-list-doc'
import { TOP_1000_PLAYLIST_ID } from '../../common/sidebar-ipods'
import { buildGoItems, goAction, searchGo, type GoItem } from '../goAnywhere'
import type { SmartPlaylistId, Track, ViewName } from '../types'
import type { SettingsTab } from './SettingsModal'
import '../styles/go-anywhere.css'

interface Props {
  onClose: () => void
  onOpenSettings: (tab: SettingsTab) => void
}

export default function GoAnywhere({ onClose, onOpenSettings }: Props): JSX.Element {
  const { state: lib, dispatch } = useLibrary()
  const { playTrack } = useAudio()
  const ipodLists = useIpodLists()
  const top1000Ids = useTop1000List()
  const top1000Name = useTop1000Name()
  const liveSets = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  useEscape('go-anywhere', true, onClose)

  const byId = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t] as const)), [lib.tracks])
  const items = useMemo(() => {
    const idx = buildIndex(lib.tracks, lib.playlists || [])
    return buildGoItems({
      artists: idx.artists,
      albums: idx.albums,
      playlists: idx.playlists,
      smartPlaylists: BUILTIN_SMART_PLAYLISTS,
      ipods: [
        { playlistId: TOP_1000_PLAYLIST_ID, name: top1000Name },
        ...ipodLists.map((l) => ({ playlistId: ipodListPlaylistId(l.id), name: l.name })),
      ],
      concerts: declaredConcerts(liveSets.sets, (id) => byId.get(id)).map((c) => ({ albumKey: c.albumKey, band: c.band, show: c.show, trackId: c.entry.mergedTrackId })),
    })
  }, [lib.tracks, lib.playlists, ipodLists, top1000Name, liveSets, byId])
  const results = useMemo(() => searchGo(items, query), [items, query])
  const at = Math.min(cursor, Math.max(0, results.length - 1))

  const tracksOf = (item: GoItem): Track[] => {
    const t = item.target
    const ids = (list: readonly number[]): Track[] => list.map((id) => byId.get(id)).filter((x): x is Track => !!x)
    switch (t.kind) {
      case 'album': return sortAlbumTracks(lib.tracks.filter((x) => albumKeyOf(x) === t.key))
      case 'artist': {
        const who = artistIdentityKey(t.name)
        const albums = new Map<string, Track[]>()
        for (const x of lib.tracks) {
          if (artistIdentityKey(x.albumArtist || x.artist || '') !== who && artistIdentityKey(x.artist || '') !== who) continue
          const k = albumKeyOf(x)
          albums.set(k, [...(albums.get(k) ?? []), x])
        }
        return [...albums.values()]
          .sort((a, b) => (Number(a[0].year) || 0) - (Number(b[0].year) || 0) || (a[0].album || '').localeCompare(b[0].album || ''))
          .flatMap((a) => sortAlbumTracks(a))
      }
      case 'playlist':
        if (t.smart) return evaluateSmartPlaylist(t.id as SmartPlaylistId, lib.tracks)
        return ids((lib.playlists || []).find((p) => p.id === t.id)?.trackIds ?? [])
      case 'ipod':
        if (t.playlistId === TOP_1000_PLAYLIST_ID) return ids(top1000Ids ?? [])
        return ids(ipodLists.find((l) => ipodListPlaylistId(l.id) === t.playlistId)?.ids ?? [])
      case 'concert': return ids([t.trackId])
      default: return []
    }
  }

  const open = (item: GoItem): void => {
    const t = item.target
    switch (t.kind) {
      case 'page': dispatch({ type: 'SET_VIEW', view: t.view as ViewName }); break
      case 'artist': dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: t.name }); break
      case 'album': dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: t.key }); break
      case 'playlist':
        if (t.smart) dispatch({ type: 'VIEW_SMART_PLAYLIST', id: t.id as SmartPlaylistId })
        else dispatch({ type: 'VIEW_PLAYLIST', id: t.id })
        break
      case 'ipod': dispatch({ type: 'VIEW_SMART_PLAYLIST', id: t.playlistId as SmartPlaylistId }); break
      case 'concert': setConcertKey(t.albumKey); dispatch({ type: 'SET_VIEW', view: 'concert-detail' }); break
      case 'setting': onOpenSettings(t.tab as SettingsTab); break
    }
  }

  const choose = (item: GoItem | undefined, play: boolean): void => {
    if (!item) return
    if (goAction(item, play) === 'play') {
      const list = tracksOf(item)
      if (list.length > 0) playTrack(list[0], list, 0, undefined, true)
    }
    open(item)
    onClose()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[at], e.metaKey || e.ctrlKey) }
  }

  return (
    <div className="go-anywhere-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="go-anywhere" role="dialog" aria-modal="true" aria-label="Go anywhere">
        <input
          className="go-anywhere-input"
          autoFocus
          spellCheck={false}
          placeholder="Go to a page, artist, album, playlist, iPod…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0) }}
          onKeyDown={onKeyDown}
          aria-label="Go anywhere"
        />
        {query.trim() !== '' && (
          <ul className="go-anywhere-list" role="listbox">
            {results.length === 0 && <li className="go-anywhere-empty">Nothing by that name.</li>}
            {results.map((r, i) => (
              <li
                key={`${r.target.kind}:${r.title}:${r.detail}:${i}`}
                role="option"
                aria-selected={i === at}
                className={`go-anywhere-row${i === at ? ' go-anywhere-row--on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(r, e.metaKey || e.ctrlKey) }}
              >
                <span className="go-anywhere-title">{r.title}</span>
                <span className="go-anywhere-detail">{r.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="go-anywhere-foot">↩ open · ⌘↩ play · esc close</div>
      </div>
    </div>
  )
}
