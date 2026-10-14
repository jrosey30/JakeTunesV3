// Brief 177 — enrichment-ledger.mjs: load/save, attempt TTL, ordering.
// Run: node --test scripts/__tests__/enrichment-ledger.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadLedger, saveLedger, entryFor, markClapAttempted, markClapDone, markClapFailed,
  clapNeedsAttempt, orderClapCandidates, RETRY_TTL_MS,
} from '../enrichment-ledger.mjs'

const dir = mkdtempSync(join(tmpdir(), 'enrichment-ledger-'))
const p = join(dir, 'enrichment-ledger.json')
const NOW = 1_800_000_000_000

test('load of missing / corrupt / shapeless files yields an empty ledger', () => {
  assert.deepEqual(loadLedger(p), { version: 1, tracks: {} })
  writeFileSync(p, '{corrupt')
  assert.deepEqual(loadLedger(p), { version: 1, tracks: {} })
  writeFileSync(p, '{"nope":true}')
  assert.deepEqual(loadLedger(p), { version: 1, tracks: {} })
})

test('marks persist through save/load with the brief’s field shape', () => {
  const led = loadLedger(p)
  markClapAttempted(led, 7, NOW)
  markClapDone(led, 8, NOW)
  markClapFailed(led, 9, 'ffmpeg exited 1', NOW)
  saveLedger(p, led)
  const back = loadLedger(p)
  assert.equal(back.tracks['7'].clapAttempted, true)
  assert.equal(back.tracks['7'].clapDone, false)
  assert.equal(back.tracks['8'].clapDone, true)
  assert.equal(back.tracks['8'].clapDoneAt, NOW)
  assert.equal(back.tracks['9'].lastError, 'ffmpeg exited 1')
  assert.equal(back.tracks['9'].clapAttemptedAt, NOW)
})

test('clapNeedsAttempt: done never, fresh always, failed only after the TTL', () => {
  const led = { version: 1, tracks: {} }
  assert.equal(clapNeedsAttempt(undefined, NOW), true)
  assert.equal(clapNeedsAttempt(entryFor(led, 1), NOW), true)   // never attempted
  const done = markClapDone(led, 2, NOW - 1000)
  assert.equal(clapNeedsAttempt(done, NOW), false)
  const failed = markClapFailed(led, 3, 'x', NOW - 1000)
  assert.equal(clapNeedsAttempt(failed, NOW), false)          // inside TTL
  assert.equal(clapNeedsAttempt(failed, NOW - 1000 + RETRY_TTL_MS), false)  // exactly at the line
  assert.equal(clapNeedsAttempt(failed, NOW - 1000 + RETRY_TTL_MS + 1), true)  // past it
})

test('ordering: never-attempted and TTL-expired first, recent failures last', () => {
  const led = { version: 1, tracks: {} }
  const recentFail = markClapFailed(led, 1, 'dead file', NOW - 60_000)
  const oldFail = markClapFailed(led, 2, 'dead file', NOW - RETRY_TTL_MS - 60_000)
  const cands = [
    { id: 1, entry: recentFail },
    { id: 2, entry: oldFail },
    { id: 3, entry: undefined },
    { id: 4, entry: entryFor(led, 4) },
  ]
  const { ordered, freshCount, deferredCount } = orderClapCandidates(cands, NOW)
  assert.deepEqual(ordered.map((c) => c.id), [2, 3, 4, 1])
  assert.equal(freshCount, 3)
  assert.equal(deferredCount, 1)
})
