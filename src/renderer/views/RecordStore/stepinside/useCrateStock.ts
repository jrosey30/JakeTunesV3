/**
 * What's actually in the bin — real records out of the real library.
 *
 * Grouped by album and put back in running order, so pulling one out and
 * playing it drops the needle on side A track 1 rather than wherever the
 * library happened to list it (the same bug the 2D shop had).
 *
 * The stock is shuffled per shop-visit but STABLE within one, so walking
 * away from the crate and coming back doesn't reshuffle the bin under you.
 */
import { useMemo } from 'react'
import { useLibrary } from '../../../context/LibraryContext'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../../../utils/artworkLookup'
import type { CrateRecord } from './types'

const MAX_RECORDS = 48

interface LibTrack {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  year?: number | string
  trackNumber?: number
  discNumber?: number
}

export function useCrateStock(seed: number): CrateRecord[] {
  const { state: lib } = useLibrary()
  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

  return useMemo(() => {
    const byAlbum = new Map<string, { rec: CrateRecord; tracks: LibTrack[] }>()
    for (const raw of lib.tracks as unknown as LibTrack[]) {
      const album = (raw.album || '').trim()
      const artist = (raw.albumArtist || raw.artist || '').trim()
      if (!album || !artist) continue
      const key = `${album}::${artist}`
      let entry = byAlbum.get(key)
      if (!entry) {
        entry = {
          rec: {
            id: key,
            album,
            artist,
            year: raw.year,
            coverUrl: null,
            trackIds: [],
            owned: true,
          },
          tracks: [],
        }
        byAlbum.set(key, entry)
      }
      entry.tracks.push(raw)
    }

    const all = [...byAlbum.values()]
    // Albums, not singles — a crate of one-track "albums" is a database
    // dump, not a record shop.
    const albums = all.filter((e) => e.tracks.length >= 4)
    const pool = albums.length >= MAX_RECORDS ? albums : all

    // Deterministic shuffle from the visit seed: same bin all visit long.
    let s = seed || 1
    const rand = (): number => {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    }
    const picked = [...pool]
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[picked[i], picked[j]] = [picked[j], picked[i]]
    }

    return picked.slice(0, MAX_RECORDS).map((e) => {
      const ordered = [...e.tracks].sort((a, b) => {
        const da = Number(a.discNumber) || 1
        const db = Number(b.discNumber) || 1
        if (da !== db) return da - db
        const na = Number(a.trackNumber) || Number.MAX_SAFE_INTEGER
        const nb = Number(b.trackNumber) || Number.MAX_SAFE_INTEGER
        if (na !== nb) return na - nb
        return (a.title || '').localeCompare(b.title || '')
      })
      const hash = lookupArtwork(lib.artworkMap, artIndex, e.rec.artist, e.rec.album)
      return {
        ...e.rec,
        coverUrl: hash ? `album-art://${hash}.jpg` : null,
        trackIds: ordered.map((t) => t.id),
      }
    })
  }, [lib.tracks, lib.artworkMap, artIndex, seed])
}
