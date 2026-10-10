/**
 * Sync batching (src/common/sync-batching.ts, 2026-10-10): routine library
 * saves share one sync per 5-minute window; imports, covers and manual syncs
 * still go in 5 s and carry the batch with them.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  syncUrgency, nextDueAt, mergePendingReason, dueAfterRun, SYNC_URGENT_DELAY_MS, SYNC_BATCH_WINDOW_MS,
} from '../../common/sync-batching.ts'

const S = 1000
const MIN = 60 * S

/** The orchestrator's timing, without electron: triggers at given times;
 *  a run happens at dueAt and takes `runMs`. Returns the start times. */
function replay(triggers: Array<[number, string]>, runMs = 6 * S, until = 60 * MIN): number[] {
  const runs: number[] = []
  let due: number | null = null
  let pending: string | null = null
  let busyUntil = -1
  const events = [...triggers].sort((a, b) => a[0] - b[0])
  let i = 0
  for (let now = 0; now <= until; now += 100) {
    while (i < events.length && events[i][0] <= now) {
      pending = mergePendingReason(pending, events[i][1])
      due = nextDueAt(due, events[i][1], now)
      i++
    }
    if (now === busyUntil && pending !== null) due = dueAfterRun(due, now)
    if (pending !== null && due !== null && now >= due && now >= busyUntil) {
      runs.push(now)
      pending = null
      due = null
      busyUntil = now + runMs
    }
  }
  return runs
}

describe('which triggers wait', () => {
  it('routine saves batch; new music, covers and asked-for syncs do not', () => {
    for (const r of ['metadata-edit', 'playlist', 'startup']) assert.equal(syncUrgency(r), 'batched', r)
    for (const r of ['import', 'artwork', 'manual', 'nas-recovery', 'safety-net']) assert.equal(syncUrgency(r), 'urgent', r)
  })
})

describe('when the pending sync runs', () => {
  it('the first routine save opens a 5-minute window, and later ones do not slide it', () => {
    const first = nextDueAt(null, 'metadata-edit', 0)
    assert.equal(first, SYNC_BATCH_WINDOW_MS)
    assert.equal(nextDueAt(first, 'metadata-edit', 4 * MIN), first)
  })

  it('an import runs 5 s after the last trigger and pulls a waiting batch in with it', () => {
    const batch = nextDueAt(null, 'metadata-edit', 0)
    assert.equal(nextDueAt(batch, 'import', 30 * S), 30 * S + SYNC_URGENT_DELAY_MS)
    assert.equal(nextDueAt(31 * S + 4 * S, 'import', 32 * S), 32 * S + SYNC_URGENT_DELAY_MS, 'trailing: each import resets the 5 s')
  })

  it('a routine save never turns a pending urgent pass into a routine one', () => {
    assert.equal(mergePendingReason('safety-net', 'metadata-edit'), 'safety-net')
    assert.equal(mergePendingReason('import', 'playlist'), 'import')
    assert.equal(mergePendingReason('metadata-edit', 'import'), 'import')
    assert.equal(mergePendingReason(null, 'startup'), 'startup')
  })

  it('after a run, a pending batch keeps its moment; a moment that passed mid-run waits only 5 s', () => {
    assert.equal(dueAfterRun(10 * MIN, 2 * MIN), 10 * MIN)
    assert.equal(dueAfterRun(1 * MIN, 2 * MIN), 2 * MIN + SYNC_URGENT_DELAY_MS)
    assert.equal(dueAfterRun(null, 2 * MIN), 2 * MIN + SYNC_URGENT_DELAY_MS)
  })
})

describe('replayed against the orchestrator timing', () => {
  it('a save every 10 s for 12 minutes (building a playlist) is 3 syncs, not 72', () => {
    const edits = Array.from({ length: 72 }, (_, k): [number, string] => [k * 10 * S, 'metadata-edit'])
    const runs = replay(edits)
    assert.equal(runs.length, 3)
    assert.equal(runs[0], 5 * MIN)
    for (let k = 1; k < runs.length; k++) assert.ok(runs[k] - runs[k - 1] >= SYNC_BATCH_WINDOW_MS, 'at most one sync per window')
  })

  it('no change waits more than 5 minutes (plus one in-flight run)', () => {
    const edits = Array.from({ length: 40 }, (_, k): [number, string] => [k * 37 * S, 'metadata-edit'])
    const runs = replay(edits)
    for (const [t] of edits) {
      const next = runs.find((r) => r >= t)
      assert.ok(next !== undefined && next - t <= SYNC_BATCH_WINDOW_MS + 6 * S, `change at ${t / S}s synced at ${next! / S}s`)
    }
  })

  it('an album of 12 imports one second apart is one sync, 5 s after the last', () => {
    const imports = Array.from({ length: 12 }, (_, k): [number, string] => [k * S, 'import'])
    assert.deepEqual(replay(imports), [11 * S + SYNC_URGENT_DELAY_MS])
  })

  it('an import mid-window takes the waiting play counts along — no second sync', () => {
    const runs = replay([[0, 'metadata-edit'], [40 * S, 'metadata-edit'], [2 * MIN, 'import']])
    assert.deepEqual(runs, [2 * MIN + SYNC_URGENT_DELAY_MS])
  })
})

describe('the orchestrator is wired to the policy', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'sync-orchestrator.ts'), 'utf8')
  it('schedules through nextDueAt / mergePendingReason / dueAfterRun, with no fixed debounce left', () => {
    assert.match(src, /dueAt = nextDueAt\(dueAt, reason, Date\.now\(\)\)/)
    assert.match(src, /pendingReason = mergePendingReason\(pendingReason, reason\)/)
    assert.match(src, /dueAt = dueAfterRun\(dueAt, Date\.now\(\)\)/)
    assert.doesNotMatch(src, /DEBOUNCE_MS/)
  })
  it('a cover is a quick sync, only urgent reasons preempt a full walk, and launch queues one catch-up', () => {
    assert.match(src, /r === 'artwork'/)
    assert.match(src, /syncUrgency\(reason\) === 'urgent' && isQuickReason\(reason\) && inFlight/)
    assert.match(src, /triggerSync\('startup'\)/)
  })
})
