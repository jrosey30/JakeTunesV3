/**
 * Concert posters — the full live concerts, on the wall instead of in
 * the bins (Jake: "live concerts instead of vinyls should be posters on
 * the wall somewhere. make em look like real posters too without
 * changing their design").
 *
 * A poster is a sheet of paper: the concert's own artwork, untouched, on
 * the top two-thirds, and under it the facts a gig poster prints — the
 * act, the venue, the city, the date — set in the shop's own type. Every
 * word comes from the concert's grounded metadata; nothing is invented.
 * Taped up at the corners, a hair off the wall, each one a touch crooked.
 */
import * as THREE from 'three'

export interface PosterFacts {
  artist: string
  title: string
  venue?: string
  city?: string
  date?: string
  coverUrl: string | null
}

export const POSTER_W = 0.9
export const POSTER_H = 1.35
const PX = 600                          // texture width; height follows the aspect

export interface Poster {
  group: THREE.Group
  dispose: () => void
}

function drawPoster(facts: PosterFacts, art: CanvasImageSource | null): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = PX
  c.height = Math.round(PX * POSTER_H / POSTER_W)
  const g = c.getContext('2d')!
  // Paper.
  g.fillStyle = '#efe7d6'
  g.fillRect(0, 0, c.width, c.height)
  const grain = g.createLinearGradient(0, 0, 0, c.height)
  grain.addColorStop(0, 'rgba(0,0,0,0)')
  grain.addColorStop(1, 'rgba(0,0,0,0.06)')
  g.fillStyle = grain
  g.fillRect(0, 0, c.width, c.height)

  // The art, full width less a margin, square, at the top. Untouched.
  const m = 36
  const artW = c.width - m * 2
  if (art) g.drawImage(art, m, m, artW, artW)
  else { g.fillStyle = '#d8cbb0'; g.fillRect(m, m, artW, artW) }

  // The print under it.
  const font = (px: number, weight = 'bold'): string => `${weight} ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`
  const fit = (text: string, px: number, weight: string, maxW: number): number => {
    let size = px
    g.font = font(size, weight)
    while (size > 18 && g.measureText(text).width > maxW) { size -= 2; g.font = font(size, weight) }
    return size
  }
  g.fillStyle = '#1a1714'
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  let y = m + artW + 78
  const line = (text: string, px: number, weight = 'bold', gap = 1.15): void => {
    if (!text) return
    const size = fit(text, px, weight, c.width - m * 2)
    g.fillText(text, c.width / 2, y)
    y += size * gap
  }
  line(facts.artist.toUpperCase(), 64)
  y += 4
  if (facts.venue) line(facts.venue.toUpperCase(), 34, '600')
  const where = [facts.city, facts.date].filter(Boolean).join('  ·  ')
  if (where) line(where, 26, '500', 1.3)
  else line(facts.title, 26, '500', 1.3)
  // A rule and the one word that says what this is.
  g.fillStyle = '#1a1714'
  g.fillRect(m, c.height - 62, c.width - m * 2, 3)
  g.font = font(22, '700')
  g.fillText('LIVE', c.width / 2, c.height - 28)
  return c
}

export function buildPoster(facts: PosterFacts, tilt = 0, loader = new THREE.TextureLoader()): Poster {
  const group = new THREE.Group()
  const disposables: Array<{ dispose: () => void }> = []
  let alive = true

  const paper = new THREE.MeshLambertMaterial({ color: 0xffffff })
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(POSTER_W, POSTER_H), paper)
  sheet.position.z = 0.006
  group.add(sheet)
  disposables.push(paper, sheet.geometry)

  let tex = new THREE.CanvasTexture(drawPoster(facts, null))
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  paper.map = tex
  paper.needsUpdate = true

  if (facts.coverUrl) {
    loader.load(facts.coverUrl, (t) => {
      if (!alive) { t.dispose(); return }
      const next = new THREE.CanvasTexture(drawPoster(facts, t.image as CanvasImageSource))
      next.colorSpace = THREE.SRGBColorSpace
      next.anisotropy = 8
      t.dispose()
      tex.dispose()
      tex = next
      paper.map = next
      paper.needsUpdate = true
    }, undefined, () => { /* paper and print only */ })
  }

  // Tape: four short translucent strips across the corners.
  const tapeMat = new THREE.MeshLambertMaterial({ color: 0xe9dcb8, transparent: true, opacity: 0.72 })
  const tapeGeo = new THREE.PlaneGeometry(0.16, 0.05)
  disposables.push(tapeMat, tapeGeo)
  for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
    const tape = new THREE.Mesh(tapeGeo, tapeMat)
    tape.position.set(sx * (POSTER_W / 2 - 0.02), sy * (POSTER_H / 2 - 0.02), 0.009)
    tape.rotation.z = sx * sy * Math.PI / 4
    group.add(tape)
  }
  group.rotation.z = tilt

  return {
    group,
    dispose: () => {
      alive = false
      tex.dispose()
      for (const d of disposables) d.dispose()
    },
  }
}
