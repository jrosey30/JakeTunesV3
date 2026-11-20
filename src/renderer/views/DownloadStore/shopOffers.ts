/**
 * Taking an offer (Brief 257, Record Shop Phase 4). A refused album carries
 * what can be had instead (common/closest-edition.ts); each is taken only
 * here, from a tap, never on its own:
 *
 *   - edition:    a Save album of that edition, exactly as the Search tab or
 *                 the Edition menu would queue it (its own preflight, the walk
 *                 and the identity rules unchanged). The Listen List row rides
 *                 on it: Jake chose this edition for that jot.
 *   - songs:      each song that exists, saved as a song pinned to the asked
 *                 edition's own row (title, album, length), folded under the
 *                 refused album in Downloads; the songs Qobuz doesn't have go
 *                 on the Listen List as song rows to try again.
 *   - bandcamp:   the same album job again, allowed to take the lossy copy.
 *   - songs-each: the asked edition's songs, each saved as a song.
 *
 * The songs never carry the row's recommendation id: a few songs don't
 * fulfil an album jot (Brief 255's rule).
 */
import { enqueue, getQueue, markOfferTaken, queueKey, retry, trackQueryId, type QItem, type QResult, type QueueGroup } from './downloadQueue.ts'
import { albumJobFor } from './albumEditions.ts'
import { offerTakenEvent, type OfferSong, type ShopOffer } from '../../../common/closest-edition.ts'

/** Apple's " - Single" / " - EP" stamp off the name. ⚠️ TWIN: albumEditions.ts plainName. */
const plainName = (name: string): string => name.replace(/\s[-–—]\s*(EP|Single)$/i, '').trim() || name

/** The Save album job for an offered edition. Never the refused job's own key. Pure. */
export function editionOfferJob(parent: QItem, offer: Extract<ShopOffer, { kind: 'edition' }>, clickedAt: number): QResult {
  const r = parent.result
  const job = albumJobFor({ artist: r.artist || '', album: offer.edition.name, edition: offer.edition, editionFrom: 'picked', surface: r.surface ?? 'panel', origin: r.origin, clickedAt })
  if (queueKey(job) === parent.key) job.id = `${job.id}|${offer.edition.collectionId}`
  job.offerOf = parent.key
  return job
}

/** One song save per song, each the Search tab's song save of that row of the asked edition, folded under the album. Pure. */
export function offerSongJobs(parent: QItem, songs: readonly OfferSong[], o: { of: number; notAcquired?: readonly OfferSong[]; skippedOwned?: number }): QResult[] {
  const r = parent.result
  const artist = (r.artist || '').trim()
  const album = plainName((r.album || '').trim())
  if (!artist) return []
  const notAcquired = (o.notAcquired ?? []).map((s, i) => ({ position: s.trackNumber ?? i + 1, title: s.title, reason: 'not on Qobuz' }))
  return songs.filter((s) => s.title).map((s, i): QResult => {
    const group: QueueGroup = { parentKey: parent.key, label: album, of: o.of, position: s.trackNumber ?? i + 1, notAcquired, skippedOwned: o.skippedOwned ?? 0, ...(r.collectionId ? { collectionId: r.collectionId } : {}) }
    return {
      kind: 'query', source: 'qobuz', mediaType: 'track',
      id: trackQueryId(artist, s.title),
      desc: `${s.title} — ${artist}`,
      artist, title: s.title,
      album: album || undefined,
      durationMs: s.durationSec ? Math.round(s.durationSec * 1000) : undefined,
      cleanedSource: s.explicitness === 'cleaned' || undefined,
      explicitSource: s.explicitness === 'explicit' || (s.explicitness == null && r.explicitSource) || undefined,
      releaseYear: r.releaseYear,
      // The sender and share source ride along; the album jot itself does not.
      origin: { ...(r.origin ?? { recommendationIds: [] }), recommendationIds: [], entryId: undefined, group },
    }
  })
}

/** The songs Qobuz doesn't have, as Listen List song rows. */
async function keepOnList(parent: QItem, missing: readonly OfferSong[]): Promise<number> {
  const add = typeof window !== 'undefined' ? window.electronAPI?.addRecommendation : undefined
  const artist = (parent.result.artist || '').trim()
  const album = plainName((parent.result.album || '').trim())
  if (!add || !artist) return 0
  let n = 0
  // One at a time: each is a write to the list (and to homemini behind it).
  for (const s of missing) {
    try {
      const res = await add({ song: s.title, artist, album: album || undefined, note: 'Not on Qobuz yet', source: 'user', kind: 'track' }) as { ok?: boolean } | undefined
      if (res?.ok) n++
    } catch { /* the rest still go */ }
  }
  return n
}

function logOffer(o: ShopOffer): void {
  try { window.electronAPI.usageLog?.([{ t: new Date().toISOString(), ...offerTakenEvent(o) }]) } catch { /* observation only */ }
}

/** Take one offer on a refused job. Answers what was queued, and what went on the list. */
export async function takeOffer(parentKey: string, offer: ShopOffer): Promise<{ queued: number; listed: number }> {
  const parent = getQueue().find((q) => q.key === parentKey)
  if (!parent || parent.offerTaken || parent.status === 'queued' || parent.status === 'downloading') return { queued: 0, listed: 0 }
  logOffer(offer)
  switch (offer.kind) {
    case 'edition': {
      markOfferTaken(parent.key, 'edition')
      enqueue(editionOfferJob(parent, offer, Date.now()))
      return { queued: 1, listed: 0 }
    }
    case 'songs': {
      markOfferTaken(parent.key, 'songs')
      const jobs = offerSongJobs(parent, offer.have, { of: offer.of, notAcquired: offer.missing, skippedOwned: offer.owned })
      for (const j of jobs) enqueue(j)
      const listed = offer.missing.length ? await keepOnList(parent, offer.missing) : 0
      return { queued: jobs.length, listed }
    }
    case 'bandcamp': {
      // The same album again, this time allowed the lossy copy: the walk runs as it always has.
      markOfferTaken(parent.key, 'bandcamp', { lossyOk: true })
      retry(parent.key)
      return { queued: 1, listed: 0 }
    }
    case 'songs-each': {
      const r = parent.result
      const api = window.electronAPI?.itunesAlbumTracks
      if (!api || !r.artist || !r.album) return { queued: 0, listed: 0 }
      const res = await api(r.collectionId ?? { artist: r.artist, album: r.album }).catch(() => null)
      if (!res?.ok || !res.tracks.length) return { queued: 0, listed: 0 }
      markOfferTaken(parent.key, 'songs-each')
      const songs: OfferSong[] = res.tracks.map((t) => ({ title: t.song, trackNumber: t.trackNumber, durationSec: t.durationSecs, explicitness: t.explicitness }))
      const jobs = offerSongJobs(parent, songs, { of: songs.length })
      for (const j of jobs) enqueue(j)
      return { queued: jobs.length, listed: 0 }
    }
  }
}
