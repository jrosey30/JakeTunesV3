import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pickFromTop1000, TOP1000_RESERVE } from '../../common/top1000-sync.ts'
import { halfAndHalfLine } from '../../common/activity-split.ts'
import { createTop1000SyncSource } from '../top1000-sync-source.ts'
import type { IpodIdentity } from '../../common/ipod-identity.ts'

describe('the Original’s brain half from the Top 1000', () => {
  test('goes straight down the ranked list, skipping your half and unsyncable songs, then keeps reserves', () => {
    const ranked = Array.from({ length: 200 }, (_, i) => i + 1)
    const got = pickFromTop1000(ranked, {
      gap: 10,
      exclude: new Set([1, 3]),
      syncable: (id) => id !== 5,
    })
    assert.deepEqual(got.picked, [2, 4, 6, 7, 8, 9, 10, 11, 12, 13])
    assert.equal(got.reserve.length, TOP1000_RESERVE)
    assert.equal(got.reserve[0], 14)
  })

  test('no artist cap and no repeats: it is his list, not a mix', () => {
    const got = pickFromTop1000([7, 7, 8, 9], { gap: 5, exclude: new Set(), syncable: () => true })
    assert.deepEqual(got.picked, [7, 8, 9])   // a short list fills what it can; Music Man covers the rest
    assert.deepEqual(got.reserve, [])
  })

  test('the review line says where every song came from', () => {
    const split = { pinnedCount: 257, waitingIds: [1, 2] }
    assert.equal(halfAndHalfLine(split, 500, 500, 0),
      'Half and half: 257 from your pinned lists + your 243 newest pool drops + 500 from your Top 1000, best first. 2 older pool songs sit this one out.')
    assert.equal(halfAndHalfLine({ pinnedCount: 0, waitingIds: [] }, 1, 0, 1),
      'Half and half: 0 from your pinned lists + your 1 newest pool drop + 1 Music Man pick.')
  })
})

describe('where the brain half comes from at sync time', () => {
  const original: IpodIdentity = { status: 'known', device: { version: 1, id: 'a', name: 'Original', color: 'silver', purpose: 'My top 1000 songs', primary: true, createdAt: '2026-10-23' } }
  const red: IpodIdentity = { status: 'known', device: { version: 1, id: 'b', name: 'Red', color: 'red', purpose: '', primary: false, createdAt: '2026-10-23' } }
  const list = async () => ({ ok: true as const, value: { list: [{ id: 30, rank: 3, pIn: 0.6 }, { id: 10, rank: 1, pIn: 0.99 }, { id: 20, rank: 2, pIn: 0.9 }] } })
  const quiet = () => {}

  test('the Original gets the Top 1000, best first', async () => {
    const src = createTop1000SyncSource({ getMount: () => '/Volumes/JAKE', identify: async () => original, list, log: quiet })
    assert.deepEqual(await src(), [10, 20, 30])
  })

  test('Red — or an iPod not set up yet — never gets the Original’s list', async () => {
    let asked = 0
    const counted = async () => { asked++; return list() }
    assert.equal(await createTop1000SyncSource({ getMount: () => '/Volumes/RED', identify: async () => red, list: counted, log: quiet })(), null)
    assert.equal(await createTop1000SyncSource({ getMount: () => '/Volumes/X', identify: async () => ({ status: 'unknown', canBeOriginal: false }), list: counted, log: quiet })(), null)
    assert.equal(await createTop1000SyncSource({ getMount: () => '/Volumes/X', identify: async () => { throw new Error('unreadable') }, list: counted, log: quiet })(), null)
    assert.equal(asked, 0, 'homemini is never even asked')
  })

  test('building ahead of the sync (no iPod plugged in) uses the list; homemini down → Music Man', async () => {
    assert.deepEqual(await createTop1000SyncSource({ getMount: () => null, identify: async () => red, list, log: quiet })(), [10, 20, 30])
    const down = async () => ({ ok: false as const, error: 'homemini isn’t answering' })
    assert.equal(await createTop1000SyncSource({ getMount: () => null, identify: async () => original, list: down, log: quiet })(), null)
  })
})
