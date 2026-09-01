/** Sync History pairing — picks↔result by picksWhen, aborted runs shown
 *  honestly, removed names resolved from the PREVIOUS sync's picked list,
 *  round trips interleaved newest-first. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSyncHistory } from '../ipc/sync-history-ipc.ts'

const L = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n')

describe('buildSyncHistory', () => {
  const picks1 = { kind: 'picks', when: '2026-09-01T10:00:00Z', target: 2, pickedIds: [1, 2], added: [1, 2], removed: [], picked: [{ id: 1, t: 'One', a: 'A' }, { id: 2, t: 'Two', a: 'B' }] }
  const result1 = { kind: 'result', when: '2026-09-01T10:05:00Z', picksWhen: '2026-09-01T10:00:00Z', target: 2, landed: 2, sealedOk: true }
  const picks2 = { kind: 'picks', when: '2026-09-01T12:00:00Z', target: 2, pickedIds: [2, 3], added: [3], removed: [1], picked: [{ id: 2, t: 'Two', a: 'B' }, { id: 3, t: 'Three', a: 'C' }] }

  test('sealed sync pairs with its result; aborted run says so', () => {
    const out = buildSyncHistory(L([picks1, result1, picks2]), '')
    assert.equal(out.length, 2)
    const [newest, older] = out
    assert.equal(newest.aborted, true)          // picks2 has no result
    assert.equal(older.sealedOk, true)
    assert.equal(older.landed, 2)
  })

  test('removed names resolve from the PREVIOUS picks entry', () => {
    const out = buildSyncHistory(L([picks1, result1, picks2]), '')
    const newest = out[0]
    assert.deepEqual(newest.removed, [{ id: 1, t: 'One', a: 'A' }])
    assert.deepEqual(newest.added, [{ id: 3, t: 'Three', a: 'C' }])
  })

  test('round trips interleave newest-first', () => {
    const trip = { kind: 'roundtrip', when: '2026-09-01T11:00:00Z', plays: [{ id: 2, delta: 3 }], otg: [], unmatched: 0 }
    const out = buildSyncHistory(L([picks1, result1, picks2]), L([trip]))
    assert.deepEqual(out.map((e) => e.kind), ['sync', 'roundtrip', 'sync'])
    assert.deepEqual(out[1].plays, [{ id: 2, delta: 3 }])
  })

  test('torn lines and empty ledgers never throw', () => {
    assert.deepEqual(buildSyncHistory('not json\n{"kind":"picks"', ''), [])
    assert.deepEqual(buildSyncHistory('', ''), [])
  })
})
