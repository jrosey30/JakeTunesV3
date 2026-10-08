import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ackVersionAfterSave, hubAdoptAfterMerge, trackIdKey } from '../../common/hub-catalog-ack.ts'

describe('hub version is acknowledged only after the save that contains it', () => {
  const pending = { version: 'hub-v9', idKey: trackIdKey([1, 2]) }

  it('a refused or failed save does not advance the adopted version', () => {
    assert.equal(ackVersionAfterSave({
      ok: false,
      savedIdKey: pending.idKey,
      launched: pending,
      current: pending,
    }), null)
    // Shrink / lock refusal tells the renderer to reload. That reload's
    // save succeeds and writes the PRE-adoption library. It must not ack.
    assert.equal(ackVersionAfterSave({
      ok: true,
      savedIdKey: trackIdKey([1, 2, 3]),
      launched: pending,
      current: pending,
    }), null)
    // A newer merge landed while this save was in flight. Acking the old
    // version would skip the new one.
    assert.equal(ackVersionAfterSave({
      ok: true,
      savedIdKey: pending.idKey,
      launched: pending,
      current: { version: 'hub-v10', idKey: pending.idKey },
    }), null)
  })

  it('a save that wrote the adopted ids advances that version', () => {
    assert.equal(ackVersionAfterSave({
      ok: true,
      savedIdKey: pending.idKey,
      launched: pending,
      current: pending,
    }), 'hub-v9')
  })

  it('a merge is not acknowledged before a save exists, and a held snapshot is retried', () => {
    assert.equal(hubAdoptAfterMerge({ changed: true, hasUnpersistedMerge: false }), 'save-then-ack')
    assert.equal(
      hubAdoptAfterMerge({ changed: false, ignoredReason: 'empty-full-snapshot', hasUnpersistedMerge: false }),
      'hold',
    )
    assert.equal(
      hubAdoptAfterMerge({ changed: false, ignoredReason: 'full-snapshot-shrink-guard:100->10', hasUnpersistedMerge: false }),
      'hold',
    )
    // The refused save left the merge in memory. The next poll looks
    // unchanged and must save again, not ack.
    assert.equal(hubAdoptAfterMerge({ changed: false, hasUnpersistedMerge: true }), 'save-then-ack')
    // Nothing changed and nothing is waiting: the library on disk already
    // matches. A mass-removal guard is a decision, not a missed save.
    assert.equal(hubAdoptAfterMerge({ changed: false, hasUnpersistedMerge: false }), 'ack-now')
    assert.equal(
      hubAdoptAfterMerge({ changed: false, ignoredReason: 'mass-removal-guard:40', hasUnpersistedMerge: false }),
      'ack-now',
    )
  })

  it('App.tsx acks from the save result, not from the merge dispatch', () => {
    const app = readFileSync(new URL('../../renderer/App.tsx', import.meta.url), 'utf8')
    assert.match(app, /hubAdoptAfterMerge\(/)
    assert.match(app, /ackVersionAfterSave\(/)
    const start = app.indexOf('onHubCatalogUpdated')
    const end = app.indexOf('scheduleLibrarySave(r.tracks')
    assert.ok(start > 0 && end > start)
    const handler = app.slice(start, end)
    assert.match(handler, /decision === 'hold'/)
    assert.match(handler, /decision === 'ack-now'/)
    assert.equal(handler.includes('ackVersionAfterSave'), false)
  })
})
