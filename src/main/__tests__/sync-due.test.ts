import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncIsDue } from '../../common/sync-due.ts'

test('Sync is due: never synced, an unfinished or unsealed sync, or a different count', () => {
  assert.equal(syncIsDue(1000, null), true)
  assert.equal(syncIsDue(1000, {}), true)
  assert.equal(syncIsDue(1000, { landed: 1000, aborted: true }), true)
  assert.equal(syncIsDue(1000, { landed: 1000, sealedOk: false }), true)
  assert.equal(syncIsDue(1000, { landed: 998, sealedOk: true }), true)
  assert.equal(syncIsDue(1000, { landed: 1000, sealedOk: true }), false)
  assert.equal(syncIsDue(1000, { landed: 1000 }), false)
})
