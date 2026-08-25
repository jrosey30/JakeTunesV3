import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { refuseIpodSyncUnlessUserClick } from '../ipod-sync-origin.ts'

describe('iPod writes are click-only', () => {
  it('refuses plug-in / restart / missing origin — that is how 500 became 486', () => {
    const r = refuseIpodSyncUnlessUserClick(undefined)
    assert.equal(r?.ok, false)
    assert.match(r?.error || '', /Activity Sync or Full Sync/)
    assert.equal(refuseIpodSyncUnlessUserClick({})?.ok, false)
    assert.equal(refuseIpodSyncUnlessUserClick({ wipeFirst: true })?.ok, false)
    assert.equal(refuseIpodSyncUnlessUserClick({ origin: 'auto-repair' })?.ok, false)
  })

  it('Activity Sync must wipe; incremental repair is closed', () => {
    const r = refuseIpodSyncUnlessUserClick({ origin: 'activity-click' })
    assert.equal(r?.ok, false)
    assert.match(r?.error || '', /wipe and rebuild/)
    assert.equal(refuseIpodSyncUnlessUserClick({ origin: 'activity-click', wipeFirst: true }), null)
  })

  it('Full Sync is allowed without wipe, and cannot use the activity engine', () => {
    assert.equal(refuseIpodSyncUnlessUserClick({ origin: 'full-library-click' }), null)
    const r = refuseIpodSyncUnlessUserClick({ origin: 'full-library-click', wipeFirst: true })
    assert.equal(r?.ok, false)
  })
})
