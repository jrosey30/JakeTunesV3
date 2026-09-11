/**
 * What's actually in the bins — real records out of the real library,
 * filed the way Jake asked (shopPlan.ts).
 *
 * Grouped by album and put back in running order, so pulling one out and
 * playing it drops the needle on side A track 1 rather than wherever the
 * library happened to list it (the same bug the 2D shop had).
 *
 * Each bin's stock is shuffled per shop-visit but STABLE within one, so
 * walking away from a crate and coming back doesn't reshuffle it under
 * you. NEW ARRIVALS is not shuffled: it is the newest albums, newest at
 * the front, the way a shop puts out what just came in. A record can be
 * in NEW ARRIVALS and in its genre bin at once — shops have two copies.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useLibrary } from '../../../context/LibraryContext'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../../../utils/artworkLookup'
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, libraryHiddenTrackIds } from '../../../liveSets'
import type { PosterFacts } from './posters'
import {
  BINS, CRATE_CAPACITY, OTHER_SECTIONS, fileGenre, filingKey, letterSections, groupSections,
  type BinDef, type Section,
} from './shopPlan'
import type { CrateRecord } from './types'

interface LibTrack {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  year?: number | string
  genre?: string
  trackNumber?: number
  discNumber?: number
  dateAdded?: string | number
}

export interface ShopBin extends BinDef {
  records: CrateRecord[]
  sections: Section[]
}

interface AlbumEntry {
  rec: CrateRecord
  tracks: LibTrack[]
  genres: Map<string, number>
  added: number
}

/** The full live concerts, as posters: act, venue, city, date and the
 *  artwork, all from the concert's own grounded metadata. */
export function useConcertPosters(): PosterFacts[] {
  const { state: lib } = useLibrary()
  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const live = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  useEffect(() => { void ensureLiveSetsLoaded() }, [])
  return useMemo(() => {
    const byId = new Map<number, LibTrack>()
    for (const t of lib.tracks as unknown as LibTrack[]) byId.set(t.id, t)
    const out: PosterFacts[] = []
    for (const entry of Object.values(live.sets)) {
      const t = byId.get(entry.mergedTrackId)
      if (!t) continue
      const artist = (t.albumArtist || t.artist || '').trim()
      const album = (t.album || '').trim()
      if (!artist || !album) continue
      const hash = lookupArtwork(lib.artworkMap, artIndex, artist, album)
      out.push({
        artist, title: album,
        venue: entry.concert?.venue, city: entry.concert?.city, date: entry.concert?.date,
        coverUrl: hash ? `album-art://${hash}.jpg` : null,
      })
    }
    return out
  }, [lib.tracks, lib.artworkMap, artIndex, live])
}

export function useShopStock(seed: number): ShopBin[] {
  const { state: lib } = useLibrary()
  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  // Full live concerts are posters on the wall, not records in the bins:
  // the same projection the regular library uses hides them here.
  const live = useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  useEffect(() => { void ensureLiveSetsLoaded() }, [])

  return useMemo(() => {
    const ids = new Set((lib.tracks as unknown as LibTrack[]).map((t) => t.id))
    const hidden = live.loaded ? libraryHiddenTrackIds(ids) : new Set<number>()
    const byAlbum = new Map<string, AlbumEntry>()
    for (const raw of lib.tracks as unknown as LibTrack[]) {
      if (hidden.has(raw.id)) continue
      const album = (raw.album || '').trim()
      const artist = (raw.albumArtist || raw.artist || '').trim()
      if (!album || !artist) continue
      const key = `${album}::${artist}`
      let entry = byAlbum.get(key)
      if (!entry) {
        entry = {
          rec: { id: key, album, artist, year: raw.year, coverUrl: null, trackIds: [], owned: true },
          tracks: [],
          genres: new Map(),
          added: 0,
        }
        byAlbum.set(key, entry)
      }
      entry.tracks.push(raw)
      if (raw.genre) entry.genres.set(raw.genre, (entry.genres.get(raw.genre) || 0) + 1)
      const t = typeof raw.dateAdded === 'number' ? raw.dateAdded : Date.parse(String(raw.dateAdded || '')) || 0
      if (t > entry.added) entry.added = t
    }

    // Albums, not singles — a crate of one-track "albums" is a database
    // dump, not a record shop.
    const albums = [...byAlbum.values()].filter((e) => e.tracks.length >= 4)

    // Deterministic shuffle from the visit seed: same bins all visit long.
    let s = seed || 1
    const rand = (): number => {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    }
    const shuffle = <T,>(xs: T[]): T[] => {
      const out = [...xs]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    }

    const finish = (e: AlbumEntry): CrateRecord => {
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
      return { ...e.rec, coverUrl: hash ? `album-art://${hash}.jpg` : null, trackIds: ordered.map((t) => t.id) }
    }

    // The album's genre is the one most of its tracks carry.
    const filingOf = (e: AlbumEntry) => {
      let best = ''
      let n = -1
      for (const [g, c] of e.genres) if (c > n) { best = g; n = c }
      return fileGenre(best)
    }
    const byBin = new Map<string, Array<{ e: AlbumEntry; section?: string }>>()
    for (const e of albums) {
      const f = filingOf(e)
      let list = byBin.get(f.bin)
      if (!list) { list = []; byBin.set(f.bin, list) }
      list.push({ e, section: f.section })
    }
    const byArtist = (a: AlbumEntry, b: AlbumEntry): number =>
      filingKey(a.rec.artist).localeCompare(filingKey(b.rec.artist)) || a.rec.album.localeCompare(b.rec.album)

    return BINS.map((def): ShopBin => {
      if (def.kind === 'arrivals') {
        const newest = [...albums].sort((a, b) => b.added - a.added).slice(0, CRATE_CAPACITY)
        return { ...def, records: newest.map(finish), sections: [] }
      }
      const pool = byBin.get(def.id) || []
      const picked = pool.length > CRATE_CAPACITY ? shuffle(pool).slice(0, CRATE_CAPACITY) : [...pool]
      if (def.kind === 'mixed') {
        const rank = (x: string | undefined): number => Math.max(0, OTHER_SECTIONS.indexOf((x || 'ODDITIES') as typeof OTHER_SECTIONS[number]))
        picked.sort((a, b) => rank(a.section) - rank(b.section) || byArtist(a.e, b.e))
        return { ...def, records: picked.map((p) => finish(p.e)), sections: groupSections(picked.map((p) => p.section || 'ODDITIES')) }
      }
      picked.sort((a, b) => byArtist(a.e, b.e))
      const records = picked.map((p) => finish(p.e))
      return { ...def, records, sections: letterSections(records.map((r) => r.artist)) }
    })
  }, [lib.tracks, lib.artworkMap, artIndex, seed, live])
}
