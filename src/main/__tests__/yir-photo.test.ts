/**
 * The Year in Review's artist-photo check (src/common/yir-photo.ts): the artist page's header
 * photo first, the app's Deezer photo only when it is big and in focus, else initials.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chooseArtistPhoto, photoDetail, photoPasses, toGray, PHOTO_MIN_SIDE } from '../../common/yir-photo.ts'

/** A w×h grey picture from a function of (x, y). */
const pic = (w: number, h: number, f: (x: number, y: number) => number): Float64Array => {
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f(x, y)
  return out
}

describe('the photo check', () => {
  it('a sharp picture has detail and focus; the same picture blurred loses its focus', () => {
    const sharp = pic(64, 64, (x, y) => (((x >> 2) + (y >> 2)) % 2 ? 230 : 25))   // 4-px checkerboard
    // A wide, soft gradient with the same light and shade: Deezer's Drake, in miniature.
    const soft = pic(64, 64, (x, y) => 25 + (205 * (Math.sin(x / 10) + Math.sin(y / 10) + 2)) / 4)
    const a = photoDetail(sharp, 64, 64), b = photoDetail(soft, 64, 64)
    assert.ok(a.detail > 1000 && a.focus > 0.5, JSON.stringify(a))
    assert.ok(b.detail < 25 && b.focus < 0.006, JSON.stringify(b))
    assert.equal(photoPasses({ width: 1000, height: 1000, ...a }), true)
    assert.equal(photoPasses({ width: 1000, height: 1000, ...b }), false)
  })

  it('a flat picture (Deezer\'s blank and silhouette placeholders) fails on detail', () => {
    const flat = photoDetail(pic(32, 32, () => 128), 32, 32)
    assert.deepEqual(flat, { detail: 0, focus: 0 })
  })

  it('too small fails however sharp', () => {
    assert.equal(photoPasses({ width: PHOTO_MIN_SIDE - 1, height: 1000, detail: 900, focus: 0.3 }), false)
    assert.equal(photoPasses({ width: PHOTO_MIN_SIDE, height: PHOTO_MIN_SIDE, detail: 900, focus: 0.3 }), true)
  })

  it('reads RGBA and BGRA as the same grey', () => {
    const rgba = [255, 0, 0, 255], bgra = [0, 0, 255, 255]
    assert.deepEqual([...toGray(rgba, 1, 1, 'rgba')], [...toGray(bgra, 1, 1, 'bgra')])
  })
})

describe('which artist photo the Review shows', () => {
  it('the artist page\'s header photo wins, checked or not', () => {
    assert.equal(chooseArtistPhoto({ heroSlug: 'hero-1a4e', appSlug: 'drake', appOk: false }), 'hero-1a4e')
  })
  it('the app photo only once it has passed', () => {
    assert.equal(chooseArtistPhoto({ appSlug: 'geese', appOk: true }), 'geese')
    assert.equal(chooseArtistPhoto({ appSlug: 'drake', appOk: false }), null)
    assert.equal(chooseArtistPhoto({ appSlug: 'drake', appOk: null }), null, 'not measured yet: nothing flashes')
    assert.equal(chooseArtistPhoto({}), null)
  })
})
