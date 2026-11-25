import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncIsDue } from '../../common/sync-due.ts'

const plan = Array.from({ length: 1000 }, (_, i) => i + 1)

test('Sync is due: never synced, an unfinished or unsealed sync, or a different count', () => {
  assert.equal(syncIsDue(plan, null), true)
  assert.equal(syncIsDue(plan, {}), true)
  assert.equal(syncIsDue(plan, { landed: 1000, aborted: true }), true)
  assert.equal(syncIsDue(plan, { landed: 1000, sealedOk: false }), true)
  assert.equal(syncIsDue(plan, { landed: 998, sealedOk: true }), true)
  assert.equal(syncIsDue(plan, { landed: 1000, sealedOk: true }), false)
  assert.equal(syncIsDue(plan, { landed: 1000 }), false)
})

test('a song that can never go on does not keep Sync pulsing for ever', () => {
  // two songs on the list the last sync had to leave off (can't be converted)
  assert.equal(syncIsDue(plan, { landed: 998, sealedOk: true, leftOff: [{ id: 5 }, { id: 9 }] }), false)
  // one of them was taken off the list since: it no longer counts against the plan
  assert.equal(syncIsDue(plan.filter((id) => id !== 9), { landed: 998, sealedOk: true, leftOff: [{ id: 5 }, { id: 9 }] }), false)
  // a new song added to the list since: due
  assert.equal(syncIsDue([...plan, 1001], { landed: 998, sealedOk: true, leftOff: [{ id: 5 }, { id: 9 }] }), true)
})
