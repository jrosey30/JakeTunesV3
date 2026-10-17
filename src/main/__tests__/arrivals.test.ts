import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  stepImportBatch, idleImportBatch, arrivalsMessage, albumsNeedingArt, albumArtKey, runLimited,
  type ImportBatch, type ImportItemLike,
} from '../../common/arrivals.ts'

type T = { id: number }
type Item = ImportItemLike<T>

/** Replays queue snapshots; returns every finished summary. */
function replay(snapshots: Item[][]) {
  let b: ImportBatch<T> = idleImportBatch<T>()
  const done = []
  for (const items of snapshots) {
    const r = stepImportBatch(b, items)
    b = r.batch
    if (r.finished) done.push(r.finished)
  }
  return { done, batch: b }
}

describe('import batch: busy → empty reports THIS batch’s delta', () => {
  it('counts imported / duplicate / failed / gone for one batch', () => {
    const { done } = replay([
      [{ uid: 'a', status: 'pending' }, { uid: 'b', status: 'pending' }, { uid: 'c', status: 'pending' }, { uid: 'd', status: 'pending' }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }, { uid: 'b', status: 'running' }, { uid: 'c', status: 'pending' }, { uid: 'd', status: 'pending' }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }, { uid: 'b', status: 'dupe', dupeReason: 'in-library' }, { uid: 'c', status: 'failed' }, { uid: 'd', status: 'dupe', dupeReason: 'source-gone' }],
    ])
    assert.equal(done.length, 1)
    assert.deepEqual({ ...done[0], tracks: done[0].tracks.map((t) => t.id) }, { imported: 1, dupes: 1, gone: 1, failed: 1, tracks: [1] })
  })

  it('history left from an earlier batch is not re-counted', () => {
    const old: Item[] = [{ uid: 'x', status: 'done', track: { id: 9 } }, { uid: 'y', status: 'failed' }]
    const { done } = replay([
      old,
      [...old, { uid: 'a', status: 'pending' }],
      [...old, { uid: 'a', status: 'done', track: { id: 1 } }],
    ])
    assert.equal(done.length, 1)
    assert.equal(done[0].imported, 1)
    assert.equal(done[0].failed, 0)
  })

  it('a second drop mid-batch that PURGES finished rows does not lose them', () => {
    const { done } = replay([
      [{ uid: 'a', status: 'pending' }, { uid: 'b', status: 'pending' }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }, { uid: 'b', status: 'running' }],
      // enqueueFiles purged done rows and appended the new drop
      [{ uid: 'b', status: 'running' }, { uid: 'c', status: 'pending' }],
      [{ uid: 'b', status: 'done', track: { id: 2 } }, { uid: 'c', status: 'done', track: { id: 3 } }],
    ])
    assert.equal(done.length, 1)
    assert.equal(done[0].imported, 3)
    assert.deepEqual(done[0].tracks.map((t) => t.id), [1, 2, 3])
  })

  it('a retried failure that now succeeds counts as imported, not failed', () => {
    const { done } = replay([
      [{ uid: 'a', status: 'failed' }],
      [{ uid: 'a', status: 'pending' }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }],
    ])
    assert.equal(done[0].imported, 1)
    assert.equal(done[0].failed, 0)
  })

  it('quiet (internal) imports are never announced', () => {
    const { done } = replay([
      [{ uid: 'm', status: 'pending', quiet: true }],
      [{ uid: 'm', status: 'done', quiet: true, track: { id: 5 } }],
    ])
    assert.equal(done.length, 0)
  })

  it('each batch reports once, and the tracker goes idle after', () => {
    const { done, batch } = replay([
      [{ uid: 'a', status: 'pending' }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }, { uid: 'b', status: 'pending' }],
      [{ uid: 'a', status: 'done', track: { id: 1 } }, { uid: 'b', status: 'done', track: { id: 2 } }],
    ])
    assert.equal(done.length, 2)
    assert.deepEqual(done.map((d) => d.imported), [1, 1])
    assert.equal(batch.busy, false)
  })
})

describe('landing toast copy', () => {
  it('all in Recently Added → they ride the next Activity Sync', () => {
    assert.deepEqual(arrivalsMessage('import', { landed: 12, inRecentlyAdded: 12 }), {
      message: 'Imported 12 songs — in Recently Added, so they ride the next Activity Sync',
      kind: 'success',
    })
  })
  it('singular reads right', () => {
    assert.equal(arrivalsMessage('import', { landed: 1, inRecentlyAdded: 1 })?.message,
      'Imported 1 song — in Recently Added, so it rides the next Activity Sync')
  })
  it('a batch bigger than Recently Added says only the newest ride — never overclaims', () => {
    assert.equal(arrivalsMessage('import', { landed: 80, inRecentlyAdded: 50 })?.message,
      'Imported 80 songs — the newest 50 are in Recently Added, so they ride the next Activity Sync')
  })
  it('none in Recently Added → no ride claim at all', () => {
    assert.equal(arrivalsMessage('phone', { landed: 3, inRecentlyAdded: 0 })?.message, '3 phone downloads added')
  })
  it('duplicate and failed counts ride along', () => {
    const m = arrivalsMessage('import', { landed: 10, inRecentlyAdded: 10, dupes: 2, failed: 1 })
    assert.equal(m?.message, 'Imported 10 songs — in Recently Added, so they ride the next Activity Sync · 2 already in your library · 1 failed — see the import list')
    assert.equal(m?.kind, 'info')
  })
  it('only duplicates → says nothing new landed', () => {
    assert.deepEqual(arrivalsMessage('import', { landed: 0, inRecentlyAdded: 0, dupes: 4 }), {
      message: 'Nothing new imported · 4 already in your library', kind: 'info',
    })
  })
  it('only failures → error', () => {
    assert.equal(arrivalsMessage('import', { landed: 0, inRecentlyAdded: 0, failed: 2 })?.kind, 'error')
  })
  it('nothing at all → no toast', () => {
    assert.equal(arrivalsMessage('import', { landed: 0, inRecentlyAdded: 0 }), null)
  })
  it('phone downloads use their own opening', () => {
    assert.equal(arrivalsMessage('phone', { landed: 2, inRecentlyAdded: 2 })?.message,
      '2 phone downloads added — in Recently Added, so they ride the next Activity Sync')
  })
})

describe('arrival art: one fetch per artist + album without art', () => {
  it('dedupes per artist+album (case/space-insensitive) and skips albums that have art', () => {
    const tracks = [
      { artist: 'Pavement', album: 'Wowee Zowee' },
      { artist: 'pavement ', album: 'wowee zowee' },
      { artist: 'Pavement', album: 'Slanted and Enchanted' },
      { artist: 'Morphine', album: 'Cure for Pain' },
      { artist: '', album: 'No Artist' },
      { artist: 'No Album', album: '' },
    ]
    const has = new Set([albumArtKey('Pavement', 'Slanted and Enchanted')])
    const r = albumsNeedingArt(tracks, (a, b) => has.has(albumArtKey(a, b)))
    assert.deepEqual(r, [{ artist: 'Pavement', album: 'Wowee Zowee' }, { artist: 'Morphine', album: 'Cure for Pain' }])
  })

  it('runLimited never runs more than the limit at once, and one failure does not stop the rest', async () => {
    let live = 0
    let peak = 0
    const ran: number[] = []
    await runLimited([1, 2, 3, 4, 5], 2, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live--
      if (n === 2) throw new Error('boom')
      ran.push(n)
    })
    assert.equal(peak, 2)
    assert.deepEqual(ran.sort(), [1, 3, 4, 5])
  })

  it('runLimited on nothing resolves', async () => {
    await runLimited([], 2, async () => { throw new Error('never') })
  })
})

describe('wired', () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8')
  it('App announces import batches and phone absorbs, and runs the art pass for both', () => {
    const app = src('renderer/App.tsx')
    assert.match(app, /stepImportBatch\(batch, getQueueState\(\)\.items\)/)
    assert.match(app, /arrivalsMessage\('import', \{/)
    assert.match(app, /arrivalsMessage\('phone', \{/)
    assert.equal((app.match(/fetchArtForArrivals\(/g) || []).length, 2)
  })
  it('the art pass never forces a fetch (hand-set covers and the strict match survive)', () => {
    const mod = src('renderer/utils/newArrivals.ts')
    assert.match(mod, /fetchAlbumArt\(artist, album\)/)
    assert.doesNotMatch(mod, /fetchAlbumArt\([^)]*true/)
  })
  it('a concert merge is imported quietly', () => {
    assert.match(src('renderer/liveSetDeclare.ts'), /enqueueFiles\(\[mergedPath\], 'alac', \{ quiet: true \}\)/)
  })
})
