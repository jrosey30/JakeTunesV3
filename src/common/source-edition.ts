/**
 * A SOURCE EDITION — an album selected by its stable source identity and
 * its own tracklist, not by an iTunes collection (Compare editions, action
 * B). The selection is the URL plus the tracklist snapshot taken when Jake
 * compared; acquisition is verified against exactly that snapshot, so a
 * tracklist that changed at the source between comparison and acquisition
 * is refused, never silently taken.
 */
export interface SourceEditionTrack { title: string; trackNumber: number; durationSec: number | null }
export interface SourceEdition {
  provider: 'bandcamp'
  /** The stable identity: the album's own page. */
  url: string
  title: string
  artist: string
  releaseYear?: number
  tracks: SourceEditionTrack[]
  /** What this edition was chosen INSTEAD of, and where it differs — carried for honest reporting. */
  differsFrom?: { label: string; collectionId?: number; tracks: Array<{ position: number; title: string; foundSec: number | null; pickedSec: number | null }> }
}

export const fmtSec = (s: number | null | undefined): string => s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`

/** "differs from iTunes 96265705 at track 4 (8:04 vs 6:50)" */
export function differsLine(se: SourceEdition, nameTheOther = true): string | null {
  if (!se.differsFrom || se.differsFrom.tracks.length === 0) return null
  const at = se.differsFrom.tracks.map((t) => `track ${t.position} (${fmtSec(t.foundSec)} vs ${fmtSec(t.pickedSec)})`).join(', ')
  return nameTheOther ? `differs from ${se.differsFrom.label} at ${at}` : `differs at ${at}`
}

/** The source identity in one line: "terryleebrownjunior.bandcamp.com/album/chocolate-chords · 12 tracks · 1997". */
export function sourceEditionLabel(se: SourceEdition, trackCount?: number): string {
  const n = se.tracks.length || trackCount || 0
  return `${se.url.replace(/^https?:\/\//, '')} · ${n} tracks${se.releaseYear ? ` · ${se.releaseYear}` : ''}`
}
