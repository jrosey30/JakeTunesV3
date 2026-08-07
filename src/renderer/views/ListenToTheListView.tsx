/**
 * Listen to the List v3 — the inbox you FINISH (2026-07-23 ground-up rebuild).
 *
 * Jake: "it's a pile, not a flow… it only accumulates… exhausting." v3 turns
 * it into a triage inbox you blow through:
 *
 *   - THREE zones: Inbox (to decide) · Getting (downloading) · Landed (done).
 *     No more one undifferentiated list that only grows.
 *   - KEYBOARD fly-through on the Inbox: ↑↓ move · Space previews the selected
 *     · Enter/G gets it · X tosses it — every decision auto-advances to the
 *     next, so you reach the bottom. The selected row is spotlit.
 *   - TOSS is instant + reversible: the row leaves immediately with a 5s
 *     "Undo" — no confirm dialog killing your speed, no accidental permadelete.
 *   - A satisfying empty state when the inbox hits zero.
 *
 * Reuses the PROVEN layer untouched: useListenToTheList (identity-safe sync),
 * ltlDownload (serial Qobuz queue), previewPlayer, friends/Scouts ledger.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useLibrary } from '../context/LibraryContext'
import { getPreviewSnapshot, subscribePreview, togglePreview, stopPreview } from '../previewPlayer'
import { formatAppDate } from '../utils/formatDate'
import type { Recommendation, ItunesSuggestion } from '../types'
import { displayRecoName } from '../listen-to-the-list/components'
import { useItunesAutocomplete } from '../listen-to-the-list/useItunesAutocomplete'
import { useListenToTheList } from '../listen-to-the-list/useListenToTheList'
import type { AddFormState } from '../listen-to-the-list/useListenToTheList'
import {
  canDownloadReco, getLtlDownloadSnapshot, prefillDownloadView,
  queueRecoDownload, subscribeLtlDownload, type LtlDownloadStatus,
} from '../listen-to-the-list/ltlDownload'
import '../styles/listen-to-the-list.css'

interface Friend { name: string; adds: number; got: number; tossed: number; lastAt: number; imported: number }

function friendOf(rec: Recommendation): string | null {
  const m = String(rec.note || '').match(/(?:^|· )from ([^·]+?)(?: ·|$)/)
  return m ? m[1].trim() : null
}
function humanNoteOf(rec: Recommendation): string {
  return String(rec.note || '')
    .replace(/(?:^|· )from [^·]+?(?= ·|$)/, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(?:\s*·\s*)+/g, ' · ').replace(/^\s*·\s*|\s*·\s*$/g, '').trim()
}
const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim())

const TOSS_UNDO_MS = 5000

export default function ListenToTheListView() {
  const { dispatch } = useLibrary()
  const { recs, loading, adding, addFromForm, deleteRecommendation, EMPTY_FORM } = useListenToTheList()

  const ltlPageRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('ltl-page', ltlPageRef)
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM)
  const [omni, setOmni] = useState('')
  const [fromWho, setFromWho] = useState('')
  const [linkInfo, setLinkInfo] = useState<{ kind: string; link: string } | null>(null)
  const [resolving, setResolving] = useState(false)
  const [friends, setFriends] = useState<Friend[]>([])
  const [contacts, setContacts] = useState<string[]>([])
  const omniRef = useRef<HTMLInputElement>(null)

  const { suggestions, searching, pick, clearSuggestions } = useItunesAutocomplete(form.song, form.artist)
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const dlMap = useSyncExternalStore(subscribeLtlDownload, getLtlDownloadSnapshot)

  // Rows the user just tossed — hidden immediately, deleted for real after the
  // undo window. Keyed by id → the reco + its timer, so Undo can restore it.
  const [tossing, setTossing] = useState<Recommendation | null>(null)
  const tossTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.electronAPI.getFriends?.().then((r) => { if (r?.ok) setFriends(r.friends) })
  }, [recs.length])
  useEffect(() => {
    void window.electronAPI.getContacts?.().then((r) => { if (r?.ok) setContacts(r.names) })
  }, [])

  const [imsgDenied, setImsgDenied] = useState(false)
  useEffect(() => {
    let alive = true
    const check = () => window.electronAPI.imessageCaptureStatus?.().then((r) => {
      if (alive && r?.ok) setImsgDenied(r.access === 'denied')
    })
    void check()
    const t = setInterval(() => void check(), 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const dlOf = (id: string): LtlDownloadStatus => dlMap.get(id) ?? { state: 'idle' }
  const isGetting = (r: Recommendation) => { const s = dlOf(r.id).state; return s === 'queued' || s === 'downloading' }
  const isDone = (r: Recommendation) => Boolean(r.owned) || dlOf(r.id).state === 'done'

  // Song / Album / Artist — the list groups by what a reco IS (Jake 2026-07-23).
  const recoType = (r: Recommendation): 'song' | 'album' | 'artist' => {
    const song = (r.matchedTitle || r.song || '').trim()
    const album = (r.matchedAlbum || r.album || '').trim()
    if (r.kind === 'album' || r.kind === 'concert') return 'album'
    if (song) return 'song'
    if (album) return 'album'
    return 'artist'
  }

  // Added to the library (downloaded this session, or the fulfillment sweep
  // found it) → take it OFF the list (Jake: "when i add a song from the list,
  // take it off"). Delete once, tracked so it fires a single time.
  const autoRemovedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const r of recs) {
      if (isDone(r) && !autoRemovedRef.current.has(r.id)) {
        autoRemovedRef.current.add(r.id)
        // Credit the friend who sent it (Jake: "give the friend points if i
        // download one of their suggestions") — run the imports sweep while the
        // reco still exists so their `imported` count lands, THEN take it off.
        void (async () => {
          try { await window.electronAPI.sweepFriendImports?.() } catch { /* best-effort */ }
          await deleteRecommendation(r)
          void window.electronAPI.getFriends?.().then((res) => { if (res?.ok) setFriends(res.friends) })
        })()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, dlMap])

  // ── ONE ordered list ──────────────────────────────────────────────────────
  // This used to be split into Songs / Albums / Artists zones, which meant
  // "what do I deal with next" had three possible answers and your eye had to
  // pick. It is an inbox: there is exactly one next thing. Ordered by what
  // needs YOU, not by what kind of thing it is —
  //   1. failed      — something went wrong and only you can decide to retry
  //   2. in flight   — happening now, so it stays visible where you left it
  //   3. everything else, oldest first, because the list is a queue
  const { inboxFlat } = useMemo(() => {
    const removing = (r: Recommendation) => r.id === tossing?.id || autoRemovedRef.current.has(r.id)
    const visible = recs.filter((r) => !removing(r) && !isDone(r))
    const rank = (r: Recommendation): number => {
      const st = dlMap.get(r.id)?.state
      if (st === 'error') return 0
      if (st === 'queued' || st === 'downloading') return 1
      return 2
    }
    const ordered = [...visible].sort((a, b) => {
      const d = rank(a) - rank(b)
      if (d !== 0) return d
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    })
    return { inboxFlat: ordered }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, dlMap, tossing])

  // ── Triage selection (index into the flat inbox order) ────────────────────
  const [sel, setSel] = useState(0)
  const [showAdd, setShowAdd] = useState(false)
  const [showFriends, setShowFriends] = useState(false)
  useEffect(() => { setSel((s) => Math.max(0, Math.min(s, inboxFlat.length - 1))) }, [inboxFlat.length])
  const selRef = useRef<HTMLDivElement>(null)
  useEffect(() => { selRef.current?.scrollIntoView({ block: 'nearest' }) }, [sel])

  // ── Actions ──────────────────────────────────────────────────────────────
  const previewReco = useCallback((r: Recommendation) => {
    if (!r.previewUrl) return
    togglePreview(r.id, r.previewUrl, r.matchedTitle || r.song || r.album || 'Preview', r.matchedArtist || r.artist || '')
  }, [])

  const getReco = useCallback((r: Recommendation) => {
    if (!canDownloadReco(r)) return
    const f = friendOf(r)
    if (f) void window.electronAPI.friendEvent?.(f, 'got')
    queueRecoDownload(r)
  }, [])

  const commitToss = useCallback((r: Recommendation) => {
    if (getPreviewSnapshot().playingId === r.id) stopPreview()
    const f = friendOf(r)
    if (f) void window.electronAPI.friendEvent?.(f, 'tossed')
    void deleteRecommendation(r)
  }, [deleteRecommendation])

  const tossReco = useCallback((r: Recommendation) => {
    // Flush any prior pending toss immediately, then stage this one.
    setTossing((prev) => { if (prev) commitToss(prev); return r })
    if (tossTimer.current) clearTimeout(tossTimer.current)
    tossTimer.current = setTimeout(() => {
      setTossing((cur) => { if (cur) commitToss(cur); return null })
      tossTimer.current = null
    }, TOSS_UNDO_MS)
  }, [commitToss])

  const undoToss = useCallback(() => {
    if (tossTimer.current) { clearTimeout(tossTimer.current); tossTimer.current = null }
    setTossing(null)
  }, [])
  useEffect(() => () => { if (tossTimer.current) clearTimeout(tossTimer.current) }, [])

  // ── Keyboard fly-through (Inbox only; never steals from inputs) ───────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (inboxFlat.length === 0) return
      const cur = inboxFlat[Math.min(sel, inboxFlat.length - 1)]
      switch (e.key) {
        case 'ArrowDown': case 'j': e.preventDefault(); setSel((s) => Math.min(s + 1, inboxFlat.length - 1)); break
        case 'ArrowUp': case 'k': e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); break
        case ' ': e.preventDefault(); e.stopPropagation(); if (cur) previewReco(cur); break
        case 'Enter': case 'g': case 'd': e.preventDefault(); if (cur && canDownloadReco(cur)) getReco(cur); break
        case 'x': case 'Backspace': case 'Delete': e.preventDefault(); if (cur) tossReco(cur); break
        case 'a': e.preventDefault(); omniRef.current?.focus(); break
        default: return
      }
    }
    window.addEventListener('keydown', onKey, true)   // capture — beat the global transport Space
    return () => window.removeEventListener('keydown', onKey, true)
  }, [inboxFlat, sel, previewReco, getReco, tossReco])

  // ── Capture (omnibox — unchanged proven flow) ────────────────────────────
  const handleOmni = async (raw: string) => {
    setOmni(raw)
    if (isUrl(raw)) {
      setResolving(true)
      try {
        const r = await window.electronAPI.captureResolveLink?.(raw.trim())
        if (r?.ok) {
          setLinkInfo({ kind: r.kind || 'link', link: raw.trim() })
          const seed = r.title || r.raw || ''
          setForm((f) => ({ ...f, song: seed, artist: r.artist || '', link: raw.trim() }))
          setOmni(seed ? `${seed}${r.artist ? ` — ${r.artist}` : ''}` : raw)
        }
      } finally { setResolving(false) }
    } else {
      setForm((f) => ({ ...f, song: raw, artist: '', link: linkInfo?.link || '' }))
    }
  }
  const resetCapture = () => { setOmni(''); setForm(EMPTY_FORM); setLinkInfo(null); clearSuggestions(); omniRef.current?.focus() }
  const quickAdd = async (s: ItunesSuggestion) => {
    if (adding) return
    const picked = pick(s)
    const draft: AddFormState = { ...form, ...picked, from: fromWho.trim(), link: linkInfo?.link || form.link }
    resetCapture()
    const res = await addFromForm(draft)
    if (!res.ok) { setForm(draft); setOmni(draft.song) }
  }
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!omni.trim() || adding) return
    const draft: AddFormState = { ...form, song: form.song || omni.trim(), from: fromWho.trim(), link: linkInfo?.link || '' }
    resetCapture()
    const res = await addFromForm(draft)
    if (!res.ok) { setForm(draft); setOmni(draft.song) }
  }

  const openDownloadForReco = (rec: Recommendation) => {
    const f = friendOf(rec)
    if (f) void window.electronAPI.friendEvent?.(f, 'got')
    prefillDownloadView(rec, recoType(rec) === 'album' ? 'album' : 'song')
    dispatch({ type: 'SET_VIEW', view: 'download' })
  }

  // ── Standings (2026-08-05, Jake: "i want the friends area to look like
  // standings") — points are computed in main against the LIVE library, so a
  // deletion shows up here on the next open without any event wiring.
  type Standing = NonNullable<Awaited<ReturnType<NonNullable<typeof window.electronAPI.getFriendStandings>>>['standings']>[number]
  const [standings, setStandings] = useState<Standing[]>([])
  const [openFriend, setOpenFriend] = useState<string | null>(null)
  useEffect(() => {
    if (!showFriends) return
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | null = null
    // Cold-boot race (2026-08-07, Jake: "where did my friends go???"): opening
    // the panel right after launch could catch the main process before its
    // caches were warm — one empty/failed response, and nothing ever refired,
    // so the board stayed blank until a navigation. Retry until a real answer
    // lands; the panel being open is the demand signal.
    const fetchStandings = (attempt: number) => {
      void window.electronAPI.getFriendStandings?.().then((r) => {
        if (cancelled) return
        if (r?.ok && r.standings && r.standings.length > 0) { setStandings(r.standings); return }
        if (attempt < 5) retry = setTimeout(() => fetchStandings(attempt + 1), 1200)
      }).catch(() => {
        if (!cancelled && attempt < 5) retry = setTimeout(() => fetchStandings(attempt + 1), 1200)
      })
    }
    fetchStandings(0)
    return () => { cancelled = true; if (retry) clearTimeout(retry) }
  }, [showFriends, friends, recs.length])

  const renderTriageRow = (r: Recommendation, i: number) => {
    const selected = i === sel
    const isPlaying = preview.playingId === r.id
    const friend = friendOf(r)
    const note = humanNoteOf(r)
    const canDl = canDownloadReco(r)
    const isAlbum = recoType(r) === 'album'
    const dl = dlOf(r.id)
    return (
      <div
        key={r.id}
        ref={selected ? selRef : undefined}
        className={`ltl-tri${selected ? ' is-selected' : ''}`}
        onClick={() => setSel(i)}
        role="button"
        tabIndex={-1}
      >
        <div className="ltl-tri-art">
          {r.artworkUrl ? <img src={r.artworkUrl} alt="" loading="lazy" /> : <span className="ltl-tri-art-ph" aria-hidden="true">♪</span>}
          {r.previewUrl && (
            <button type="button" className={`ltl-tri-play${isPlaying ? ' is-on' : ''}`}
              onClick={(e) => { e.stopPropagation(); previewReco(r) }} title={isPlaying ? 'Stop' : 'Preview'}>
              {isPlaying ? '❚❚' : '▶'}
            </button>
          )}
        </div>
        <div className="ltl-tri-body">
          <div className="ltl-tri-name-row">
            <span className="ltl-tri-name">{displayRecoName(r)}</span>
            {/* Friend tag — Jake wants to KNOW who sent it / why it's here. */}
            {friend && <span className="ltl-friend-chip">from {friend}</span>}
          </div>
          <div className="ltl-tri-sub">
            {isAlbum && (r.matchedAlbum || r.album) && <span className="ltl-tri-album">{r.matchedAlbum || r.album}</span>}
            {note && <span className="ltl-tri-note">{note}</span>}
            <span className="ltl-tri-date">{formatAppDate(r.createdAt)}</span>
          </div>
        </div>
        <div className="ltl-tri-actions" onClick={(e) => e.stopPropagation()}>
          {dl.state === 'queued' || dl.state === 'downloading' ? (
            <span className="ltl-tri-getting" title="Importing…">
              <span className="ltl-tri-spinner" aria-hidden="true" />
              {dl.state === 'downloading' ? 'Getting…' : 'Queued…'}
            </span>
          ) : dl.state === 'error' ? (
            <>
              {/* Failure was previously rendered NOWHERE — an errored row fell
                  back into the list looking exactly like one never tried, so a
                  failed import was indistinguishable from an ignored one. */}
              <span className="ltl-tri-failed" title={dl.error || 'Download failed'}>FAILED</span>
              <button type="button" className="ltl-tri-get" onClick={() => getReco(r)} title={dl.error || 'Try again'}>Retry</button>
            </>
          ) : isAlbum ? (
            <button type="button" className="ltl-tri-get" onClick={() => openDownloadForReco(r)} title="Pick tracks in Download">Tracks</button>
          ) : canDl && (
            <button type="button" className="ltl-tri-get" onClick={() => getReco(r)} title="Get it (Enter)">Get</button>
          )}
          <button type="button" className="ltl-tri-toss" onClick={() => tossReco(r)} title="Toss it (X)">✕</button>
        </div>
      </div>
    )
  }

  const inboxEmpty = !loading && inboxFlat.length === 0

  return (
    <div className="ltl-view ltl-view--v3" ref={ltlPageRef}>
      <div className="ltl-header">
        <div className="ltl-header-titles">
          <h1 className="ltl-title">Listen to the List</h1>
          <span className="ltl-progress">
            {inboxFlat.length > 0 ? `${inboxFlat.length} to decide` : recs.length > 0 ? 'Inbox zero ✓' : ''}
          </span>
        </div>
        <div className="ltl-header-tools">
          {inboxFlat.length > 0 && <span className="ltl-kbd-hint">Space preview · Enter get · X toss · ↑↓ move</span>}
          <button
            type="button"
            className={`ltl-tool${showFriends ? ' is-on' : ''}`}
            onClick={() => setShowFriends((v) => !v)}
            title="Who sends you what"
          >
            Friends
          </button>
          <button
            type="button"
            className={`ltl-tool ltl-tool--add${showAdd ? ' is-on' : ''}`}
            onClick={() => { setShowAdd((v) => !v); if (!showAdd) setTimeout(() => omniRef.current?.focus(), 30) }}
            title="Jot something down"
          >
            {showAdd ? 'Close' : '+ Add'}
          </button>
        </div>
      </div>

      {imsgDenied && (
        <div className="ltl-imsg-setup">
          Songs texted to you can land here automatically — JakeTunes just needs Full Disk Access to see Messages.{' '}
          <button type="button" className="ltl-imsg-setup-btn" onClick={() => { void window.electronAPI.openFullDiskAccessSettings?.() }}>Open System Settings</button>
        </div>
      )}

      {/* ── Capture ── */}
      {showAdd && (
      <div className="ltl-add-wrap">
        <form className="ltl-capture" onSubmit={handleSubmit}>
          <input ref={omniRef} className="ltl-omni" placeholder="Drop a song, a Spotify/YouTube/TikTok link, or a hunch…"
            value={omni} onChange={(e) => void handleOmni(e.target.value)} spellCheck={false} />
          <input className="ltl-from" placeholder="From…" title="Who sent you this?" value={fromWho}
            onChange={(e) => setFromWho(e.target.value)} list="ltl-friends-list" spellCheck={false} />
          <datalist id="ltl-friends-list">
            {[...new Set([...friends.map((f) => f.name), ...contacts])].map((n) => <option key={n} value={n} />)}
          </datalist>
          <button className="ltl-add-btn" type="submit" disabled={!omni.trim() || adding}>{adding ? 'Adding…' : 'Jot it'}</button>
        </form>
        {linkInfo && (
          <div className="ltl-linkinfo">
            via {linkInfo.kind}{resolving ? ' — reading…' : ' — pick the match below (or edit the text)'}
            <button type="button" className="ltl-linkinfo-x" onClick={resetCapture} aria-label="Clear">✕</button>
          </div>
        )}
        {(suggestions.length > 0 || searching) && omni.trim() && (
          <div className="ltl-suggestions">
            {searching && suggestions.length === 0 && <div className="ltl-suggest-empty">Checking…</div>}
            {suggestions.map((s, i) => (
              <button type="button" key={`${s.song}-${s.artist}-${i}`} className="ltl-suggest-row" title="Click to add" onClick={() => void quickAdd(s)}>
                {s.artworkUrl ? <img className="ltl-suggest-art" src={s.artworkUrl} alt="" loading="lazy" /> : <span className="ltl-suggest-art ltl-suggest-art--ph" aria-hidden="true">♪</span>}
                <span className="ltl-suggest-text">
                  <span className="ltl-suggest-song">{s.song}</span>
                  <span className="ltl-suggest-artist">{s.artist}</span>
                  {s.album && <span className="ltl-suggest-album">{s.album}</span>}
                </span>
                <span className="ltl-suggest-add" aria-hidden="true">+ Add</span>
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {showFriends && (
        <div className="ltl-standings">
          <div className="ltl-standings-head">
            <span className="ltl-standings-col-name">Friend</span>
            <span className="ltl-standings-col-pts">Points</span>
          </div>
          {standings.length === 0 && <div className="ltl-standings-empty">No standings yet — points land when a friend's send gets imported.</div>}
          {standings.map((f, i) => (
            <div key={f.name} className="ltl-standing">
              <button
                type="button"
                className={`ltl-standing-row${openFriend === f.name ? ' is-open' : ''}`}
                onClick={() => setOpenFriend((cur) => (cur === f.name ? null : f.name))}
                title="Click for details"
              >
                <span className="ltl-standing-rank">{i + 1}</span>
                <span className="ltl-standing-name">{f.name}</span>
                <span className={`ltl-standing-pts${f.points < 0 ? ' is-neg' : ''}`}>{f.points}</span>
              </button>
              {openFriend === f.name && (
                <div className="ltl-standing-detail">
                  <div className="ltl-standing-context">{f.adds} sent · {f.credits.length} imported · {f.tossed} tossed</div>
                  {f.credits.length === 0 && <div className="ltl-standing-line ltl-standing-line--muted">Nothing imported from {f.name} yet.</div>}
                  {f.credits.map((c, j) => (
                    <div key={j} className="ltl-standing-line">
                      <span className="ltl-standing-what">{c.record.label}</span>
                      <span className={`ltl-standing-status ltl-standing-status--${c.status}`}>
                        {c.status === 'kept' ? (c.record.kind === 'album' ? 'album kept' : 'kept')
                          : c.status === 'partial' ? 'album, partly kept'
                          : c.status === 'deleted' ? 'deleted'
                          : 'imported'}
                      </span>
                      <span className={`ltl-standing-delta${c.points < 0 ? ' is-neg' : ''}`}>{c.points > 0 ? `+${c.points}` : c.points}</span>
                    </div>
                  ))}
                  <button type="button" className="ltl-standing-tag" onClick={() => setFromWho(f.name)}>Tag next add as from {f.name}</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Inbox (triage) ── */}
      {loading ? (
        <div className="ltl-loading">Loading…</div>
      ) : inboxEmpty ? (
        <div className="ltl-inboxzero">
          <div className="ltl-inboxzero-mark" aria-hidden="true">✓</div>
          <div className="ltl-inboxzero-title">{recs.length === 0 ? 'Nothing on the list yet' : 'You’re at the bottom.'}</div>
          <div className="ltl-inboxzero-sub">
            {recs.length === 0 ? 'Drop a song, a link, or a hunch above — friends’ picks get tracked too.' : 'Everything’s decided. Jot the next one when it hits you.'}
          </div>
        </div>
      ) : (
        <div className="ltl-tri-list">
          {inboxFlat.map((r, i) => renderTriageRow(r, i))}
        </div>
      )}

      {/* ── Getting ── */}

      {/* ── Undo toast ── */}
      {tossing && (
        <div className="ltl-toast" role="status">
          <span className="ltl-toast-text">Tossed <strong>{displayRecoName(tossing)}</strong></span>
          <button type="button" className="ltl-toast-undo" onClick={undoToss}>Undo</button>
        </div>
      )}
    </div>
  )
}
