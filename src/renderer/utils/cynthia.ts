import { Track, CynthiaScope } from '../types'

// Strip a Track down to the fields Cynthia actually uses. Done as an
// explicit map rather than passing Track[] through structurally because
// it (a) shrinks the IPC payload — no playCount, dateAdded, fileSize,
// path being shipped main-side just to be ignored — and (b) keeps the
// IPC contract narrow if Track ever grows new fields.
export function toCynthiaTrack(t: Track): CynthiaScope['tracks'][number] {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumArtist: t.albumArtist,
    trackNumber: t.trackNumber,
    trackCount: t.trackCount,
    discNumber: t.discNumber,
    discCount: t.discCount,
    year: t.year,
    genre: t.genre,
    duration: t.duration,
  }
}
