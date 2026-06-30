import { useState, useRef, useSyncExternalStore } from 'react'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useLibrary } from '../context/LibraryContext'
import { getPreviewSnapshot, stopPreview } from '../previewPlayer'
import type { Recommendation } from '../types'
import { MmSuggestions, RecoRow } from './components'
import { useItunesAutocomplete } from './useItunesAutocomplete'
import { useListenToTheList } from './useListenToTheList'
import type { AddFormState } from './useListenToTheList'
import {
  canDownloadReco,
  getLtlDownloadSnapshot,
  prefillDownloadView,
  queueAllRecoDownloads,
  subscribeLtlDownload,
} from './ltlDownload'
import '../styles/listen-to-the-list.css'

export default function ListenToTheListView() {
  const { dispatch } = useLibrary()
  const {
    recs,
    loading,
    adding,
    visibleMm,
    suggLoading,
    refreshSuggestions,
    addFromForm,
    addSuggestion,
    deleteRecommendation,
    EMPTY_FORM,
  } = useListenToTheList()

  const [form, setForm] = useState<AddFormState>(EMPTY_FORM)
  const [deleteTarget, setDeleteTarget] = useState<Recommendation | null>(null)
  const { suggestions, searching, pick, clearSuggestions } = useItunesAutocomplete(form.song, form.artist)

  const viewRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('listen-to-the-list', viewRef)

  const canAdd = Boolean(form.song.trim() || form.artist.trim() || form.album.trim() || form.note.trim())

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canAdd || adding) return
    const draft = { ...form }
    setForm(EMPTY_FORM)
    clearSuggestions()
    const result = await addFromForm(draft)
    if (!result.ok) setForm(draft)
  }

  const handleDelete = (rec: Recommendation) => {
    if (getPreviewSnapshot().playingId === rec.id) stopPreview()
    void deleteRecommendation(rec)
  }

  const jots = recs.filter((r) => (r.source ?? 'user') === 'user')
  const suggested = recs.filter((r) => r.source === 'mm' || r.source === 'radar')
  const downloadable = recs.filter(canDownloadReco)
  const dlMap = useSyncExternalStore(subscribeLtlDownload, getLtlDownloadSnapshot)
  const dlActive = [...dlMap.values()].some((s) => s.state === 'queued' || s.state === 'downloading')

  const openDownloadForReco = (rec: Recommendation) => {
    prefillDownloadView(rec)
    dispatch({ type: 'SET_VIEW', view: 'download' })
  }

  return (
    <div className="ltl-view" ref={viewRef}>
      <div className="ltl-header">
        <h1 className="ltl-title">Listen to the List</h1>
        <span className="ltl-count">{recs.length} {recs.length === 1 ? 'reco' : 'recos'}</span>
        {downloadable.length > 0 && (
          <button
            type="button"
            className="ltl-download-all"
            onClick={() => queueAllRecoDownloads(downloadable)}
            disabled={dlActive}
            title="Download all via Qobuz (one at a time)"
          >
            {dlActive ? 'Downloading…' : `Download all (${downloadable.length})`}
          </button>
        )}
      </div>

      <div className="ltl-add-wrap">
        <form className="ltl-add" onSubmit={handleSubmit}>
          <input
            className="ltl-add-input"
            placeholder="Song"
            value={form.song}
            onChange={(e) => setForm((f) => ({ ...f, song: e.target.value }))}
          />
          <input
            className="ltl-add-input"
            placeholder="Artist"
            value={form.artist}
            onChange={(e) => setForm((f) => ({ ...f, artist: e.target.value }))}
          />
          <input
            className="ltl-add-input"
            placeholder="Album"
            value={form.album}
            onChange={(e) => setForm((f) => ({ ...f, album: e.target.value }))}
          />
          <input
            className="ltl-add-input ltl-add-note"
            placeholder="Note (optional)"
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
          <button className="ltl-add-btn" type="submit" disabled={!canAdd || adding}>
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
        {(suggestions.length > 0 || searching) && (
          <div className="ltl-suggestions">
            {searching && suggestions.length === 0 && (
              <div className="ltl-suggest-empty">Searching…</div>
            )}
            {suggestions.map((s, i) => (
              <button
                type="button"
                key={`${s.song}-${s.artist}-${i}`}
                className="ltl-suggest-row"
                onClick={() => {
                  const picked = pick(s)
                  setForm((f) => ({ ...f, ...picked }))
                }}
              >
                {s.artworkUrl
                  ? <img className="ltl-suggest-art" src={s.artworkUrl} alt="" loading="lazy" />
                  : <span className="ltl-suggest-art ltl-suggest-art--ph" aria-hidden="true">♪</span>}
                <span className="ltl-suggest-text">
                  <span className="ltl-suggest-song">{s.song}</span>
                  <span className="ltl-suggest-artist">{s.artist}</span>
                  {s.album && <span className="ltl-suggest-album">{s.album}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <MmSuggestions
        visible={visibleMm}
        loading={suggLoading}
        onRefresh={() => void refreshSuggestions()}
        onAdd={(s) => void addSuggestion(s)}
      />

      {loading ? (
        <div className="ltl-loading">Loading…</div>
      ) : recs.length === 0 ? (
        <EmptyState noun="recommendations" />
      ) : (
        <div className="ltl-list">
          {jots.length > 0 && (
            <div className="ltl-section">
              <div className="ltl-section-head">
                Your jots<span className="ltl-section-count">{jots.length}</span>
              </div>
              {jots.map((rec) => (
                <RecoRow key={rec.id} rec={rec} onDelete={() => setDeleteTarget(rec)} onOpenDownload={openDownloadForReco} />
              ))}
            </div>
          )}
          {suggested.length > 0 && (
            <div className="ltl-section">
              <div className="ltl-section-head">
                Suggested for you<span className="ltl-section-count">{suggested.length}</span>
              </div>
              {suggested.map((rec) => (
                <RecoRow key={rec.id} rec={rec} onDelete={() => setDeleteTarget(rec)} onOpenDownload={openDownloadForReco} />
              ))}
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          message="Remove this from your list?"
          detail="This deletes the recommendation everywhere (mobile too). This cannot be undone."
          confirmLabel="Remove"
          onConfirm={() => { handleDelete(deleteTarget); setDeleteTarget(null) }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
