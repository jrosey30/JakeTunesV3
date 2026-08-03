import { useEffect, useState } from 'react'
import { takeDownloadPrefill } from '../../listen-to-the-list/ltlDownload'
import './download-store.css'

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
const TYPES = [
  { id: 'track', label: 'Tracks' },
  { id: 'album', label: 'Albums' },
  { id: 'artist', label: 'Artists' },
]

// 4.5: page memory — this view unmounts on navigate-away. A module-level cache
// (same pattern as MadeForYou's sessionMixes) restores the working state — your
// search, source, results, and pasted link — when you leave and come back.
interface DownloadCache {
  query: string; source: string; mediaType: string
  results: SearchResult[]; art: Record<string, string>; pasteUrl: string
}
let pageCache: DownloadCache = {
  query: '', source: 'qobuz', mediaType: 'track', results: [], art: {}, pasteUrl: '',
}

// streamrip result descs end with " by <artist>" ("Creep by Radiohead",
// "Sub Urban - Cradles [NCS Release] by Sub Urban"). Split on the LAST " by "
// to feed the app's artist-verified iTunes art lookup.
// ⚠️ TWIN: src/main/streamrip-match.ts → parseStreamripDesc
function parseDesc(desc: string): { artist: string; title: string } {
  const i = desc.lastIndexOf(' by ')
  if (i > 0) return { title: desc.slice(0, i).trim(), artist: desc.slice(i + 4).trim() }
  return { title: desc.trim(), artist: '' }
}

export default function DownloadView() {
  const [status, setStatus] = useState<RipStatus | null>(null)
  const [query, setQuery] = useState(pageCache.query)
  const [source, setSource] = useState(pageCache.source)
  const [mediaType, setMediaType] = useState(pageCache.mediaType)
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[]>(pageCache.results)
  const [art, setArt] = useState<Record<string, string>>(pageCache.art)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
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
    return window.electronAPI.onBandcampImportFailed((r) => {
      setFailures((prev) => [...prev, r])
    })
  }, [])

  // Prefill search when opened from Listen to the List (failed match fallback).
  // Prefer the latched query (survives mount-order), then also listen for
  // live events if the view is already mounted.
  useEffect(() => {
    const apply = (q: string) => {
      const trimmed = q.trim()
      if (!trimmed) return
      setQuery(trimmed)
      setResults([])
      setArt({})
      setSearchErr(null)
      setNotice(null)
    }
    const latched = takeDownloadPrefill()
    if (latched) apply(latched)
    const onPrefill = (e: Event) => {
      const q = (e as CustomEvent<{ query?: string }>).detail?.query?.trim()
      if (q) apply(q)
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

  const runSearch = async () => {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchErr(null)
    setResults([])
    setArt({})
    setNotice(null)
    try {
      const r = await window.electronAPI.streamripSearch?.({ query: q, source, mediaType, numResults: 25 })
      if (r?.ok) setResults(r.results || [])
      else setSearchErr(r?.error || 'Search failed.')
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : 'Search failed.')
    } finally {
      setSearching(false)
    }
  }

  const downloadResult = async (res: SearchResult) => {
    if (downloadingId) return
    setDownloadingId(res.id)
    setNotice(null)
    setFailures([])
    try {
      const r = await window.electronAPI.streamripDownloadId?.(res.source, res.mediaType, res.id)
      if (r?.ok && (r.imported ?? 0) > 0) {
        const dup = r.dupes ? `, ${r.dupes} already in library` : ''
        setNotice({ ok: true, msg: `Imported ${r.imported} track${r.imported === 1 ? '' : 's'}${dup} — ${res.desc}` })
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
      setDownloadingId(null)
    }
  }

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

  return (
    <div className="download-view">
      <div className="download-card">
        <h1 className="download-title">Download</h1>
        <p className="download-sub">
          Search a source and click to grab it — or paste a link. It imports straight into your library.
        </p>

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
          <select className="download-select" value={mediaType} onChange={(e) => setMediaType(e.target.value)} disabled={searching}>
            {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <input
            className="download-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runSearch() }}
            placeholder="Search artists, songs, albums…"
            disabled={searching}
            spellCheck={false}
          />
          <button className="download-btn" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {searchErr && <div className="download-result download-result--err">{searchErr}</div>}

        {results.length > 0 && (
          <ul className="download-results" role="list">
            {results.map((res) => {
              const busy = downloadingId === res.id
              return (
                <li key={res.id} className="download-result-row">
                  {art[res.id]
                    ? <img className="download-result-art" src={art[res.id]} alt="" loading="lazy" />
                    : <span className="download-result-art download-result-art--ph" aria-hidden="true">♪</span>}
                  <span className="download-result-desc" title={res.desc}>{res.desc}</span>
                  <button
                    className="download-result-btn"
                    onClick={() => void downloadResult(res)}
                    disabled={!!downloadingId}
                  >
                    {busy ? 'Downloading…' : res.mediaType === 'artist' ? 'Download all' : 'Download'}
                  </button>
                </li>
              )
            })}
          </ul>
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
