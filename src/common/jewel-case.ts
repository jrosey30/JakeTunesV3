/**
 * The Island Albums jewel case (Jake, 2026-10-21: "was hoping the cd
 * animation would be for all devices involved here not just phone") — the
 * Home Cover Flow's front cover sits in a CD jewel case; click it and the lid
 * pops off its latch, swings open on its left hinge, the disc lifts off the
 * hub and the album page comes out of the disc. Back from that page, the page
 * shrinks into the disc, the disc drops onto the hub and the lid snaps shut.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/LaunchPageG.swift — `JewelCase`,
 * `CaseLid`, `FlowCaseTray` and `IslandCoverFlow.tap` (Mobile PR #519, "Spec
 * for the desktop twin"). Every number below is the phone's, in its points
 * with the cover = 160; the desktop scales by its cover / 160. Change one
 * side, change the other.
 *
 * Pure: geometry, the lid's angle over time (latch pop → spring swing →
 * settle; the accelerating snap shut), and what each angle looks like (which
 * face shows, the shading, the lid's shadow on the tray, the gloss, the
 * reflection). The renderer (components/JewelCase.tsx) samples these into
 * Web Animations keyframes — transform/opacity only, run by the compositor,
 * no per-frame JS.
 *
 * Angles here are the phone's: 0 shut … 108 open. CSS rotateY(θ) about the
 * lid's LEFT edge maps a point x along the lid to depth −x·sin θ (+z toward
 * the viewer), so the CSS angle is the NEGATIVE: rotateY(−108deg) brings the
 * free edge toward you and over to the left, like a book cover.
 */

/** The phone's case, in its points (cover = 160). */
export const JEWEL_CASE = {
  art: 160,
  /** Ribbed hinge strip on the LEFT. */
  spine: 9,
  /** Clear rim on the top, right and bottom. */
  rim: 2.5,
  /** The plastic's corner radius. */
  radius: 2.5,
  /** Open angle: past 90° you see the inside of the lid. */
  openAngle: 108,
  /** Camera distance from the case plane … */
  camera: 800,
  /** … and its height below the case's top edge (x is the art's centre). */
  cameraY: 25,
  disc: 150,
  /** Disc radii, centre out: hole | clear ring | mirror band | label | data ring. */
  discRadii: { hole: 9.5, clear: 17, mirror: 24, label: 62, outer: 75 },
  /** Booklet tabs on the lid's free edge: size and centres (fraction of the case height). */
  tab: { w: 7, h: 17, at: [0.27, 0.73] as const },
  /** Hinge knuckles on the base's spine: size, and y of the top one (the bottom one is h − 13). */
  knuckle: { w: 3, h: 11, top: 2, bottomFromEnd: 13 },
  /** Ribs: 0.5 wide every 1.8, from x = 2 to spine − 1.5. */
  ribs: { from: 2, endInset: 1.5, every: 1.8, width: 0.5 },
  /** Rosette hub: frame, prong ring radii, centre button diameter, slits. */
  rosette: { frame: 28, outer: 12, inner: 4.5, button: 7, slits: 8 },
  /** Finger notches (a capsule across the tray) and the disc's recess. */
  notch: { inset: 4, h: 34 },
  recessExtra: 4,
} as const

/** The phone's motion (IslandCoverFlow.tap / .onChange(of: openAlbum)). */
export const JEWEL_CASE_MOTION = {
  /** Latch pop: 0 → 10° in 80 ms, easeOut. */
  latchAngle: 10,
  latchMs: 80,
  /** The swing takes over mid-pop at +50 ms, inheriting the pop's velocity … */
  swingStartMs: 50,
  /** … a spring (response 0.34 s, damping 0.74, mass 1) to the open angle. */
  springResponse: 0.34,
  springDamping: 0.74,
  /** The disc lifts off the hub: +0.24 s, 0.15 s easeOut. */
  liftStartMs: 240,
  liftMs: 150,
  liftScale: 1.06,
  /** Lift: up 2, shadow radius 1.5 → 8 and y 1 → 5 (black 55%), phone points. */
  liftDy: -2,
  shadowRest: { radius: 1.5, y: 1 },
  shadowLifted: { radius: 8, y: 5 },
  /** The album page comes out of the disc. */
  navigateAtMs: 390,
  /** Back: the page shrinks into the disc (the phone's zoom back) … */
  returnMorphMs: 260,
  /** … the disc drops onto the hub at +0.26 s (0.10 s easeIn) … */
  dropAtMs: 260,
  dropMs: 100,
  /** … and the lid swings shut from +0.34 s over 0.24 s, accelerating, no bounce. */
  snapAtMs: 340,
  snapMs: 240,
  snapCurve: [0.55, 0, 0.9, 0.5] as const,
} as const

/** Desktop-only: the View Transition between the disc and the album page. */
export const DISC_HANDOFF_TIMING = {
  /** Disc → the album page's cover. */
  morphMs: 420,
  /** Longest wait for the destination's image to LOAD inside the transition (discHandoff.destinationReady). */
  readyCapMs: 180,
} as const

/** SwiftUI's .easeOut / .easeIn. */
export const EASE_OUT = [0, 0, 0.58, 1] as const
export const EASE_IN = [0.42, 0, 1, 1] as const

/** A cubic-bezier easing as a function of progress 0…1 (CSS semantics). */
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number): (x: number) => number {
  const bx = (t: number): number => ((1 - 3 * p2x + 3 * p1x) * t + (3 * p2x - 6 * p1x)) * t * t + 3 * p1x * t
  const by = (t: number): number => ((1 - 3 * p2y + 3 * p1y) * t + (3 * p2y - 6 * p1y)) * t * t + 3 * p1y * t
  const dbx = (t: number): number => 3 * (1 - 3 * p2x + 3 * p1x) * t * t + 2 * (3 * p2x - 6 * p1x) * t + 3 * p1x
  return (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 8; i++) {
      const d = dbx(t)
      if (Math.abs(d) < 1e-6) break
      const next = t - (bx(t) - x) / d
      if (next < 0 || next > 1) break
      t = next
    }
    // Bisection polish (Newton can stall on flat ends).
    let lo = 0
    let hi = 1
    for (let i = 0; i < 30 && Math.abs(bx(t) - x) > 1e-7; i++) {
      if (bx(t) < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return by(t)
  }
}

const easeOut = cubicBezier(...EASE_OUT)
const snapEase = cubicBezier(...JEWEL_CASE_MOTION.snapCurve)

/** The latch pop alone: degrees at `ms` after the click. */
function latchAt(ms: number): number {
  const m = JEWEL_CASE_MOTION
  return m.latchAngle * easeOut(Math.min(1, Math.max(0, ms / m.latchMs)))
}

/**
 * The lid's angle while opening, `ms` after the click: the latch pop, taken
 * over at +50 ms by an underdamped spring that starts from the pop's angle and
 * velocity and overshoots the hinge stop by ~3° before it settles.
 */
export function lidAngleOpening(ms: number, open: number = JEWEL_CASE.openAngle): number {
  const m = JEWEL_CASE_MOTION
  if (ms <= m.swingStartMs) return latchAt(Math.max(0, ms))
  const h = 0.5
  const x0 = latchAt(m.swingStartMs) - open
  const v0 = ((latchAt(m.swingStartMs + h) - latchAt(m.swingStartMs - h)) / (2 * h)) * 1000 // °/s
  const w0 = (2 * Math.PI) / m.springResponse
  const z = m.springDamping
  const wd = w0 * Math.sqrt(1 - z * z)
  const t = (ms - m.swingStartMs) / 1000
  const b = (v0 + z * w0 * x0) / wd
  return open + Math.exp(-z * w0 * t) * (x0 * Math.cos(wd * t) + b * Math.sin(wd * t))
}

/** The lid's angle while snapping shut, `ms` after the snap starts: accelerating, ending at speed. */
export function lidAngleClosing(ms: number, from: number = JEWEL_CASE.openAngle): number {
  const p = Math.min(1, Math.max(0, ms / JEWEL_CASE_MOTION.snapMs))
  return from * (1 - snapEase(p))
}

/** Depth of a point `x` from the hinge after CSS rotateY(cssDeg): > 0 = toward the viewer. */
export function lidPointDepth(cssDeg: number, x: number): number {
  return -x * Math.sin((cssDeg * Math.PI) / 180)
}

/** The CSS rotateY for a phone angle (0 shut … 108 open): opening is NEGATIVE. */
export function cssLidAngle(deg: number): number {
  return deg === 0 ? 0 : -deg
}

export interface LidLook {
  /** The camera is behind the lid's plane: you see its inside (paper + tabs). */
  inside: boolean
  /** Black over the outside face, 0…0.36 — it dims as it turns away. */
  frontShade: number
  /** Black over the inside face, 0…0.16 — the paper must still read as paper. */
  insideShade: number
  /** The lid's shadow on the tray, from the hinge: width as a fraction of the case, and its opacity. */
  shadowWidth: number
  shadowOpacity: number
  /** Where the gloss streak's peak sits along the diagonal, 0.30 → 0.65 as the lid goes 0 → 90°. */
  glossAt: number
  /** The shut cover's reflection under the case. */
  reflection: number
}

/** What the lid looks like at `deg` (phone angle), with the phone's camera on the art's centre. */
export function lidLook(deg: number): LidLook {
  const c = JEWEL_CASE
  const t = (deg * Math.PI) / 180
  const s = Math.sin(t)
  const co = Math.cos(t)
  const cx = c.spine + c.art / 2
  const inside = co - (cx * s) / c.camera < 0
  return {
    inside,
    frontShade: 0.36 * (1 - Math.max(0, co)),
    insideShade: 0.16 * (1 - Math.max(0, -co)),
    shadowWidth: Math.min(1, Math.max(0, co + s * 0.36)),
    shadowOpacity: Math.min(1, Math.max(0, deg / 12)),
    glossAt: 0.3 + 0.35 * Math.min(1, Math.max(0, deg / 90)),
    reflection: Math.max(0, 1 - deg / 45),
  }
}

export interface LidFrame extends LidLook {
  /** ms from the start of the motion. */
  t: number
  /** Phone angle. */
  deg: number
}

/** The lid's motion as frames every `stepMs`: opening runs until it has settled. */
export function lidOpeningFrames(stepMs = 10, untilMs = 520): LidFrame[] {
  const out: LidFrame[] = []
  for (let t = 0; t <= untilMs + 1e-9; t += stepMs) {
    const deg = lidAngleOpening(t)
    out.push({ t, deg, ...lidLook(deg) })
  }
  return out
}

/** The snap shut as frames every `stepMs`, from the open angle to 0. */
export function lidClosingFrames(stepMs = 10): LidFrame[] {
  const out: LidFrame[] = []
  const end = JEWEL_CASE_MOTION.snapMs
  for (let t = 0; t < end; t += stepMs) {
    const deg = lidAngleClosing(t)
    out.push({ t, deg, ...lidLook(deg) })
  }
  out.push({ t: end, deg: 0, ...lidLook(0) })
  return out
}

/** The open, settled pose (where the reverse starts). */
export function lidOpenLook(): LidFrame {
  const deg = JEWEL_CASE.openAngle
  return { t: 0, deg, ...lidLook(deg) }
}

export interface JewelCaseGeometry {
  scale: number
  art: number
  spine: number
  rim: number
  radius: number
  width: number
  height: number
  /** perspective + perspective-origin for the lid, from the case's top-left (the hinge is x = 0). */
  camera: number
  cameraX: number
  cameraY: number
  disc: number
}

/** The case around a front cover `artPx` square: the art keeps its place, the case grows out around it. */
export function jewelCaseGeometry(artPx: number): JewelCaseGeometry {
  const c = JEWEL_CASE
  const k = artPx / c.art
  const spine = c.spine * k
  const rim = c.rim * k
  return {
    scale: k,
    art: artPx,
    spine,
    rim,
    radius: c.radius * k,
    width: spine + artPx + rim,
    height: artPx + 2 * rim,
    camera: c.camera * k,
    cameraX: spine + artPx / 2,
    cameraY: c.cameraY * k,
    disc: c.disc * k,
  }
}

// ── the disc ↔ album page handoff ────────────────────────────────────────

/** Where the main pane is: the view, and the album key when it's an album page. */
export interface HandoffLoc {
  view: string
  albumKey: string | null
}

export function sameHandoffLoc(a: HandoffLoc, b: HandoffLoc): boolean {
  return a.view === b.view && (a.view !== 'album-detail' || a.albumKey === b.albumKey)
}

export type DiscHandoffKind = 'open' | 'close'

/**
 * Is this navigation the disc handoff?
 *   open   Home → the album page whose case is open with its disc up (armed).
 *   close  that album page → straight back to Home (opened). Anything in
 *          between (another album, the artist, any other view) forgets the
 *          case: when Home isn't the page you came from, no reverse.
 */
export function discHandoffKind(
  prev: HandoffLoc,
  next: HandoffLoc,
  armed: { albumKey: string } | null,
  opened: { albumKey: string } | null,
): DiscHandoffKind | null {
  if (prev.view === 'home' && next.view === 'album-detail' && armed && next.albumKey === armed.albumKey) return 'open'
  if (prev.view === 'album-detail' && next.view === 'home' && opened && prev.albumKey === opened.albumKey) return 'close'
  return null
}

/** After a navigation that ISN'T a handoff: the opened album survives only while you're still on its page. */
export function keepOpenedAfter(next: HandoffLoc, opened: { albumKey: string } | null): boolean {
  return !!opened && next.view === 'album-detail' && next.albumKey === opened.albumKey
}
