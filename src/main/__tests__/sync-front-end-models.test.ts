/**
 * Activity Sync front end: the pure models. The engine's phases are replayed
 * as it really sends them; every failure literal in the engine and the sync
 * IPC must map to plain words that say whether the iPod changed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IDLE_TIMELINE, applySyncResult, reduceSyncEvent, resultLine, startTimeline, timelinePercent, type SyncEvent } from '../../common/sync-progress-model.ts'
import { syncFailureCopy, syncOutcome, stoppedLabel } from '../../common/sync-failure-copy.ts'
import { ipodCountLabel } from '../../common/sync-progress-model.ts'

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
  it('reads the message for what happened and what to do, keeping the original', () => {
    const c = syncFailureCopy('Only 998 of 1000 songs held across two remounts. Not writing a catalog (N means N). Sync again.')
    assert.equal(c.stage, 'verify'); assert.match(c.next, /Sync again/); assert.match(c.raw, /N means N/)
    assert.equal(syncFailureCopy('Activity TSA boarded 3 for a 500-song set. Nothing was wiped.').stage, 'prepare')
    assert.equal(syncFailureCopy('something the engine never said').stage, null)
  })
  it('never diagnoses a failing card from a short count alone', () => {
    for (const raw of ['Only 998 of 1000 songs held across two remounts. Not writing a catalog (N means N). Sync again.', 'Only 993 of 1000 songs actually stuck on the iPod after 3 tries — the card keeps dropping writes', 'Only 990 of 1000 songs confirmed on the card after copy. Not writing a catalog']) {
      const c = syncFailureCopy(raw)
      assert.doesNotMatch(c.happened + ' ' + c.next, /card is failing|card or cable is dropping/i, raw)
      assert.match(c.next, /check the cable and the port before anything else/)
    }
  })
})

describe('sync outcome — claims from phase evidence', () => {
  const run = (events: SyncEvent[], target = 1000) => events.reduce((t, e) => reduceSyncEvent(t, e, T0), startTimeline(T0, target))
  it('pre-catalog cancellation: the engine re-empties Music — songs gone, previous catalog stands', () => {
    const t = run([ev('copy', 0, 1, 'Wiping…'), ev('copy', 40, 1000, 'x'), ev('cancelled', 40, 1000)])
    const o = syncOutcome(t)!
    assert.equal(o.stoppedAt, 'copy'); assert.equal(o.changed, 'emptied'); assert.equal(o.catalog, 'previous'); assert.equal(o.fromEvidence, true)
    assert.match(o.changedLine, /cleared again/); assert.match(o.changedLine, /previous catalog stands/); assert.equal(stoppedLabel(o), 'Stopped at Copy')
  })
  it('post-catalog seal failure: never the pre-catalog explanation — a catalog was written but not proved', () => {
    const t = applySyncResult(run([ev('copy', 1000, 1000, 'x'), ev('verify', 1, 16), ev('db', 0, 1, 'Writing iTunesDB...'), ev('db', 1, 1, 'iTunesDB written'), ev('verify', 1, 1, 'Sealing')]), { ok: false, error: 'The 1000-song catalog never committed to the card. Mac cache is not the Mini — that is how Songs became 450. Not calling this done.' }, T0)
    const o = syncOutcome(t)!
    assert.equal(o.stoppedAt, 'seal'); assert.equal(o.changed, 'catalog-unverified'); assert.equal(o.catalog, 'written-unverified')
    assert.doesNotMatch(o.changedLine, /no catalog was written|catalog was not replaced/)
    assert.match(o.changedLine, /a new catalog was written, but the card did not prove it/)
    // the engine reporting ok but short after the catalog is the same claim
    const short = applySyncResult(run([ev('db', 1, 1, 'iTunesDB written'), ev('verify', 1, 1, 'Sealing')]), { ok: true, landed: 993, target: 1000, sealedOk: true }, T0)
    assert.equal(syncOutcome(short)!.catalog, 'written-unverified')
  })
  it('verify and catalog-stage failures: new songs on the card, catalog not replaced', () => {
    const v = syncOutcome(applySyncResult(run([ev('copy', 1000, 1000, 'x'), ev('verify', 3, 16)]), { ok: false, error: 'Only 998 of 1000 songs held across two remounts. Not writing a catalog (N means N). Sync again.' }, T0))!
    assert.equal(v.changed, 'songs-only'); assert.equal(v.catalog, 'previous')
    const c = syncOutcome(applySyncResult(run([ev('copy', 1000, 1000, 'x'), ev('verify', 1, 16), ev('db', 0, 1, 'Writing iTunesDB...')]), { ok: false, error: 'The catalog could not be conformed to firmware id order (x). Previous catalog is untouched. Sync again.' }, T0))!
    assert.equal(c.stoppedAt, 'catalog'); assert.equal(c.changed, 'songs-only'); assert.equal(c.catalog, 'previous')
  })
  it('unknown state: a wipe-stage stop, or no phase evidence at all, says so', () => {
    const w = syncOutcome(applySyncResult(run([ev('copy', 0, 1, 'Wiping the iPod for a clean rebuild…')]), { ok: false, error: 'Activity wipe failed (EIO). Nothing was copied.' }, T0))!
    assert.equal(w.changed, 'unknown'); assert.match(w.changedLine, /not known/)
    const blind = syncOutcome(applySyncResult(startTimeline(T0, 500), { ok: false, error: 'ENXIO: device not configured' }, T0))!
    assert.equal(blind.fromEvidence, false); assert.equal(blind.changed, 'unknown'); assert.equal(stoppedLabel(blind), 'Stopped')
    // nothing-happened stages may be trusted from the message alone
    const tsa = syncOutcome(applySyncResult(startTimeline(T0, 500), { ok: false, error: 'Activity TSA boarded 3 for a 500-song set. Nothing was wiped.' }, T0))!
    assert.equal(tsa.changed, 'no')
  })
  it('the header says "Last verified" after an uncertain or partial attempt', () => {
    const clean = { landed: 1000, target: 1000, sealedOk: true }
    assert.equal(ipodCountLabel(clean, 'idle'), 'On the iPod now')
    assert.equal(ipodCountLabel(clean, 'failed'), 'Last verified')
    assert.equal(ipodCountLabel(clean, 'cancelled'), 'Last verified')
    assert.equal(ipodCountLabel(clean, 'running'), 'Last verified')
    assert.equal(ipodCountLabel({ landed: 993, target: 1000, sealedOk: true }, 'idle'), 'Last verified')
    assert.equal(ipodCountLabel({ landed: 500, target: 500, sealedOk: false }, 'idle'), 'Last verified')
    assert.equal(ipodCountLabel(null, 'idle'), null)
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
