// Classic Cover Flow geometry (src/common/cover-flow.ts) — the launch page's
// Island Albums row. The approved mockup's numbers at its 1104px stage, the
// transform the renderer composes, stepping, keys, and odd inputs.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { coverFlowPoses, clampCoverIndex, stepCover, coverFlowKeyDelta, COVER_FLOW_DEFAULTS } from '../../common/cover-flow.ts'

describe('coverFlowPoses — the mockup at a 1104px stage (1280 − 2 × 88)', () => {
  const poses = coverFlowPoses(10, 3, { width: 1104 })

  test('the chosen cover faces you, centred, 240px, on top', () => {
    const c = poses[3]
    assert.equal(c.offset, 0)
    assert.equal(c.left, 552 - 120)
    assert.equal(c.top, 12)
    assert.equal(c.size, 240)
    assert.equal(c.rotateY, 0)
    assert.equal(c.scale, 1)
    assert.equal(c.zIndex, 100)
    assert.deepEqual([c.tx, c.ty], [432, 12])
  })

  test('side covers: 190px, 37px down, turned 62° toward the centre, 175px then +70px out', () => {
    const l1 = poses[2]
    const r1 = poses[4]
    const r2 = poses[5]
    assert.equal(l1.left, 552 - 175 - 95)
    assert.equal(r1.left, 552 + 175 - 95)
    assert.equal(r2.left, 552 + 245 - 95)
    assert.equal(l1.rotateY, 62)
    assert.equal(r1.rotateY, -62)
    for (const p of [l1, r1, r2]) { assert.equal(p.size, 190); assert.equal(p.top, 37) }
  })

  test('nearer covers stack over farther ones', () => {
    assert.ok(poses[4].zIndex > poses[5].zIndex)
    assert.ok(poses[2].zIndex > poses[1].zIndex)
    assert.equal(poses[2].zIndex, poses[4].zIndex)
  })

  test('the transform reproduces the drawn box: a 240 box scaled about its centre', () => {
    for (const p of poses) {
      const visualLeft = p.tx + (240 - 240 * p.scale) / 2
      const visualTop = p.ty + (240 - 240 * p.scale) / 2
      assert.ok(Math.abs(visualLeft - p.left) < 1e-9)
      assert.ok(Math.abs(visualTop - p.top) < 1e-9)
      assert.ok(Math.abs(240 * p.scale - p.size) < 1e-9)
    }
  })

  test('covers pushed past the stage edges are marked off-stage', () => {
    const atStart = coverFlowPoses(10, 0, { width: 1104 })
    assert.equal(atStart[0].onStage, true)
    assert.equal(atStart[6].onStage, true)                              // 552 + 525 − 95 = 982 < 1104
    assert.equal(atStart[9].onStage, false)                             // 552 + 735 − 95 = 1192 ≥ 1104
  })

  test('a narrow stage keeps the centre centred', () => {
    const narrow = coverFlowPoses(4, 1, { width: 600 })
    assert.equal(narrow[1].left, 300 - 120)
    assert.equal(narrow[3].onStage, true)                               // 300 + 245 − 95 = 450
  })
})

describe('stepping and keys', () => {
  test('clamp: out-of-range, fractional and NaN indices land on a real cover', () => {
    assert.equal(clampCoverIndex(-3, 10), 0)
    assert.equal(clampCoverIndex(42, 10), 9)
    assert.equal(clampCoverIndex(2.6, 10), 3)
    assert.equal(clampCoverIndex(Number.NaN, 10), 0)
    assert.equal(clampCoverIndex(5, 0), 0)
  })

  test('steps stop at the ends — the row is ranked, it does not wrap', () => {
    assert.equal(stepCover(0, -1, 10), 0)
    assert.equal(stepCover(0, 1, 10), 1)
    assert.equal(stepCover(9, 1, 10), 9)
  })

  test('←/→ only', () => {
    assert.equal(coverFlowKeyDelta('ArrowLeft'), -1)
    assert.equal(coverFlowKeyDelta('ArrowRight'), 1)
    assert.equal(coverFlowKeyDelta('ArrowUp'), 0)
    assert.equal(coverFlowKeyDelta('Enter'), 0)
  })

  test('an empty list has no poses; the active index is clamped into a short list', () => {
    assert.deepEqual(coverFlowPoses(0, 0, { width: 1104 }), [])
    const p = coverFlowPoses(3, 7, { width: 1104 })
    assert.equal(p[2].offset, 0)
    assert.equal(p.length, 3)
  })

  test('defaults are the mockup’s', () => {
    assert.deepEqual(COVER_FLOW_DEFAULTS, { centerSize: 240, sideSize: 190, centerTop: 12, sideTop: 37, firstGap: 175, step: 70, angle: 62 })
  })
})
