/**
 * Desktop hub-sync client (2026-08-28) — the pins that matter: stamps only
 * move when CONTENT moves, the hub's answer is adopted before the renderer
 * hears about it, and an unreachable hub is a quiet no-op.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp } from 'fs/promises'
import { stampModifiedPlaylists, convergePlaylistHub } from '../playlist-hub-sync.ts'
import { loadTombstones } from '../playlist-tombstones.ts'

const pl = (id: string, name: string, trackIds: number[] = [1], modifiedAt = '') => ({ id, name, trackIds, modifiedAt })

describe('stampModifiedPlaylists', () => {
  const now = () => '2026-08-28T12:00:00Z'

  test('a changed playlist gets a fresh stamp; an untouched one carries its old stamp', () => {
    const prev = [pl('a', 'Same', [1, 2], '2026-08-01T00:00:00Z'), pl('b', 'Old Name', [1], '2026-08-01T00:00:00Z')]
    const next = [pl('a', 'Same', [1, 2]), pl('b', 'New Name', [1])]
    const out = stampModifiedPlaylists(prev, next, now)
    assert.equal(out[0].modifiedAt, '2026-08-01T00:00:00Z', 'unchanged carries its stamp')
    assert.equal(out[1].modifiedAt, '2026-08-28T12:00:00Z', 'renamed gets now')
  })

  test('REORDERING tracks is a content change — order is the playlist', () => {
    const prev = [pl('a', 'Mix', [1, 2, 3], '2026-08-01T00:00:00Z')]
    const out = stampModifiedPlaylists(prev, [pl('a', 'Mix', [3, 1, 2])], now)
    assert.equal(out[0].modifiedAt, '2026-08-28T12:00:00Z')
  })

  test('a brand-new playlist gets now', () => {
    const out = stampModifiedPlaylists([], [pl('fresh', 'New')], now)
    assert.equal(out[0].modifiedAt, '2026-08-28T12:00:00Z')
  })
})

describe('convergePlaylistHub', () => {
  const files = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-'))
    return { tombstonesFile: join(dir, 'ts.json'), pinsFile: join(dir, 'pins.json') }
  }
  const hubReply = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

  test('adopts the hub answer BEFORE notifying, and only when it differs', async () => {
    const { tombstonesFile, pinsFile } = await files()
    const local = [pl('a', 'Mine', [1], '2026-08-28T01:00:00Z')]
    const hub = [pl('a', 'Mine', [1], '2026-08-28T01:00:00Z'), pl('b', 'From workmini', [2], '2026-08-28T02:00:00Z')]
    const order: string[] = []
    const r = await convergePlaylistHub({
      hubUrl: 'http://hub', device: 'test',
      getPlaylists: async () => local,
      setPlaylists: () => { order.push('set') },
      onApplied: () => { order.push('applied') },
      tombstonesFile, pinsFile,
      fetchFn: hubReply({ ok: true, playlists: hub, tombstones: [], pins: null }),
      log: () => {},
    })
    assert.equal(r.ok, true)
    assert.equal(r.changed, true)
    assert.deepEqual(order, ['set', 'applied'], 'cache first, renderer second')
  })

  test('identical hub answer = no set, no notify', async () => {
    const { tombstonesFile, pinsFile } = await files()
    const local = [pl('a', 'Mine', [1], '2026-08-28T01:00:00Z')]
    let touched = false
    const r = await convergePlaylistHub({
      hubUrl: 'http://hub', device: 'test',
      getPlaylists: async () => local,
      setPlaylists: () => { touched = true },
      onApplied: () => { touched = true },
      tombstonesFile, pinsFile,
      fetchFn: hubReply({ ok: true, playlists: local, tombstones: [], pins: null }),
      log: () => {},
    })
    assert.equal(r.changed, false)
    assert.equal(touched, false)
  })

  test('hub tombstones land in the local tombstone file', async () => {
    const { tombstonesFile, pinsFile } = await files()
    const r = await convergePlaylistHub({
      hubUrl: 'http://hub', device: 'test',
      getPlaylists: async () => [],
      setPlaylists: () => {},
      tombstonesFile, pinsFile,
      fetchFn: hubReply({ ok: true, playlists: [], tombstones: [{ id: 'dead', name: 'Gone', deletedAt: '2026-08-28T00:00:00Z' }], pins: null }),
      log: () => {},
    })
    assert.equal(r.ok, true)
    assert.deepEqual((await loadTombstones(tombstonesFile)).map((t) => t.id), ['dead'])
  })

  test('an unreachable hub is a quiet no-op, never a throw', async () => {
    const { tombstonesFile, pinsFile } = await files()
    const r = await convergePlaylistHub({
      hubUrl: 'http://hub', device: 'test',
      getPlaylists: async () => [pl('a', 'Mine')],
      setPlaylists: () => { throw new Error('must not be called') },
      tombstonesFile, pinsFile,
      fetchFn: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
      log: () => {},
    })
    assert.equal(r.ok, false)
    assert.equal(r.changed, false)
  })
})
