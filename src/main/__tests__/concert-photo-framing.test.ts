// Jake, 2026-11-03: "i dont like how the photos cut off the artists faces. at all. thats why i
// asked for a 4:3 ratio". The window stays 4:3 and filled; these tests are the rule for where the
// crop sits (src/common/concert-photo-framing.ts), the same fixtures as the phone twin's
// ConcertPhotoFramingTests.swift. The boxes named after an act are what Vision found on that act's
// real photo (11/3). The arithmetic is also run at the phone's 200 × 150 with its numbers, so the
// two sides can be compared line by line.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CONCERT_PHOTO_DRIFT, CONCERT_PHOTO_WINDOW, concertPhotoFrame, concertPhotoLayout,
  type ConcertPhotoLayout, type FaceBox, type PhotoSize,
} from '../../common/concert-photo-framing.ts'

const phone: PhotoSize = { width: 200, height: 150 }
const square: PhotoSize = { width: 1000, height: 1000 }
const box = (x: number, y: number, width: number, height: number): FaceBox => ({ x, y, width, height })
const layout = (image: PhotoSize, faces: FaceBox[] | null, window: PhotoSize = phone, drift = 14) => concertPhotoLayout(image, faces, window, drift)

interface Rect { minX: number; minY: number; maxX: number; maxY: number }
/** The window on the drawn picture, in picture points, `d` along the drift. */
function shown(l: ConcertPhotoLayout, window: PhotoSize = phone, d = 0): Rect {
  const minX = l.width / 2 - l.offsetX - d - window.width / 2
  const minY = l.height / 2 - l.offsetY - window.height / 2
  return { minX, minY, maxX: minX + window.width, maxY: minY + window.height }
}
const onPicture = (f: FaceBox, l: ConcertPhotoLayout): Rect => ({ minX: f.x * l.width, minY: f.y * l.height, maxX: (f.x + f.width) * l.width, maxY: (f.y + f.height) * l.height })
/** A face's whole head: the crown 0.55 of the box above it. Cut to the picture (a head the photographer cut cannot be shown whole). */
function headOf(f: FaceBox, l: ConcertPhotoLayout): Rect {
  const r = onPicture(f, l)
  return { ...r, minY: Math.max(0, r.minY - f.height * 0.55 * l.height) }
}
const close = (a: number, b: number, why = '') => assert.ok(Math.abs(a - b) < 0.001, `${why} ${a} ≠ ${b}`)
function inside(inner: Rect, outer: Rect, why: string) {
  const slop = 0.001
  assert.ok(inner.minX >= outer.minX - slop && inner.maxX <= outer.maxX + slop && inner.minY >= outer.minY - slop && inner.maxY <= outer.maxY + slop,
    `${why}: ${JSON.stringify(inner)} is not inside ${JSON.stringify(outer)}`)
}
function covers(l: ConcertPhotoLayout, window: PhotoSize = phone) {
  const picture = { minX: 0, minY: 0, maxX: l.width, maxY: l.height }
  for (const d of [-l.drift, 0, l.drift]) inside(shown(l, window, d), picture, `no empty edge at drift ${d}`)
}
function oldSides(l: ConcertPhotoLayout, drift = 14) {
  close(l.offsetX, 0, 'around the middle')
  close(l.drift, drift, 'the whole drift')
}
const oldCrop = (l: ConcertPhotoLayout, window: PhotoSize = phone) => ({ minY: (l.height - window.height) / 2 })

describe('the two cards in Jake\'s screenshot', () => {
  const sofie = box(0.402, 0.099, 0.11, 0.11)
  const newConstellations = [box(0.314, 0.106, 0.085, 0.085), box(0.516, 0.209, 0.071, 0.071)]
  for (const [label, window, drift] of [['phone', phone, 14], ['desktop', CONCERT_PHOTO_WINDOW, CONCERT_PHOTO_DRIFT]] as const) {
    it(`${label}: Sofie Royer's head is back in the window`, () => {
      const l = layout(square, [sofie], window, drift)
      const face = onPicture(sofie, l)
      assert.ok((face.minY + face.maxY) / 2 < oldCrop(l, window).minY, 'the old crop started below the middle of her face')
      close(l.width, window.width + drift * 2, 'the same size as ever: only the crop moved')
      close(l.height, window.width + drift * 2)
      oldSides(l, drift)
      covers(l, window)
      for (const d of [-l.drift, 0, l.drift]) inside(headOf(sofie, l), shown(l, window, d), 'her head')
    })
    it(`${label}: both of New Constellations' heads are back in the window`, () => {
      const l = layout(square, newConstellations, window, drift)
      const his = onPicture(newConstellations[0], l)
      assert.ok((his.minY + his.maxY) / 2 < oldCrop(l, window).minY, 'the old crop cut his face off')
      oldSides(l, drift)
      covers(l, window)
      for (const f of newConstellations) for (const d of [-l.drift, 0, l.drift]) inside(headOf(f, l), shown(l, window, d), 'each head')
    })
  }
})

describe('a crop that was fine stays exactly where it was', () => {
  it('a square photo with the head already inside', () => {
    const l = layout(square, [box(0.45, 0.42, 0.1, 0.1)])
    close(l.offsetY, 0)
    oldSides(l)
  })
  it('a wide photo with its faces in the middle', () => {
    const l = layout({ width: 1800, height: 900 }, [box(0.45, 0.3, 0.1, 0.2)])
    close(l.width, 300)
    close(l.height, 150)
    close(l.offsetY, 0)
    oldSides(l)
  })
})

describe('it moves only as far as it must', () => {
  it('a head just past the old crop moves it just far enough', () => {
    // The old window starts at y = 39 of 228. This crown is at 34.2.
    const f = box(0.45, 0.205, 0.1, 0.1)
    const l = layout(square, [f])
    close(shown(l).minY, (f.y - f.height * 0.55) * 228 - 150 * 0.04, 'the margin above the crown, no more')
  })
  it('a portrait photo finds a face far from the middle', () => {
    const f = box(0.4, 0.16, 0.109, 0.082) // Jalen Ngonda's 900 × 1200: 304 tall, the old window starts at 77.
    const l = layout({ width: 900, height: 1200 }, [f])
    close(l.width, 228)
    close(l.height, 304)
    covers(l)
    inside(headOf(f, l), shown(l), 'the head')
  })
  it('a face low in the picture is found too', () => {
    const f = box(0.45, 0.82, 0.1, 0.1)
    const l = layout(square, [f])
    covers(l)
    inside(headOf(f, l), shown(l), 'the head')
    assert.ok(l.offsetY < 0, 'the picture moved up to show its bottom')
  })
})

describe('nothing found', () => {
  it('a picture cut top and bottom is cut a third of the way down', () => {
    const sq = layout(square, null)
    close(shown(sq).minY, 78 / 3, '78 pt of overhang: 26 off the top, 52 off the bottom')
    oldSides(sq)
    const tall = layout({ width: 800, height: 1200 }, null)
    close(shown(tall).minY, (342 - 150) / 3)
    covers(tall)
  })
  it('a wide picture keeps the old crop: it is only cut at its sides', () => {
    const l = layout({ width: 1800, height: 900 }, null)
    close(l.offsetY, 0)
    oldSides(l)
  })
  it('no usable box is nothing found', () => {
    const nothing = layout(square, null)
    assert.deepEqual(layout(square, []), nothing)
    assert.deepEqual(layout(square, [box(0.4, 0.4, 0, 0.1)]), nothing)
    assert.deepEqual(layout(square, [box(Number.NaN, 0.4, 0.1, 0.1)]), nothing)
    assert.deepEqual(layout(square, [box(1.4, 1.4, 0.1, 0.1)]), nothing, 'outside the picture')
  })
  it('a nonsense picture size is safe', () => {
    for (const bad of [{ width: 0, height: 0 }, { width: 0, height: 500 }, { width: 500, height: 0 }]) {
      assert.deepEqual(layout(bad, [box(0.4, 0.4, 0.1, 0.1)]), { width: 228, height: 150, offsetX: 0, offsetY: 0, drift: 14 })
    }
  })
})

describe('the drift moves only within the slack that keeps the faces in', () => {
  it('a face in the middle keeps the whole drift and the old motion', () => {
    oldSides(layout(square, [box(0.45, 0.1, 0.1, 0.1)]))
  })
  it('a face near a side drifts less and never leaves', () => {
    const f = box(0.08, 0.4, 0.1, 0.1)
    const l = layout(square, [f])
    assert.ok(l.drift > 0 && l.drift < 14)
    covers(l)
    for (const d of [-l.drift, 0, l.drift]) inside(headOf(f, l), shown(l, phone, d), 'the head')
  })
  it('a face at a side stops the drift: nothing beyond it to show, the picture sits against that side', () => {
    const f = box(0.02, 0.4, 0.1, 0.1)
    const l = layout(square, [f])
    close(l.drift, 0)
    close(shown(l).minX, 0)
    inside(onPicture(f, l), shown(l), 'the face')
  })
  it('a wide picture moves a face in and still drifts all the way', () => {
    const f = box(0.2, 0.3, 0.1, 0.2)
    const l = layout({ width: 1800, height: 900 }, [f])
    close(l.drift, 14)
    covers(l)
    for (const d of [-l.drift, 0, l.drift]) inside(headOf(f, l), shown(l, phone, d), 'the head')
    assert.ok(l.offsetX > 0, 'the picture moved right, as little as it could')
    close(shown(l, phone, -l.drift).minX, 54 - 200 * 0.02, 'at the end of the drift the head has just its margin (54 is its left, hair included)')
  })
  it('a group wider than the window is centred and still', () => {
    const l = layout(square, [box(0.02, 0.4, 0.08, 0.08), box(0.9, 0.4, 0.08, 0.08)])
    close(l.drift, 0)
    close(l.offsetX, 0, 'the same cut each side')
    covers(l)
  })
})

describe('which faces count', () => {
  it('faces that cannot fit top to bottom: the crop with the most face decides', () => {
    const big = box(0.4, 0.09, 0.1, 0.103)
    const middle = box(0.2, 0.46, 0.09, 0.091)
    const low = box(0.7, 0.84, 0.08, 0.081)
    const l = layout(square, [low, middle, big]) // The Menzingers': the detector's order is its own.
    inside(headOf(big, l), shown(l), 'the biggest face')
    inside(headOf(middle, l), shown(l), 'the next one fits with it')
    assert.ok(onPicture(low, l).maxY > shown(l).maxY, 'the last does not: the window is only so tall')
  })
  it('the biggest wins even when it is not the highest', () => {
    const small = box(0.2, 0.05, 0.08, 0.08)
    const big = box(0.6, 0.75, 0.12, 0.12)
    const l = layout(square, [small, big])
    inside(headOf(big, l), shown(l), 'the biggest face')
    assert.ok(onPicture(small, l).minY < shown(l).minY, 'the smaller one, too far above it, is let go')
  })
  it('when two crops show as much face, the biggest face stays whole', () => {
    const small = box(0.2, 0.1, 0.18, 0.18)
    const big = box(0.5, 0.6, 0.3, 0.3)
    const l = layout(square, [small, big])
    inside(onPicture(big, l), shown(l), 'the biggest face')
  })
  it('two people stacked, a little too tall for the window, both stay with the same cut each', () => {
    // Milk & Bone's and Bag Raiders' desktop photos: letting one go showed a slice of her face.
    for (const faces of [[box(0.241, 0.214, 0.346, 0.346), box(0.445, 0.646, 0.283, 0.283)], [box(0.169, 0.553, 0.385, 0.385), box(0.598, 0.178, 0.393, 0.393)]]) {
      const l = layout(square, faces)
      covers(l)
      const s = shown(l)
      const [a, b] = faces.map((f) => onPicture(f, l)) as [Rect, Rect]
      close(Math.min(a.minY, b.minY) - s.minY, s.maxY - Math.max(a.maxY, b.maxY), 'the same cut above and below')
      for (const r of [a, b]) assert.ok((Math.min(r.maxY, s.maxY) - Math.max(r.minY, s.minY)) / (r.maxY - r.minY) > 0.75, 'most of each face')
    }
  })
  it('a group a little too tall for its margins is still whole', () => {
    // Man/Woman/Chainsaw: five faces in 0.654 of a picture whose window shows 0.658.
    const faces = [box(0.31, 0.08, 0.058, 0.058), box(0.5, 0.64, 0.094, 0.094), box(0.2, 0.4, 0.069, 0.069), box(0.6, 0.4, 0.076, 0.076), box(0.75, 0.14, 0.062, 0.062)]
    const l = layout(square, faces)
    for (const f of faces) inside(onPicture(f, l), shown(l), 'each face')
  })
  it('a background face (under a third of the biggest) does not count', () => {
    const main = box(0.45, 0.1, 0.15, 0.15)
    assert.deepEqual(layout(square, [box(0.02, 0.9, 0.04, 0.04), main]), layout(square, [main]))
    // Beside her, where it would fit: it still neither moves the crop nor holds the drift back.
    assert.deepEqual(layout(square, [box(0.02, 0.12, 0.04, 0.04), main]), layout(square, [main]))
  })
  it('a face over a third of the biggest still counts', () => {
    const beside = box(0.03, 0.15, 0.06, 0.06)
    const l = layout(square, [box(0.45, 0.1, 0.15, 0.15), beside])
    assert.ok(l.drift < 13, 'someone at the side keeps the drift from losing them')
    inside(onPicture(beside, l), shown(l), 'the second face')
  })
})

describe('close-ups', () => {
  it('a close-up whose head cannot fit keeps its face', () => {
    const f = box(0.28, 0.26, 0.44, 0.437) // LCD's 0.437: 100 pt of face; with its crown, more than the window.
    const l = layout(square, [f])
    covers(l)
    inside(onPicture(f, l), shown(l), 'brow to chin')
    // Just under the window's room: 130 pt of face, every point of it kept.
    const big = box(0.2, 0.3, 0.6, 0.57)
    inside(onPicture(big, layout(square, [big])), shown(layout(square, [big])), 'brow to chin')
  })
  it('a face taller than the window\'s room is centred', () => {
    const f = box(0.27, 0.3, 0.62, 0.608) // Mary J. Blige's 0.608: 139 pt of a 150 pt window.
    const l = layout(square, [f])
    covers(l)
    const r = onPicture(f, l)
    const s = shown(l)
    close((r.minY + r.maxY) / 2, (s.minY + s.maxY) / 2, 'the same cut above and below')
  })
})

describe('always', () => {
  // A little reproducible generator (no flaky seed).
  let state = 0x20261103n
  const next = (): number => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn
    return Number((state >> 33n) & 0xffffn) / 65535
  }
  const shapes: PhotoSize[] = [[1000, 1000], [800, 1200], [1350, 1800], [900, 1600], [1800, 900], [600, 301], [1200, 800], [1000, 501], [3000, 1000], [640, 640], [1500, 1000], [1001, 999]]
    .map(([width, height]) => ({ width, height }))

  for (const [label, window, drift] of [['phone', phone, 14], ['desktop', CONCERT_PHOTO_WINDOW, CONCERT_PHOTO_DRIFT]] as const) {
    it(`${label}: the picture covers the window at every drift, whatever the boxes say`, () => {
      for (const shape of shapes) {
        for (let i = 0; i < 300; i++) {
          const faces = Array.from({ length: 1 + Math.floor(next() * 5) }, () => box(next() * 1.2 - 0.1, next() * 1.2 - 0.1, next() * 0.9 + 0.005, next() * 0.9 + 0.005))
          const l = layout(shape, faces, window, drift)
          covers(l, window)
          assert.ok(l.drift >= 0 && l.drift <= drift)
        }
      }
    })
    it(`${label}: one face that fits is inside at every drift, wherever it is`, () => {
      for (const shape of shapes) {
        for (let i = 0; i < 500; i++) {
          const h = next() * 0.2 + 0.03
          const w = h / (shape.width / shape.height) // about square in the picture's own pixels
          const f = box(next() * (1 - w), next() * (1 - h), w, h)
          const l = layout(shape, [f], window, drift)
          covers(l, window)
          const whole = headOf(f, l)
          if (whole.maxY - whole.minY > window.height * 0.92 * 0.9 || whole.maxX - whole.minX > window.width * 0.7) continue
          for (const d of [-l.drift, 0, l.drift]) inside(whole, shown(l, window, d), `${shape.width}x${shape.height} ${JSON.stringify(f)}`)
        }
      }
    })
  }
})

describe('what home.css draws', () => {
  /** The picture's left and top in the window, the way the browser places it from a frame. */
  function placed(image: PhotoSize, frame: ReturnType<typeof concertPhotoFrame>, window: PhotoSize, drift: number) {
    const box = { width: window.width + drift * 2, height: window.height }
    const scale = Math.max(box.width / image.width, box.height / image.height)
    const [x, y] = frame.position.split(' ').map((p) => Number.parseFloat(p) / 100) as [number, number]
    return {
      left: -drift + frame.rest + (box.width - image.width * scale) * x,
      top: (box.height - image.height * scale) * y,
    }
  }

  it('object-position + translateX put the picture exactly where the layout says', () => {
    const w = CONCERT_PHOTO_WINDOW, d = CONCERT_PHOTO_DRIFT
    const cases: [PhotoSize, FaceBox[] | null][] = [
      [square, null], [square, [box(0.402, 0.099, 0.11, 0.11)]], [square, [box(0.08, 0.4, 0.1, 0.1)]], [square, [box(0.02, 0.4, 0.1, 0.1)]],
      [square, [box(0.86, 0.4, 0.1, 0.1)]], [{ width: 900, height: 1200 }, [box(0.4, 0.16, 0.109, 0.082)]],
      [{ width: 1800, height: 900 }, null], [{ width: 1800, height: 900 }, [box(0.2, 0.3, 0.1, 0.2)]], [{ width: 1800, height: 900 }, [box(0.02, 0.3, 0.1, 0.2)]],
      [{ width: 1800, height: 900 }, [box(0.92, 0.3, 0.06, 0.12)]], [{ width: 3000, height: 1000 }, [box(0.7, 0.3, 0.05, 0.15)]],
    ]
    for (const [image, faces] of cases) {
      const l = concertPhotoLayout(image, faces, w, d)
      const frame = concertPhotoFrame(image, faces)
      const at = placed(image, frame, w, d)
      const left = l.offsetX + (w.width - l.width) / 2
      const top = l.offsetY + (w.height - l.height) / 2
      assert.ok(Math.abs(at.left - left) < 0.05, `left ${at.left} ≠ ${left} (${JSON.stringify(faces)})`)
      assert.ok(Math.abs(at.top - top) < 0.05, `top ${at.top} ≠ ${top} (${JSON.stringify(faces)})`)
      assert.ok(Math.abs(frame.drift - l.drift) < 0.01)
      // The element itself never leaves an edge of the window bare, at rest or along the drift.
      for (const dd of [-frame.drift, frame.drift]) assert.ok(Math.abs(frame.rest + dd) <= d + 0.011, `element moves ${frame.rest + dd} of its ±${d}`)
    }
  })

  it('a photo that needs no help reads as it always did; nothing found is the CSS fallback', () => {
    const middle = concertPhotoFrame(square, [box(0.45, 0.42, 0.1, 0.1)])
    assert.deepEqual([middle.position, middle.rest, middle.drift], ['50% 50%', 0, 14])
    assert.deepEqual(concertPhotoFrame(square, null), { position: '50% 33.33%', stillPosition: '50% 33.33%', rest: 0, drift: 14 })
    assert.deepEqual(concertPhotoFrame({ width: 800, height: 1200 }, null), { position: '50% 33.33%', stillPosition: '50% 33.33%', rest: 0, drift: 14 })
  })

  it('Reduce Motion: the still position, computed for the window with no drift frame, keeps the head in', () => {
    const f = box(0.402, 0.099, 0.11, 0.11)
    const still = concertPhotoFrame(square, [f])
    const y = Number.parseFloat(still.stillPosition.split(' ')[1]!) / 100
    const w = CONCERT_PHOTO_WINDOW
    // Drawn w.width square, inside a window w.height tall.
    const top = (w.width - w.height) * y
    assert.ok(top <= (f.y - f.height * 0.55) * w.width + 0.001, 'the crown is below the window\'s top')
    assert.ok(top + w.height >= (f.y + f.height) * w.width, 'the chin is above its bottom')
  })
})

describe('the wiring', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
  const index = read('../index.ts')
  const shows = read('../../renderer/components/HomeShows.tsx')
  const frames = read('../../renderer/concertPhotoFrames.ts')
  const css = read('../../renderer/styles/home.css')

  it('the main window turns on the one Blink feature, and nothing turns on all of them', () => {
    assert.match(index, /mainWindow = new BrowserWindow\(\{[\s\S]*?webPreferences: \{[\s\S]*?enableBlinkFeatures: 'FaceDetector',[\s\S]*?\n {4}\}\n {2}\}\)/)
    for (const [label, source] of [['main/index.ts', index], ['HomeShows', shows], ['concertPhotoFrames', frames]] as const) {
      assert.doesNotMatch(source, /experimentalFeatures: *true|enable-experimental-web-platform-features|enable-blink-features/, label)
    }
  })

  it('the card shows its photo framed, hidden until its faces are read, never jumping', () => {
    assert.match(shows, /home-concert-photo-img\$\{frame \? '' : ' home-concert-photo-img--checking'\}/)
    assert.match(shows, /'--concert-pos': frame\.position/)
    assert.match(shows, /'--concert-pos-still': frame\.stillPosition/)
    assert.match(shows, /'--concert-rest': `\$\{frame\.rest\}px`/)
    assert.match(shows, /'--concert-drift': `\$\{frame\.drift\}px`/)
    assert.match(css, /\.home-concert-photo-img--checking \{ opacity: 0; \}/)
  })

  it('a photo is never left hidden: no API, a failure or no answer all still give a frame', () => {
    assert.match(frames, /if \(!api\) \{[\s\S]*?return null\n {2}\}/)
    assert.match(frames, /if \(!found\) return concertPhotoFrame\(size, null\)/)
    assert.match(frames, /Promise\.race\(\[read\(slug\), timeout\]\)/)
    assert.match(frames, /return concertPhotoFrame\(\{ width: 1, height: 1 \}, null\)/)
  })

  it('home.css draws the frame: the crop, the rest and the drift, and the fallbacks are "nothing found"', () => {
    const img = css.match(/\n\.home-concert-photo-img \{[^}]*\}/)?.[0] ?? ''
    assert.match(img, /object-fit: cover;/)
    assert.match(img, /object-position: var\(--concert-pos, 50% 33\.33%\);/)
    assert.match(img, /transform: translateX\(var\(--concert-rest, 0px\)\);/)
    assert.match(css, /from \{ transform: translateX\(calc\(var\(--concert-rest, 0px\) \+ var\(--concert-drift, 14px\)\)\); \}/)
    assert.match(css, /to \{ transform: translateX\(calc\(var\(--concert-rest, 0px\) - var\(--concert-drift, 14px\)\)\); \}/)
    assert.match(img, /left: -14px;\n {2}width: calc\(100% \+ 28px\);/, 'the frame is the window plus CONCERT_PHOTO_DRIFT each side')
    assert.equal(CONCERT_PHOTO_DRIFT, 14)
  })

  it('Reduce Motion stills it at its still position', () => {
    assert.match(css, /\.home-concert-photo-img \{ animation: none; left: 0; width: 100%; transform: none; object-position: var\(--concert-pos-still, 50% 33\.33%\); \}/)
  })
})
