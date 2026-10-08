/**
 * THE COLD BOOT — retargeted to the 2.0 mark (2026-08-09).
 *
 * The app doesn't fade a logo in; it powers the mark on, and the animation is
 * driven by the logo's own pixels rather than by CSS on a rectangle:
 *
 *   0.00s  dark. a single scanline snaps on and expands — CRT/LCD power-on.
 *   0.15s  the mark COMES INTO FOCUS: the real logo bitmap, drawn smooth
 *          (anti-aliased from the 1024px art), resolves out of a soft blur
 *          while it scales up a hair and a warm sheen passes over it. One
 *          continuous motion — no grid, no cells. (2026-09-02: the 2.0 boot
 *          assembled the tile from 9px cells with per-cell ignition flashes
 *          and a CRT scanline overlay; Jake: "a little blocky for some
 *          reason… deserves to be more elegant". It was blocky on purpose,
 *          and the purpose was wrong.)
 *   1.05s  the NOTE lights: a bloom rises off the glyph itself, so the note
 *          reads as struck-and-ringing rather than printed.
 *   1.45s  settle. the chord blooms (playIntroStinger), the wordmark springs,
 *          the EQ starts dancing, progress runs.
 *
 * ⚠️ WHY THE GLYPH IS MEASURED, NOT HARDCODED. The 5.0 version of this file
 * was written around the OLD mark (a pixel iPod) and carried its anatomy as
 * magic numbers: a bloom pinned to the rect where that device's SCREEN sat,
 * and a light arc sweeping its CLICK WHEEL. When the mark became a music note
 * both aimed at nothing — a cream smudge and a spinning ring floating over
 * solid orange. So the bloom now finds the glyph at load time by flooding the
 * outer paper from the border (see markGlyph) and lighting whatever bright
 * shape is left. Change the logo again and this follows it.
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
const T_LIT = 1250         // the note's bloom reaches full
const T_SETTLE = 1450      // boot complete, hand off to the settled frame
const FOCUS_BLUR_PX = 7    // how soft the mark starts before it resolves
const FOCUS_SCALE = 0.955  // how far in it starts before settling at 1

/** The dark "screen off" field the mark ignites against. Matches the shape of
 *  the art exactly: since brand/make-icons.py the in-app mark is a full-canvas
 *  tile with only its corners cut away, on the same squircle proportion Apple
 *  uses (0.225 of the side). Any mismatch here shows as a dark fringe peeking
 *  out from behind the tile during assembly. */
const PLATE_INK = '#261208'
const PLATE_INSET = 0
const PLATE_RADIUS = 0.225

function getGreeting(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'Good morning, Jake.'
  if (h >= 12 && h < 17) return 'Good afternoon, Jake.'
  if (h >= 17 && h < 22) return 'Good evening, Jake.'
  return 'Burning the midnight oil, Jake.'
}

interface Glyph { cx: number; cy: number; w: number; h: number }

/**
 * Where the light part of the mark actually IS, measured off the baked bitmap.
 *
 * The logo is a bright glyph on a coloured tile, sitting on white paper. Both
 * the glyph and the paper are bright, so a plain brightness threshold finds
 * both. The paper is the part that TOUCHES THE BORDER, though — so flooding
 * bright pixels inward from every edge marks the paper, and whatever bright
 * pixels are left over are the glyph. That distinction is topological rather
 * than positional, which is the whole point: it holds for any mark, at any
 * size, without knowing what the mark depicts.
 *
 * Runs once on load over a 240² buffer, so the flood is trivial.
 * Returns null when nothing enclosed is bright (a mark with no light glyph),
 * and the caller simply skips the bloom rather than lighting a guess.
 */
function markGlyph(px: Uint8ClampedArray, size: number): Glyph | null {
  const bright = new Uint8Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    const min = Math.min(px[o], px[o + 1], px[o + 2])
    bright[i] = min > 170 && px[o + 3] > 128 ? 1 : 0
  }
  // Flood the outer paper in from the border.
  const paper = new Uint8Array(size * size)
  const stack: number[] = []
  const push = (i: number): void => { if (bright[i] && !paper[i]) { paper[i] = 1; stack.push(i) } }
  for (let x = 0; x < size; x++) { push(x); push((size - 1) * size + x) }
  for (let y = 0; y < size; y++) { push(y * size); push(y * size + size - 1) }
  while (stack.length) {
    const i = stack.pop() as number
    const x = i % size, y = (i / size) | 0
    if (x > 0) push(i - 1)
    if (x < size - 1) push(i + 1)
    if (y > 0) push(i - size)
    if (y < size - 1) push(i + size)
  }
  let minX = size, minY = size, maxX = -1, maxY = -1, sx = 0, sy = 0, n = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      if (!bright[i] || paper[i]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      sx += x; sy += y; n++
    }
  }
  if (n < size * 2) return null   // no meaningful enclosed glyph
  return { cx: sx / n, cy: sy / n, w: maxX - minX + 1, h: maxY - minY + 1 }
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
    ctx.imageSmoothingEnabled = true    // the 1024px art downsamples smooth — no blocks
    ctx.imageSmoothingQuality = 'high'

    let raf = 0
    let cancelled = false
    const img = new Image()
    img.src = logoUrl
    img.onload = () => {
      if (cancelled) return
      // Bake the mark once at display size; every frame composites from here.
      // Baked at device resolution so the settled frame is crisp on Retina.
      const off = document.createElement('canvas')
      off.width = SIZE * dpr
      off.height = SIZE * dpr
      const octx = off.getContext('2d')
      if (!octx) return
      octx.imageSmoothingEnabled = true
      octx.imageSmoothingQuality = 'high'
      octx.drawImage(img, 0, 0, SIZE * dpr, SIZE * dpr)
      const drawMark = (): void => { ctx.drawImage(off, 0, 0, SIZE, SIZE) }

      // Find the glyph now, off the same buffer every frame composites from,
      // so the bloom can never drift from the art it is lighting.
      let glyph: Glyph | null = null
      try {
        // Measure off a CSS-pixel copy so the glyph box is in draw units.
        const m = document.createElement('canvas')
        m.width = SIZE; m.height = SIZE
        const mctx = m.getContext('2d')
        if (mctx) { mctx.drawImage(img, 0, 0, SIZE, SIZE); glyph = markGlyph(mctx.getImageData(0, 0, SIZE, SIZE).data, SIZE) }
      } catch { glyph = null }   // tainted canvas: skip the bloom, keep the boot

      if (reduce) {
        ctx.clearRect(0, 0, SIZE, SIZE)
        drawMark()
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
          const inset = SIZE * PLATE_INSET
          ctx.fillStyle = PLATE_INK
          ctx.beginPath()
          ctx.roundRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2, SIZE * PLATE_RADIUS)
          ctx.fill()
          ctx.restore()
        }

        // 1. Power-on scanline: a hot orange line that snaps on and expands.
        if (t < T_POWER_ON) {
          const p = t / T_POWER_ON
          const h = Math.max(2, SIZE * 0.88 * p * p)
          const g = ctx.createLinearGradient(0, (SIZE - h) / 2, 0, (SIZE + h) / 2)
          g.addColorStop(0, 'rgba(254, 90, 1, 0)')
          g.addColorStop(0.5, `rgba(255, 149, 92, ${0.95 - p * 0.25})`)
          g.addColorStop(1, 'rgba(254, 90, 1, 0)')
          ctx.fillStyle = g
          ctx.fillRect(SIZE * PLATE_INSET, (SIZE - h) / 2, SIZE * (1 - PLATE_INSET * 2), h)
          raf = requestAnimationFrame(draw)
          return
        }

        // 2. Focus: the whole mark resolves out of a soft blur while it eases
        //    up from FOCUS_SCALE to 1 — one continuous, anti-aliased motion.
        //    A warm sheen (a soft diagonal band) passes over it once as it
        //    lands, so the tile reads as lit rather than switched on.
        const ap = Math.min(1, (t - T_POWER_ON) / (T_ASSEMBLE - T_POWER_ON))
        const eased = 1 - Math.pow(1 - ap, 3)
        const blur = FOCUS_BLUR_PX * (1 - eased)
        const scale = FOCUS_SCALE + (1 - FOCUS_SCALE) * eased
        ctx.save()
        ctx.globalAlpha = Math.min(1, ap * 1.6)
        ctx.filter = blur > 0.15 ? `blur(${blur.toFixed(2)}px)` : 'none'
        ctx.translate(SIZE / 2, SIZE / 2)
        ctx.scale(scale, scale)
        ctx.translate(-SIZE / 2, -SIZE / 2)
        drawMark()
        ctx.restore()
        if (ap > 0.35 && ap < 1) {
          // sheen: a soft light band sweeping top-left → bottom-right, clipped
          // to the tile's squircle so it never spills onto the paper.
          const sp = (ap - 0.35) / 0.65
          const x = -SIZE * 0.6 + sp * SIZE * 2.2
          const g = ctx.createLinearGradient(x, 0, x + SIZE * 0.55, SIZE * 0.55)
          g.addColorStop(0, 'rgba(255, 244, 220, 0)')
          g.addColorStop(0.5, `rgba(255, 244, 220, ${0.28 * Math.sin(sp * Math.PI)})`)
          g.addColorStop(1, 'rgba(255, 244, 220, 0)')
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.beginPath()
          ctx.roundRect(0, 0, SIZE, SIZE, SIZE * PLATE_RADIUS)
          ctx.clip()
          ctx.fillStyle = g
          ctx.fillRect(0, 0, SIZE, SIZE)
          ctx.restore()
        }

        // 3. The note lights. Centred on the glyph the loader measured, and
        //    reaching a little past it, so the light reads as coming OFF the
        //    note rather than sitting on top of it. Composited with 'lighter'
        //    so it brightens the mark instead of washing a pale film over it —
        //    on a hot orange field a normal-blend cream fill reads as haze.
        if (glyph && t > T_ASSEMBLE - 120) {
          const rise = Math.min(1, (t - (T_ASSEMBLE - 120)) / (T_LIT - (T_ASSEMBLE - 120)))
          // …and ease back out before the handoff. The settled frame is the
          // bare artwork, so a bloom still at full strength on the last drawn
          // frame would vanish between one frame and the next — a visible
          // blink right as the app appears.
          const fall = 1 - Math.min(1, Math.max(0, (t - T_SETTLE) / 260))
          const bp = rise * fall
          const reach = Math.max(glyph.w, glyph.h) * 0.85
          const g = ctx.createRadialGradient(glyph.cx, glyph.cy, 1, glyph.cx, glyph.cy, reach)
          g.addColorStop(0, `rgba(255, 244, 214, ${0.5 * bp})`)
          g.addColorStop(0.45, `rgba(255, 196, 132, ${0.22 * bp})`)
          g.addColorStop(1, 'rgba(255, 196, 132, 0)')
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(glyph.cx, glyph.cy, reach, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }

        if (t < T_SETTLE + 260) raf = requestAnimationFrame(draw)
        else { ctx.clearRect(0, 0, SIZE, SIZE); drawMark(); setPhase('settled') }
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
          {/* Canvas paints the assembly and the note's own light; the scanline
              and halo overlays sit on top so they can bloom independently.
              (A click-wheel sweep used to live here too — it belonged to the
              old iPod mark and had nothing to sweep once the mark became a
              note.) */}
          <canvas ref={canvasRef} className="app-splash-canvas" width={240} height={240} />
          {/* (The CRT scanline overlay is gone with the cell assembly — it was
              the other half of the blockiness.) */}
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
