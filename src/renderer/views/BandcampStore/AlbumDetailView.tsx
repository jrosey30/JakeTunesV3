import { StoreAlbumWire } from '../../types'
import { coverUrl } from './helpers'
import { usePreviewPlayer } from './PreviewPlayer'
import BuyButton from './BuyButton'

interface Props {
  album: StoreAlbumWire
  onBack: () => void
  onBuy: (album: StoreAlbumWire) => void
}

function fmtDur(sec: number): string {
  if (!sec || sec < 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function AlbumDetailView({ album, onBack, onBuy }: Props) {
  const { playingUrl, toggle } = usePreviewPlayer()
  const art = coverUrl(album.coverArtId, 16)

  return (
    <div className="bcs-detail">
      <button className="bcs-back" onClick={onBack}>‹ Back</button>

      <div className="bcs-detail-head">
        <div className="bcs-detail-art">
          {art ? <img src={art} alt="" /> : <div className="bcs-tile-noart" />}
        </div>
        <div className="bcs-detail-meta">
          <h2 className="bcs-detail-title">{album.title}</h2>
          <div className="bcs-detail-artist">{album.artist}</div>
          {album.releaseDate && <div className="bcs-detail-sub">{album.releaseDate}</div>}
          {album.geo && <div className="bcs-detail-sub">{album.geo}</div>}
          {album.tags.length > 0 && (
            <div className="bcs-tags">
              {album.tags.slice(0, 8).map((t) => <span key={t} className="bcs-tag">{t}</span>)}
            </div>
          )}
          <div className="bcs-detail-buy">
            <BuyButton album={album} onBuy={onBuy} />
          </div>
        </div>
      </div>

      <ol className="bcs-tracklist">
        {album.tracks.map((t) => {
          const isPreviewing = !!t.previewUrl && playingUrl === t.previewUrl
          return (
            <li key={`${t.num}-${t.title}`} className={`bcs-track ${isPreviewing ? 'bcs-track--playing' : ''}`}>
              <button
                className="bcs-preview-btn"
                disabled={!t.previewUrl}
                onClick={() => toggle(t.previewUrl)}
                title={t.previewUrl ? 'Preview' : 'No preview available'}
              >
                {isPreviewing ? '■' : '▶'}
              </button>
              <span className="bcs-track-num">{t.num || ''}</span>
              <span className="bcs-track-title">{t.title}</span>
              <span className="bcs-track-dur">{fmtDur(t.durationSec)}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
