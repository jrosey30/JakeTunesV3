import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type RecoOutboxOp,
  parseOutbox,
  scrubOutboxForDelete,
  pendingAddLocalIds,
  pendingDeleteIds,
  pendingDeleteIdentities,
} from '../reco-outbox.ts'

// Brief 126: ops carry identities: string[] (v2). parseOutbox still accepts
// the legacy single-`identity` field — covered in reco-sync.test.ts.
const addOp = (localId: string, identities: string[] = []): RecoOutboxOp => ({
  op: 'add',
  localId,
  input: { song: 'S', artist: 'A' },
  identities,
  queuedAt: '2026-07-02T00:00:00.000Z',
})

const deleteOp = (ids: string[], identities: string[] = []): RecoOutboxOp => ({
  op: 'delete',
  ids,
  identities,
  queuedAt: '2026-07-02T00:00:00.000Z',
})

describe('parseOutbox', () => {
  it('returns [] for non-arrays and garbage', () => {
    assert.deepEqual(parseOutbox(null), [])
    assert.deepEqual(parseOutbox({ op: 'add' }), [])
    assert.deepEqual(parseOutbox('nope'), [])
  })

  it('keeps valid ops and drops malformed ones', () => {
    const ops = parseOutbox([
      addOp('a1'),
      deleteOp(['x']),
      { op: 'add' },                       // no localId/input
      { op: 'delete', ids: [1, 2] },       // non-string ids
      { op: 'jump' },                      // unknown op
      42,
    ])
    assert.equal(ops.length, 2)
    assert.equal(ops[0].op, 'add')
    assert.equal(ops[1].op, 'delete')
  })
})

describe('scrubOutboxForDelete', () => {
  it('cancels a queued add by localId and excludes it from remote deletes', () => {
    const { ops, remoteIds } = scrubOutboxForDelete([addOp('L1')], ['L1', 'B2'], [])
    assert.deepEqual(ops, [])
    assert.deepEqual(remoteIds, ['B2'])   // L1 never reached the backend
  })

  it('cancels a queued add by identity even under a different id', () => {
    const { ops, remoteIds } = scrubOutboxForDelete(
      [addOp('L1', ['song|artist'])],
      ['B9'],
      ['song|artist'],
    )
    assert.deepEqual(ops, [])
    assert.deepEqual(remoteIds, ['B9'])
  })

  it('keeps unrelated ops untouched', () => {
    const unrelated = [addOp('L2', ['other|song']), deleteOp(['Z1'])]
    const { ops, remoteIds } = scrubOutboxForDelete(unrelated, ['B1'], ['song|artist'])
    assert.deepEqual(ops, unrelated)
    assert.deepEqual(remoteIds, ['B1'])
  })

  it('empty identities cancels only by localId', () => {
    const { ops } = scrubOutboxForDelete([addOp('L1', [])], ['B1'], [])
    assert.equal(ops.length, 1)   // no id overlap, no identity — add survives
  })

  it('offline add-then-delete of the same song leaves nothing to replay', () => {
    // The resurrection scenario: POST must not fire after the DELETE.
    const { ops, remoteIds } = scrubOutboxForDelete(
      [addOp('L1', ['song|artist'])],
      ['L1'],
      ['song|artist'],
    )
    assert.deepEqual(ops, [])
    assert.deepEqual(remoteIds, [])
  })

  it('any overlapping key cancels — multi-key ops (solo/ext) included', () => {
    const { ops } = scrubOutboxForDelete(
      [addOp('L1', ['s|b', 'solo:s~~'])],
      ['B1'],
      ['solo:s~~'],
    )
    assert.deepEqual(ops, [])
  })
})

describe('pending sets', () => {
  it('collects ids and identities by op type', () => {
    const ops = [addOp('L1'), deleteOp(['B1', 'B2'], ['k1', 'k2']), deleteOp(['B3'], [])]
    assert.deepEqual([...pendingAddLocalIds(ops)], ['L1'])
    assert.deepEqual([...pendingDeleteIds(ops)].sort(), ['B1', 'B2', 'B3'])
    assert.deepEqual([...pendingDeleteIdentities(ops)].sort(), ['k1', 'k2'])
  })
})
