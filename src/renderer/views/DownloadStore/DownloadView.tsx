import { useEffect, useState } from 'react'
import './download-store.css'

// streamrip "Download" view — replaces the embedded web-store browser views
// (squid/lucida/dab, all dead/walled/ad-trapped). Browse by searching a
// source's catalog and clicking a result, or paste a direct link. Either way
// the audio imports into the library through the same pipeline every other
// import uses. No embedded browser, no Cloudflare.

interface RipStatus { installed: boolean; version?: string }
interface SearchResult { source: string; mediaType: string; id: string; desc: string }

const SOURCES = [
  { id: 'soundcloud', label: 'SoundCloud' },
  { id: 'qobuz', label: 'Qobuz' },
  { id: 'tidal', label: 'Tidal' },
  { id: 'deezer', label: 'Deezer' },
  { id: 'youtube', label: 'YouTube' },
]
const TYPES = [
  { id: 'track', label: 'Tracks' },
  { id: 'album', label: 'Albums' },
]

export default function DownloadView() {
  const [status, setStatus] = useState<RipStatus | null>(null)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('soundcloud')
  const [mediaType, setMediaType] = useState('track')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)
  const [pasteUrl, setPasteUrl] = useState('')
  const [pasteBusy, setPasteBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.streamripStatus?.().then((r) => {
      if (!cancelled && r?.ok) setStatus({ installed: !!r.installed, version: r.version })
    }).catch(() => { if (!cancelled) setStatus({ installed: false }) })
    return () => { cancelled = true }
  }, [])

  const runSearch = async () => {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setSearchErr(null)
    setResults([])
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
    try {
      const r = await window.electronAPI.streamripDownloadId?.(res.source, res.mediaType, res.id)
      if (r?.ok) {
        const dup = r.dupes ? `, ${r.dupes} already in library` : ''
        setNotice({ ok: true, msg: `Imported ${r.imported} track${r.imported === 1 ? '' : 's'}${dup} — ${res.desc}` })
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
    try {
      const r = await window.electronAPI.streamripDownload?.(link)
      if (r?.ok) {
        const dup = r.dupes ? `, ${r.dupes} already in library` : ''
        setNotice({ ok: true, msg: `Imported ${r.imported} track${r.imported === 1 ? '' : 's'}${dup}.` })
        setPasteUrl('')
      } else {
        setNotice({ ok: false, msg: r?.error || 'Download failed.' })
      }
    } catch (e) {
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Download failed.' })
    } finally {
      setPasteBusy(false)
    }
  }

  return (
    <div className="download-view">
      <div className="download-card">
        <h1 className="download-title">Download</h1>
        <p className="download-sub">
          Search a catalog and click to grab it, or paste a direct link. Either way it
          downloads and imports straight into your library.
        </p>

        {/* ── Browse: search → results → click ── */}
        <div className="download-search">
          <select className="download-select" value={source} onChange={(e) => setSource(e.target.value)} disabled={searching}>
            {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
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
                  <span className="download-result-desc" title={res.desc}>{res.desc}</span>
                  <button
                    className="download-result-btn"
                    onClick={() => void downloadResult(res)}
                    disabled={!!downloadingId}
                  >
                    {busy ? 'Downloading…' : 'Download'}
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
          SoundCloud &amp; YouTube need no login. Qobuz, Tidal, and Deezer need your account —
          add it once in streamrip’s <code>config.toml</code>.
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
