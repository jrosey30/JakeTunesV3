/**
 * Classic Cover Flow geometry (launch page "G", 2026-10-18) — the Island
 * Albums row on the art-soaked Home backdrop. iTunes 7's side-scroll, not the
 * Albums view's jukebox arc: the chosen cover faces you, the rest stand
 * turned on either side, each step further out tucked closer to its
 * neighbour.
 *
 * Numbers are the approved mockup's (D-Desktop): a 240 px centre cover 12 px
 * from the top, 190 px side covers 37 px down, turned 62°, the first side
 * cover's centre 175 px from the middle and each further one 70 px on.
 *
 * Pure. The renderer draws every cover as a CENTRE-SIZED box and moves it
 * with one transform — translate3d(tx, ty) rotateY(rotateY) scale(scale) —
 * so a change of cover animates on the compositor (transform only, ~0.55 s),
 * with the scale shrinking the box around its own centre.
 */

export interface CoverFlowOptions {
  /** Width of the stage the flow is centred in, px. */
  width: number
  centerSize?: number
  sideSize?: number
  centerTop?: number
  sideTop?: number
  /** Distance from the stage centre to the first side cover's centre. */
  firstGap?: number
  /** Each further side cover sits this much further out. */
  step?: number
  /** Side covers' turn, degrees. */
  angle?: number
}

export interface CoverPose {
  index: number
  /** index − active: < 0 left of centre, > 0 right. */
  offset: number
  /** The cover as drawn: its left / top edge and side, px. */
  left: number
  top: number
  size: number
  /** For a centre-sized box at (0, 0): translate by (tx, ty), turn, scale. */
  tx: number
  ty: number
  scale: number
  rotateY: number
  zIndex: number
  /** Any part of it lands on the stage. */
  onStage: boolean
}

export const COVER_FLOW_DEFAULTS = {
  centerSize: 240,
  sideSize: 190,
  centerTop: 12,
  sideTop: 37,
  firstGap: 175,
  step: 70,
  angle: 62,
} as const

export function clampCoverIndex(index: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(count - 1, Math.round(index)))
}

/** One step left (−1) or right (+1); stops at the ends (no wrap — the row is ranked). */
export function stepCover(active: number, delta: number, count: number): number {
  return clampCoverIndex(active + delta, count)
}

/** ←/→ → −1/+1; anything else 0. */
export function coverFlowKeyDelta(key: string): -1 | 0 | 1 {
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  return 0
}

export function coverFlowPoses(count: number, active: number, opts: CoverFlowOptions): CoverPose[] {
  const o = { ...COVER_FLOW_DEFAULTS, ...opts }
  const at = clampCoverIndex(active, count)
  const mid = o.width / 2
  const poses: CoverPose[] = []
  for (let i = 0; i < count; i++) {
    const offset = i - at
    const d = Math.abs(offset)
    let left: number
    let top: number
    let size: number
    let rotateY: number
    if (offset === 0) {
      size = o.centerSize
      left = mid - size / 2
      top = o.centerTop
      rotateY = 0
    } else {
      size = o.sideSize
      left = mid + Math.sign(offset) * (o.firstGap + (d - 1) * o.step) - size / 2
      top = o.sideTop
      // Left-hand covers turn their faces right, toward the centre; and back.
      rotateY = offset < 0 ? o.angle : -o.angle
    }
    const scale = size / o.centerSize
    const shrink = (o.centerSize - size) / 2
    poses.push({
      index: i,
      offset,
      left,
      top,
      size,
      tx: left - shrink,
      ty: top - shrink,
      scale,
      rotateY,
      zIndex: 100 - d,
      onStage: left + size > 0 && left < o.width,
    })
  }
  return poses
}
