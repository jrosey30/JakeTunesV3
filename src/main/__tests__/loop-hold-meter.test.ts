import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLoopHoldMeter } from '../loop-hold-meter.ts'

/** Fake clocks the test moves by hand. */
function clocks() {
  const c = { mono: 0, wall: 1_000_000, cpu: 0 }
  return {
    c,
    api: { mono: () => c.mono, wall: () => c.wall, cpu: () => c.cpu },
    /** One tick that arrives `elapsed` ms after the last, using `cpu` ms of CPU and `wall` ms of wall clock. */
    advance(elapsed: number, cpu: number, wall = elapsed) { c.mono += elapsed; c.cpu += cpu; c.wall += wall },
  }
}

describe('loop hold meter', () => {
  it('reports nothing when every tick is on time', () => {
    const k = clocks()
    const m = createLoopHoldMeter(k.api, 100, 150)
    for (let i = 0; i < 50; i++) { k.advance(100, 2); m.tick() }
    assert.equal(m.take(), null)
  })

  it('a hold the app spent working carries its CPU time (the code)', () => {
    const k = clocks()
    const m = createLoopHoldMeter(k.api, 100, 150)
    k.advance(100, 1); m.tick()
    k.advance(2100, 1950); m.tick()   // 2 s late, ~2 s of CPU
    const r = m.take()
    assert.ok(r)
    assert.equal(r.count, 1)
    assert.equal(r.max, 2000)
    assert.equal(r.cpuMs, 1950)
    assert.equal(r.wallMs, 2100)
    assert.equal(r.sinceSuspendMs, null)
  })

  it('a hold the app spent waiting on the Mac carries almost no CPU', () => {
    const k = clocks()
    const m = createLoopHoldMeter(k.api, 100, 150)
    k.advance(20_100, 40); m.tick()   // 20 s late, 40 ms of CPU: App Nap or a starved machine
    const r = m.take()
    assert.ok(r)
    assert.equal(r.max, 20_000)
    assert.equal(r.cpuMs, 40)
  })

  it('a sleep shows as wall time far over the hold, and as a recent suspend', () => {
    const k = clocks()
    const m = createLoopHoldMeter(k.api, 100, 150)
    k.advance(100, 1); m.tick()
    m.suspend()
    k.advance(400, 2, 15 * 60_000)    // the monotonic clock barely moved; the wall moved 15 min
    m.tick()
    k.advance(0, 0, 5_000)            // the report comes 5 s after the tick
    const r = m.take()
    assert.ok(r)
    assert.equal(r.max, 300)
    assert.equal(r.wallMs, 15 * 60_000)
    assert.equal(r.sinceSuspendMs, 15 * 60_000 + 5_000)
  })

  it('the numbers are the longest hold’s, and each window starts fresh', () => {
    const k = clocks()
    const m = createLoopHoldMeter(k.api, 100, 150)
    k.advance(600, 500); m.tick()     // 500 late, busy
    k.advance(5100, 10); m.tick()     // 5000 late, idle: the longest
    k.advance(400, 300); m.tick()     // 300 late
    const r = m.take()
    assert.ok(r)
    assert.equal(r.count, 3)
    assert.equal(r.max, 5000)
    assert.equal(r.cpuMs, 10)
    assert.equal(r.wallMs, 5100)
    k.advance(100, 1); m.tick()
    assert.equal(m.take(), null)
  })

  it('a late tick under the threshold is not a hold', () => {
    const k = clocks()
    const m = createLoopHoldMeter(k.api, 100, 150)
    k.advance(250, 100); m.tick()     // exactly 150 late: not over
    assert.equal(m.take(), null)
  })

  it('the usage log sends the meter’s numbers with every main.loop-held', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'usage-log-start.ts'), 'utf-8')
    assert.match(src, /createLoopHoldMeter\(/)
    assert.match(src, /powerMonitor\.on\('suspend'/)
    const line = src.split('\n').find((l) => l.includes("'main.loop-held'")) ?? ''
    for (const key of ['cpuMs', 'wallMs', 'sinceSuspendMs']) assert.ok(line.includes(key), `main.loop-held carries ${key}`)
  })
})
