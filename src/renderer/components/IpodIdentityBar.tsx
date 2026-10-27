/**
 * Which iPod is plugged in — a strip above the Device page (2026-10-23, one
 * Pool per iPod, step 1). DeviceView itself is on the do-not-touch list, so
 * this lives beside it rather than inside it.
 *
 *   • the original: its name and what it's for, nothing to do
 *   • another iPod JakeTunes knows (the red Mini): name + "left alone until it
 *     has its own Pool" — main refuses every write to it anyway
 *   • an iPod with no ID yet: set it up, either as the original (only when no
 *     original is registered on this Mac) or as a new iPod with a name, a
 *     sticker colour and a line about what it's for
 */
import { useCallback, useEffect, useState } from 'react'
import type { IpodIdentity } from '../../common/ipod-identity'
import '../styles/ipod-identity.css'

// iPod mini's own colours, plus black for whatever comes next.
const STICKERS: Array<{ name: string; hex: string }> = [
  { name: 'red', hex: '#c8262c' },
  { name: 'silver', hex: '#b9bcc0' },
  { name: 'gold', hex: '#d4b06a' },
  { name: 'pink', hex: '#e79bb8' },
  { name: 'blue', hex: '#6f9fd8' },
  { name: 'green', hex: '#8cc56b' },
  { name: 'black', hex: '#2a2a2a' },
]

function stickerHex(color: string | null): string {
  return STICKERS.find((s) => s.name === color)?.hex || color || '#b9bcc0'
}

export default function IpodIdentityBar() {
  const [identity, setIdentity] = useState<IpodIdentity | null>(null)
  const [setup, setSetup] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState('red')
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await window.electronAPI.getIpodDevice?.()
      setIdentity(r?.ok && r.mounted && r.identity ? r.identity : null)
    } catch {
      setIdentity(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.electronAPI.onIpodDeviceChanged?.(() => { void refresh() })
    const onMount = () => { void refresh() }
    window.addEventListener('jaketunes-ipod-mounted', onMount)
    window.addEventListener('jaketunes-ipod-ejected', onMount)
    return () => {
      off?.()
      window.removeEventListener('jaketunes-ipod-mounted', onMount)
      window.removeEventListener('jaketunes-ipod-ejected', onMount)
    }
  }, [refresh])

  const register = async (asOriginal: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.electronAPI.registerIpodDevice?.(
        asOriginal ? { asOriginal: true } : { asOriginal: false, name: name.trim(), color, purpose: purpose.trim() },
      )
      if (!r) setError('This build can’t set up iPods.')
      else if (!r.ok) setError(r.error)
      else { setSetup(false); await refresh() }
    } finally {
      setBusy(false)
    }
  }

  if (!identity) return null

  if (identity.status === 'known') {
    const d = identity.device
    return (
      <div className="ipod-id-bar">
        <span className="ipod-id-sticker" style={{ background: stickerHex(d.color) }} aria-hidden="true" />
        <span className="ipod-id-name">{d.name}</span>
        {d.purpose && <span className="ipod-id-purpose">{d.purpose}</span>}
        {!d.primary && (
          <span className="ipod-id-note">It has its own Pool — drop songs on the sidebar’s iPod Pool while it’s plugged in. Syncing it comes next; until then JakeTunes won’t sync it or read its play counts.</span>
        )}
      </div>
    )
  }

  return (
    <div className="ipod-id-bar ipod-id-bar--unknown">
      {!setup ? (
        <>
          <span className="ipod-id-note ipod-id-note--strong">
            JakeTunes doesn’t know this iPod yet. Until it’s set up, JakeTunes won’t sync it or read its play counts.
          </span>
          <div className="ipod-id-actions">
            {identity.canBeOriginal && (
              <button className="device-itunes-btn" disabled={busy} onClick={() => { void register(true) }}>
                This is my original iPod
              </button>
            )}
            <button className="device-itunes-btn" disabled={busy} onClick={() => { setSetup(true); setError(null) }}>
              Set up as a new iPod
            </button>
          </div>
        </>
      ) : (
        <form
          className="ipod-id-form"
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) void register(false) }}
        >
          <label className="ipod-id-field">
            <span>Name</span>
            <input value={name} maxLength={40} placeholder="Red" autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="ipod-id-field">
            <span>Sticker</span>
            <div className="ipod-id-swatches" role="radiogroup" aria-label="Sticker colour">
              {STICKERS.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  role="radio"
                  aria-checked={color === s.name}
                  aria-label={s.name}
                  title={s.name}
                  className={`ipod-id-swatch${color === s.name ? ' is-on' : ''}`}
                  style={{ background: s.hex }}
                  onClick={() => setColor(s.name)}
                />
              ))}
            </div>
          </div>
          <label className="ipod-id-field ipod-id-field--wide">
            <span>What’s it for?</span>
            <input value={purpose} maxLength={120} placeholder="Optional — decide later" onChange={(e) => setPurpose(e.target.value)} />
          </label>
          <div className="ipod-id-actions">
            <button type="submit" className="device-itunes-btn" disabled={busy || !name.trim()}>Save</button>
            <button type="button" className="device-link-btn" disabled={busy} onClick={() => setSetup(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <span className="ipod-id-error">{error}</span>}
    </div>
  )
}
