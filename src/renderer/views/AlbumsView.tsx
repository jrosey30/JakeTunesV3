import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import AlbumArtImage from '../components/AlbumArtImage'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { albumKeyOf, albumKeyFromStrings } from '../utils/albumKey'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import EmptyState from '../components/EmptyState'
import { Track } from '../types'
import '../styles/albums.css'

interface Album {
  name: string
  artist: string
  artists: string[]   // all unique artist variants for art lookup
  year: string | number
  tracks: Track[]
}

export default function AlbumsView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb } = usePlayback()

  // When returning from AlbumDetailView (← Albums), pendingAlbumKey is still
  // set — scroll that card into view, then clear so a later sidebar visit
  // doesn't jump again.
  useEffect(() => {
    if (lib.currentView !== 'albums') return
    if (!lib.pendingAlbumKey) return
    const key = lib.pendingAlbumKey
    libDispatch({ type: 'CLEAR_PENDING_ALBUM_KEY' })
    window.setTimeout(() => {
      const card = document.querySelector(`.album-card[data-album-key="${CSS.escape(key)}"]`)
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
  }, [lib.pendingAlbumKey, lib.currentView, libDispatch])

  const albums = useMemo((): Album[] => {
    const map = new Map<string, Album>()
    for (const t of lib.tracks) {
      const key = albumKeyOf(t)
      if (!map.has(key)) {
        map.set(key, {
          name: t.album || 'Unknown Album',
          artist: t.albumArtist || t.artist || 'Unknown Artist',
          artists: [],
          year: t.year || '',
          tracks: [],
        })
      }
      const album = map.get(key)!
      album.tracks.push(t)
      const a = (t.artist || '').trim()
      if (a && !album.artists.includes(a)) album.artists.push(a)
      if (t.albumArtist) {
        const aa = t.albumArtist.trim()
        if (aa && !album.artists.includes(aa)) album.artists.push(aa)
      }
      if (!album.year && t.year) album.year = t.year
    }
    for (const album of map.values()) {
      album.tracks = sortAlbumTracks(album.tracks)
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [lib.tracks])

  const effectiveQuery = (lib.searchQuery || '').trim().toLowerCase()
  const [albFilter, setAlbFilter] = useState('')
  const af = albFilter.trim().toLowerCase()
  const filteredAlbums = useMemo(() => {
    let result = albums
    if (effectiveQuery) {
      const q = effectiveQuery
      result = result.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.artist.toLowerCase().includes(q) ||
        a.artists.some(art => art.toLowerCase().includes(q)) ||
        a.tracks.some(t => (t.title || '').toLowerCase().includes(q)),
      )
    }
    // In-view filter box — album or artist name.
    if (af) result = result.filter(a => a.name.toLowerCase().includes(af) || a.artist.toLowerCase().includes(af))
    return result
  }, [albums, effectiveQuery, af])

  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const findArtHash = useCallback((album: Album): string | undefined => {
    for (const artist of album.artists) {
      const hit = lookupArtwork(lib.artworkMap, normalizedArtIndex, artist, album.name)
      if (hit) return hit
    }
    return lookupArtwork(lib.artworkMap, normalizedArtIndex, album.artist, album.name)
  }, [lib.artworkMap, normalizedArtIndex])

  // Resolve missing covers in small idle batches — never during render.
  useEffect(() => {
    if (lib.currentView !== 'albums') return
    const missing = filteredAlbums.slice(0, 32).filter(a => !findArtHash(a))
    if (missing.length === 0) return
    queueArtworkResolutions(
      missing.map(a => ({ artist: a.artist || a.artists[0] || '', album: a.name })),
      libDispatch,
    )
  }, [lib.currentView, filteredAlbums, findArtHash, libDispatch])

  // Warm caches for the first screenful so covers pop in without stagger.
  useEffect(() => {
    if (lib.currentView !== 'albums') return
    prefetchAlbumArtHashes(filteredAlbums.slice(0, 48).map(a => findArtHash(a)))
  }, [lib.currentView, filteredAlbums, findArtHash, lib.artworkMap])

  const openAlbum = useCallback((key: string) => {
    libDispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: key })
  }, [libDispatch])

  const viewRootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('albums', viewRootRef)
  const lastUserActivityAtRef = useRef<number>(0)
  const isAutoScrollAtRef = useRef<number>(0)
  const FOLLOW_IDLE_MS = 5000
  const noteUserActivity = useCallback(() => {
    if (Date.now() - isAutoScrollAtRef.current > 200) {
      lastUserActivityAtRef.current = Date.now()
    }
  }, [])

  useEffect(() => {
    if (lib.currentView !== 'albums') return
    if (!pb.nowPlaying) return
    if (Date.now() - lastUserActivityAtRef.current < FOLLOW_IDLE_MS) return
    const key = albumKeyOf(pb.nowPlaying)
    const exists = filteredAlbums.some(a => albumKeyFromStrings(a.artist, a.name) === key)
    if (!exists) return
    isAutoScrollAtRef.current = Date.now()
    requestAnimationFrame(() => {
      const root = viewRootRef.current
      if (!root) return
      const card = root.querySelector(`[data-album-key="${CSS.escape(key)}"]`) as HTMLElement | null
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    })
  }, [pb.nowPlaying?.id, lib.currentView, filteredAlbums])

  return (
    <div
      className="albums-view"
      ref={viewRootRef}
      onClickCapture={noteUserActivity}
      onWheelCapture={noteUserActivity}
      onScrollCapture={noteUserActivity}
      onKeyDownCapture={noteUserActivity}
    >
      <div className="albums-toolbar">
        <div className="list-filter">
          <span className="list-filter-icon" aria-hidden="true">⌕</span>
          <input
            className="list-filter-input"
            type="text"
            placeholder="Filter albums…"
            value={albFilter}
            onChange={(e) => setAlbFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setAlbFilter('') }}
            spellCheck={false}
            aria-label="Filter albums"
          />
          {albFilter && (
            <button className="list-filter-clear" onClick={() => setAlbFilter('')} aria-label="Clear filter" title="Clear">×</button>
          )}
        </div>
      </div>
      {filteredAlbums.length === 0 && (
        <EmptyState query={lib.searchQuery} noun="albums" />
      )}
      <div className="albums-grid">
        {filteredAlbums.map((album) => {
          const key = albumKeyFromStrings(album.artist, album.name)
          const artHash = findArtHash(album)
          return (
            <div
              key={key}
              className="album-card"
              data-album-key={key}
              onClick={() => openAlbum(key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlbum(key) } }}
              role="button"
              tabIndex={0}
            >
              <div className="album-card-art">
                {artHash ? (
                  <AlbumArtImage hash={artHash} alt={album.name} className="album-card-img" />
                ) : (
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="#bbb">
                    <circle cx="16" cy="16" r="14" fill="none" stroke="#bbb" strokeWidth="1" />
                    <circle cx="16" cy="16" r="5" fill="none" stroke="#bbb" strokeWidth="1" />
                    <circle cx="16" cy="16" r="1.5" fill="#bbb" />
                  </svg>
                )}
              </div>
              <div className="album-card-title">{album.name}</div>
              <div className="album-card-artist">{album.artist}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
