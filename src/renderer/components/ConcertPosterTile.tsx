import { useCallback, useState } from 'react'
import type React from 'react'
import AlbumArtImage from './AlbumArtImage'
import { liveCaption, posterShowLine, posterVenue } from '../../common/artist-page'
import '../styles/concert-stage.css'

/**
 * One show on the artist page's Live wall, as its poster (Jake, 2026-10-18:
 * "as posters, not albums!!!"; the approved 10/20 design):
 *
 *  - a REAL poster (portrait art — taller than it is wide) is shown whole and
 *    uncropped, at its own aspect;
 *  - a show without one gets a poster made from its square cover and its
 *    details — band, title, venue · city · year — in the 961:1292 frame of a
 *    real one, so the wall reads as one set of posters.
 *
 * Which one is decided from the picture itself once it loads; until then the
 * slot holds the 961:1292 frame so nothing jumps. Under each: the venue, then
 * city · date · set. Every line wraps — a name never clips.
 *
 * Presentational only: the caller decides what the tile opens.
 */
export interface ConcertPosterTileProps {
  artHash?: string
  band: string
  title: string
  venue?: string
  city?: string
  date?: string
  /** Release year, for a made poster's footer when the date is not grounded. */
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

/** Taller than this (h / w) reads as a poster; a square cover is ~1.0. */
const POSTER_MIN_RATIO = 1.15

function bandSize(band: string): string {
  const longestWord = Math.max(0, ...band.split(/\s+/).map((w) => [...w].length))
  const n = [...band].length
  if (n <= 7 && longestWord <= 7) return 'xl'
  if (n <= 14 && longestWord <= 9) return 'l'
  if (n <= 26 && longestWord <= 12) return 'm'
  return 's'
}

export default function ConcertPosterTile({
  artHash, band, title, venue, city, date, year, songs, fullSet, studio, tooltip, onOpen, onContextMenu, onDragStart, albumKey,
}: ConcertPosterTileProps) {
  // null = not measured yet; true = real portrait poster; false = square cover.
  const [portrait, setPortrait] = useState<boolean | null>(null)
  const [ratio, setRatio] = useState<number>(1292 / 961)
  const onArtLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget
    if (w > 0 && h > 0) {
      setPortrait(h / w >= POSTER_MIN_RATIO)
      setRatio(h / w)
    }
  }, [])
  const onArtError = useCallback(() => setPortrait(false), [])
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
      {portrait ? (
        <div className="concert-tile-poster" style={{ aspectRatio: `1 / ${ratio}` }}>
          <AlbumArtImage hash={artHash!} alt={`${band} — ${title} poster`} className="concert-tile-poster-img" size={640} onLoad={onArtLoad} onError={onArtError} />
        </div>
      ) : (
        <div className={`concert-tile-made${portrait === null && artHash ? ' is-measuring' : ''}`}>
          <span className={`concert-tile-made-band concert-tile-made-band--${bandSize(band)}`}>{band}</span>
          <div className="concert-tile-made-art">
            {artHash
              ? <AlbumArtImage hash={artHash} alt="" className="concert-tile-made-img" size={480} onLoad={onArtLoad} onError={onArtError} />
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
