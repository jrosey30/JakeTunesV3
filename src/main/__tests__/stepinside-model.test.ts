import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { digStart, digFlip, digTogglePull, digAtEdge, digPosition } from '../../renderer/views/RecordStore/stepinside/digModel.ts'
import { bodyStart, stepBody, gait, resolveCollisions, angleDelta, WALK_SPEED } from '../../renderer/views/RecordStore/stepinside/playerModel.ts'

describe('digging a crate', () => {
  it('is a stack with ends, not a carousel', () => {
    let d = digStart()
    assert.deepEqual(digPosition(d, 10), { at: 1, of: 10 })
    assert.equal(digAtEdge(d, 10), 'front')
    // Back past the front sleeve does nothing — that IS the front.
    d = digFlip(d, -1, 10)
    assert.equal(d.index, 0)
    // And the last sleeve is the back of the bin, not a wrap to the first.
    d = digFlip(d, 99, 10)
    assert.equal(d.index, 9)
    assert.equal(digAtEdge(d, 10), 'back')
    d = digFlip(d, 1, 10)
    assert.equal(d.index, 9)
  })

  it('puts a pulled record back when you flip past it', () => {
    let d = digTogglePull(digStart())
    assert.equal(d.pulled, true)
    d = digFlip(d, 1, 5)
    assert.equal(d.pulled, false, 'you cannot carry one sleeve into the next')
  })

  it('survives an empty crate', () => {
    const d = digFlip(digStart(), 1, 0)
    assert.deepEqual(d, { index: 0, pulled: false })
    assert.equal(digAtEdge(d, 0), null)
    assert.deepEqual(digPosition(d, 0), { at: 0, of: 0 })
  })
})

describe('walking', () => {
  it('accelerates into a walk instead of snapping to full speed', () => {
    const first = stepBody(bodyStart(), 0, -1, 1 / 60)
    assert.ok(Math.hypot(first.vx, first.vz) < WALK_SPEED * 0.5, 'one frame is not full speed')
    let b = bodyStart()
    for (let i = 0; i < 120; i++) b = stepBody(b, 0, -1, 1 / 60)
    assert.ok(Math.abs(Math.hypot(b.vx, b.vz) - WALK_SPEED) < 0.05, 'and it does reach walking pace')
  })

  it('coasts to a stop rather than halting dead', () => {
    let b = bodyStart()
    for (let i = 0; i < 120; i++) b = stepBody(b, 0, -1, 1 / 60)
    const moving = Math.hypot(b.vx, b.vz)
    b = stepBody(b, 0, 0, 1 / 60)
    const justAfter = Math.hypot(b.vx, b.vz)
    assert.ok(justAfter > 0 && justAfter < moving, 'still drifting, but slowing')
  })

  it('does not let diagonals outrun the straights', () => {
    let straight = bodyStart()
    let diagonal = bodyStart()
    for (let i = 0; i < 200; i++) {
      straight = stepBody(straight, 0, -1, 1 / 60)
      diagonal = stepBody(diagonal, 1, -1, 1 / 60)
    }
    const s = Math.hypot(straight.vx, straight.vz)
    const d = Math.hypot(diagonal.vx, diagonal.vz)
    assert.ok(Math.abs(s - d) < 0.05, `diagonal ${d.toFixed(2)} must match straight ${s.toFixed(2)}`)
  })

  it('feels the same at 60 and 120 Hz', () => {
    let slow = bodyStart()
    let fast = bodyStart()
    for (let i = 0; i < 60; i++) slow = stepBody(slow, 0, -1, 1 / 60)
    for (let i = 0; i < 120; i++) fast = stepBody(fast, 0, -1, 1 / 120)
    assert.ok(Math.abs(slow.z - fast.z) < 0.05, 'a second of walking covers the same ground')
  })

  it('turns the short way around', () => {
    assert.ok(Math.abs(angleDelta(0.1, -0.1) + 0.2) < 1e-9)
    // Across the seam: 350° to 10° is +20°, not -340°.
    const d = angleDelta(Math.PI * 1.95, Math.PI * 0.05)
    assert.ok(d > 0 && d < 0.4, `expected a short positive turn, got ${d}`)
  })

  it('reports gait for the walk cycle', () => {
    assert.equal(gait(bodyStart()), 0)
    let b = bodyStart()
    for (let i = 0; i < 200; i++) b = stepBody(b, 0, -1, 1 / 60)
    assert.ok(gait(b) > 0.95)
  })
})

describe('walls', () => {
  const wall = [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }]

  it('stops you entering, without sticking', () => {
    const prev = bodyStart(0, 3)
    const next = { ...prev, z: 1.2 }
    const out = resolveCollisions(prev, next, wall)
    assert.equal(out.z, prev.z, 'blocked on the axis you came in on')
  })

  it('lets you slide along a wall instead of catching on it', () => {
    // Already beside the wall on X, moving along Z: the X axis is free.
    const prev = bodyStart(1.3, 3)
    const next = { ...prev, x: 1.3, z: 1.2 }
    const out = resolveCollisions(prev, next, wall)
    assert.equal(out.x, 1.3, 'movement parallel to the wall survives')
  })

  it('leaves open floor alone', () => {
    const prev = bodyStart(5, 5)
    const next = { ...prev, x: 5.1, z: 5.1 }
    assert.deepEqual(resolveCollisions(prev, next, wall), next)
  })
})
