/**
 * Procedural surfaces — PS2 texturing without an asset pipeline.
 *
 * The era's look is low-poly geometry wearing small, honest textures, not
 * flat colour. Every material in the shop that isn't album art is drawn
 * here on a canvas at 256px and tiled, which keeps the bundle free of
 * image assets and lets the palette stay one place.
 */
import * as THREE from 'three'

function canvas(size = 256): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  return { c, g }
}

function finish(c: HTMLCanvasElement, repeat: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(repeat, repeat)
  t.anisotropy = 8
  return t
}

/** Seeded so the same crate looks the same every visit. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

/** Plank wood: a base tone, long-grain streaks with a slow wobble, a few
 *  darker knots. Stained dark for the bin, lighter for the counter. */
export function woodTexture(base: string, grain: string, seed = 7, repeat = 1): THREE.CanvasTexture {
  const { c, g } = canvas()
  const r = rng(seed)
  g.fillStyle = base
  g.fillRect(0, 0, 256, 256)
  g.globalAlpha = 0.55
  for (let i = 0; i < 70; i++) {
    const y = r() * 256
    const w = 0.6 + r() * 1.8
    g.strokeStyle = grain
    g.lineWidth = w
    g.beginPath()
    for (let x = 0; x <= 256; x += 8) {
      const yy = y + Math.sin((x / 256) * Math.PI * (1 + r() * 0.3) + i) * 2.2
      if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy)
    }
    g.stroke()
  }
  g.globalAlpha = 0.35
  for (let i = 0; i < 4; i++) {
    g.fillStyle = grain
    g.beginPath()
    g.ellipse(r() * 256, r() * 256, 3 + r() * 5, 1.5 + r() * 2.5, r() * Math.PI, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
  return finish(c, repeat)
}

/** Kraft card: tan with fibre speckle. Sleeve backs, spines, dividers. */
export function kraftTexture(tone = '#b9a07a', seed = 11): THREE.CanvasTexture {
  const { c, g } = canvas()
  const r = rng(seed)
  g.fillStyle = tone
  g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 2600; i++) {
    const v = r()
    g.fillStyle = v < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.08)'
    g.fillRect(r() * 256, r() * 256, 1 + r() * 1.5, 1)
  }
  return finish(c, 1)
}

/** Painted plaster with a faint tooth, for walls. */
export function plasterTexture(tone: string, seed = 3): THREE.CanvasTexture {
  const { c, g } = canvas()
  const r = rng(seed)
  g.fillStyle = tone
  g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)'
    g.fillRect(r() * 256, r() * 256, 2, 2)
  }
  return finish(c, 4)
}

/** Floorboards: wood with a plank seam every 32px, turned so the boards
 *  run front-to-back. `repeat` sets the plank width: the tile is 8 boards,
 *  so on a 14 m floor repeat 14 gives 12 cm boards — real, not tabletop. */
export function floorboardTexture(seed = 5, repeat = 14): THREE.CanvasTexture {
  const t = woodTexture('#5a5348', '#433d35', seed, repeat)
  const c = t.image as HTMLCanvasElement
  const g = c.getContext('2d')!
  g.fillStyle = 'rgba(0,0,0,0.35)'
  for (let y = 0; y < 256; y += 32) g.fillRect(0, y, 256, 1.5)
  t.center.set(0.5, 0.5)
  t.rotation = Math.PI / 2
  t.needsUpdate = true
  return t
}

/** A printed tab label: black type on index card. Drawn wide so the
 *  0.20 × 0.07 tab shows it at the right aspect. */
export function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 180
  const g = c.getContext('2d')!
  g.fillStyle = '#ece6d6'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#1c1a17'
  g.font = 'bold 118px "Helvetica Neue", Helvetica, Arial, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, c.width / 2, c.height / 2 + 6)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

/** Soft contact shadow: a blurred dark rectangle on a transparent tile,
 *  laid under furniture. The PS2 way — no shadow maps, one decal. */
export function contactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')!
  g.clearRect(0, 0, 256, 256)
  g.filter = 'blur(22px)'
  g.fillStyle = 'rgba(0,0,0,0.9)'
  g.fillRect(48, 48, 160, 160)
  g.filter = 'none'
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
