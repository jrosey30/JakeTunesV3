/**
 * Action B's verification: the request IS the snapshot. The same album judge
 * (verifyAlbumCandidate) runs against a RequestedAlbum built from the
 * source edition's own tracklist — no collection id, no packaging labels —
 * so the staged files must match the snapshot's count, titles and runtimes
 * or the whole thing is refused. Pure.
 */
import { buildRequestedAlbum, verifyAlbumCandidate, type CandidateAlbum, type AlbumVerdict } from './album-identity.ts'
import type { RequestedAlbum } from '../common/acquisition-identity.ts'
import type { SourceEdition } from '../common/source-edition.ts'

export function requestFromSourceEdition(se: SourceEdition): RequestedAlbum {
  return buildRequestedAlbum({
    artist: se.artist, title: se.title,
    trackCount: se.tracks.length,
    tracks: se.tracks.map((t) => ({ title: t.title, trackNumber: t.trackNumber, durationSec: t.durationSec ?? undefined })),
    releaseYear: se.releaseYear,
  })
}

/** Exact only when the staged album is the snapshot; a changed source refuses with the judge's reason. */
export function verifySourceEdition(se: SourceEdition, staged: CandidateAlbum): AlbumVerdict {
  const v = verifyAlbumCandidate(requestFromSourceEdition(se), staged)
  if (v.verdict === 'exact') return v
  return { ...v, reason: `the ${se.provider} tracklist is not the one you compared — ${v.reason}` } as AlbumVerdict
}
