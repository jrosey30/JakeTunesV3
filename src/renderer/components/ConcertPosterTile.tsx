import type React from 'react'
import AlbumArtImage from './AlbumArtImage'
import '../styles/concert-stage.css'

/**
 * One show as a portrait poster tile — the artist page's Live wall (Jake,
 * 2026-10-18: "needs to be displayed via poster presentation"). The poster
 * or cover fills a 3:4 portrait slot (aspect-fill + clip, the way the
 * phone's ConcertPosterThumb shows a square cover), with the phone's orange
 * LIVE capsule on it; underneath, the Live Concerts rows' type: orange band,
 * serif show title, venue / city / date in the secondary colour. Every line
 * wraps — a name never clips.
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
  /** Hover text. */
  tooltip: string
  onOpen: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  /** data-album-key, for probes. */
  albumKey?: string
}

export default function ConcertPosterTile({
  artHash, band, title, venue, city, date, tooltip, onOpen, onContextMenu, onDragStart, albumKey,
}: ConcertPosterTileProps) {
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
      <div className="concert-tile-art">
        {artHash
          ? <AlbumArtImage hash={artHash} alt={title} className="concert-tile-img" size={480} />
          : <div className="concert-tile-noart" aria-hidden="true" />}
        <span className="concert-tile-live">LIVE</span>
      </div>
      {band && <div className="concert-tile-band">{band}</div>}
      <div className="concert-tile-show">{title}</div>
      {(venue || city || date) && (
        <div className="concert-tile-where">
          {venue && <b>{venue}</b>}{venue && city ? ', ' : ''}{city}{(venue || city) && date ? ' · ' : ''}{date}
        </div>
      )}
    </button>
  )
}
