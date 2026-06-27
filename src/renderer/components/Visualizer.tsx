/**
 * 4.5: Fullscreen Visualizer mode — the iTunes feature we never had, rebuilt
 * the modern way. Driven by the SAME Web Audio analyser the EQ already taps off
 * Howler.masterGain (getVisualizerBins / getVisualizerWaveform in audio/eq.ts —
 * no new AudioContext, no Howler.ctx pinning, see feedback_audiocontext_pin).
 *
 * Style = the "radial bloom" Jake picked: a breathing core, frequency spokes
 * radiating out (bilaterally mirrored so it reads symmetric), and rings that
 * ripple on the bass. Warm amber→magenta→violet sweep — a nod to the brand.
 *
 * Self-contained: it owns its on/off state, listens for the `toggle-visualizer`
 * window event (the toolbar button fires it) + Cmd/Ctrl+T, and exits on Esc or
 * click. App renders one <Visualizer/> and is otherwise untouched.
 */
import { useEffect, useRef, useState } from 'react'
import { getVisualizerBins } from '../audio/eq'
import { usePlayback } from '../context/PlaybackContext'
import '../styles/visualizer.css'

function Stage({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { state: pb } = usePlayback()
  const np = pb.nowPlaying

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const DPR = Math.min(2, window.devicePixelRatio || 1)
    const size = (): void => {
      canvas.width = window.innerWidth * DPR
      canvas.height = window.innerHeight * DPR
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    }
    size()
    window.addEventListener('resize', size)

    const M = 96, HALF = 48
    let t = 0, bassEnv = 0, prevBass = 0, raf = 0
    const rings: Array<{ r: number; a: number }> = []

    const frame = (): void => {
      t += 0.016
      const W = window.innerWidth, H = window.innerHeight, cx = W / 2, cy = H / 2
      const bins = getVisualizerBins(HALF) || new Uint8Array(HALF)
      let bass = 0
      for (let i = 0; i < 6; i++) bass += bins[i] || 0
      bass = bass / 6 / 255
      const kick = Math.max(0, bass - bassEnv)
      bassEnv = bassEnv * 0.92 + bass * 0.08
      if (kick > 0.05 && bass - prevBass > 0.035) rings.push({ r: 38, a: 0.5 })
      prevBass = bass
      // A gentle idle shimmer so it stays alive when paused / silent.
      const idle = 0.05 + 0.04 * Math.sin(t * 1.5)

      ctx.fillStyle = 'rgba(11,7,16,0.26)'
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'

      for (let i = rings.length - 1; i >= 0; i--) {
        const rg = rings[i]!
        rg.r += 4; rg.a *= 0.955
        if (rg.a < 0.02) { rings.splice(i, 1); continue }
        ctx.strokeStyle = `hsla(${(t * 18) % 360},85%,65%,${rg.a})`
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(cx, cy, rg.r, 0, 7); ctx.stroke()
      }

      const coreR = 30 + bass * 60 + 8 * Math.sin(t * 1.3)
      for (let g = 3; g >= 1; g--) {
        ctx.fillStyle = `hsla(28,95%,60%,${0.09 * g * (0.5 + bass)})`
        ctx.beginPath(); ctx.arc(cx, cy, coreR * g * 0.9, 0, 7); ctx.fill()
      }

      const inner = coreR + 8, maxLen = Math.min(W, H) * 0.40
      for (let i = 0; i < M; i++) {
        const bi = i < HALF ? i : (M - 1 - i)
        const v = Math.max(idle, (bins[bi] || 0) / 255)
        const ang = (i / M) * Math.PI * 2 + t * 0.12
        const len = inner + v * maxLen, hue = 18 + (i / M) * 300
        const x0 = cx + Math.cos(ang) * inner, y0 = cy + Math.sin(ang) * inner
        const x1 = cx + Math.cos(ang) * len, y1 = cy + Math.sin(ang) * len
        ctx.strokeStyle = `hsla(${hue},88%,62%,0.82)`
        ctx.lineWidth = 2.6
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
        ctx.fillStyle = `hsla(${hue},95%,72%,0.9)`
        ctx.beginPath(); ctx.arc(x1, y1, 1.6 + v * 3, 0, 7); ctx.fill()
      }

      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', size) }
  }, [])

  return (
    <div className="visualizer-overlay" onClick={onClose} role="presentation">
      <canvas ref={canvasRef} className="visualizer-canvas" aria-hidden />
      {np && (
        <div className="visualizer-np">
          <div className="visualizer-np-title">{np.title}</div>
          <div className="visualizer-np-artist">{np.artist}</div>
        </div>
      )}
      <div className="visualizer-hint">Esc or click to exit</div>
    </div>
  )
}

export default function Visualizer() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    const onToggle = (): void => setActive((a) => !a)
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        setActive((a) => !a)
      }
    }
    window.addEventListener('toggle-visualizer', onToggle)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('toggle-visualizer', onToggle)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Esc closes the visualizer (capture + stopPropagation so the global Esc
  // handler in App.tsx doesn't also fire underneath us).
  useEffect(() => {
    if (!active) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setActive(false) }
    }
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [active])

  if (!active) return null
  return <Stage onClose={() => setActive(false)} />
}
