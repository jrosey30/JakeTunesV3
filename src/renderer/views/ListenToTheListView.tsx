import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import { setNotice } from '../activity'
import { togglePreview, subscribePreview, getPreviewSnapshot } from '../previewPlayer'
import type { Recommendation, ItunesSuggestion } from '../types'
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
  // Preview plays in the now-playing pill (iTunes-style) via the shared
  // previewPlayer; this view just reflects which row is currently playing.
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)

  // Brief 122 Phase 2 — iTunes autocomplete. As the song/artist fields are
  // typed, debounce a search and surface a live suggestion list. Picking a
  // suggestion fills the fields (the backend re-resolves on add, so the
  // chip still gets canonical artwork + links). suppressSearchRef stops the
  // effect from re-firing the moment a pick programmatically sets the field.
  const [suggestions, setSuggestions] = useState<ItunesSuggestion[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressSearchRef = useRef(false)

  const load = useCallback(async () => {
    const res = await window.electronAPI.loadRecommendations()
    setRecs(res.ok ? res.recommendations : [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Debounced iTunes search keyed on the song + artist fields.
  useEffect(() => {
    if (suppressSearchRef.current) { suppressSearchRef.current = false; return }
    const q = [form.song.trim(), form.artist.trim()].filter(Boolean).join(' ')
    if (q.length < 2) { setSuggestions([]); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      const res = await window.electronAPI.searchItunes(q)
      setSearching(false)
      setSuggestions(res.ok ? res.results : [])
    }, 250)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [form.song, form.artist])

  const pickSuggestion = useCallback((s: ItunesSuggestion) => {
    suppressSearchRef.current = true
    setForm((f) => ({ ...f, song: s.song, artist: s.artist, album: s.album || '' }))
    setSuggestions([])
  }, [])

  const canAdd = form.song.trim() || form.artist.trim() || form.album.trim() || form.note.trim()

  const handleAdd = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canAdd || adding) return
    setAdding(true)
    // try/finally is load-bearing: without it, a thrown invoke (e.g. the
    // IPC channel missing, or fetch rejecting) would skip setAdding(false),
    // leaving `adding` stuck true → the Add button disabled forever → clicks
    // silently do nothing. finally guarantees the button re-enables; catch
    // guarantees every failure is visible instead of swallowed.
    try {
      console.log('[ltl] add →', form)
      const res = await window.electronAPI.addRecommendation({
        song: form.song.trim() || undefined,
        artist: form.artist.trim() || undefined,
        album: form.album.trim() || undefined,
        note: form.note.trim() || undefined,
      })
      console.log('[ltl] add result', res)
      if (!res?.ok) {
        setNotice(
          (res?.error?.includes('failed') || res?.error?.includes('fetch'))
            ? "Couldn't reach the JakeTunes backend to save. Is the Mini up?"
            : `Couldn't save recommendation${res?.error ? `: ${res.error}` : ''}.`,
          { kind: 'error' }
        )
        return
      }
      setForm({ song: '', artist: '', album: '', note: '' })
      setSuggestions([])
      await load()
    } catch (err) {
      console.error('[ltl] add threw', err)
      setNotice(`Add failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' })
    } finally {
      setAdding(false)
    }
  }, [form, canAdd, adding, load])

  const handleDelete = useCallback(async (rec: Recommendation) => {
    const res = await window.electronAPI.deleteRecommendation(rec.id)
    if (!res.ok) {
      setNotice(`Couldn't delete${res.error ? `: ${res.error}` : ''}.`, { kind: 'error' })
      return
    }
    await load()
  }, [load])

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

      <div className="ltl-add-wrap">
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
                onClick={() => pickSuggestion(s)}
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

      {loading ? (
        <div className="ltl-loading">Loading…</div>
      ) : recs.length === 0 ? (
        <EmptyState noun="recommendations" />
      ) : (
        <div className="ltl-list">
          {recs.map(rec => {
            const artwork = rec.artworkUrl
            const isPlaying = preview.playingId === rec.id
            return (
              <div key={rec.id} className="ltl-row">
                <div className="ltl-art">
                  {artwork
                    ? <img src={artwork} alt="" loading="lazy" />
                    : <div className="ltl-art-placeholder" aria-hidden="true">♪</div>}
                  {rec.previewUrl && (
                    <button
                      className={`ltl-preview-btn ${isPlaying ? 'ltl-preview-btn--playing' : ''}`}
                      onClick={() => togglePreview(
                        rec.id,
                        rec.previewUrl!,
                        rec.matchedTitle || rec.song || rec.album || 'Preview',
                        rec.matchedArtist || rec.artist || ''
                      )}
                      title={isPlaying ? 'Stop preview' : 'Play preview in player'}
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
                    {/* Preview plays in the now-playing pill with its scrubber
                        (see NowPlaying). No "open in Apple Music" link by
                        design — we never send the user out to the app. */}
                  </div>
                </div>
                <button className="ltl-delete" onClick={() => setDeleteTarget(rec)} title="Remove from list">✕</button>
              </div>
            )
          })}
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
