/**
 * Playlist tombstones (2026-08-28) — "existence is not memory" applied to
 * playlists. The pins that matter:
 *   • a deleted ID stays dead across syncs (applyTombstones)
 *   • a renderer glitch can never mass-tombstone the collection (guards)
 *   • a deliberate re-create clears its own tombstone (live copy wins)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp } from 'fs/promises'
import {
  derivePlaylistDeletions, clearResurrected, applyTombstones, unionTombstones,
  recordPlaylistSave, loadTombstones,
} from '../playlist-tombstones.ts'

const pl = (id: string, name = `Playlist ${id}`) => ({ id, name })
const ts = (id: string, deletedAt = '2026-08-28T00:00:00Z') => ({ id, name: `Playlist ${id}`, deletedAt })

describe('derivePlaylistDeletions', () => {
  test('one deleted playlist is derived from the save diff', () => {
    const r = derivePlaylistDeletions([pl('a'), pl('b')], [pl('a')])
    assert.deepEqual(r.deletions, [{ id: 'b', name: 'Playlist b' }])
    assert.equal(r.guarded, null)
  })

  test('no drop, no tombstone', () => {
    assert.deepEqual(derivePlaylistDeletions([pl('a')], [pl('a'), pl('b')]).deletions, [])
  })

  test('GUARD: an empty save never tombstones the whole collection', () => {
    const r = derivePlaylistDeletions([pl('a'), pl('b'), pl('c')], [])
    assert.deepEqual(r.deletions, [])
    assert.ok(r.guarded, 'the guard must announce itself')
  })

  test('GUARD: a mass drop (over half, more than 3) is refused', () => {
    const prev = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((i) => pl(i))
    const r = derivePlaylistDeletions(prev, [pl('a'), pl('b'), pl('c')])
    assert.deepEqual(r.deletions, [])
    assert.ok(r.guarded)
  })

  test('deleting the LAST remaining playlist is legitimate, not a wipe', () => {
    const r = derivePlaylistDeletions([pl('only')], [])
    assert.deepEqual(r.deletions, [{ id: 'only', name: 'Playlist only' }])
    assert.equal(r.guarded, null)
  })
})

describe('clearResurrected — a live copy in a save is the owner\'s word', () => {
  test('re-created playlist clears its tombstone', () => {
    const out = clearResurrected([ts('a'), ts('b')], [pl('a')])
    assert.deepEqual(out.map((t) => t.id), ['b'])
  })
})

describe('applyTombstones — the sync-side gate', () => {
  test('a tombstoned ID never comes back, whatever its name says', () => {
    const remote = [pl('a', 'Renamed To Something Else'), pl('b')]
    assert.deepEqual(applyTombstones(remote, [ts('a')]).map((p) => p.id), ['b'])
  })
})

describe('unionTombstones', () => {
  test('merges by ID, earliest deletion wins', () => {
    const out = unionTombstones(
      [ts('a', '2026-08-28T10:00:00Z')],
      [ts('a', '2026-08-27T10:00:00Z'), ts('b')],
    )
    const a = out.find((t) => t.id === 'a')
    assert.equal(a?.deletedAt, '2026-08-27T10:00:00Z')
    assert.equal(out.length, 2)
  })
})

describe('recordPlaylistSave — the IPC hook, end to end on a temp file', () => {
  test('delete → tombstone persisted; re-create → tombstone cleared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pl-ts-'))
    const file = join(dir, 'playlist-tombstones.json')
    const now = () => '2026-08-28T12:00:00Z'

    const r1 = await recordPlaylistSave([pl('a'), pl('b')], [pl('a')], file, now)
    assert.equal(r1.added, 1)
    assert.deepEqual((await loadTombstones(file)).map((t) => t.id), ['b'])

    // Jake re-creates b (restore, undo, whatever) — the save proves it lives.
    const r2 = await recordPlaylistSave([pl('a')], [pl('a'), pl('b')], file, now)
    assert.equal(r2.cleared, 1)
    assert.deepEqual(await loadTombstones(file), [])
  })

  test('guarded mass drop records NOTHING', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pl-ts-'))
    const file = join(dir, 'playlist-tombstones.json')
    const prev = ['a', 'b', 'c', 'd', 'e', 'f'].map((i) => pl(i))
    const r = await recordPlaylistSave(prev, [], file)
    assert.ok(r.guarded)
    assert.deepEqual(await loadTombstones(file), [])
  })

  test('a second identical save does not duplicate tombstones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pl-ts-'))
    const file = join(dir, 'playlist-tombstones.json')
    await recordPlaylistSave([pl('a'), pl('b')], [pl('a')], file)
    await recordPlaylistSave([pl('a'), pl('b')], [pl('a')], file)
    assert.equal((await loadTombstones(file)).length, 1)
  })
})
