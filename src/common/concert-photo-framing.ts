/**
 * Where a concert card's photo sits in its 4:3 window. Pure arithmetic, tested in
 * src/main/__tests__/concert-photo-framing.test.ts.
 *
 * Jake, 2026-11-03, on the Home concert rail: "i dont like how the photos cut off the artists
 * faces. at all. thats why i asked for a 4:3 ratio". The window already was 4:3; the photo was
 * centre-cropped into it (object-fit: cover). Press photos are mostly square or portrait, so a
 * centre crop drops the top of the picture, which is where the heads are.
 *
 * The photo still fills the window at the size it always had (no bars, no letterbox); only WHERE
 * the crop sits changes, and only as far as it must:
 *
 * - Each face (the renderer's concertPhotoFrames.ts asks Chromium's FaceDetector, which is Apple
 *   Vision on macOS) is grown to its whole head: the crown sits 0.55 face-heights above the box,
 *   plus a little chin and hair at the sides. The heads must be inside the window with a margin;
 *   a crop that already holds them stays exactly where it was, otherwise it moves just far enough.
 * - Faces under a third of the biggest one's height are background (a poster on the wall, the
 *   crowd) and do not count. When the rest cannot all fit top to bottom, the crop with the most
 *   face in it decides: everyone at least half in it stays, the rest are let go.
 * - Heads that cannot fit whole keep their face boxes (brow to chin) instead: a close-up, two
 *   people stacked. Faces taller than even that are centred, the same cut above and below.
 * - No face: a picture cut top and bottom is cropped a third of the way down instead of through
 *   the middle.
 * - The drift (±14px of parallax as the rail scrolls) moves only within the range that keeps the
 *   kept heads in: the full ±14 when there is room, less when a head sits near a side, none when
 *   no position holds them all.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/ConcertPhotoFraming.swift (same rules; the phone's
 * window is 200 × 150, and its Vision also has upper bodies to fall back on before "no face").
 */

export interface PhotoSize {
  width: number
  height: number
}

/** A face, normalized (0…1) on the upright picture, origin top-left. */
export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ConcertPhotoLayout {
  /** The picture's drawn size: it covers the drift frame (the window plus the drift each side). */
  width: number
  height: number
  /** The picture's centre against the window's centre, at rest. */
  offsetX: number
  offsetY: number
  /** How far the drift moves it each way (0…maxDrift). */
  drift: number
}

/** The rail's photo window, as measured: inside the 272px card's borders, above the band's 1px line. */
export const CONCERT_PHOTO_WINDOW: PhotoSize = { width: 270, height: 201.5 }
/** How far the photo may drift each way; it is drawn this much wider (home.css `.home-concert-photo-img`). */
export const CONCERT_PHOTO_DRIFT = 14

/** Vision's face box starts at the brows: the crown is this many face-heights above it (the hub's CROWN_ABOVE_BOX). */
const CROWN_ABOVE_BOX = 0.55
/** A little neck under the chin, and hair beside the box, kept too. */
const CHIN_BELOW_BOX = 0.12
const BESIDE_BOX = 0.2
/** A face shorter than this share of the biggest one is background. */
const BACKGROUND_FACE = 1 / 3
/** The room kept between a head and the window's edge, as a share of its height (top and bottom) and width (sides). */
const MARGIN_Y = 0.04
const MARGIN_X = 0.02
/** With no face found, a picture cut top and bottom is cropped this far down its overhang (0.5 was the old centre crop). */
const TOP_BIAS = 1 / 3

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface Head {
  /** The whole head, in picture points, cut to the picture. */
  head: Rect
  /** The face box (brow to chin), for a close-up whose whole head cannot fit. */
  face: Rect
  height: number
}

/** The heads a picture shows, in picture points, biggest first; faces under a third of the biggest one dropped. */
function headsOf(faces: readonly FaceBox[], size: PhotoSize): Head[] {
  const boxes = faces.filter((b) => [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0)
  const tallest = Math.max(0, ...boxes.map((b) => b.height))
  const onPicture = (minX: number, minY: number, w: number, h: number): Rect | null => {
    const r = {
      minX: Math.max(0, minX * size.width), minY: Math.max(0, minY * size.height),
      maxX: Math.min(size.width, (minX + w) * size.width), maxY: Math.min(size.height, (minY + h) * size.height),
    }
    return r.maxX > r.minX && r.maxY > r.minY ? r : null
  }
  const out: Head[] = []
  for (const b of boxes) {
    if (b.height < tallest * BACKGROUND_FACE) continue
    const head = onPicture(b.x - b.width * BESIDE_BOX, b.y - b.height * CROWN_ABOVE_BOX, b.width * (1 + BESIDE_BOX * 2), b.height * (1 + CROWN_ABOVE_BOX + CHIN_BELOW_BOX))
    const face = onPicture(b.x, b.y, b.width, b.height)
    if (head && face) out.push({ head, face, height: b.height })
  }
  return out.sort((a, b) => (a.height !== b.height ? b.height - a.height : a.head.minY - b.head.minY))
}

/**
 * Who the window keeps: everyone at least half in the crop with the most face in it (a crop with
 * some face just inside its top or bottom edge, the biggest face deciding a tie). Everyone, when
 * they all fit.
 */
function keptHeads(heads: Head[], window: number, margin: number, pictureHeight: number): Head[] {
  if (heads.length === 0) return []
  const seen = (h: Head, top: number): number => Math.min(h.face.maxY, top + window) - Math.max(h.face.minY, top)
  let bestTop = 0
  let bestShowing = -1
  for (const h of heads) {
    for (const edge of [h.face.minY - margin, h.face.maxY + margin - window]) {
      const top = clamp(edge, 0, pictureHeight - window)
      const showing = heads.reduce((sum, other) => sum + Math.max(0, seen(other, top)), 0)
      if (showing > bestShowing + 0.000001) {
        bestTop = top
        bestShowing = showing
      }
    }
  }
  const stay = heads.filter((h) => seen(h, bestTop) * 2 >= h.face.maxY - h.face.minY)
  return stay.length > 0 ? stay : [heads[0]]
}

/** `faces` null or empty: nothing found. */
export function concertPhotoLayout(image: PhotoSize, faces: readonly FaceBox[] | null, window: PhotoSize, maxDrift: number): ConcertPhotoLayout {
  const drift = Math.max(0, maxDrift)
  const frame = { width: window.width + drift * 2, height: window.height }
  if (!(image.width > 0 && image.height > 0 && window.width > 0 && window.height > 0)) {
    return { width: frame.width, height: frame.height, offsetX: 0, offsetY: 0, drift }
  }
  const scale = Math.max(frame.width / image.width, frame.height / image.height)
  const size = { width: image.width * scale, height: image.height * scale }
  // The picture's top-left corner in the window. Any y in [minY, 0] covers the window top to
  // bottom; any x in [minX, 0] side to side.
  const minX = window.width - size.width
  const minY = window.height - size.height
  const centreX = minX / 2
  const centreY = minY / 2
  const my = window.height * MARGIN_Y
  const mx = window.width * MARGIN_X

  let y = centreY
  let span: { lo: number; hi: number } | null = null
  const heads = keptHeads(headsOf(faces ?? [], size), window.height, my, size.height)
  if (heads.length === 0) {
    // Nothing found: cut a little higher than the middle.
    y = minY * TOP_BIAS
  } else {
    const top = Math.min(...heads.map((h) => h.head.minY))
    const bottom = Math.max(...heads.map((h) => h.head.maxY))
    if (bottom - top <= window.height - my * 2) {
      y = clamp(centreY, my - top, window.height - my - bottom)
    } else {
      const faceTop = Math.min(...heads.map((h) => h.face.minY))
      const faceBottom = Math.max(...heads.map((h) => h.face.maxY))
      y = faceBottom - faceTop <= window.height - my * 2
        ? clamp(centreY, my - faceTop, window.height - my - faceBottom)
        : (window.height - faceTop - faceBottom) / 2
    }
    span = { lo: Math.min(...heads.map((h) => h.head.minX)), hi: Math.max(...heads.map((h) => h.head.maxX)) }
  }
  y = clamp(y, minY, 0)

  // Side to side: the old drift, centred, unless the heads need it to sit elsewhere or move less.
  let lo = centreX - drift
  let hi = centreX + drift
  if (span) {
    const keepLo = Math.max(minX, mx - span.lo)
    const keepHi = Math.min(0, window.width - mx - span.hi)
    if (keepLo <= keepHi) {
      if (keepHi - keepLo >= drift * 2) {
        lo = clamp(centreX - drift, keepLo, keepHi - drift * 2)
        hi = lo + drift * 2
      } else {
        lo = keepLo
        hi = keepHi
      }
    } else {
      // No position holds them all (or none can reach one at an edge): centred on them, still.
      lo = clamp((window.width - span.lo - span.hi) / 2, minX, 0)
      hi = lo
    }
  }
  const x = (lo + hi) / 2
  return {
    width: size.width,
    height: size.height,
    offsetX: x + size.width / 2 - window.width / 2,
    offsetY: y + size.height / 2 - window.height / 2,
    drift: (hi - lo) / 2,
  }
}

/** What home.css needs to draw a layout (the custom properties on `.home-concert-photo-img`). */
export interface ConcertPhotoFrame {
  /** `object-position` in the drift frame (--concert-pos). */
  position: string
  /** `object-position` with Reduce Motion, when there is no drift frame (--concert-pos-still). */
  stillPosition: string
  /** translateX at rest, in px: the part of the crop `object-position` cannot reach (--concert-rest). */
  rest: number
  /** The drift each way, in px (--concert-drift). */
  drift: number
}

const percent = (v: number): string => `${Number((v * 100).toFixed(2))}%`

/**
 * A layout as `object-position` in its element (`box` wide and tall, `drift` beyond the window on
 * each side) plus the translateX that `object-position` cannot reach. A square picture exactly
 * fills the drift frame, so it has no room to move sideways inside its element: the element moves.
 */
function position(l: ConcertPhotoLayout, window: PhotoSize, drift: number): { x: number; y: number; rest: number } {
  const box = { width: window.width + drift * 2, height: window.height }
  // Where the picture's top-left corner sits in the element, at rest.
  const left = l.offsetX + (window.width - l.width) / 2 + drift
  const top = l.offsetY + (window.height - l.height) / 2
  const slackX = box.width - l.width
  const slackY = box.height - l.height
  const x = slackX < -1e-6 ? clamp(left / slackX, 0, 1) : 0.5
  const y = slackY < -1e-6 ? clamp(top / slackY, 0, 1) : 0.5
  return { x, y, rest: left - (slackX < -1e-6 ? slackX * x : 0) }
}

export function concertPhotoFrame(image: PhotoSize, faces: readonly FaceBox[] | null, window: PhotoSize = CONCERT_PHOTO_WINDOW, maxDrift: number = CONCERT_PHOTO_DRIFT): ConcertPhotoFrame {
  const moving = concertPhotoLayout(image, faces, window, maxDrift)
  const at = position(moving, window, maxDrift)
  const stillAt = position(concertPhotoLayout(image, faces, window, 0), window, 0)
  return {
    position: `${percent(at.x)} ${percent(at.y)}`,
    stillPosition: `${percent(stillAt.x)} ${percent(stillAt.y)}`,
    rest: Number(at.rest.toFixed(2)),
    drift: Number(moving.drift.toFixed(2)),
  }
}
