// The Island Albums jewel case (src/common/jewel-case.ts) — the desktop twin
// of the phone's case (JakeTunesMobile LaunchPageG.swift, Mobile PR #519's
// "Spec for the desktop twin"). These pin the phone's numbers and the
// physical rules: hinge on the left, the free edge toward you, the inside of
// the lid (never the art mirrored) past the point you see it edge-on, a
// spring that overshoots ~3° and settles, a close that accelerates into a
// hard stop.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  JEWEL_CASE, JEWEL_CASE_MOTION, DISC_HANDOFF_TIMING,
  cubicBezier, lidAngleOpening, lidAngleClosing, lidPointDepth, cssLidAngle, lidLook,
  lidOpeningFrames, lidClosingFrames, lidOpenLook, jewelCaseGeometry,
  discHandoffKind, keepOpenedAfter, sameHandoffLoc,
} from '../../common/jewel-case.ts'

const near = (a: number, b: number, eps: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b} (±${eps})`)

describe('cubicBezier', () => {
  test('endpoints, monotonic, and the curve shapes the names promise', () => {
    const easeOut = cubicBezier(0, 0, 0.58, 1)
    const snap = cubicBezier(...JEWEL_CASE_MOTION.snapCurve)
    for (const f of [easeOut, snap]) {
      assert.equal(f(0), 0)
      assert.equal(f(1), 1)
      let prev = 0
      for (let x = 0.01; x <= 1; x += 0.01) {
        const y = f(x)
        assert.ok(y >= prev - 1e-9, `not monotonic at ${x}`)
        prev = y
      }
    }
    assert.ok(easeOut(0.5) > 0.6, 'easeOut is ahead at the midpoint')
    assert.ok(snap(0.5) < 0.3, 'the snap curve starts slow (accelerating)')
  })
  test('matches the linear curve on the diagonal', () => {
    const lin = cubicBezier(0.25, 0.25, 0.75, 0.75)
    for (const x of [0.1, 0.33, 0.5, 0.9]) near(lin(x), x, 1e-5)
  })
})

describe('the lid opening (latch pop → spring → settle)', () => {
  test('the latch pops a few degrees, fast', () => {
    assert.equal(lidAngleOpening(0), 0)
    const at50 = lidAngleOpening(JEWEL_CASE_MOTION.swingStartMs)
    assert.ok(at50 > 5 && at50 <= JEWEL_CASE_MOTION.latchAngle, `latch at +50 ms: ${at50}°`)
    for (let t = 1; t <= 50; t++) assert.ok(lidAngleOpening(t) > lidAngleOpening(t - 1), `the pop keeps lifting at ${t} ms`)
  })
  test('the swing takes over mid-pop without a jump', () => {
    const t = JEWEL_CASE_MOTION.swingStartMs
    const before = lidAngleOpening(t) - lidAngleOpening(t - 1)
    const after = lidAngleOpening(t + 1) - lidAngleOpening(t)
    assert.ok(Math.abs(lidAngleOpening(t + 0.01) - lidAngleOpening(t)) < 0.05, 'continuous')
    assert.ok(after > 0 && Math.abs(after - before) < 1, `velocity carries over (${before.toFixed(3)} → ${after.toFixed(3)} °/ms)`)
  })
  test('the spring overshoots ~3° near +0.30 s and settles by ~+0.45 s (the phone spec)', () => {
    let peak = 0
    let peakAt = 0
    for (let t = 0; t <= 800; t++) {
      const d = lidAngleOpening(t)
      if (d > peak) { peak = d; peakAt = t }
    }
    near(peak, 111, 1, 'peak')
    near(peakAt, 300, 30, 'peak time')
    for (let t = 460; t <= 800; t += 5) near(lidAngleOpening(t), JEWEL_CASE.openAngle, 0.5, `settled at ${t} ms`)
  })
  test('the lid is past 90° (its inside showing) before the disc lifts', () => {
    assert.ok(lidAngleOpening(JEWEL_CASE_MOTION.liftStartMs) > 100)
    assert.ok(lidLook(lidAngleOpening(JEWEL_CASE_MOTION.liftStartMs)).inside)
  })
  test('the frames sample the same curve and end settled', () => {
    const f = lidOpeningFrames(10, 520)
    assert.equal(f[0].t, 0)
    assert.equal(f.at(-1)!.t, 520)
    for (const x of f) near(x.deg, lidAngleOpening(x.t), 1e-9)
    near(f.at(-1)!.deg, JEWEL_CASE.openAngle, 0.3)
  })
})

describe('hinge, direction and faces', () => {
  const g = jewelCaseGeometry(240)
  test('CSS angle is negative: the free edge comes TOWARD the viewer and the hinge stays put', () => {
    assert.equal(cssLidAngle(0), 0)
    assert.equal(cssLidAngle(JEWEL_CASE.openAngle), -JEWEL_CASE.openAngle)
    for (let deg = 5; deg < 180; deg += 5) {
      assert.ok(lidPointDepth(cssLidAngle(deg), g.width) > 0, `free edge toward the viewer at ${deg}°`)
      near(lidPointDepth(cssLidAngle(deg), 0), 0, 1e-12, 'the hinge never moves')
    }
  })
  test('outside until the camera passes the lid plane (~83.7°), inside after — never the art mirrored', () => {
    for (let deg = 0; deg <= 83; deg++) assert.equal(lidLook(deg).inside, false, `${deg}°`)
    for (let deg = 84; deg <= 180; deg++) assert.equal(lidLook(deg).inside, true, `${deg}°`)
    assert.ok(lidOpenLook().inside)
  })
  test('shading: the outside dims to 0.36 as it turns away, the paper never past 0.16', () => {
    assert.equal(lidLook(0).frontShade, 0)
    near(lidLook(90).frontShade, 0.36, 1e-9)
    for (let deg = 0; deg <= 180; deg += 3) {
      const l = lidLook(deg)
      assert.ok(l.frontShade >= 0 && l.frontShade <= 0.36 + 1e-9)
      assert.ok(l.insideShade >= 0 && l.insideShade <= 0.16 + 1e-9)
    }
    near(lidLook(108).insideShade, 0.16 * (1 - Math.cos((72 * Math.PI) / 180)), 1e-9)
  })
  test('the lid shadow sweeps from the free edge back to the hinge; the reflection is gone by 45°', () => {
    assert.equal(lidLook(0).shadowOpacity, 0)
    assert.equal(lidLook(12).shadowOpacity, 1)
    assert.equal(lidLook(10).shadowWidth, 1)
    let prev = 1
    for (let deg = 20; deg <= 108; deg += 4) {
      const w = lidLook(deg).shadowWidth
      assert.ok(w <= prev + 1e-9, `the shadow only retreats (${deg}°)`)
      prev = w
    }
    assert.ok(lidLook(108).shadowWidth < 0.05)
    assert.equal(lidLook(0).reflection, 1)
    assert.equal(lidLook(45).reflection, 0)
    near(lidLook(0).glossAt, 0.3, 1e-9)
    near(lidLook(90).glossAt, 0.65, 1e-9)
    near(lidLook(108).glossAt, 0.65, 1e-9)
  })
})

describe('the lid closing (Back)', () => {
  test('from open to shut, accelerating, stopping dead — no bounce', () => {
    const n = JEWEL_CASE_MOTION.snapMs
    near(lidAngleClosing(0), JEWEL_CASE.openAngle, 1e-9)
    assert.equal(lidAngleClosing(n), 0)
    for (let t = 1; t <= n; t++) {
      assert.ok(lidAngleClosing(t) <= lidAngleClosing(t - 1) + 1e-9, `never reopens (${t} ms)`)
      assert.ok(lidAngleClosing(t) >= 0, 'never past shut')
    }
    const first = JEWEL_CASE.openAngle - lidAngleClosing(40)
    const last = lidAngleClosing(n - 40)
    assert.ok(last > 4 * first, `accelerates: first 40 ms ${first.toFixed(1)}°, last 40 ms ${last.toFixed(1)}°`)
    assert.ok(lidAngleClosing(n - 10) > 5, 'still at speed 10 ms before contact (a hard stop, not an ease-in)')
  })
  test('the frames end shut with the reflection back', () => {
    const f = lidClosingFrames(10)
    assert.equal(f[0].deg, JEWEL_CASE.openAngle)
    assert.equal(f.at(-1)!.deg, 0)
    assert.equal(f.at(-1)!.t, JEWEL_CASE_MOTION.snapMs)
    assert.equal(f.at(-1)!.reflection, 1)
    assert.equal(f.at(-1)!.inside, false)
  })
})

describe('timeline (the phone spec)', () => {
  const m = JEWEL_CASE_MOTION
  test('open: pop 10° in 80 ms, swing from +50 ms, lift +0.24 s for 0.15 s, the page at +0.39 s', () => {
    assert.equal(m.latchAngle, 10)
    assert.equal(m.latchMs, 80)
    assert.equal(m.swingStartMs, 50)
    assert.equal(m.springResponse, 0.34)
    assert.equal(m.springDamping, 0.74)
    assert.equal(m.liftStartMs, 240)
    assert.equal(m.liftMs, 150)
    assert.equal(m.navigateAtMs, m.liftStartMs + m.liftMs, 'the page comes out once the disc has topped out')
    assert.equal(m.liftScale, 1.06)
  })
  test('back: the page shrinks into the disc, the disc drops at +0.26 s, the lid shuts +0.34 → +0.58 s', () => {
    assert.equal(m.returnMorphMs, m.dropAtMs, 'the disc drops as the page lands in it')
    assert.equal(m.dropMs, 100)
    assert.equal(m.snapAtMs, 340)
    assert.equal(m.snapMs, 240)
    assert.equal(m.snapAtMs + m.snapMs, 580)
    assert.deepEqual([...m.snapCurve], [0.55, 0, 0.9, 0.5])
  })
  test('the transition waits for images only briefly', () => {
    assert.ok(DISC_HANDOFF_TIMING.readyCapMs <= 250)
    assert.ok(DISC_HANDOFF_TIMING.morphMs >= 300 && DISC_HANDOFF_TIMING.morphMs <= 600)
  })
})

describe('jewelCaseGeometry', () => {
  test('the phone case at its own size', () => {
    const g = jewelCaseGeometry(160)
    assert.equal(g.scale, 1)
    assert.equal(g.width, 171.5)
    assert.equal(g.height, 165)
    assert.equal(g.camera, 800)
    assert.equal(g.cameraX, 89)
    assert.equal(g.cameraY, 25)
    assert.equal(g.disc, 150)
  })
  test('the desktop front cover (240 px): everything × 1.5, the art keeps its place, hinge strip on the LEFT', () => {
    const g = jewelCaseGeometry(240)
    assert.equal(g.scale, 1.5)
    assert.equal(g.spine, 13.5)
    assert.equal(g.rim, 3.75)
    assert.equal(g.width, 13.5 + 240 + 3.75)
    assert.equal(g.height, 240 + 7.5)
    assert.ok(g.spine > g.rim, 'the hinge side is the wide one')
    assert.equal(g.camera, 1200)
    assert.equal(g.cameraX, g.spine + 120, 'camera on the art centre')
    assert.equal(g.cameraY, 37.5)
    assert.equal(g.disc, 225)
    assert.ok(g.disc < g.art)
  })
  test('disc rings run centre-out', () => {
    const r = JEWEL_CASE.discRadii
    assert.ok(r.hole < r.clear && r.clear < r.mirror && r.mirror < r.label && r.label < r.outer)
    assert.equal(r.outer * 2, JEWEL_CASE.disc)
  })
})

describe('discHandoffKind — when the album page comes out of / goes back into the disc', () => {
  const home = { view: 'home', albumKey: null }
  const page = (k: string) => ({ view: 'album-detail', albumKey: k })
  const songs = { view: 'songs', albumKey: null }
  test('open: Home → the armed album only', () => {
    assert.equal(discHandoffKind(home, page('a'), { albumKey: 'a' }, null), 'open')
    assert.equal(discHandoffKind(home, page('b'), { albumKey: 'a' }, null), null, 'a different album')
    assert.equal(discHandoffKind(home, page('a'), null, null), null, 'not armed (a plain click elsewhere)')
    assert.equal(discHandoffKind(songs, page('a'), { albumKey: 'a' }, null), null, 'not from Home')
  })
  test('close: that album page → straight back to Home', () => {
    assert.equal(discHandoffKind(page('a'), home, null, { albumKey: 'a' }), 'close')
    assert.equal(discHandoffKind(page('b'), home, null, { albumKey: 'a' }), null, 'a different album page')
    assert.equal(discHandoffKind(page('a'), songs, null, { albumKey: 'a' }), null, 'not to Home')
    assert.equal(discHandoffKind(page('a'), home, null, null), null, 'never opened from the case')
  })
  test('Home isn\'t the page you came from → no reverse', () => {
    // Home → a (case) → the artist → back to a → Home: the artist hop forgot the case.
    let opened: { albumKey: string } | null = { albumKey: 'a' }
    const artist = { view: 'artist-detail', albumKey: null }
    if (!keepOpenedAfter(artist, opened)) opened = null
    assert.equal(discHandoffKind(artist, page('a'), null, opened), null)
    assert.equal(discHandoffKind(page('a'), home, null, opened), null)
  })
  test('keepOpenedAfter: only while still on its page', () => {
    assert.equal(keepOpenedAfter(page('a'), { albumKey: 'a' }), true)
    assert.equal(keepOpenedAfter(page('b'), { albumKey: 'a' }), false)
    assert.equal(keepOpenedAfter(home, { albumKey: 'a' }), false)
    assert.equal(keepOpenedAfter(page('a'), null), false)
  })
  test('sameHandoffLoc: album pages compare by key, other views by name', () => {
    assert.ok(sameHandoffLoc(home, { view: 'home', albumKey: 'stale' }))
    assert.ok(sameHandoffLoc(page('a'), page('a')))
    assert.ok(!sameHandoffLoc(page('a'), page('b')))
    assert.ok(!sameHandoffLoc(home, songs))
  })
})
