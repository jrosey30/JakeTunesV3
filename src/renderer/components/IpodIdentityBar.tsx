/**
 * Which iPod is plugged in — a strip above the Device page (2026-10-23, one
 * Pool per iPod, step 1). DeviceView itself is on the do-not-touch list, so
 * this lives beside it rather than inside it.
 *
 *   • an iPod JakeTunes knows: nothing here — its name, colour and one Sync
 *     button are in the Device page's Sync area (2026-11-07)
 *   • an iPod with no ID yet: set it up, either as the original (only when no
 *     original is registered on this Mac) or through the guided set-up
 *     (IpodSetupSheet, 2026-11-13): which list it carries, the checks, the ID file
 *   • an iPod that was just set up: its first sync and the checklist on the iPod
 */
import { useCallback, useEffect, useState } from 'react'
import type { IpodIdentity } from '../../common/ipod-identity'
import IpodSetupSheet from './IpodSetupSheet'
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

export function stickerHex(color: string | null): string {
  return STICKERS.find((s) => s.name === color)?.hex || color || '#b9bcc0'
}

export default function IpodIdentityBar() {
  const [identity, setIdentity] = useState<IpodIdentity | null>(null)
  // The guided set-up (2026-11-13): which list, the checks, the ID file (IpodSetupSheet).
  const [guided, setGuided] = useState(false)
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

  const registerOriginal = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.electronAPI.registerIpodDevice?.({ asOriginal: true })
      if (!r) setError('This build can’t set up iPods.')
      else if (!r.ok) setError(r.error)
      else await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!identity) return null

  // A known iPod's name and colour sit in the Device page's Sync area, beside
  // its one Sync button (2026-11-07). This strip is for setting one up, and for
  // the end of a set-up: the first sync and the checklist on the iPod itself
  // (2026-11-13). The Original has no set-up.
  if (identity.status === 'known') {
    if (identity.device.primary) return null
    return <div className="ipod-id-bar ipod-id-bar--setup"><IpodSetupSheet key={identity.device.id} mode="tail" /></div>
  }
  if (guided) {
    return <div className="ipod-id-bar ipod-id-bar--unknown ipod-id-bar--setup"><IpodSetupSheet mode="setup" onClose={() => { setGuided(false); void refresh() }} /></div>
  }

  return (
    <div className="ipod-id-bar ipod-id-bar--unknown">
      <>
        <span className="ipod-id-note ipod-id-note--strong">
          JakeTunes doesn’t know this iPod yet. Until it’s set up, JakeTunes won’t sync it or read its play counts.
        </span>
        <div className="ipod-id-actions">
          {identity.canBeOriginal && (
            <button className="device-itunes-btn" disabled={busy} onClick={() => { void registerOriginal() }}>
              This is my original iPod
            </button>
          )}
          <button className="device-itunes-btn" disabled={busy} onClick={() => { setGuided(true); setError(null) }}>
            Set up this iPod
          </button>
        </div>
      </>
      {error && <span className="ipod-id-error">{error}</span>}
    </div>
  )
}
