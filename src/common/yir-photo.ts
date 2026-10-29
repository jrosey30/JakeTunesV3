/**
 * Year in Review artist photos: the sanity check (2026-10-29, Jake: "better photo for Drake").
 *
 * The Review's artist pictures used to be the raw Deezer image (artist-photo.ts). Deezer's
 * Drake is a 1000×1000 picture of a deliberately out-of-focus face: big enough, and useless.
 * So the Review now shows what the artist PAGE shows — the profile's chosen header photo
 * (homemini's photo pipeline, Jake's own picks included) — and only falls back to the Deezer
 * image when it passes this check:
 *
 *   • size   — its short side is at least PHOTO_MIN_SIDE pixels (no upscaled thumbnails);
 *   • detail — the variance of the Laplacian on a PHOTO_SAMPLE-pixel grey copy (how much edge
 *              there is at all) is at least PHOTO_MIN_DETAIL; Deezer's grey "no photo"
 *              silhouette and flat logos score ~21 and below;
 *   • focus  — that variance divided by the picture's own contrast is at least
 *              PHOTO_MIN_FOCUS, so a dark or low-contrast photo isn't punished for being dark,
 *              while a blur over strong light and shade (Deezer's Drake: 0.0022) is.
 *
 * Calibrated on the 1,744 Deezer photos on Jake's laptop (2026-10-29): 30 fail — Drake,
 * Santigold, two blank images, the silhouette placeholder (19 artists), a few flat logos — and
 * every real portrait passes, dark ones included (lowest focus that passes: 0.011).
 * A photo that fails shows the artist's initials, never a bad photo and never album art.
 *
 * Pure. ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirImage.swift YirPhotoGate (same
 * constants, same arithmetic).
 */

export const PHOTO_MIN_SIDE = 500
export const PHOTO_SAMPLE = 256
export const PHOTO_MIN_DETAIL = 25
export const PHOTO_MIN_FOCUS = 0.006

export interface PhotoQuality {
  width: number
  height: number
  /** variance of the 4-neighbour Laplacian over the grey sample */
  detail: number
  /** detail ÷ the sample's own variance (contrast) */
  focus: number
}

/** Detail and focus of a grey picture (row-major, 0–255, w × h). */
export function photoDetail(gray: ArrayLike<number>, w: number, h: number): { detail: number; focus: number } {
  if (w < 3 || h < 3) return { detail: 0, focus: 0 }
  let sum = 0, sum2 = 0
  for (let i = 0; i < w * h; i++) { const v = gray[i]; sum += v; sum2 += v * v }
  const mean = sum / (w * h)
  const variance = sum2 / (w * h) - mean * mean
  let ls = 0, ls2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      ls += lap; ls2 += lap * lap; n++
    }
  }
  const lm = ls / n
  const detail = ls2 / n - lm * lm
  return { detail, focus: detail / Math.max(variance, 1) }
}

/** Does the photo pass the Review's bar? */
export function photoPasses(q: PhotoQuality): boolean {
  return Math.min(q.width, q.height) >= PHOTO_MIN_SIDE && q.detail >= PHOTO_MIN_DETAIL && q.focus >= PHOTO_MIN_FOCUS
}

/** RGBA or BGRA pixels → grey (Rec. 601 luma). The caller names the channel order. */
export function toGray(px: ArrayLike<number>, w: number, h: number, order: 'rgba' | 'bgra'): Float64Array {
  const out = new Float64Array(w * h)
  const [r, b] = order === 'rgba' ? [0, 2] : [2, 0]
  for (let i = 0; i < w * h; i++) out[i] = 0.299 * px[i * 4 + r] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + b]
  return out
}

/**
 * Which picture the Review shows for an artist — the artist page's own choice first:
 *   1. the profile's header photo (`hero`, saved on this machine as heroSlug) — homemini's photo
 *      pipeline picked it (face-checked, credited, or Jake's own pick);
 *   2. else the app's Deezer image, once it has passed photoPasses (null quality = not measured
 *      yet: nothing shows until it is, so a bad photo never flashes);
 *   3. else nothing: the caller shows initials.
 */
export function chooseArtistPhoto(p: { heroSlug?: string | null; appSlug?: string | null; appOk?: boolean | null }): string | null {
  if (p.heroSlug) return p.heroSlug
  if (p.appSlug && p.appOk === true) return p.appSlug
  return null
}
