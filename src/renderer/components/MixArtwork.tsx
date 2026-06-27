/**
 * 4.5: artwork for a "Your Mixes" mix — same rule as iOS playlist art
 * (PlaylistsView.swift): a Spotify/Apple-style **2×2 mosaic of the first 4
 * UNIQUE album covers**, falling back to a single cover when fewer than 4 unique
 * covers exist, then a ♪ placeholder. A mix spans many albums, so it usually
 * gets the 4-up grid — far more representative than just track #1's cover.
 *
 * Self-contained: resolves hashes itself from the library artwork map, so
 * callers just pass the mix's tracks. Fills its container (the caller rounds +
 * clips), so it drops into both the Home card and the detail-page cover.
 */
import { useMemo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import AlbumArtImage from './AlbumArtImage'
import type { Track } from '../types'
import '../styles/mix-artwork.css'

export default function MixArtwork({ tracks, alt = '', priority = false }: { tracks: Track[]; alt?: string; priority?: boolean }) {
  const { state: lib } = useLibrary()
  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

  // First 4 covers from DISTINCT albums that actually have art.
  const hashes = useMemo(() => {
    const seenAlbums = new Set<string>()
    const out: string[] = []
    for (const t of tracks) {
      const artist = (t.albumArtist || t.artist || '').toLowerCase().trim()
      const albumKey = `${artist}|||${(t.album || '').toLowerCase().trim()}`
      if (seenAlbums.has(albumKey)) continue
      const h = lookupArtwork(lib.artworkMap, artIndex, t.albumArtist || t.artist || '', t.album || '')
      if (!h) continue
      seenAlbums.add(albumKey)
      out.push(h)
      if (out.length >= 4) break
    }
    return out
  }, [tracks, lib.artworkMap, artIndex])

  if (hashes.length >= 4) {
    return (
      <div className="mix-mosaic">
        {hashes.slice(0, 4).map((h, i) => <AlbumArtImage key={`${h}-${i}`} hash={h} alt="" />)}
      </div>
    )
  }
  if (hashes.length >= 1) return <AlbumArtImage hash={hashes[0]} alt={alt} priority={priority} />
  return <div className="mix-art-ph" aria-hidden="true">♪</div>
}
