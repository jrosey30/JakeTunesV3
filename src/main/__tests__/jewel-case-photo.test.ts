// The photographed jewel case (src/common/jewel-case-photo.ts): the numbers
// the album page and the Home case lay the photo's layers out with. They
// are measured on the photo, so they are locked to the shipped asset: the
// frame PNG's own pixel box must have the case's aspect, the booklet window
// must sit inside the case with the hinge strip to its left, and the Home
// geometry must keep the phone's camera, disc and motion scale.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JEWEL_CASE_PHOTO, jewelCasePhotoVars, photoCaseGeometry } from '../../common/jewel-case-photo.ts'
import { JEWEL_CASE, jewelCaseGeometry } from '../../common/jewel-case.ts'

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'assets', 'jewel-case')
const pngSize = (name: string): { w: number; h: number } => {
  const b = readFileSync(join(ASSETS, name))
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `${name} is a PNG`)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

describe('JEWEL_CASE_PHOTO', () => {
  test('the booklet window sits inside the case, the hinge strip left of it', () => {
    const p = JEWEL_CASE_PHOTO
    assert.ok(p.winLeft > 0 && p.winTop > 0)
    assert.ok(p.winLeft + 1 < p.caseW, 'a rim right of the booklet')
    assert.ok(p.winTop + 1 < p.caseH, 'a rim under the booklet')
    assert.ok(p.stripLeft < p.stripRight && p.stripRight < p.winLeft, 'the strip ends before the booklet')
    assert.ok(p.stripTop < p.stripBottom && p.stripBottom <= p.caseH)
    assert.ok(p.winLeft > p.caseW - p.winLeft - 1, 'the hinge side is the wide one')
  })
  test('the frame and lid PNGs are the case box; the shadow adds its margin', () => {
    const p = JEWEL_CASE_PHOTO
    const frame = pngSize('case-frame.png')
    const lid = pngSize('case-lid.png')
    const shadow = pngSize('case-shadow.png')
    assert.deepEqual(lid, frame)
    assert.ok(Math.abs(frame.w / frame.h - p.caseW / p.caseH) < 0.004, `frame ${frame.w}x${frame.h} has the case's aspect`)
    const shadowW = (p.caseW + 2 * p.shadowMargin) / p.caseW
    assert.ok(Math.abs(shadow.w / frame.w - shadowW) < 0.004, 'the shadow is the case plus its margin')
    assert.ok(frame.w >= 2 * 1.18 * 340, 'at least 2x of the album page case')
  })
  test('CSS vars: one per number, kebab-cased, six decimals', () => {
    const v = jewelCasePhotoVars('--apd-f-')
    assert.equal(Object.keys(v).length, Object.keys(JEWEL_CASE_PHOTO).length)
    assert.equal(v['--apd-f-case-w'], (2840 / 2400).toFixed(6))
    assert.equal(v['--apd-f-win-left'], '0.125000')
    assert.equal(v['--apd-f-strip-bottom'], (2440 / 2400).toFixed(6))
  })
})

describe('photoCaseGeometry', () => {
  test('the Home front cover (240 px): the art keeps its place, the case is the photo, the rest is the phone', () => {
    const g = photoCaseGeometry(240)
    const twin = jewelCaseGeometry(240)
    assert.equal(g.art, 240)
    assert.equal(g.scale, 1.5)
    assert.equal(g.spine, 0.125 * 240)
    assert.equal(g.rim, (28 / 2400) * 240)
    assert.equal(g.width, (2840 / 2400) * 240)
    assert.equal(g.height, (2500 / 2400) * 240)
    assert.ok(g.spine > g.rim, 'the hinge side is the wide one')
    assert.equal(g.cameraX, g.spine + 120, 'camera on the art centre')
    assert.equal(g.camera, twin.camera)
    assert.equal(g.cameraY, twin.cameraY)
    assert.equal(g.disc, twin.disc)
    assert.equal(g.disc, JEWEL_CASE.disc * 1.5)
    assert.ok(g.disc < g.art)
    assert.ok(g.width > twin.width && g.height > twin.height, 'a real case is wider than the drawn one')
  })
})
