import { useEffect, useState } from 'react'
import './download-store.css'

// streamrip "Download" view — replaces the embedded web-store browser views
// (squid/lucida/dab, all dead/walled/ad-trapped). Paste a streaming link →
// main shells out to `rip` → the result imports into the library through the
// same pipeline every other import uses. No embedded browser, no Cloudflare.

interface RipStatus { installed: boolean; version?: string }

export default function DownloadView() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<RipStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.streamripStatus?.().then((r) => {
      if (!cancelled && r?.ok) setStatus({ installed: !!r.installed, version: r.version })
    }).catch(() => { if (!cancelled) setStatus({ installed: false }) })
    return () => { cancelled = true }
  }, [])

  const go = async () => {
    const link = url.trim()
    if (!link || busy) return
    setBusy(true)
    setResult(null)
    try {
      const r = await window.electronAPI.streamripDownload?.(link)
      if (r?.ok) {
        const dup = r.dupes ? `, ${r.dupes} already in library` : ''
        setResult({ ok: true, msg: `Imported ${r.imported} track${r.imported === 1 ? '' : 's'}${dup}.` })
        setUrl('')
      } else {
        setResult({ ok: false, msg: r?.error || 'Download failed.' })
      }
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : 'Download failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="download-view">
      <div className="download-card">
        <h1 className="download-title">Download</h1>
        <p className="download-sub">
          Paste a Qobuz, Tidal, Deezer, SoundCloud, or YouTube link — the track or album
          downloads and imports straight into your library.
        </p>
        <div className="download-row">
          <input
            className="download-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void go() }}
            placeholder="https://…"
            disabled={busy}
            spellCheck={false}
          />
          <button className="download-btn" onClick={() => void go()} disabled={busy || !url.trim()}>
            {busy ? 'Downloading…' : 'Download'}
          </button>
        </div>
        {busy && <div className="download-busy">Working… an album can take a few minutes.</div>}
        {result && (
          <div className={`download-result ${result.ok ? 'download-result--ok' : 'download-result--err'}`}>
            {result.msg}
          </div>
        )}
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
