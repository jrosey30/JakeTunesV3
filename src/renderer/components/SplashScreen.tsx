/**
 * 5.0 launch — THE COLD BOOT (2026-08-08).
 *
 * Jake shipped a new mark — a pixel-art iPod — and asked for a launch
 * animation "centered around this and more advanced than ever". So the app
 * doesn't fade a logo in; it BOOTS THE DEVICE, and the animation is driven by
 * the logo's own pixels rather than by CSS on a rectangle:
 *
 *   0.00s  dark. a single scanline snaps on and expands — CRT/LCD power-on.
 *   0.15s  the iPod ASSEMBLES: the real logo bitmap is read into a canvas and
 *          revealed grid-cell by grid-cell on a diagonal sweep. Each cell
 *          IGNITES (a white flash that decays over ~180ms) at the moment it
 *          lands, so the body writes itself on like pixels powering up.
 *   1.05s  the screen backlight blooms — the same olive LCD the toolbar pill
 *          wears — and the J reads as lit rather than printed.
 *   1.25s  the click wheel spins up: a light arc sweeps once around the ring.
 *   1.45s  settle. the chord blooms (playIntroStinger), the wordmark springs,
 *          the EQ starts dancing, progress runs.
 *
 * WHY CANVAS: a pixel-art mark deserves a pixel-native reveal. Reading the
 * bitmap once and compositing cells is one draw call per frame with no DOM
 * churn, and it scales with the art instead of faking it with masks.
 *
 * ACCESSIBILITY: prefers-reduced-motion jumps straight to the settled frame —
 * no sweep, no ignition, no shake.
 */

import { useEffect, useRef, useState } from 'react'
import logoUrl from '../assets/jaketunes-logo.png'
import wordmarkUrl from '../assets/jaketunes-wordmark.png'
import { playIntroStinger } from '../utils/introStinger'

const STAGES = [
  'Reading your library…',
  'Loading playlists…',
  'Building artwork index…',
  'Tuning the amps…',
  'Almost there…',
]

// Boot choreography, ms from mount. The stinger's chord blooms at ~0.9s, so
// assembly finishes just before it and the settle lands on the bloom.
const T_POWER_ON = 150     // scanline expand completes
const T_ASSEMBLE = 1050    // last pixel cell lands
const T_BACKLIT = 1250     // screen glow full
const T_WHEEL = 1450       // wheel sweep completes
const CELL = 9             // reveal grid, CSS px — reads as chunky pixels
const IGNITE_MS = 190      // per-cell flash decay

function getGreeting(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'Good morning, Jake.'
  if (h >= 12 && h < 17) return 'Good afternoon, Jake.'
  if (h >= 17 && h < 22) return 'Good evening, Jake.'
  return 'Burning the midnight oil, Jake.'
}

/** Deterministic per-cell jitter so the sweep edge is ragged, not a ruler. */
function hash01(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

interface Props {
  /** True when App.tsx's load chain settles: progress snaps to 100%. */
  isReady: boolean
}

export default function SplashScreen({ isReady }: Props) {
  const [stageIdx, setStageIdx] = useState(0)
  const [progress, setProgress] = useState(5)
  const [greeting] = useState(getGreeting)
  const [phase, setPhase] = useState<'boot' | 'settled'>('boot')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => { playIntroStinger() }, [])

  // ── the boot itself ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const SIZE = 240
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = SIZE * dpr
    canvas.height = SIZE * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.imageSmoothingEnabled = false   // pixel art stays pixel art

    let raf = 0
    let cancelled = false
    const img = new Image()
    img.src = logoUrl
    img.onload = () => {
      if (cancelled) return
      // Bake the mark once at display size; every frame composites from here.
      const off = document.createElement('canvas')
      off.width = SIZE
      off.height = SIZE
      const octx = off.getContext('2d')
      if (!octx) return
      octx.imageSmoothingEnabled = false
      octx.drawImage(img, 0, 0, SIZE, SIZE)

      const cols = Math.ceil(SIZE / CELL)
      const rows = Math.ceil(SIZE / CELL)
      // Per-cell arrival time along a diagonal sweep + jitter.
      const arrival: number[] = new Array(cols * rows)
      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          const diag = (gx / cols) * 0.55 + (gy / rows) * 0.45
          arrival[gy * cols + gx] = Math.min(0.999, diag * 0.86 + hash01(gx, gy) * 0.14)
        }
      }

      if (reduce) {
        ctx.clearRect(0, 0, SIZE, SIZE)
        ctx.drawImage(off, 0, 0)
        setPhase('settled')
        return
      }

      const start = performance.now()
      const draw = (now: number): void => {
        if (cancelled) return
        const t = now - start
        ctx.clearRect(0, 0, SIZE, SIZE)

        // 0. The dark "screen off" plate the device ignites against. Without
        //    it the boot was invisible — the splash field is warm off-white,
        //    so a cream power-on line drew cream-on-cream (caught on the
        //    first screencast, 2026-08-08).
        const plateFade = Math.min(1, Math.max(0, (t - (T_ASSEMBLE - 220)) / 420))
        if (plateFade < 1) {
          ctx.save()
          ctx.globalAlpha = 1 - plateFade
          const r = SIZE * 0.19
          ctx.fillStyle = '#241109'
          ctx.beginPath()
          ctx.roundRect(SIZE * 0.06, SIZE * 0.06, SIZE * 0.88, SIZE * 0.88, r)
          ctx.fill()
          ctx.restore()
        }

        // 1. Power-on scanline: a hot orange line that snaps on and expands.
        if (t < T_POWER_ON) {
          const p = t / T_POWER_ON
          const h = Math.max(2, SIZE * 0.88 * p * p)
          const g = ctx.createLinearGradient(0, (SIZE - h) / 2, 0, (SIZE + h) / 2)
          g.addColorStop(0, 'rgba(233, 64, 2, 0)')
          g.addColorStop(0.5, `rgba(255, 178, 92, ${0.95 - p * 0.25})`)
          g.addColorStop(1, 'rgba(233, 64, 2, 0)')
          ctx.fillStyle = g
          ctx.fillRect(SIZE * 0.06, (SIZE - h) / 2, SIZE * 0.88, h)
          raf = requestAnimationFrame(draw)
          return
        }

        // 2. Assembly: reveal cells whose arrival time has passed, and flash
        //    each one as it lands.
        const ap = Math.min(1, (t - T_POWER_ON) / (T_ASSEMBLE - T_POWER_ON))
        const eased = 1 - Math.pow(1 - ap, 2)
        for (let gy = 0; gy < rows; gy++) {
          for (let gx = 0; gx < cols; gx++) {
            const a = arrival[gy * cols + gx]
            if (eased < a) continue
            const x = gx * CELL
            const y = gy * CELL
            ctx.drawImage(off, x, y, CELL, CELL, x, y, CELL, CELL)
            // ignition flash, decaying
            const sinceLanded = (eased - a) * (T_ASSEMBLE - T_POWER_ON)
            if (sinceLanded < IGNITE_MS) {
              const f = 1 - sinceLanded / IGNITE_MS
              ctx.fillStyle = `rgba(255, 246, 222, ${0.75 * f * f})`
              ctx.fillRect(x, y, CELL, CELL)
            }
          }
        }

        // 3. Backlight bloom over the screen window (upper third of the mark).
        if (t > T_ASSEMBLE - 120) {
          const bp = Math.min(1, (t - (T_ASSEMBLE - 120)) / (T_BACKLIT - (T_ASSEMBLE - 120)))
          const sx = SIZE * 0.30, sy = SIZE * 0.15, sw = SIZE * 0.40, sh = SIZE * 0.28
          const g = ctx.createRadialGradient(sx + sw / 2, sy + sh / 2, 2, sx + sw / 2, sy + sh / 2, sw)
          g.addColorStop(0, `rgba(246, 252, 205, ${0.42 * bp})`)
          g.addColorStop(1, 'rgba(246, 252, 205, 0)')
          ctx.fillStyle = g
          ctx.fillRect(sx - sw * 0.4, sy - sh * 0.5, sw * 1.8, sh * 2.2)
        }

        if (t < T_WHEEL + 260) raf = requestAnimationFrame(draw)
        else { ctx.clearRect(0, 0, SIZE, SIZE); ctx.drawImage(off, 0, 0); setPhase('settled') }
      }
      raf = requestAnimationFrame(draw)
    }
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }, [])

  useEffect(() => {
    if (isReady) return
    const id = window.setInterval(() => setStageIdx(i => (i + 1) % STAGES.length), 480)
    return () => window.clearInterval(id)
  }, [isReady])

  useEffect(() => {
    let rafId = 0
    const start = performance.now()
    const from = progress
    const to = isReady ? 100 : 92
    const duration = isReady ? 320 : 2600
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setProgress(from + (to - from) * eased)
      if (t < 1) rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  const statusText = isReady ? 'Ready.' : STAGES[stageIdx]

  return (
    <div className={`app-splash app-splash--boot app-splash--${phase}`}>
      <div className="app-splash-bg-glow" />
      <div className="app-splash-inner">
        <div className="app-splash-stage" aria-hidden="true">
          {/* The device. Canvas paints the assembly; the ring and scanline
              overlays sit on top so they can bloom independently. */}
          <canvas ref={canvasRef} className="app-splash-canvas" width={240} height={240} />
          <div className="app-splash-scanlines" />
          <div className="app-splash-wheel-sweep" />
          <div className="app-splash-device-glow" />
        </div>
        {/* The wordmark IS the logo's wordmark — the same pixels lifted off
            the device's screen (Jake: "the text below the ipod logo needs to
            match the wordmark in the logo"), recolored to brand orange so it
            reads on the light field. */}
        <img src={wordmarkUrl} alt="jaketunes" className="app-splash-wordmark-img" />
        <div className="app-splash-tagline">The greatest music platform ever built.</div>
        <div className="app-splash-greeting">{greeting}</div>
        <div className="app-splash-eq" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <div
              key={i}
              className="app-splash-eq-bar"
              style={{ animationDelay: `${1.55 + i * 0.11}s`, animationDuration: `${0.78 + (i % 3) * 0.14}s` }}
            />
          ))}
        </div>
        <div className="app-splash-progress">
          <div className="app-splash-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="app-splash-status">{statusText}</div>
      </div>
    </div>
  )
}
