import { useState, useEffect, useCallback, useRef } from 'react'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import { setNotice } from '../activity'
import type { Recommendation } from '../types'
import '../styles/listen-to-the-list.css'

// Brief 122 Phase 1 — "Listen to the List". Mirrors the mobile app's
// recommendations list on desktop and lets you add/delete from here too.
// Reads recommendations.json fresh from the NAS state dir (via the main
// process); add/delete route through the Mini backend so it stays the
// single writer (cache-coherent + iTunes-enriched). Does NOT touch the
// music library, its metadata, or its artwork — reco artwork is external
// (iTunes) URLs.
export default function ListenToTheListView() {
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Recommendation | null>(null)
  const [form, setForm] = useState({ song: '', artist: '', album: '', note: '' })
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const load = useCallback(async () => {
    const res = await window.electronAPI.loadRecommendations()
    setRecs(res.ok ? res.recommendations : [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Stop any preview when leaving the view.
  useEffect(() => () => { audioRef.current?.pause() }, [])

  const canAdd = form.song.trim() || form.artist.trim() || form.album.trim() || form.note.trim()

  const handleAdd = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canAdd || adding) return
    setAdding(true)
    const res = await window.electronAPI.addRecommendation({
      song: form.song.trim() || undefined,
      artist: form.artist.trim() || undefined,
      album: form.album.trim() || undefined,
      note: form.note.trim() || undefined,
    })
    setAdding(false)
    if (!res.ok) {
      setNotice(
        res.error?.includes('failed') || res.error?.includes('fetch')
          ? "Couldn't reach the JakeTunes backend to save. Is the Mini up?"
          : `Couldn't save recommendation${res.error ? `: ${res.error}` : ''}.`,
        { kind: 'error' }
      )
      return
    }
    setForm({ song: '', artist: '', album: '', note: '' })
    await load()
  }, [form, canAdd, adding, load])

  const handleDelete = useCallback(async (rec: Recommendation) => {
    const res = await window.electronAPI.deleteRecommendation(rec.id)
    if (!res.ok) {
      setNotice(`Couldn't delete${res.error ? `: ${res.error}` : ''}.`, { kind: 'error' })
      return
    }
    await load()
  }, [load])

  const togglePreview = useCallback((rec: Recommendation) => {
    if (!rec.previewUrl) return
    const audio = audioRef.current
    if (!audio) return
    if (playingId === rec.id) {
      audio.pause()
      setPlayingId(null)
      return
    }
    audio.src = rec.previewUrl
    audio.currentTime = 0
    audio.play().then(() => setPlayingId(rec.id)).catch(() => {
      setNotice("Couldn't play preview.", { kind: 'error' })
    })
  }, [playingId])

  const displayName = (rec: Recommendation) => {
    const title = rec.matchedTitle || rec.song
    const artist = rec.matchedArtist || rec.artist
    if (title && artist) return `${title} — ${artist}`
    return title || artist || rec.album || rec.note || 'Untitled'
  }

  return (
    <div className="ltl-view">
      <div className="ltl-header">
        <h1 className="ltl-title">Listen to the List</h1>
        <span className="ltl-count">{recs.length} {recs.length === 1 ? 'reco' : 'recos'}</span>
      </div>

      <form className="ltl-add" onSubmit={handleAdd}>
        <input className="ltl-add-input" placeholder="Song" value={form.song}
          onChange={e => setForm(f => ({ ...f, song: e.target.value }))} />
        <input className="ltl-add-input" placeholder="Artist" value={form.artist}
          onChange={e => setForm(f => ({ ...f, artist: e.target.value }))} />
        <input className="ltl-add-input" placeholder="Album" value={form.album}
          onChange={e => setForm(f => ({ ...f, album: e.target.value }))} />
        <input className="ltl-add-input ltl-add-note" placeholder="Note (optional)" value={form.note}
          onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
        <button className="ltl-add-btn" type="submit" disabled={!canAdd || adding}>
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>

      {loading ? (
        <div className="ltl-loading">Loading…</div>
      ) : recs.length === 0 ? (
        <EmptyState noun="recommendations" />
      ) : (
        <div className="ltl-list">
          {recs.map(rec => {
            const artwork = rec.artworkUrl
            const isPlaying = playingId === rec.id
            return (
              <div key={rec.id} className="ltl-row">
                <div className="ltl-art">
                  {artwork
                    ? <img src={artwork} alt="" loading="lazy" />
                    : <div className="ltl-art-placeholder" aria-hidden="true">♪</div>}
                  {rec.previewUrl && (
                    <button
                      className={`ltl-preview-btn ${isPlaying ? 'ltl-preview-btn--playing' : ''}`}
                      onClick={() => togglePreview(rec)}
                      title={isPlaying ? 'Pause preview' : 'Play preview'}
                    >
                      {isPlaying ? '❚❚' : '▶'}
                    </button>
                  )}
                </div>
                <div className="ltl-meta">
                  <div className="ltl-name">{displayName(rec)}</div>
                  {(rec.matchedAlbum || rec.album) && (
                    <div className="ltl-album">{rec.matchedAlbum || rec.album}</div>
                  )}
                  {rec.note && <div className="ltl-note">{rec.note}</div>}
                  <div className="ltl-sub">
                    <span className="ltl-date">{new Date(rec.createdAt).toLocaleDateString()}</span>
                    {rec.appleMusicUrl && (
                      <a className="ltl-link" href={rec.appleMusicUrl} target="_blank" rel="noreferrer">Apple Music ↗</a>
                    )}
                  </div>
                </div>
                <button className="ltl-delete" onClick={() => setDeleteTarget(rec)} title="Remove from list">✕</button>
              </div>
            )
          })}
        </div>
      )}

      <audio ref={audioRef} onEnded={() => setPlayingId(null)} hidden />

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
