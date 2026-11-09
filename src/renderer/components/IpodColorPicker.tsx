// "iPod color…" (2026-11-09). Jake: "if i dont have one use a default ipod photo
// to which i can customize color". A small popover in the context menu's look:
// the eleven real iPod mini / nano / classic colours as swatches, the current
// one ringed in the JakeTunes orange, and Custom… for any other colour. A pick
// saves at once (renderer/ipodLists.ts setIpodListColor: the cover changes now,
// homemini hears it now or when it next answers).
import { useEffect, useRef, useState } from 'react'
import { IPOD_COLORS, ipodColorHex } from '../../common/ipod-covers'
import { setIpodListColor } from '../ipodLists'
import '../styles/contextmenu.css'
import '../styles/ipod-color-picker.css'

interface Props {
  deviceId: string
  ipodName: string
  /** The colour the cover shows now (a named iPod colour or '#rrggbb'). */
  current: string
  x: number
  y: number
  onClose: () => void
  /** One plain line after a save, e.g. for the status bar. */
  onSaved?: (line: string) => void
}

export function IpodColorPicker({ deviceId, ipodName, current, x, y, onClose, onSaved }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState({ x, y })
  // The system colour panel fires on every drag; the colour is saved on Use.
  const [custom, setCustom] = useState(ipodColorHex(current))

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [onClose])

  // Keep the popover on screen.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = Math.max(8, Math.min(x, window.innerWidth - r.width - 8))
    const ny = Math.max(8, Math.min(y, window.innerHeight - r.height - 32))
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny })
  }, [x, y, pos.x, pos.y])

  const pick = (color: string) => {
    setError(null)
    void setIpodListColor(deviceId, color).then((r) => {
      if (!r.ok) { setError(r.error); return }
      onSaved?.(r.homemini === 'saved'
        ? `${ipodName} is ${color.startsWith('#') ? 'a custom colour' : color} now.`
        : `${ipodName} is ${color.startsWith('#') ? 'a custom colour' : color} now. The phone gets it when homemini answers.`)
      onClose()
    })
  }

  const isCustom = !IPOD_COLORS.some((c) => c.name === current)

  return (
    <div className="context-menu ipod-color-picker" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ipod-color-picker-title">iPod color</div>
      <div className="ipod-color-picker-swatches">
        {IPOD_COLORS.map((c) => (
          <button
            key={c.name}
            type="button"
            className={`ipod-color-swatch${c.name === current ? ' ipod-color-swatch--current' : ''}`}
            style={{ background: c.hex }}
            title={c.name[0].toUpperCase() + c.name.slice(1)}
            aria-label={c.name}
            onClick={() => pick(c.name)}
          />
        ))}
      </div>
      <div className={`ipod-color-custom${isCustom ? ' ipod-color-custom--current' : ''}`}>
        <label className="ipod-color-custom-pick">
          <span className="ipod-color-swatch ipod-color-swatch--small" style={{ background: custom }} aria-hidden="true" />
          Custom…
          <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </label>
        <button type="button" className="ipod-color-use" disabled={custom === ipodColorHex(current)} onClick={() => pick(custom)}>Use</button>
      </div>
      {error && <div className="ipod-color-picker-error">{error}</div>}
    </div>
  )
}
