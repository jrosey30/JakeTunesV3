import { useSyncExternalStore } from 'react'
import type { Recommendation } from '../types'
import { formatAppDate } from '../utils/formatDate'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import type { MmSuggestion } from './store'
import {
  canDownloadReco,
  getLtlDownloadStatus,
  isLtlDownloadBusy,
  queueRecoDownload,
  subscribeLtlDownload,
  getLtlDownloadSnapshot,
} from './ltlDownload'

export function displayRecoName(rec: Recommendation): string {
  const title = rec.matchedTitle || rec.song
  const artist = rec.matchedArtist || rec.artist
  if (title && artist) return `${title} — ${artist}`
  return title || artist || rec.album || rec.note || 'Untitled'
}

interface RecoRowProps {
  rec: Recommendation
  onDelete: (rec: Recommendation) => void
  onOpenDownload?: (rec: Recommendation) => void
}

export function RecoRow({ rec, onDelete, onOpenDownload }: RecoRowProps) {
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const dlMap = useSyncExternalStore(subscribeLtlDownload, getLtlDownloadSnapshot)
  const dl = dlMap.get(rec.id) ?? getLtlDownloadStatus(rec.id)
  const artwork = rec.artworkUrl
  const isPlaying = preview.playingId === rec.id
  const canDl = canDownloadReco(rec)
  const dlBusy = isLtlDownloadBusy(rec.id)

  const dlLabel = dl.state === 'downloading' ? '…'
    : dl.state === 'queued' ? '…'
    : dl.state === 'done' ? '✓'
    : dl.state === 'error' ? '!'
    : '↓'

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
        {/* v2: the synced note carries machine bits ("from Ben", the source
            URL). Display the HUMAN part only; the friend becomes ONE clean
            chip on the date line (it was rendering twice — Jake caught it). */}
        {(() => {
          const rawNote = String(rec.note || '')
          const friend = (rawNote.match(/(?:^|· )from ([^·]+?)(?: ·|$)/) || [])[1]?.trim()
          const humanNote = rawNote
            .replace(/(?:^|· )from [^·]+?(?= ·|$)/, '')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/(?:\s*·\s*)+/g, ' · ').replace(/^\s*·\s*|\s*·\s*$/g, '').trim()
          return (
            <>
              {humanNote && <div className="ltl-note">{humanNote}</div>}
              <div className="ltl-sub">
                <span className="ltl-date">{formatAppDate(rec.createdAt)}</span>
                {friend && <span className="ltl-friend-chip">from {friend}</span>}
              </div>
            </>
          )
        })()}
      </div>
      {canDl && (
        <button
          type="button"
          className={`ltl-download${dl.state === 'done' ? ' ltl-download--done' : ''}${dl.state === 'error' ? ' ltl-download--err' : ''}`}
          onClick={() => {
            if (dl.state === 'error') onOpenDownload?.(rec)
            else queueRecoDownload(rec)
          }}
          disabled={dlBusy}
          title={
            dl.state === 'downloading' ? 'Downloading…'
            : dl.state === 'queued' ? 'Queued…'
            : dl.state === 'done' ? (dl.imported ? `Imported ${dl.imported} track(s)` : 'Already in library')
            : dl.state === 'error' ? `${dl.error || 'Failed'} — click to open Download view`
            : 'Download to library'
          }
        >
          {dlLabel}
        </button>
      )}
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
