import { useSyncExternalStore } from 'react'
import type { Recommendation } from '../types'
import { formatAppDate } from '../utils/formatDate'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import type { MmSuggestion } from './store'

export function displayRecoName(rec: Recommendation): string {
  const title = rec.matchedTitle || rec.song
  const artist = rec.matchedArtist || rec.artist
  if (title && artist) return `${title} — ${artist}`
  return title || artist || rec.album || rec.note || 'Untitled'
}

interface RecoRowProps {
  rec: Recommendation
  onDelete: (rec: Recommendation) => void
}

export function RecoRow({ rec, onDelete }: RecoRowProps) {
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const artwork = rec.artworkUrl
  const isPlaying = preview.playingId === rec.id

  return (
    <div className="ltl-row">
      <div className="ltl-art">
        {artwork
          ? <img src={artwork} alt="" loading="lazy" />
          : <div className="ltl-art-placeholder" aria-hidden="true">♪</div>}
        {rec.previewUrl && (
          <button
            type="button"
            className={`ltl-preview-btn ${isPlaying ? 'ltl-preview-btn--playing' : ''}`}
            onClick={() => togglePreview(
              rec.id,
              rec.previewUrl!,
              rec.matchedTitle || rec.song || rec.album || 'Preview',
              rec.matchedArtist || rec.artist || '',
            )}
            title={isPlaying ? 'Stop preview' : 'Play preview in player'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
        )}
      </div>
      <div className="ltl-meta">
        <div className="ltl-name">{displayRecoName(rec)}</div>
        {(rec.matchedAlbum || rec.album) && (
          <div className="ltl-album">{rec.matchedAlbum || rec.album}</div>
        )}
        {rec.note && <div className="ltl-note">{rec.note}</div>}
        <div className="ltl-sub">
          <span className="ltl-date">{formatAppDate(rec.createdAt)}</span>
        </div>
      </div>
      <button type="button" className="ltl-delete" onClick={() => onDelete(rec)} title="Remove from list">✕</button>
    </div>
  )
}

interface MmSuggestionsProps {
  visible: MmSuggestion[]
  loading: boolean
  onRefresh: () => void
  onAdd: (s: MmSuggestion) => void
}

export function MmSuggestions({ visible, loading, onRefresh, onAdd }: MmSuggestionsProps) {
  return (
    <div className="ltl-mm-suggests">
      <div className="ltl-mm-head">
        <span className="ltl-mm-title">Music Man suggests</span>
        <button
          type="button"
          className="ltl-mm-refresh"
          onClick={onRefresh}
          disabled={loading}
          aria-busy={loading || undefined}
          title="New suggestions"
        >↻</button>
      </div>
      <div className="ltl-mm-row">
        {Array.from({ length: 3 }).map((_, i) => {
          const s = visible[i]
          if (s) {
            return (
              <div className="ltl-mm-card" key={`${s.song}-${s.artist}-${i}`}>
                <div className="ltl-mm-card-text">
                  <div className="ltl-mm-song">{s.song}</div>
                  <div className="ltl-mm-artist">{s.artist}</div>
                  {s.note && <div className="ltl-mm-note">{s.note}</div>}
                </div>
                <button type="button" className="ltl-mm-add" onClick={() => onAdd(s)}>+ Add</button>
              </div>
            )
          }
          if (!loading) return null
          return (
            <div className="ltl-mm-card ltl-mm-card--loading" key={`loading-${i}`} aria-busy="true">
              <div className="ltl-mm-loading">Finding another…</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
