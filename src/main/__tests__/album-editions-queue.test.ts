/**
 * Brief 255 review fixes — the edition lookups' line (renderer albumEditions.ts):
 *
 *  - A lookup that fails says so ('failed'), is not kept, and the next look asks again
 *    (the songs sheet falls back to its by-name load on 'failed' instead of spinning).
 *  - One lookup at a time, in turn; a Save album click (or the menu / songs opened)
 *    jumps ahead of every lookup still waiting.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editionsState, editionToSave, loadEditions, resetEditionsForTests } from '../../renderer/views/DownloadStore/albumEditions.ts'
import type { AlbumEditions } from '../../common/album-preflight.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const asked: string[] = []
let active = 0
let maxActive = 0
const fail = new Set<string>()
const gates = new Map<string, () => void>()

const answerFor = (album: string): AlbumEditions => ({ ok: true, editions: [{ collectionId: album.length, name: album, label: 'Standard', trackCount: 9 }], chosenId: album.length })

;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    listAlbumEditions: async (_artist: string, album: string): Promise<AlbumEditions> => {
      asked.push(album)
      active++; maxActive = Math.max(maxActive, active)
      try {
        // A lookup named in `gates` waits until the test lets it go.
        if (gates.has(album)) await new Promise<void>((r) => { gates.set(album, r) })
        else await sleep(5)
        if (fail.has(album)) return { ok: false, editions: [], chosenId: null }
        return answerFor(album)
      } finally { active-- }
    },
  },
}

beforeEach(async () => {
  await sleep(400)   // let a previous test's line drain (SPACING_MS is 250)
  resetEditionsForTests()
  asked.length = 0; active = 0; maxActive = 0; fail.clear(); gates.clear()
})

describe('an edition lookup that fails', () => {
  it('idle → loading → failed, not kept: the next look asks again and can be ready', async () => {
    fail.add('Animals')
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'idle')
    const p = loadEditions('Pink Floyd', 'Animals')
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'loading')
    const out = await p
    assert.equal(out.ok, false)
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'failed')

    fail.delete('Animals')
    await sleep(300)
    const again = loadEditions('Pink Floyd', 'Animals')
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'loading')
    assert.equal((await again).ok, true)
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'ready')
    assert.deepEqual(asked, ['Animals', 'Animals'])
  })

  it('a Save album whose lookup fails saves the record by name', async () => {
    fail.add('Meddle')
    const s = await editionToSave('Pink Floyd', 'Meddle')
    assert.deepEqual(s, { edition: null, from: 'none' })
    assert.equal(editionsState('Pink Floyd', 'Meddle').state, 'failed')
  })
})

describe('the line of lookups', () => {
  it('nothing is asked until something asks', async () => {
    await sleep(50)
    assert.deepEqual(asked, [])
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'idle')
  })

  it('one at a time, in turn; a Save album click goes ahead of everything still waiting', async () => {
    gates.set('A1', () => {})
    const bg = ['A1', 'A2', 'A3', 'A4'].map((a) => loadEditions('X', a))
    await sleep(10)
    assert.deepEqual(asked, ['A1'], 'only the first is asked; the rest wait')
    // Save album on a record nobody has asked about yet, and the menu opened on A4 (already waiting)
    const save = editionToSave('X', 'Clicked')
    void loadEditions('X', 'A4', { front: true })
    gates.get('A1')!()
    const saved = await save
    assert.equal(saved.edition?.name, 'Clicked')
    await Promise.all(bg)
    // The latest front-of-line ask goes first, then the earlier one, then the background in order.
    assert.deepEqual(asked, ['A1', 'A4', 'Clicked', 'A2', 'A3'])
    assert.equal(maxActive, 1, 'never two lookups at once')
  })

  it('a Save album click answers without waiting for the queued background lookups', async () => {
    const bg = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map((a) => loadEditions('X', a))
    const save = editionToSave('X', 'Now')
    await save
    // Asked second at most: the one already running, then the click.
    assert.ok(asked.indexOf('Now') <= 1, `asked: ${asked.join(', ')}`)
    assert.ok(!asked.includes('B6'), 'the background lookups are still waiting')
    await Promise.all(bg)
  })
})
