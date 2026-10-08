// Music Sources — where the music comes from: the Qobuz account and the
// streamrip tool the exact-download pipeline runs on. One panel, two homes
// (Record Shop step 5, "Music Sources placement"): Preferences → Music
// Sources is the address; the Download view's setup drawer keeps showing it
// until that placement is verified, so nothing is orphaned in between.
// Credentials are written to streamrip's config on this Mac by main; nothing
// here ever shows them on a discovery card.
import { useEffect, useState } from 'react'
import '../views/DownloadStore/download-store.css'

export interface QobuzState { configured: boolean; email?: string }
export interface RipStatus { installed: boolean; version?: string; reason?: string }

export default function MusicSourcesPanel({ onQobuzChange, onStatusChange }: {
  onQobuzChange?: (q: QobuzState) => void
  onStatusChange?: (s: RipStatus) => void
}) {
  const [status, setStatus] = useState<RipStatus | null>(null)
  const [qobuz, setQobuz] = useState<QobuzState | null>(null)
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
      if (cancelled) return
      const s: RipStatus = r?.ok ? { installed: !!r.installed, version: r.version, reason: r.reason } : { installed: false, reason: r?.reason }
      setStatus(s); onStatusChange?.(s)
    }).catch(() => { if (!cancelled) { setStatus({ installed: false }); onStatusChange?.({ installed: false }) } })
    window.electronAPI.streamripGetQobuz?.().then((r) => {
      if (!cancelled && r?.ok) { const q = { configured: r.configured, email: r.email }; setQobuz(q); onQobuzChange?.(q) }
    }).catch(() => { /* leave the form shown */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connected = (q: QobuzState): void => { setQobuz(q); onQobuzChange?.(q) }

  const saveQobuz = async () => {
    const e = qEmail.trim()
    if (!e || !qPass || qSaving) return
    setQSaving(true); setQMsg(null)
    try {
      const r = await window.electronAPI.streamripSetQobuz?.(e, qPass)
      if (r?.ok) { connected({ configured: true, email: e }); setQPass(''); setQEditing(false); setQMsg({ ok: true, msg: 'Qobuz connected — downloads now resolve there in hi-fi.' }) }
      else setQMsg({ ok: false, msg: r?.error || 'Couldn’t save Qobuz login.' })
    } catch (err) {
      setQMsg({ ok: false, msg: err instanceof Error ? err.message : 'Couldn’t save Qobuz login.' })
    } finally { setQSaving(false) }
  }

  const saveQobuzToken = async () => {
    const u = qUserId.trim(), t = qToken.trim()
    if (!u || !t || qSaving) return
    setQSaving(true); setQMsg(null)
    try {
      const r = await window.electronAPI.streamripSetQobuzToken?.(u, t)
      if (r?.ok) { connected({ configured: true, email: `user ${u}` }); setQToken(''); setQEditing(false); setQMsg({ ok: true, msg: 'Qobuz connected via token — downloads now resolve there in hi-fi.' }) }
      else setQMsg({ ok: false, msg: r?.error || 'Couldn’t save Qobuz token.' })
    } catch (err) {
      setQMsg({ ok: false, msg: err instanceof Error ? err.message : 'Couldn’t save Qobuz token.' })
    } finally { setQSaving(false) }
  }

  return (
    <div className="music-sources">
      {/* ── Qobuz account — password hashed locally, written to streamrip's config ── */}
      <section className="dl-setup-card">
        <div className="dl-setup-card-head">Qobuz account</div>
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
      </section>

      {/* ── The tool the downloads run on ── */}
      <section className="dl-setup-card">
        <div className="dl-setup-card-head">Download tool</div>
        {status === null ? (
          <div className="download-hint">Checking streamrip…</div>
        ) : status.installed ? (
          <div className="download-account-row">
            <span className="download-account-status">streamrip {status.version || ''} · ready</span>
          </div>
        ) : (
          <div className="download-warn">
            {/* The reason comes from main, which tells "not installed" apart
                from "installed but can't start" — those need different fixes,
                and the old blanket message sent Jake to `pipx install
                streamrip` for a broken Homebrew dependency (2026-08-08). */}
            {status.reason || <>streamrip (the <code>rip</code> command) wasn’t found. Install it with <code>pipx install streamrip</code>, then reopen this view.</>}
          </div>
        )}
      </section>
    </div>
  )
}
