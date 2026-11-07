import type React from 'react'
import AlbumArtImage from './AlbumArtImage'
import { liveCaption, posterShowLine, posterVenue } from '../../common/artist-page'
import { POSTER_GROUND, isMatteColour } from '../../common/concert-poster'
import '../styles/concert-stage.css'

/**
 * One show on the artist page's Live wall, as its poster (Jake, 2026-10-18:
 * "as posters, not albums!!!"; the poster rule, 2026-11-06, in
 * common/concert-poster.ts):
 *
 *  - a declared concert draws its one image in the 961:1292 frame: whole, never
 *    cropped, on a matte of the poster's own edge colour, nothing on top. There
 *    is no measuring and no threshold: one frame fits every poster;
 *  - a live ALBUM is not a show and has no poster, so it is drawn as a made tile
 *    from its cover and its details, in the same frame, so the wall still reads
 *    as one set of posters.
 *
 * Under each: the venue, then city · date · set. Every line wraps — a name never
 * clips.
 *
 * Presentational only: the caller decides what the tile opens.
 */
export interface ConcertPosterTileProps {
  /** A declared show: its poster's hash. A live album: its cover's. */
  artHash?: string
  /** A show's matte (concert.posterMatte). */
  matte?: string
  band: string
  title: string
  venue?: string
  city?: string
  date?: string
  /** Release year, for a made tile's footer when the date is not grounded. */
  year?: number | string
  /** Songs in the set. */
  songs?: number
  /** A declared full concert (vs a live album). */
  fullSet?: boolean
  /** The show's own details say it was taped in a studio. */
  studio?: boolean
  /** Hover text. */
  tooltip: string
  onOpen: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  /** data-album-key, for probes. */
  albumKey?: string
}

function bandSize(band: string): string {
  const longestWord = Math.max(0, ...band.split(/\s+/).map((w) => [...w].length))
  const n = [...band].length
  if (n <= 7 && longestWord <= 7) return 'xl'
  if (n <= 14 && longestWord <= 9) return 'l'
  if (n <= 26 && longestWord <= 12) return 'm'
  return 's'
}

export default function ConcertPosterTile({
  artHash, matte, band, title, venue, city, date, year, songs, fullSet, studio, tooltip, onOpen, onContextMenu, onDragStart, albumKey,
}: ConcertPosterTileProps) {
  const caption = liveCaption({ title, venue, city, date, songs, fullSet, studio })
  const shownVenue = posterVenue(venue)
  const showLine = posterShowLine({ venue: shownVenue, city, date, year })

  return (
    <button
      type="button"
      className="concert-tile"
      data-album-key={albumKey}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      title={tooltip}
    >
      {fullSet ? (
        <div className="concert-tile-poster" style={{ background: isMatteColour(matte) ? matte : POSTER_GROUND }}>
          {artHash
            ? <AlbumArtImage hash={artHash} alt={`${band} — ${title} poster`} className="concert-tile-poster-img" size={640} />
            : <div className="concert-tile-noframe-art" aria-hidden="true" />}
        </div>
      ) : (
        <div className="concert-tile-made">
          <span className={`concert-tile-made-band concert-tile-made-band--${bandSize(band)}`}>{band}</span>
          <div className="concert-tile-made-art">
            {artHash
              ? <AlbumArtImage hash={artHash} alt="" className="concert-tile-made-img" size={480} />
              : <div className="concert-tile-noart" aria-hidden="true" />}
          </div>
          <span className="concert-tile-made-rule" aria-hidden="true" />
          <span className="concert-tile-made-show">
            {title}
            {showLine && <><br />{showLine}</>}
          </span>
        </div>
      )}
      <div className="concert-tile-caption">
        <div className="concert-tile-head">{caption.head}</div>
        {caption.meta && <div className="concert-tile-meta">{caption.meta}</div>}
      </div>
    </button>
  )
}
