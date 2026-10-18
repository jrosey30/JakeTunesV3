/**
 * 2026-10-17: the screen saver locked the Mac 18 minutes into a 25-minute
 * Activity Sync; macOS then refused the Verify unmount (loginwindow
 * "Allow = NO" while locked), the engine aborted and re-emptied Music, and
 * the result line still claimed "the new songs are on the card".
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withDisplayAwake, type DisplaySleepBlocker } from '../sync-keep-awake.ts'
import { REWIPED_NOTE, syncOutcome } from '../../common/sync-failure-copy.ts'
import { IDLE_TIMELINE, type SyncTimeline } from '../../common/sync-progress-model.ts'

function fakeBlocker(): DisplaySleepBlocker & { log: string[] } {
  const log: string[] = []
  return {
    log,
    start: (type) => { log.push(`start:${type}`); return 7 },
    stop: (id) => { log.push(`stop:${id}`) },
  }
}

test('the display is held awake for the whole sync and released after', async () => {
  const b = fakeBlocker()
  const r = await withDisplayAwake(b, async () => { b.log.push('sync'); return 'ok' })
  assert.equal(r, 'ok')
  assert.deepEqual(b.log, ['start:prevent-display-sleep', 'sync', 'stop:7'])
})

test('the blocker is released when the sync throws', async () => {
  const b = fakeBlocker()
  await assert.rejects(withDisplayAwake(b, async () => { throw new Error('boom') }), /boom/)
  assert.deepEqual(b.log, ['start:prevent-display-sleep', 'stop:7'])
})

test('a blocker that cannot start never blocks the sync', async () => {
  const b: DisplaySleepBlocker = { start: () => { throw new Error('no power api') }, stop: () => { throw new Error('must not stop') } }
  assert.equal(await withDisplayAwake(b, async () => 42), 42)
})

test('sync-to-ipod runs inside the display-awake hold', () => {
  const ipc = readFileSync(join(import.meta.dirname, '../ipc/sync-ipc.ts'), 'utf-8')
  assert.match(ipc, /withDisplayAwake\(powerSaveBlocker, \(\) => host\.syncToIpod\(/)
})

test('an abort that re-emptied the card is reported as emptied, not "songs on the card"', () => {
  const t: SyncTimeline = {
    ...IDLE_TIMELINE, status: 'failed', step: 'verify', reached: ['prepare', 'wipe', 'copy', 'verify'],
    current: 1, total: 1, seen: 40,
    error: `Could not verify the iPod (remount failed after writing). Sync again without unplugging. ${REWIPED_NOTE}`,
  }
  const o = syncOutcome(t)
  assert.ok(o)
  assert.equal(o.changed, 'emptied')
  assert.equal(o.catalog, 'previous')
  // Without the note, a Verify stop keeps its old claim.
  const plain = syncOutcome({ ...t, error: 'Could not verify the iPod (remount failed after writing).' })
  assert.equal(plain?.changed, 'songs-only')
})

test('the activity engine stamps the re-empty note on every abort after the wipe', () => {
  const engine = readFileSync(join(import.meta.dirname, '../ipod-activity-engine.ts'), 'utf-8')
  assert.match(engine, /const error = \[why\.error \|\| 'Sync stopped\.', REWIPED_NOTE\]\.join\(' '\)\n\s+return \{ \.\.\.why, error \}/)
})
