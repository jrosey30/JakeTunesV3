/**
 * The guarded library publish and a song Jake deleted (2026-11-12): dates the way
 * JavaScript writes them, read the same on homemini's Python (/usr/bin/python3) and
 * on PATH's. Split from sync-script-publish-deletions.test.ts (the story is there);
 * the shared rig is sync-script-publish-rig.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { ALBUM, DAY, HOUR, NOW, OLD, PYTHONS, type Row, T, offsetMs, publish } from './sync-script-publish-rig.ts'

describe('guarded publish: dates the way JavaScript writes them, on every Python', () => {
  const INCOMING = [...OLD, ...ALBUM]
  // Fixed instants around a deletion at 2026-11-12T18:13:42.6Z, moved to "about now"
  // by keeping the row inside the 30-day window: the row is added a few hours ago.
  const base = new Date(NOW - 3 * HOUR)
  const stamp = (d: Date, shape: 'ms' | 'one' | 'none' | 'six' | 'offset' | 'lower') => {
    const z = d.toISOString()                    // 2026-11-12T18:13:42.620Z
    const head = z.slice(0, 19)
    if (shape === 'ms') return z
    if (shape === 'one') return `${head}.${z.slice(20, 21)}Z`
    if (shape === 'none') return `${head}Z`
    if (shape === 'six') return `${head}.${z.slice(20, 23)}000Z`
    if (shape === 'lower') return z.replace('T', 't').replace('Z', 'z')
    const shifted = new Date(d.getTime() + 5.5 * HOUR).toISOString()
    return `${shifted.slice(0, 23)}+05:30`
  }

  it('every shape of the same instant is read as that instant', () => {
    const shapes = ['ms', 'one', 'none', 'six', 'offset', 'lower'] as const
    const added = base
    const later = new Date(base.getTime() + HOUR)
    const earlier = new Date(base.getTime() - HOUR)
    for (const a of shapes) {
      for (const d of shapes) {
        const lost: Row = { id: 15122, title: 'Save Yourself', dateAdded: stamp(added, a), audioFingerprint: 'dc6b107e' }
        const after = publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: T({ audioFingerprint: 'dc6b107e', deletedAt: stamp(later, d) }) })
        assert.equal(after.out, 'published 4', `added ${a}, deleted an hour later ${d}`)
        const before = publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: T({ audioFingerprint: 'dc6b107e', deletedAt: stamp(earlier, d) }) })
        assert.match(before.out, /^refused-/, `added ${a}, deleted an hour EARLIER ${d}`)
      }
    }
  })

  /** x as wall-clock digits in a zone, no zone written: "2026-11-12T13:00:15". */
  const wall = (ms: number, tz: string) => new Date(ms).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')
  const lostAt = (dateAdded: string): Row => ({ id: 15122, title: 'Save Yourself', dateAdded, audioFingerprint: 'dc6b107e' })
  const deletedAtMs = (ms: number) => T({ audioFingerprint: 'dc6b107e', deletedAt: new Date(ms).toISOString() })
  const verdict = (dateAdded: string, deletedMs: number, tz: string) =>
    publish({ homemini: [...OLD, lostAt(dateAdded)], incoming: INCOMING, tombstones: deletedAtMs(deletedMs) }, tz).out

  it('a date with no time is the LATER of UTC midnight and local midnight, so it is never excused early', () => {
    const day = new Date(NOW - 2 * DAY).toISOString().slice(0, 10)
    const utcMidnight = Date.parse(day)
    for (const tz of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
      const localMidnight = utcMidnight - offsetMs(tz, utcMidnight - offsetMs(tz, utcMidnight))   // the offset in force AT local midnight
      const later = Math.max(utcMidnight, localMidnight)
      assert.equal(verdict(day, later, tz), 'published 4', `${tz}: deleted at the later midnight`)
      assert.match(verdict(day, later - 1000, tz), /^refused-/, `${tz}: deleted a second before the later midnight`)
    }
  })

  it('a time with no zone is local time, as JavaScript reads it', () => {
    const x = base.getTime() - (base.getTime() % 1000)
    for (const tz of ['America/New_York', 'Asia/Kolkata']) {
      assert.equal(verdict(wall(x, tz), x + 1000, tz), 'published 4', `${tz}: deleted a second after`)
      assert.match(verdict(wall(x, tz), x - 1000, tz), /^refused-/, `${tz}: deleted a second before`)
    }
  })

  it("an offset's sign matters: +05:00 is five hours east, -05:00 five hours west", () => {
    const x = base.getTime() - (base.getTime() % 1000)
    const written = (sign: '+' | '-') => `${new Date(x + (sign === '+' ? 5 : -5) * HOUR).toISOString().slice(0, 19)}${sign}05:00`
    for (const sign of ['+', '-'] as const) {
      assert.equal(verdict(written(sign), x + 1000, 'UTC'), 'published 4', `${sign}05:00, deleted a second after`)
      assert.match(verdict(written(sign), x - 1000, 'UTC'), /^refused-/, `${sign}05:00, deleted a second before`)
    }
    // And on the deletion: the same instant written both ways excuses the same song.
    for (const sign of ['+', '-'] as const) {
      const del = (ms: number) => T({ audioFingerprint: 'dc6b107e', deletedAt: `${new Date(ms + (sign === '+' ? 5 : -5) * HOUR).toISOString().slice(0, 19)}${sign}05:00` })
      const lost = lostAt(new Date(x).toISOString())
      assert.equal(publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: del(x + 1000) }, 'UTC').out, 'published 4')
      assert.match(publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: del(x - 1000) }, 'UTC').out, /^refused-/)
    }
  })

  it("homemini's own Python is one of the interpreters wherever it exists", () => {
    if (existsSync('/usr/bin/python3')) assert.equal(PYTHONS[0], '/usr/bin/python3')
  })
})
