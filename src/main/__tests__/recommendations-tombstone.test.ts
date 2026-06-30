import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRecordTombstoned,
  tombstoneKeysForRecord,
  recordsMatchForDelete,
  RECO_IDENTITY_TOMBSTONE_PREFIX,
  type RecoTombstoneRecord,
} from '../reco-tombstone.ts'

function rec(partial: Partial<RecoTombstoneRecord> & { id: string }): RecoTombstoneRecord {
  return { ...partial }
}

test('identity tombstone blocks same song under a new id', () => {
  const tombstones = new Set([RECO_IDENTITY_TOMBSTONE_PREFIX + 'aroundtheworld|daftpunk'])
  const resurrected = rec({
    id: 'new-uuid-from-homemini',
    song: 'Around the World',
    artist: 'Daft Punk',
  })
  assert.ok(isRecordTombstoned(tombstones, resurrected))
})

test('full-key tombstone blocks note-only jots re-minted with new id', () => {
  const noteOnly = rec({ id: 'a', note: 'ask Jake about this band' })
  const keys = tombstoneKeysForRecord(noteOnly)
  const tombstones = new Set(keys)
  const resurrected = rec({ id: 'b', note: 'ask Jake about this band' })
  assert.ok(isRecordTombstoned(tombstones, resurrected))
})

test('recordsMatchForDelete matches song identity across different ids', () => {
  const a = rec({ id: '1', song: 'Teardrop', artist: 'Massive Attack' })
  const b = rec({ id: '2', song: 'Teardrop', artist: 'Massive Attack', matchedTitle: 'Teardrop', matchedArtist: 'Massive Attack' })
  assert.ok(recordsMatchForDelete(a, b))
})

test('id tombstone alone blocks exact id resurrection', () => {
  const tombstones = new Set(['dead-id-123'])
  const row = rec({ id: 'dead-id-123', song: 'X', artist: 'Y' })
  assert.ok(isRecordTombstoned(tombstones, row))
})
