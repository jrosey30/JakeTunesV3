/**
 * Activity Sync front end: the pure models. The engine's phases are replayed
 * as it really sends them; every failure literal in the engine and the sync
 * IPC must map to plain words that say whether the iPod changed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDLE_TIMELINE, applySyncResult, reduceSyncEvent, resultLine, startTimeline, timelinePercent, type SyncEvent } from '../../common/sync-progress-model.ts'
import { syncFailureCopy } from '../../common/sync-failure-copy.ts'

const T0 = 1_000_000
const ev = (phase: SyncEvent['phase'], current: number, total: number, title = ''): SyncEvent => ({ phase, current, total, title })
const REAL_RUN: SyncEvent[] = [
  ev('preflight', 0, 100, 'Checking files'), ev('preflight', 100, 100),
  ev('copy', 0, 1, 'Wiping the iPod for a clean rebuild…'),
  ev('copy', 1, 100, 'Once In a Lifetime'), ev('copy', 100, 100, 'Road to Nowhere'),
  ev('verify', 1, 16, 'Remounting to verify (attempt 1 of 16)'),
  ev('db', 0, 1, 'Writing iTunesDB...'), ev('db', 1, 1, 'iTunesDB written'),
  ev('verify', 1, 1, 'Sealing'),
]

describe('sync timeline', () => {
  it('walks the six steps in the engine’s real order and tells Verify from Seal', () => {
    let t = startTimeline(T0, 100)
    const seen: string[] = []
    for (const e of REAL_RUN) { t = reduceSyncEvent(t, e, T0 + 1); if (t.step && seen[seen.length - 1] !== t.step) seen.push(t.step) }
    assert.deepEqual(seen, ['prepare', 'wipe', 'copy', 'verify', 'catalog', 'seal'])
    assert.equal(t.status, 'running')
    t = applySyncResult(t, { ok: true, landed: 100, target: 100, sealedOk: true, copied: 100 }, T0 + 60_000)
    assert.equal(t.status, 'done'); assert.equal(timelinePercent(t), 100)
    assert.equal(resultLine(t, () => '9:41 AM'), 'Landed 100 of 100 — verified on the card, 9:41 AM')
  })
  it('percent climbs within a step from the engine’s counts', () => {
    let t = startTimeline(T0, 100)
    t = reduceSyncEvent(t, ev('copy', 0, 1, 'Wiping…'), T0)
    t = reduceSyncEvent(t, ev('copy', 50, 100, 'x'), T0)
    assert.equal(t.step, 'copy'); assert.equal(timelinePercent(t), Math.round(((2 + 0.5) / 6) * 100))
  })
  it('a cancel mid-copy lands on cancelled with what was copied, and late events are ignored', () => {
    let t = startTimeline(T0, 100)
    t = reduceSyncEvent(t, ev('copy', 40, 100, 'x'), T0)
    t = reduceSyncEvent(t, ev('cancelled', 40, 100), T0 + 5)
    assert.equal(t.status, 'cancelled'); assert.equal(t.copied, 40); assert.equal(t.step, 'copy')
    const after = reduceSyncEvent(t, ev('db', 1, 1), T0 + 6)
    assert.equal(after.status, 'cancelled')
    const r = applySyncResult(startTimeline(T0, 100), { ok: false, cancelled: true, copied: 40 }, T0 + 9)
    assert.equal(r.status, 'cancelled')
  })
  it('never says done when fewer landed than the target or the seal failed', () => {
    const short = applySyncResult(startTimeline(T0, 1000), { ok: true, landed: 998, target: 1000, sealedOk: true }, T0)
    assert.equal(short.status, 'failed'); assert.match(short.error!, /Only 998 of 1000/)
    const unsealed = applySyncResult(startTimeline(T0, 500), { ok: true, landed: 500, target: 500, sealedOk: false }, T0)
    assert.equal(unsealed.status, 'failed')
    const failed = applySyncResult(startTimeline(T0, 500), { ok: false, error: 'Activity TSA boarded 3 for a 500-song set. Nothing was wiped.' }, T0)
    assert.equal(failed.status, 'failed'); assert.match(failed.error!, /TSA/)
    assert.equal(resultLine(failed, () => ''), null)
  })
  it('an engine error event fails the timeline with the engine’s words kept', () => {
    const t = reduceSyncEvent(startTimeline(T0, 10), ev('error', 0, 0, 'Activity wipe failed (EIO). Nothing was copied.'), T0)
    assert.equal(t.status, 'failed'); assert.match(t.error!, /wipe failed/)
    assert.equal(reduceSyncEvent(IDLE_TIMELINE, ev('preflight', 1, 2), T0).status, 'running')
  })
})

describe('sync failure copy', () => {
  it('says what happened, whether the iPod changed, and what to do — with the original kept', () => {
    const c = syncFailureCopy('Only 998 of 1000 songs held across two remounts. Not writing a catalog (N means N). Sync again.')
    assert.equal(c.stage, 'verify'); assert.equal(c.changed, 'partial'); assert.match(c.changedLine, /previous catalog stands/)
    assert.match(c.next, /Sync again/); assert.match(c.raw, /N means N/)
    const tsa = syncFailureCopy('Activity TSA boarded 3 for a 500-song set. Nothing was wiped.')
    assert.equal(tsa.changed, 'no'); assert.equal(tsa.stage, 'prepare')
  })
  it('says plainly when the iPod’s state is unknown', () => {
    const u = syncFailureCopy('something the engine never said')
    assert.equal(u.changed, 'unknown'); assert.match(u.changedLine, /not known/); assert.equal(u.raw, 'something the engine never said')
    assert.equal(syncFailureCopy('Activity wipe failed (EIO). Nothing was copied.').changed, 'unknown')
  })
  it('every failure literal the engine and the sync IPC can emit has a mapping', () => {
    const files = ['src/main/ipod-activity-engine.ts', 'src/main/workout-sync-ipc.ts']
    const literals: string[] = []
    for (const f of files) {
      const src = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8')
      for (const m of src.matchAll(/error:\s*(?:'([^']+)'|`([^`]+)`)/g)) {
        const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '7')
        if (raw.trim()) literals.push(raw)
      }
    }
    assert.ok(literals.length >= 15, `expected the engine's catalogue, found ${literals.length}`)
    const unmapped = literals.filter((l) => syncFailureCopy(l).stage === null)
    assert.deepEqual(unmapped, [], 'unmapped engine failures')
  })
})
