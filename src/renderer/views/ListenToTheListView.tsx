import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import { setNotice } from '../activity'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { togglePreview, subscribePreview, getPreviewSnapshot, stopPreview } from '../previewPlayer'
import type { Recommendation, ItunesSuggestion } from '../types'
import '../styles/listen-to-the-list.css'

// In-session cache of the list. MainContent unmounts this view on
// navigation; without a cache the remount refetched from scratch and the
// scroll reset to the top (the "forgets its spot" bug). Seeding state from
// the cache renders the list instantly on return — so useScrollPersistence
// restores the scroll against real content — while a background load()
// refreshes. Optimistic add/delete keep the cache in sync. Dies with the
// renderer (in-session only), which is what we want.
let recsCache: Recommendation[] | null = null

// Music Man's suggestion pool (≥3 visible; rest backfill when one is added).
interface MmSuggestion { song: string; artist: string; note: string }
const MM_VISIBLE = 3
let suggestionsCache: MmSuggestion[] | null = null

// Session guards survive MainContent unmount — stop duplicate heavy IPC on remount.
const RECS_LOAD_COOLDOWN_MS = 5 * 60 * 1000
const SUGGEST_AUTO_COOLDOWN_MS = 30 * 60 * 1000
let loadInFlight: Promise<void> | null = null
let lastLoadAt = 0
let suggestModuleInFlight: Promise<void> | null = null
let lastSuggestFetchAt = 0
let sessionAutoSuggestAttempted = false

function suggKey(s: { song: string; artist: string }): string {
  return `${s.artist.toLowerCase().trim()}|${s.song.toLowerCase().trim()}`
}

function recsListUnchanged(a: Recommendation[], b: Recommendation[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
  }
  return true
}

function dedupeSuggestions(incoming: MmSuggestion[], recs: Recommendation[]): MmSuggestion[] {
  const onList = new Set(
    recs.map((r) => {
      const a = (r.artist || r.matchedArtist || '').toLowerCase().trim()
      const t = (r.song || r.matchedTitle || '').toLowerCase().trim()
      return a && t ? `${a}|${t}` : ''
    }).filter(Boolean),
  )
  const seen = new Set<string>()
  const out: MmSuggestion[] = []
  for (const s of incoming) {
    const k = suggKey(s)
    if (!k || seen.has(k) || onList.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

// Brief 122 Phase 1 — "Listen to the List". Mirrors the mobile app's
// recommendations list on desktop and lets you add/delete from here too.
// Reads recommendations.json via main (syncs homemini + NAS → local SSD).
// Add/delete route through the Mini backend for iTunes enrichment; main
// keeps the local copy current. Does NOT touch the
// music library, its metadata, or its artwork — reco artwork is external
// (iTunes) URLs.
export default function ListenToTheListView() {
  const [recs, setRecs] = useState<Recommendation[]>(recsCache ?? [])
  const [loading, setLoading] = useState(recsCache === null)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Recommendation | null>(null)
  const [form, setForm] = useState({ song: '', artist: '', album: '', note: '' })
  // Music Man's visible-3 / pool-N suggestion strip.
  const [mmPool, setMmPool] = useState<MmSuggestion[]>(suggestionsCache ?? [])
  const [suggLoading, setSuggLoading] = useState(false)
  const mmPoolRef = useRef(mmPool)
  mmPoolRef.current = mmPool
  const visibleMm = mmPool.slice(0, MM_VISIBLE)
  // Preview plays in the now-playing pill (iTunes-style) via the shared
  // previewPlayer; this view just reflects which row is currently playing.
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)

  // recsRef mirrors the latest list for optimistic add/delete (so handlers
  // don't need recs in their dep arrays). viewRef + useScrollPersistence
  // remember the scroll position across unmount/remount.
  const recsRef = useRef(recs)
  recsRef.current = recs
  const viewRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('listen-to-the-list', viewRef)

  // Brief 122 Phase 2 — iTunes autocomplete. As the song/artist fields are
  // typed, debounce a search and surface a live suggestion list. Picking a
  // suggestion fills the fields (the backend re-resolves on add, so the
  // chip still gets canonical artwork + links). suppressSearchRef stops the
  // effect from re-firing the moment a pick programmatically sets the field.
  const [suggestions, setSuggestions] = useState<ItunesSuggestion[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressSearchRef = useRef(false)
  // Monotonic search token: a slow response from an older query must not
  // overwrite the suggestions of a newer one (out-of-order results).
  const searchSeqRef = useRef(0)
  const loadSeqRef = useRef(0)
  const suggestInFlightRef = useRef(false)
  // Cap silent top-ups so a thin filter result cannot spin Claude+iTunes forever.
  const suggestTopUpAttemptsRef = useRef(0)
  const MAX_SILENT_TOPUPS = 2

  const load = useCallback(async () => {
    if (loadInFlight) {
      await loadInFlight
      return
    }
    const seq = ++loadSeqRef.current
    const run = (async () => {
      try {
        const res = await window.electronAPI.loadRecommendations()
        if (seq !== loadSeqRef.current) return
        const list = res.ok ? res.recommendations : []
        recsCache = list
        lastLoadAt = Date.now()
        setRecs((prev) => (recsListUnchanged(prev, list) ? prev : list))
      } catch (err) {
        console.error('[ltl] load failed', err)
      } finally {
        if (seq === loadSeqRef.current) setLoading(false)
      }
    })()
    loadInFlight = run
    try {
      await run
    } finally {
      if (loadInFlight === run) loadInFlight = null
    }
  }, [])

  useEffect(() => {
    if (recsCache !== null && lastLoadAt === 0) lastLoadAt = Date.now()
    const hasFreshCache = recsCache !== null && Date.now() - lastLoadAt < RECS_LOAD_COOLDOWN_MS
    if (hasFreshCache) return
    void load()
  }, [load])

  // Music Man suggestions — pool of up to 10; UI always shows 3 slots.
  const mergeSuggestions = useCallback((replace: boolean, incoming: MmSuggestion[]) => {
    setMmPool((prev) => {
      const base = replace ? [] : prev
      const merged = dedupeSuggestions([...base, ...incoming], recsRef.current)
      suggestionsCache = merged
      mmPoolRef.current = merged
      return merged
    })
  }, [])

  const fetchSuggestionsCore = useCallback(async (replace = false, force = false) => {
    const res = await window.electronAPI.suggestRecommendations(force ? { force: true } : undefined)
    const incoming = res.ok && res.suggestions ? res.suggestions : []
    mergeSuggestions(replace, incoming)
    lastSuggestFetchAt = Date.now()
  }, [mergeSuggestions])

  const ensureThreeVisible = useCallback(async (replace = false, silent = false) => {
    if (suggestInFlightRef.current || suggestModuleInFlight) {
      if (suggestModuleInFlight) await suggestModuleInFlight
      return
    }
    if (silent && suggestTopUpAttemptsRef.current >= MAX_SILENT_TOPUPS) return
    if (silent && Date.now() - lastSuggestFetchAt < SUGGEST_AUTO_COOLDOWN_MS) return
    if (silent) suggestTopUpAttemptsRef.current++
    else if (replace) suggestTopUpAttemptsRef.current = 0

    suggestInFlightRef.current = true
    if (!silent) setSuggLoading(true)
    const run = (async () => {
      try {
        if (replace) {
          suggestionsCache = []
          mmPoolRef.current = []
          setMmPool([])
        }
        // One suggest-recommendations IPC already retries Claude + iTunes up to 4×;
        // a second invoke here doubled main-process work and caused the pinwheel.
        await fetchSuggestionsCore(replace, replace)
      } catch (err) {
        console.error('[ltl] suggest failed', err)
      } finally {
        if (mmPoolRef.current.length >= MM_VISIBLE) suggestTopUpAttemptsRef.current = 0
        suggestInFlightRef.current = false
        if (!silent) setSuggLoading(false)
      }
    })()
    suggestModuleInFlight = run
    try {
      await run
    } finally {
      if (suggestModuleInFlight === run) suggestModuleInFlight = null
    }
  }, [fetchSuggestionsCore])

  const refreshSuggestions = useCallback(async () => {
    sessionAutoSuggestAttempted = true
    await ensureThreeVisible(true, false)
  }, [ensureThreeVisible])

  const ensureThreeVisibleRef = useRef(ensureThreeVisible)
  ensureThreeVisibleRef.current = ensureThreeVisible

  // Music Man loads after the list paints — one auto attempt per app session.
  useEffect(() => {
    if (loading) return
    if (mmPoolRef.current.length >= MM_VISIBLE) return
    if (sessionAutoSuggestAttempted) return
    if (Date.now() - lastSuggestFetchAt < SUGGEST_AUTO_COOLDOWN_MS && (suggestionsCache?.length ?? 0) > 0) return

    const isFirstLoad = suggestionsCache === null
    const delayMs = isFirstLoad ? 400 : 0
    const timer = setTimeout(() => {
      sessionAutoSuggestAttempted = true
      void ensureThreeVisibleRef.current(isFirstLoad, !isFirstLoad)
    }, delayMs)
    return () => clearTimeout(timer)
  }, [loading])

  // Drop anything from the pool that's now on the list; top up only when prune shrinks the pool.
  useEffect(() => {
    let pruned = false
    setMmPool((prev) => {
      const next = dedupeSuggestions(prev, recs)
      if (next.length === prev.length) return prev
      pruned = true
      suggestionsCache = next
      mmPoolRef.current = next
      return next
    })
    if (pruned && mmPoolRef.current.length < MM_VISIBLE && !suggestInFlightRef.current && !suggestModuleInFlight) {
      void ensureThreeVisibleRef.current(false, true)
    }
  }, [recs])

  // Debounced iTunes search keyed on the song + artist fields.
  useEffect(() => {
    if (suppressSearchRef.current) { suppressSearchRef.current = false; return }
    const q = [form.song.trim(), form.artist.trim()].filter(Boolean).join(' ')
    if (q.length < 2) { setSuggestions([]); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const seq = ++searchSeqRef.current
      setSearching(true)
      try {
        const res = await window.electronAPI.searchItunes(q)
        if (seq !== searchSeqRef.current) return // a newer query superseded this
        setSuggestions(res.ok ? res.results : [])
      } catch {
        if (seq === searchSeqRef.current) setSuggestions([])
      } finally {
        if (seq === searchSeqRef.current) setSearching(false)
      }
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

    // Optimistic: show a provisional row + clear the form instantly so
    // adding feels immediate. The Mini backend re-resolves iTunes metadata
    // and returns the canonical, artwork-enriched record, which we swap in
    // (no full reload). The provisional id is temp-* so we can find it.
    const draft = { ...form }
    const tempId = `temp-${Date.now()}`
    const provisional: Recommendation = {
      id: tempId,
      song: draft.song.trim() || undefined,
      artist: draft.artist.trim() || undefined,
      album: draft.album.trim() || undefined,
      note: draft.note.trim() || undefined,
      createdAt: new Date().toISOString(),
    }
    const prev = recsRef.current
    const withProvisional = [provisional, ...prev]
    recsCache = withProvisional
    setRecs(withProvisional)
    loadSeqRef.current++
    setForm({ song: '', artist: '', album: '', note: '' })
    setSuggestions([])

    // try/finally is load-bearing: a thrown invoke would otherwise leave
    // `adding` stuck true → Add button disabled forever. finally re-enables.
    try {
      const res = await window.electronAPI.addRecommendation({
        song: provisional.song, artist: provisional.artist,
        album: provisional.album, note: provisional.note,
      })
      if (!res?.ok) {
        // Roll the provisional row back out + restore the form to retry.
        recsCache = prev
        setRecs(prev)
        setForm(draft)
        setNotice(
          res?.error?.includes('nothing to add')
            ? 'Enter at least a song, artist, album, or note.'
            : `Couldn't save recommendation${res?.error ? `: ${res.error}` : ''}.`,
          { kind: 'error' }
        )
        return
      }
      if (res.recommendation) {
        const enriched = res.recommendation
        setRecs((cur) => {
          // If the provisional row is gone (deleted mid-save), don't drop
          // the saved record — re-insert it so a saved reco never vanishes.
          const swapped = cur.some((r) => r.id === tempId)
            ? cur.map((r) => (r.id === tempId ? enriched : r))
            : [enriched, ...cur]
          recsCache = swapped
          return swapped
        })
      } else {
        await load() // backend didn't echo the record — reconcile fully
      }
    } catch (err) {
      recsCache = prev
      setRecs(prev)
      setForm(draft)
      setNotice(`Add failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' })
    } finally {
      setAdding(false)
    }
  }, [form, canAdd, adding, load])

  // Add one of Music Man's suggestions. Mirrors handleAdd's optimistic flow
  // (provisional row → backend → swap enriched); separate because rollback
  // restores the strip card, not the form.
  const handleAddSuggestion = useCallback(async (s: MmSuggestion) => {
    setMmPool((prev) => {
      const next = prev.filter((x) => suggKey(x) !== suggKey(s))
      suggestionsCache = next
      mmPoolRef.current = next
      return next
    })
    void ensureThreeVisible(false, true)
    const tempId = `temp-sugg-${Date.now()}`
    const provisional: Recommendation = {
      id: tempId,
      song: s.song || undefined,
      artist: s.artist || undefined,
      note: s.note || undefined,
      createdAt: new Date().toISOString(),
    }
    const prev = recsRef.current
    const withProvisional = [provisional, ...prev]
    recsCache = withProvisional
    setRecs(withProvisional)
    loadSeqRef.current++
    try {
      const res = await window.electronAPI.addRecommendation({
        song: s.song || undefined, artist: s.artist || undefined, note: s.note || undefined,
      })
      if (!res?.ok) {
        recsCache = prev
        setRecs(prev)
        setNotice(`Couldn't add that pick${res?.error ? `: ${res.error}` : ''}.`, { kind: 'error' })
        // Restore the suggestion card so the user can retry.
        setMmPool((prev) => {
          const next = dedupeSuggestions([s, ...prev], recsRef.current)
          suggestionsCache = next
          mmPoolRef.current = next
          return next
        })
        return
      }
      if (res.recommendation) {
        const enriched = res.recommendation
        setRecs((cur) => {
          const swapped = cur.some((r) => r.id === tempId)
            ? cur.map((r) => (r.id === tempId ? enriched : r))
            : [enriched, ...cur]
          recsCache = swapped
          return swapped
        })
        // List row already updated above; pool backfill kicked off at click time.
      } else {
        await load()
      }
    } catch (err) {
      recsCache = prev
      setRecs(prev)
      setNotice(`Add failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' })
      setMmPool((prev) => {
        const next = dedupeSuggestions([s, ...prev], recsRef.current)
        suggestionsCache = next
        mmPoolRef.current = next
        return next
      })
    }
  }, [load, ensureThreeVisible])

  const handleDelete = useCallback(async (rec: Recommendation) => {
    // If a preview of this reco is playing, stop it so it isn't orphaned
    // (the row + its stop control are about to disappear).
    if (getPreviewSnapshot().playingId === rec.id) stopPreview()
    // Optimistic: pull the row immediately, then confirm with the backend.
    const prev = recsRef.current
    const next = prev.filter((x) => x.id !== rec.id)
    recsCache = next
    setRecs(next)
    loadSeqRef.current++
    try {
      const res = await window.electronAPI.deleteRecommendation(rec.id)
      if (!res.ok) {
        recsCache = prev
        setRecs(prev)
        loadSeqRef.current++
        setNotice(`Couldn't delete${res.error ? `: ${res.error}` : ''}.`, { kind: 'error' })
      }
    } catch (err) {
      recsCache = prev
      setRecs(prev)
      loadSeqRef.current++
      setNotice(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' })
    }
  }, [])

  const displayName = (rec: Recommendation) => {
    const title = rec.matchedTitle || rec.song
    const artist = rec.matchedArtist || rec.artist
    if (title && artist) return `${title} — ${artist}`
    return title || artist || rec.album || rec.note || 'Untitled'
  }

  return (
    <div className="ltl-view" ref={viewRef}>
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

      <div className="ltl-mm-suggests">
        <div className="ltl-mm-head">
          <span className="ltl-mm-title">Music Man suggests</span>
          <button className="ltl-mm-refresh" onClick={() => void refreshSuggestions()} disabled={suggLoading} aria-busy={suggLoading || undefined} title="New suggestions">↻</button>
        </div>
        <div className="ltl-mm-row">
          {Array.from({ length: MM_VISIBLE }).map((_, i) => {
            const s = visibleMm[i]
            if (s) {
              return (
                <div className="ltl-mm-card" key={`${s.song}-${s.artist}-${i}`}>
                  <div className="ltl-mm-card-text">
                    <div className="ltl-mm-song">{s.song}</div>
                    <div className="ltl-mm-artist">{s.artist}</div>
                    {s.note && <div className="ltl-mm-note">{s.note}</div>}
                  </div>
                  <button className="ltl-mm-add" onClick={() => handleAddSuggestion(s)}>+ Add</button>
                </div>
              )
            }
            if (!suggLoading) return null
            return (
              <div className="ltl-mm-card ltl-mm-card--loading" key={`loading-${i}`} aria-busy="true">
                <div className="ltl-mm-loading">Finding another…</div>
              </div>
            )
          })}
        </div>
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
