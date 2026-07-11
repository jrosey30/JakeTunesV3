import { useEffect, useState, useMemo, useReducer, useRef, type CSSProperties } from 'react'
import './download-store.css'
import { useLibrary } from '../../context/LibraryContext'
import { enqueue, itemFor, subscribeQueue, getQueue, retry, queueSummary, clearFinished, type QItem } from './downloadQueue'

// normalize for the "already in your library" match (local; renderer can't
// import the main-process reco-match).
const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const mmss = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

// Relevance scorer — a TWIN of the universal-search ranker in
// utils/searchIndex.ts (exact > prefix > token-start > substring > all-tokens),
// so Download organizes results by "likeliest you mean" exactly like the
// app's main search, and re-ranks live as you type more characters.
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
  // Artist weighed a touch higher than title (and "the " stripped) so searching
  // an ARTIST ("postal service") surfaces that artist's catalog above junk
  // tracks merely TITLED like the artist ("Postal Service" by some cover farm).
  const t = scoreField(normQ(title), q, qTokens)
  const aRaw = normQ(artist)
  const a = Math.max(scoreField(aRaw, q, qTokens), scoreField(stripThe(aRaw), q, qTokens))
  return t * 1.0 + a * 1.15
}

// streamrip "Download" view — replaces the embedded web-store browser views
// (squid/lucida/dab, all dead/walled/ad-trapped). Browse by searching a
// source's catalog and clicking a result, or paste a direct link. Either way
// the audio imports into the library through the same pipeline every other
// import uses. No embedded browser, no Cloudflare.

interface RipStatus { installed: boolean; version?: string }
interface SearchResult { source: string; mediaType: string; id: string; desc: string }

// 4.5: SoundCloud removed at Jake's request.
const SOURCES = [
  { id: 'qobuz', label: 'Qobuz' },
  { id: 'tidal', label: 'Tidal' },
  { id: 'deezer', label: 'Deezer' },
  { id: 'youtube', label: 'YouTube' },
]
// 4.5: page memory — this view unmounts on navigate-away. A module-level cache
// (same pattern as MadeForYou's sessionMixes) restores the working state — your
// search, source, results, and pasted link — when you leave and come back.
interface DownloadCache {
  query: string; source: string; mediaType: string
  results: SearchResult[]; art: Record<string, string>; pasteUrl: string
}
let pageCache: DownloadCache = {
  query: '', source: 'qobuz', mediaType: 'all', results: [], art: {}, pasteUrl: '',
}

// streamrip result descs end with " by <artist>" ("Creep by Radiohead",
// "Sub Urban - Cradles [NCS Release] by Sub Urban"). Split on the LAST " by "
// to feed the app's artist-verified iTunes art lookup.
function parseDesc(desc: string): { artist: string; title: string } {
  const i = desc.lastIndexOf(' by ')
  if (i > 0) return { title: desc.slice(0, i).trim(), artist: desc.slice(i + 4).trim() }
  return { title: desc.trim(), artist: '' }
}

export default function DownloadView() {
  const [status, setStatus] = useState<RipStatus | null>(null)
  const [query, setQuery] = useState(pageCache.query)
  const [source, setSource] = useState(pageCache.source)
  const [mediaType] = useState(pageCache.mediaType) // persisted for page memory; search is always album+track now
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[]>(pageCache.results)
  const [art, setArt] = useState<Record<string, string>>(pageCache.art)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)
  // 4.5: per-file import failures, kept on screen (not just the ~9s top-strip flash)
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

  // Queue: subscribe for re-render on any status change, + a 1s tick so the
  // "downloading" elapsed clock stays live. State lives in downloadQueue (module
  // level) so it survives navigating away and back.
  const { state: lib } = useLibrary()
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribeQueue(forceRender), [])
  useEffect(() => {
    const id = window.setInterval(() => {
      if (getQueue().some((q) => q.status === 'downloading')) forceRender()
    }, 1000)
    return () => window.clearInterval(id)
  }, [])
  // "Already in your library" index — track (title|artist) + album (album|artist).
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

  // Rank + group by relevance to the current query — recomputed every keystroke
  // so the likeliest match rises AS you type, before the next fetch even returns.
  const ranked = useMemo(() => {
    const q = normQ(query)
    const qTokens = q ? q.split(' ') : []
    const scored = results.map((res) => {
      const { title, artist } = parseDesc(res.desc)
      const owned = res.mediaType === 'album'
        ? libIndex.albums.has(norm(title) + '|' + norm(artist))
        : res.mediaType === 'track' && libIndex.tracks.has(norm(title) + '|' + norm(artist))
      const base = q ? scoreResult(q, qTokens, title, artist) : 0
      // Tie toward the SONG — but ONLY when the query matched the track's TITLE
      // (real song intent). A track that only matched via its ARTIST (an artist
      // search) gets no nudge, so albums still lead the discography.
      const titleHit = q ? scoreField(normQ(title), q, qTokens) > 0 : false
      const score = base > 0 && res.mediaType === 'track' && titleHit ? base + 0.5 : base
      return { res, title, artist, owned, score }
    })
    scored.sort((a, b) => b.score - a.score)
    // Only show results that actually match the current query — so stale results
    // from the previous keystroke drop the instant they no longer fit.
    const relevant = q ? scored.filter((s) => s.score > 0) : scored
    const topHit = relevant.length > 0 ? relevant[0] : null
    const rest = topHit ? relevant.filter((s) => s.res.id !== topHit.res.id) : relevant
    return {
      topHit,
      albums: rest.filter((s) => s.res.mediaType === 'album'),
      tracks: rest.filter((s) => s.res.mediaType === 'track'),
      artists: rest.filter((s) => s.res.mediaType === 'artist'),
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

  // 4.5: keep per-file import failures visible on the Download screen. App.tsx
  // also flashes each one in the top strip for ~9s, but on a multi-track album
  // they blink past and you'd only catch the last — so accumulate the full list
  // here until the next download starts.
  useEffect(() => {
    return window.electronAPI.onBandcampPerFileFailed((r) => {
      setFailures((prev) => [...prev, r])
    })
  }, [])

  // Prefill search when opened from Listen to the List (failed match fallback).
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const q = (e as CustomEvent<{ query?: string }>).detail?.query?.trim()
      if (!q) return
      setQuery(q)
      setResults([])
      setArt({})
      setSearchErr(null)
      setNotice(null)
    }
    window.addEventListener('jaketunes-download-prefill', onPrefill)
    return () => window.removeEventListener('jaketunes-download-prefill', onPrefill)
  }, [])

  // 4.5: page memory — persist the working state so leaving and returning restores it.
  useEffect(() => {
    pageCache = { query, source, mediaType, results, art, pasteUrl }
  }, [query, source, mediaType, results, art, pasteUrl])

  // Lazily fetch cover art for each result (streamrip search returns none;
  // reuse the app's artist-verified iTunes art lookup). Misses show the ♪.
  useEffect(() => {
    if (results.length === 0) return
    let cancelled = false
    for (const res of results) {
      const { artist, title } = parseDesc(res.desc)
      if (!artist || !title) continue
      window.electronAPI.lookupRecoArtwork?.({ artist, title }).then((r) => {
        if (!cancelled && r?.artworkUrl) setArt((prev) => (prev[res.id] ? prev : { ...prev, [res.id]: r.artworkUrl as string }))
      }).catch(() => { /* leave placeholder */ })
    }
    return () => { cancelled = true }
  }, [results])

  // Live, universal-search-style: albums + tracks in one shot (you never need to
  // know the album), newest query wins (stale results dropped).
  const searchTokenRef = useRef(0)
  const runSearch = async (raw: string) => {
    const q = raw.trim()
    const token = ++searchTokenRef.current
    if (!q) { setResults([]); setSearchErr(null); setSearching(false); return }
    setSearching(true)
    setSearchErr(null)
    setNotice(null)
    try {
      const settled = await Promise.all(
        ['album', 'track'].map((mt) =>
          window.electronAPI.streamripSearch?.({ query: q, source, mediaType: mt, numResults: 25 }).catch(() => null),
        ),
      )
      if (token !== searchTokenRef.current) return // a newer keystroke superseded this
      const merged: SearchResult[] = []
      const seen = new Set<string>()
      let anyErr: string | null = null
      for (const r of settled) {
        if (!r) continue
        if (!r.ok) { anyErr = r.error || anyErr; continue }
        for (const res of r.results || []) {
          const k = `${res.source}|${res.mediaType}|${res.desc.toLowerCase()}` // collapse exact dupes
          if (seen.has(k)) continue
          seen.add(k)
          merged.push(res)
        }
      }
      setResults(merged)
      setSearchErr(merged.length === 0 ? (anyErr || `No matches for “${q}”.`) : null)
    } catch (e) {
      if (token === searchTokenRef.current) setSearchErr(e instanceof Error ? e.message : 'Search failed.')
    } finally {
      if (token === searchTokenRef.current) setSearching(false)
    }
  }

  // Type and it finds — 2+ chars, 400ms after you pause; re-fires on source change.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults([]); setSearchErr(null); setSearching(false); return }
    const h = window.setTimeout(() => { void runSearch(q) }, 400)
    return () => window.clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, source])

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
        setQMsg({ ok: true, msg: 'Qobuz connected — pick Qobuz in the source dropdown to search it in hi-fi.' })
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
        setQMsg({ ok: true, msg: 'Qobuz connected via token — pick Qobuz in the source dropdown to search it in hi-fi.' })
      } else {
        setQMsg({ ok: false, msg: r?.error || 'Couldn’t save Qobuz token.' })
      }
    } catch (err) {
      setQMsg({ ok: false, msg: err instanceof Error ? err.message : 'Couldn’t save Qobuz token.' })
    } finally {
      setQSaving(false)
    }
  }

  // Each result's right-side action reflects its OWN queue lifecycle so the
  // download → into-library journey is never a black box.
  const renderAction = (res: SearchResult, item: QItem | undefined) => {
    const st = item?.status
    if (st === 'downloading') {
      const secs = item?.startedAt ? Math.floor((Date.now() - item.startedAt) / 1000) : 0
      return <span className="dl-state dl-state--busy"><span className="dl-spinner" aria-hidden="true" />Downloading {mmss(secs)}</span>
    }
    if (st === 'queued') return <span className="dl-state dl-state--queued">Queued</span>
    if (st === 'done') {
      return (
        <span className="dl-state dl-state--done">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          In your library{item?.imported ? ` · ${item.imported}` : ''}
        </span>
      )
    }
    if (st === 'failed') {
      return <button className="download-retry" onClick={() => item && retry(item.key)} title={item?.error || 'Retry'}>Retry</button>
    }
    return <button className="download-result-btn" onClick={() => enqueue(res)}>{res.mediaType === 'artist' ? 'Get all' : 'Download'}</button>
  }

  return (
    <div className="download-view">
      <div className="download-card">
        <div className="download-head">
          <span className="download-eyebrow">Get music</span>
          <h1 className="download-title">Download</h1>
          <p className="download-sub">
            Search a source and click to grab it — or paste a link. It imports straight into your library.
          </p>
        </div>

        {/* ── Browse: source pills → search → results → click ── */}
        <div className="download-sources" role="tablist" aria-label="Download source">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`download-source-pill${source === s.id ? ' is-active' : ''}`}
              onClick={() => setSource(s.id)}
              disabled={searching}
            >{s.label}</button>
          ))}
        </div>
        <div className="download-search">
          <div className="download-search-field">
            <svg className="download-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input
              className="download-input download-input--search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(query) }}
              placeholder="Search a song, album, or artist…"
              spellCheck={false}
              autoFocus
            />
            {searching && <span className="dl-spinner download-search-spinner" aria-hidden="true" />}
          </div>
        </div>

        {searchErr && <div className="download-result download-result--err">{searchErr}</div>}

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

        {(ranked.topHit || ranked.albums.length > 0 || ranked.tracks.length > 0 || ranked.artists.length > 0) && (() => {
          let idx = 0
          const renderRow = (s: { res: SearchResult; title: string; artist: string; owned: boolean }, hero = false) => {
            const { res, title, artist, owned } = s
            const item = itemFor(res)
            const i = idx++
            return (
              <li key={res.id} className={`download-result-row${hero ? ' download-result-row--hero' : ''}${item ? ` is-${item.status}` : ''}`} style={{ '--i': i } as CSSProperties}>
                {art[res.id]
                  ? <img className="download-result-art" src={art[res.id]} alt="" loading="lazy" />
                  : <span className="download-result-art download-result-art--ph" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" /></svg>
                    </span>}
                <div className="download-result-body">
                  <span className="download-result-title" title={res.desc}>{title || res.desc}</span>
                  <span className="download-result-meta">
                    {artist && <span className="download-result-artist">{artist}</span>}
                    {owned && <span className="download-owned">In your library</span>}
                  </span>
                </div>
                {renderAction(res, item)}
              </li>
            )
          }
          const groups = [
            { key: 'album', label: 'Albums', items: ranked.albums },
            { key: 'track', label: 'Tracks', items: ranked.tracks },
            { key: 'artist', label: 'Artists', items: ranked.artists },
          ].filter((g) => g.items.length > 0)
            // Strongest-matching type leads — search a song and Tracks come
            // first; search an artist/album and Albums lead.
            .sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0))
          return (
            <div className="download-results">
              {ranked.topHit && (
                <section className="download-group download-group--top">
                  <div className="download-group-head"><span className="download-group-label download-group-label--top">Top match</span></div>
                  <ul className="download-group-list" role="list">{renderRow(ranked.topHit, true)}</ul>
                </section>
              )}
              {groups.map((g) => (
                <section key={g.key} className="download-group">
                  <div className="download-group-head">
                    <span className="download-group-label">{g.label}</span>
                    <span className="download-group-count">{g.items.length}</span>
                  </div>
                  <ul className="download-group-list" role="list">{g.items.map((s) => renderRow(s))}</ul>
                </section>
              ))}
            </div>
          )
        })()}

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
