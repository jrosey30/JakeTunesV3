/**
 * The photographed jewel case (Jake, 2026-10-30: "the cd cases also look
 * cartoonish. im serious when i say make it look real"). The album page's
 * case and the Home Cover Flow's case are the same photograph of a real
 * case — "CD Jewel Case (Front).jpg" by DiscoA340, CC0, Wikimedia Commons
 * (docs/credits.md) — perspective-corrected and cut into layers
 * (renderer/assets/jewel-case/, built by tools/jewel-case/build-assets.py):
 *
 *   case-frame.png   the plastic that is not the lid's optics: the ribbed
 *                    hinge strip's dark floor, the clear rims, the hinge
 *                    zone; the booklet window cut to alpha 0 so the cover art
 *                    shows through (the plastic overlaps the art by 2 px).
 *   case-lid.png     what the clear lid does to whatever is under it: the
 *                    ribs' lit crests and dark valleys over the strip (spine
 *                    text under it reads as printed UNDER the ribs), the
 *                    lid's sheen and scratches over the window, the walls'
 *                    shadow on the booklet's edges. Composited normally:
 *                    white-with-alpha is screen and black-with-alpha is
 *                    multiply for a neutral layer, and a normal layer keeps
 *                    the disc handoff's View Transition snapshot honest.
 *   case-shadow.png  a contact shadow (the photo's paper carries none).
 *   case-tray.webp   the black tray for the Home case's open state.
 *
 * Desktop-only. The phone's twin (common/jewel-case.ts, which still runs the
 * motion, the camera, the disc and the tabs) draws its own case with its own
 * proportions; this file is the PHOTO's proportions — every number below is
 * a fraction of the booklet window, which is the cover art's square —
 * measured on the rectified photo (20 px/mm, the booklet = 120 mm = 2400 px).
 */
import type { JewelCaseGeometry } from './jewel-case.ts'
import { JEWEL_CASE } from './jewel-case.ts'

export const JEWEL_CASE_PHOTO = {
  /** The case's box. */
  caseW: 2840 / 2400,
  caseH: 2500 / 2400,
  /** Where the booklet (the art) sits: its left and top edges. */
  winLeft: 300 / 2400,
  winTop: 28 / 2400,
  /** The ribbed hinge strip (the lid's hinge end), where spine text goes. */
  stripLeft: 10 / 2400,
  stripRight: 250 / 2400,
  stripTop: 32 / 2400,
  stripBottom: 2440 / 2400,
  /** case-shadow.png is the case's box plus this on every side. */
  shadowMargin: 140 / 2400,
  /** The plastic's corner radius. */
  cornerR: 24 / 2400,
} as const

/** CSS custom properties for the fractions (the album page sets them on its sleeve). */
export function jewelCasePhotoVars(prefix: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(JEWEL_CASE_PHOTO)) out[`${prefix}${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = v.toFixed(6)
  return out
}

/**
 * The Home case around a front cover `artPx` square, in the photo's
 * proportions: the art keeps its place, the case grows out around it. The
 * camera, the disc and the motion stay the phone's (× artPx / 160).
 */
export function photoCaseGeometry(artPx: number): JewelCaseGeometry {
  const p = JEWEL_CASE_PHOTO
  const k = artPx / JEWEL_CASE.art
  const spine = p.winLeft * artPx
  return {
    scale: k,
    art: artPx,
    spine,
    rim: p.winTop * artPx,
    radius: p.cornerR * artPx,
    width: p.caseW * artPx,
    height: p.caseH * artPx,
    camera: JEWEL_CASE.camera * k,
    cameraX: spine + artPx / 2,
    cameraY: JEWEL_CASE.cameraY * k,
    disc: JEWEL_CASE.disc * k,
  }
}
