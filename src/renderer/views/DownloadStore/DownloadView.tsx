import { useEffect, useState, useMemo, useReducer, useRef, useSyncExternalStore, type CSSProperties } from 'react'
import './download-store.css'
import { useLibrary } from '../../context/LibraryContext'
import { enqueue, itemFor, subscribeQueue, getQueue, retry, cancel, queueSummary, clearFinished, type QItem, type QResult } from './downloadQueue'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../../previewPlayer'
import type { ItunesSuggestion } from '../../types'

/**
 * Download v3 (2026-07-16) — "browse fast, resolve slow".
 *
 * Jake's verdict on v2: "the search is flat out a 0/100… it doesn't work,
 * i can't find any songs, i can't cancel downloads." Root cause: live search
 * was wired to the streamrip CLI — 5-15 SECONDS per call, two calls per
 * keystroke pause. The engine worked; the experience was dead on arrival.
 *
 * v3 splits the two jobs:
 *   SEARCH  = iTunes Search (instant, artwork, 30s previews) — find the right
 *             thing in milliseconds, hear it before you commit.
 *   RESOLVE = Qobuz via streamrip, only when you click Get — by artist+title
 *             (or artist+album), server-side best-match (pickBestStreamripMatch).
 *   CANCEL  = every queued item can be removed; an in-flight download kills
 *             the rip process (streamrip:cancel-active).
 */

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const mmss = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

// Relevance scorer — a TWIN of the universal-search ranker in
// utils/searchIndex.ts (exact > prefix > token-start > substring > all-tokens).
const normQ = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function scoreField(field: string, query: string, qTokens: string[]): number {
  if (!field || !query) return 0
  if (field === query) return 100 + Math.min(20, query.length)
  if (field.startsWith(query)) return 70 + Math.min(20, query.length)
  if ((' ' + field).includes(' ' + query)) return 50
  if (field.includes(query)) return 30
  if (qTokens.length > 1 && qTokens.every((qt) => field.includes(qt))) return 20
  return 0
}
const stripThe = (s: string): string => s.replace(/^the /, '')
function scoreResult(q: string, qTokens: string[], title: string, artist: string): number {
  const t = scoreField(normQ(title), q, qTokens)
  const aRaw = normQ(artist)
  const a = Math.max(scoreField(aRaw, q, qTokens), scoreField(stripThe(aRaw), q, qTokens))
  return t * 1.0 + a * 1.15
}

interface RipStatus { installed: boolean; version?: string }

interface SongRow {
  kind: 'song'
  artist: string
  title: string
  album?: string
  artworkUrl?: string
  previewUrl?: string
  owned: boolean
  score: number
}
interface AlbumRow {
  kind: 'album'
  artist: string
  album: string
  artworkUrl?: string
  owned: boolean
  score: number
  songs: number
}

// Page memory — the view unmounts on navigate-away; restore search state on return.
interface DownloadCache { query: string; results: ItunesSuggestion[]; pasteUrl: string }
let pageCache: DownloadCache = { query: '', results: [], pasteUrl: '' }

// Queue entries resolve on Qobuz AT DOWNLOAD TIME by artist+title/album.
const songQ = (r: SongRow): QResult => ({
  kind: 'query', source: 'qobuz', mediaType: 'track',
  id: `q|track|${norm(r.artist)}|${norm(r.title)}`,
  desc: `${r.title} — ${r.artist}`,
  artist: r.artist, title: r.title,
})
const albumQ = (r: AlbumRow): QResult => ({
  kind: 'query', source: 'qobuz', mediaType: 'album',
  id: `q|album|${norm(r.artist)}|${norm(r.album)}`,
  desc: `${r.album} — ${r.artist} (album)`,
  artist: r.artist, album: r.album,
})

export default function DownloadView() {
  const [status, setStatus] = useState<RipStatus | null>(null)
  const [query, setQuery] = useState(pageCache.query)
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<ItunesSuggestion[]>(pageCache.results)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)
  const [failures, setFailures] = useState<Array<{ filename: string; error: string }>>([])
  const [pasteUrl, setPasteUrl] = useState(pageCache.pasteUrl)
  const [pasteBusy, setPasteBusy] = useState(false)
  const [qobuz, setQobuz] = useState<{ configured: boolean; email?: string } | null>(null)
  const [qEmail, setQEmail] = useState('')
  const [qPass, setQPass] = useState('')
  const [qEditing, setQEditing] = useState(false)
  const [qSaving, setQSaving] = useState(false)
  const [qMsg, setQMsg] = useState<{ ok: boolean; msg: string } | null>(null)
  const [qMode, setQMode] = useState<'password' | 'token'>('password')
  const [qUserId, setQUserId] = useState('')
  const [qToken, setQToken] = useState('')

  const { state: lib } = useLibrary()
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribeQueue(forceRender), [])
  useEffect(() => {
    const id = window.setInterval(() => {
      if (getQueue().some((q) => q.status === 'downloading')) forceRender()
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // "Already in your library" index.
  const libIndex = useMemo(() => {
    const tracks = new Set<string>()
    const albums = new Set<string>()
    for (const t of lib.tracks) {
      const a = norm(t.artist)
      if (t.title) tracks.add(norm(t.title) + '|' + a)
      if (t.album) albums.add(norm(t.album) + '|' + a)
    }
    return { tracks, albums }
  }, [lib.tracks])
  const summary = queueSummary()

  // Rank songs + derive albums from the SAME instant result set.
  const ranked = useMemo(() => {
    const q = normQ(query)
    const qTokens = q ? q.split(' ') : []
    const songs: SongRow[] = results.map((s) => {
      const owned = libIndex.tracks.has(norm(s.song) + '|' + norm(s.artist))
      const base = q ? scoreResult(q, qTokens, s.song, s.artist) : 0
      const titleHit = q ? scoreField(normQ(s.song), q, qTokens) > 0 : false
      return {
        kind: 'song' as const,
        artist: s.artist, title: s.song, album: s.album,
        artworkUrl: s.artworkUrl, previewUrl: s.previewUrl,
        owned, score: base > 0 && titleHit ? base + 0.5 : base,
      }
    }).filter((s) => !q || s.score > 0)
    songs.sort((a, b) => b.score - a.score)

    const albumMap = new Map<string, AlbumRow>()
    for (const s of results) {
      if (!s.album) continue
      const key = `${norm(s.artist)}|${norm(s.album)}`
      const albScore = q ? Math.max(
        scoreResult(q, qTokens, s.album, s.artist),
        scoreResult(q, qTokens, s.song, s.artist) * 0.85,
      ) : 0
      const cur = albumMap.get(key)
      if (cur) { cur.songs += 1; cur.score = Math.max(cur.score, albScore); if (!cur.artworkUrl) cur.artworkUrl = s.artworkUrl }
      else albumMap.set(key, {
        kind: 'album', artist: s.artist, album: s.album, artworkUrl: s.artworkUrl,
        owned: libIndex.albums.has(norm(s.album) + '|' + norm(s.artist)),
        score: albScore, songs: 1,
      })
    }
    const albums = [...albumMap.values()].filter((a) => !q || a.score > 0).sort((a, b) => b.score - a.score).slice(0, 8)

    const topSong = songs[0] ?? null
    const topAlbum = albums[0] ?? null
    // The hero is whichever type matched harder.
    const hero: SongRow | AlbumRow | null =
      topSong && topAlbum ? (topAlbum.score > topSong.score ? topAlbum : topSong) : (topSong || topAlbum)
    return {
      hero,
      songs: songs.filter((s) => s !== hero).slice(0, 12),
      albums: albums.filter((a) => a !== hero),
    }
  }, [results, query, libIndex])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.streamripStatus?.().then((r) => {
      if (!cancelled && r?.ok) setStatus({ installed: !!r.installed, version: r.version })
    }).catch(() => { if (!cancelled) setStatus({ installed: false }) })
    window.electronAPI.streamripGetQobuz?.().then((r) => {
      if (!cancelled && r?.ok) setQobuz({ configured: r.configured, email: r.email })
    }).catch(() => { /* leave the form shown */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return window.electronAPI.onBandcampPerFileFailed((r) => {
      setFailures((prev) => [...prev, r])
    })
  }, [])

  // Prefill search when opened from Listen to the List.
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const q = (e as CustomEvent<{ query?: string }>).detail?.query?.trim()
      if (!q) return
      setQuery(q)
      setResults([])
      setSearchErr(null)
      setNotice(null)
    }
    window.addEventListener('jaketunes-download-prefill', onPrefill)
    return () => window.removeEventListener('jaketunes-download-prefill', onPrefill)
  }, [])

  useEffect(() => {
    pageCache = { query, results, pasteUrl }
  }, [query, results, pasteUrl])

  // INSTANT search: iTunes answers in ~200ms with art + previews. Newest
  // keystroke wins; Qobuz is only touched when a Get button is clicked.
  const searchTokenRef = useRef(0)
  const runSearch = async (raw: string) => {
    const q = raw.trim()
    const token = ++searchTokenRef.current
    if (!q) { setResults([]); setSearchErr(null); setSearching(false); return }
    setSearching(true)
    setSearchErr(null)
    try {
      const r = await window.electronAPI.searchItunes?.(q)
      if (token !== searchTokenRef.current) return
      let list = r?.ok ? r.results : []
      if (!r?.ok) {
        // iTunes can rate-limit (403). Fall back to the slower Qobuz catalog
        // search so Jake is never staring at nothing — results just lack
        // artwork/previews until Apple lets us back in.
        const fb = await window.electronAPI.streamripSearch?.({ query: q, source: 'qobuz', mediaType: 'track', numResults: 20 }).catch(() => null)
        if (token !== searchTokenRef.current) return
        if (fb?.ok && fb.results) {
          list = fb.results.map((res) => {
            const i = res.desc.lastIndexOf(' by ')
            return {
              song: i > 0 ? res.desc.slice(0, i).trim() : res.desc,
              artist: i > 0 ? res.desc.slice(i + 4).trim() : '',
            } as ItunesSuggestion
          })
        }
      }
      setResults(list)
      setSearchErr(list.length === 0 ? `No matches for “${q}”.` : null)
    } catch (e) {
      if (token === searchTokenRef.current) setSearchErr(e instanceof Error ? e.message : 'Search failed.')
    } finally {
      if (token === searchTokenRef.current) setSearching(false)
    }
  }

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults([]); setSearchErr(null); setSearching(false); return }
    const h = window.setTimeout(() => { void runSearch(q) }, 300)
    return () => window.clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const downloadPaste = async () => {
    const link = pasteUrl.trim()
    if (!link || pasteBusy) return
    setPasteBusy(true)
    setNotice(null)
    setFailures([])
    try {
      const r = await window.electronAPI.streamripDownload?.(link)
      if (r?.ok && (r.imported ?? 0) > 0) {
        const dup = r.dupes ? `, ${r.dupes} already in library` : ''
        setNotice({ ok: true, msg: `Imported ${r.imported} track${r.imported === 1 ? '' : 's'}${dup}.` })
        setPasteUrl('')
      } else if (r?.ok && r.dupes) {
        setNotice({ ok: true, msg: `Already in your library — all ${r.dupes} track${r.dupes === 1 ? '' : 's'} skipped.` })
      } else if (r?.ok) {
        setNotice({ ok: false, msg: 'Downloaded, but no tracks made it into your library — see below.' })
      } else {
        setNotice({ ok: false, msg: r?.error || 'Download failed.' })
      }
    } catch (e) {
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Download failed.' })
    } finally {
      setPasteBusy(false)
    }
  }

  const saveQobuz = async () => {
    const e = qEmail.trim()
    if (!e || !qPass || qSaving) return
    setQSaving(true)
    setQMsg(null)
    try {
      const r = await window.electronAPI.streamripSetQobuz?.(e, qPass)
      if (r?.ok) {
        setQobuz({ configured: true, email: e })
        setQPass('')
        setQEditing(false)
        setQMsg({ ok: true, msg: 'Qobuz connected — downloads now resolve there in hi-fi.' })
      } else {
        setQMsg({ ok: false, msg: r?.error || 'Couldn’t save Qobuz login.' })
      }
    } catch (err) {
      setQMsg({ ok: false, msg: err instanceof Error ? err.message : 'Couldn’t save Qobuz login.' })
    } finally {
      setQSaving(false)
    }
  }

  const saveQobuzToken = async () => {
    const u = qUserId.trim()
    const t = qToken.trim()
    if (!u || !t || qSaving) return
    setQSaving(true)
    setQMsg(null)
    try {
      const r = await window.electronAPI.streamripSetQobuzToken?.(u, t)
      if (r?.ok) {
        setQobuz({ configured: true, email: `user ${u}` })
        setQToken('')
        setQEditing(false)
        setQMsg({ ok: true, msg: 'Qobuz connected via token — downloads now resolve there in hi-fi.' })
      } else {
        setQMsg({ ok: false, msg: r?.error || 'Couldn’t save Qobuz token.' })
      }
    } catch (err) {
      setQMsg({ ok: false, msg: err instanceof Error ? err.message : 'Couldn’t save Qobuz token.' })
    } finally {
      setQSaving(false)
    }
  }

  // Right-side action = the item's OWN lifecycle, with CANCEL at every stage
  // before "done" (a mis-click is never a commitment).
  const renderAction = (qres: QResult, item: QItem | undefined) => {
    const st = item?.status
    if (st === 'downloading') {
      const secs = item?.startedAt ? Math.floor((Date.now() - item.startedAt) / 1000) : 0
      return (
        <span className="dl-actions">
          <span className="dl-state dl-state--busy"><span className="dl-spinner" aria-hidden="true" />{mmss(secs)}</span>
          <button className="download-cancel" onClick={() => item && void cancel(item.key)} title="Cancel this download">Cancel</button>
        </span>
      )
    }
    if (st === 'queued') {
      return (
        <span className="dl-actions">
          <span className="dl-state dl-state--queued">Queued</span>
          <button className="download-cancel" onClick={() => item && void cancel(item.key)} title="Remove from queue">✕</button>
        </span>
      )
    }
    if (st === 'done') {
      return (
        <span className="dl-state dl-state--done">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          In your library{item?.imported ? ` · ${item.imported}` : ''}
        </span>
      )
    }
    if (st === 'canceled') {
      return <button className="download-retry" onClick={() => item && retry(item.key)} title="Download after all">Canceled — redo</button>
    }
    if (st === 'failed') {
      return <button className="download-retry" onClick={() => item && retry(item.key)} title={item?.error || 'Retry'}>Retry</button>
    }
    return <button className="download-result-btn" onClick={() => enqueue(qres)}>Get</button>
  }

  const renderSong = (s: SongRow, hero = false, i = 0) => {
    const qres = songQ(s)
    const item = itemFor(qres)
    const pid = `dl|${qres.id}`
    const isPlaying = preview.playingId === pid
    return (
      <li key={qres.id} className={`download-result-row${hero ? ' download-result-row--hero' : ''}${item ? ` is-${item.status}` : ''}`} style={{ '--i': i } as CSSProperties}>
        <span className="download-result-artwrap">
          {s.artworkUrl
            ? <img className="download-result-art" src={s.artworkUrl} alt="" loading="lazy" />
            : <span className="download-result-art download-result-art--ph" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" /></svg>
              </span>}
          {s.previewUrl && (
            <button
              type="button"
              className={`download-preview${isPlaying ? ' download-preview--on' : ''}`}
              onClick={() => togglePreview(pid, s.previewUrl!, s.title, s.artist)}
              title={isPlaying ? 'Stop preview' : '30s preview'}
            >{isPlaying ? '❚❚' : '▶'}</button>
          )}
        </span>
        <div className="download-result-body">
          <span className="download-result-title" title={s.title}>{s.title}</span>
          <span className="download-result-meta">
            <span className="download-result-artist">{s.artist}</span>
            {s.album && <span className="download-result-album">{s.album}</span>}
            {s.owned && <span className="download-owned">In your library</span>}
          </span>
        </div>
        {renderAction(qres, item)}
      </li>
    )
  }

  const renderAlbum = (a: AlbumRow, hero = false, i = 0) => {
    const qres = albumQ(a)
    const item = itemFor(qres)
    return (
      <li key={qres.id} className={`download-result-row${hero ? ' download-result-row--hero' : ''}${item ? ` is-${item.status}` : ''}`} style={{ '--i': i } as CSSProperties}>
        <span className="download-result-artwrap">
          {a.artworkUrl
            ? <img className="download-result-art" src={a.artworkUrl} alt="" loading="lazy" />
            : <span className="download-result-art download-result-art--ph" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" /></svg>
              </span>}
        </span>
        <div className="download-result-body">
          <span className="download-result-title" title={a.album}>{a.album}</span>
          <span className="download-result-meta">
            <span className="download-result-badge">ALBUM</span>
            <span className="download-result-artist">{a.artist}</span>
            {a.owned && <span className="download-owned">In your library</span>}
          </span>
        </div>
        {renderAction(qres, item)}
      </li>
    )
  }

  return (
    <div className="download-view">
      <div className="download-card">
        <div className="download-head">
          <span className="download-eyebrow">Get music</span>
          <h1 className="download-title">Download</h1>
          <p className="download-sub">
            Type anything — results are instant, with previews. Get resolves it on Qobuz in hi-fi.
          </p>
        </div>

        <div className="download-search">
          <div className="download-search-field">
            <svg className="download-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input
              className="download-input download-input--search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a song, album, or artist…"
              spellCheck={false}
              autoFocus
            />
            {searching && <span className="dl-spinner download-search-spinner" aria-hidden="true" />}
          </div>
        </div>

        {searchErr && !searching && <div className="download-result download-result--err">{searchErr}</div>}

        {(summary.active + summary.queued + summary.done + summary.failed) > 0 && (
          <div className="download-queue-strip">
            <span className="download-queue-summary">
              {summary.active > 0 && <span className="dq-part dq-active"><span className="dl-spinner" aria-hidden="true" />{summary.active} downloading</span>}
              {summary.queued > 0 && <span className="dq-part">{summary.queued} queued</span>}
              {summary.done > 0 && <span className="dq-part dq-done">{summary.done} in your library</span>}
              {summary.failed > 0 && <span className="dq-part dq-failed">{summary.failed} failed</span>}
            </span>
            {summary.active === 0 && summary.queued === 0 && (summary.done + summary.failed) > 0 && (
              <button className="download-link-btn" onClick={() => clearFinished()}>Clear finished</button>
            )}
          </div>
        )}

        {(ranked.hero || ranked.songs.length > 0 || ranked.albums.length > 0) && (
          <div className="download-results">
            {ranked.hero && (
              <section className="download-group download-group--top">
                <div className="download-group-head"><span className="download-group-label download-group-label--top">Top match</span></div>
                <ul className="download-group-list" role="list">
                  {ranked.hero.kind === 'song' ? renderSong(ranked.hero, true, 0) : renderAlbum(ranked.hero, true, 0)}
                </ul>
              </section>
            )}
            {ranked.songs.length > 0 && (
              <section className="download-group">
                <div className="download-group-head">
                  <span className="download-group-label">Songs</span>
                  <span className="download-group-count">{ranked.songs.length}</span>
                </div>
                <ul className="download-group-list" role="list">{ranked.songs.map((s, i) => renderSong(s, false, i + 1))}</ul>
              </section>
            )}
            {ranked.albums.length > 0 && (
              <section className="download-group">
                <div className="download-group-head">
                  <span className="download-group-label">Albums</span>
                  <span className="download-group-count">{ranked.albums.length}</span>
                </div>
                <ul className="download-group-list" role="list">{ranked.albums.map((a, i) => renderAlbum(a, false, i + 1))}</ul>
              </section>
            )}
          </div>
        )}

        {notice && (
          <div className={`download-result ${notice.ok ? 'download-result--ok' : 'download-result--err'}`}>
            {notice.msg}
          </div>
        )}

        {failures.length > 0 && (
          <div className="download-failures">
            <div className="download-failures-head">
              {failures.length} track{failures.length === 1 ? '' : 's'} couldn’t be imported:
            </div>
            <ul className="download-failures-list">
              {failures.map((f, i) => (
                <li key={`${f.filename}-${i}`}>
                  <span className="download-failures-name">{f.filename}</span>
                  <span className="download-failures-reason">{f.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Direct link ── */}
        <div className="download-divider"><span>or paste a link</span></div>
        <div className="download-row">
          <input
            className="download-input"
            value={pasteUrl}
            onChange={(e) => setPasteUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void downloadPaste() }}
            placeholder="https://…"
            disabled={pasteBusy}
            spellCheck={false}
          />
          <button className="download-btn" onClick={() => void downloadPaste()} disabled={pasteBusy || !pasteUrl.trim()}>
            {pasteBusy ? 'Downloading…' : 'Download'}
          </button>
        </div>

        <div className="download-hint">
          YouTube needs no login. For lossless Qobuz, connect your account below.
        </div>

        {/* ── Qobuz account — password hashed locally, written to streamrip's config ── */}
        <div className="download-accounts">
          <div className="download-accounts-head">Qobuz account</div>
          {qobuz?.configured && !qEditing ? (
            <div className="download-account-row">
              <span className="download-account-status">Connected{qobuz.email ? ` · ${qobuz.email}` : ''}</span>
              <button className="download-link-btn" onClick={() => { setQEditing(true); setQMsg(null) }}>Change</button>
            </div>
          ) : qMode === 'token' ? (
            <>
              <div className="download-account-form">
                <input className="download-input download-input--narrow" placeholder="Qobuz user ID" value={qUserId} onChange={(e) => setQUserId(e.target.value)} disabled={qSaving} spellCheck={false} autoComplete="off" />
                <input className="download-input" type="password" placeholder="Qobuz auth token" value={qToken} onChange={(e) => setQToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveQobuzToken() }} disabled={qSaving} autoComplete="off" />
                <button className="download-btn" onClick={() => void saveQobuzToken()} disabled={qSaving || !qUserId.trim() || !qToken.trim()}>{qSaving ? 'Saving…' : 'Connect'}</button>
              </div>
              <details className="download-steps">
                <summary>How to get your user ID + token (Google sign-in)</summary>
                <ol>
                  <li>Open <strong>play.qobuz.com</strong> in your browser and log out.</li>
                  <li>Open dev tools (<strong>⌥⌘I</strong>) → <strong>Network</strong> tab; type <code>login</code> in the filter box.</li>
                  <li>Log back in with Google. A request named <code>login</code> appears — click it → the <strong>Response</strong> tab.</li>
                  <li>Copy <code>user_auth_token</code> → paste as <strong>auth token</strong>. Find <code>"user":&#123; "id": NUMBER</code> → paste that NUMBER as <strong>user ID</strong>.</li>
                </ol>
              </details>
              <button className="download-link-btn download-toggle" onClick={() => { setQMode('password'); setQMsg(null) }}>Have a Qobuz password instead?</button>
            </>
          ) : (
            <>
              <div className="download-account-form">
                <input className="download-input" placeholder="Qobuz email" value={qEmail} onChange={(e) => setQEmail(e.target.value)} disabled={qSaving} spellCheck={false} autoComplete="off" />
                <input className="download-input" type="password" placeholder="Qobuz password" value={qPass} onChange={(e) => setQPass(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveQobuz() }} disabled={qSaving} autoComplete="off" />
                <button className="download-btn" onClick={() => void saveQobuz()} disabled={qSaving || !qEmail.trim() || !qPass}>{qSaving ? 'Saving…' : 'Connect'}</button>
              </div>
              <button className="download-link-btn download-toggle" onClick={() => { setQMode('token'); setQMsg(null) }}>Sign in with Google? Use a token instead →</button>
            </>
          )}
          {qMsg && <div className={`download-result ${qMsg.ok ? 'download-result--ok' : 'download-result--err'}`}>{qMsg.msg}</div>}
          <div className="download-hint download-hint--sub">Saved to streamrip’s config on this Mac — your credentials never leave your machine or go through chat.</div>
        </div>

        {status && !status.installed && (
          <div className="download-warn">
            streamrip (the <code>rip</code> command) wasn’t found. Install it with{' '}
            <code>pipx install streamrip</code>, then reopen this view.
          </div>
        )}
      </div>
    </div>
  )
}
