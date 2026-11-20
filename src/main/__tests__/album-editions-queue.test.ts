/**
 * Brief 255 review fixes — the edition lookups' line (renderer albumEditions.ts):
 *
 *  - A lookup that fails says so ('failed') and is not kept: a click asks again at once,
 *    a hover only after a minute (the songs sheet falls back to its by-name load on
 *    'failed' instead of spinning, and a later answer never swaps its songs or ticks).
 *  - A subscriber that throws never leaves a Save album, or the line, waiting.
 *  - The Edition menu shows only when Apple answered with two or more editions.
 *  - One lookup at a time, in turn; a Save album click (or the menu / songs opened)
 *    jumps ahead of every lookup still waiting.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editionsState, editionToSave, FAILED_QUIET_MS, loadEditions, pickEdition, resetEditionsForTests, setEditionsClockForTests, showEditionMenu, subscribeEditions, tracklistSource, type EditionsState } from '../../renderer/views/DownloadStore/albumEditions.ts'
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
  it('idle → loading → failed, not kept: a click asks again at once and can be ready', async () => {
    fail.add('Animals')
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'idle')
    const p = loadEditions('Pink Floyd', 'Animals')
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'loading')
    const out = await p
    assert.equal(out.ok, false)
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'failed')

    fail.delete('Animals')
    await sleep(300)
    const again = loadEditions('Pink Floyd', 'Animals', { front: true })
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'loading')
    assert.equal((await again).ok, true)
    assert.equal(editionsState('Pink Floyd', 'Animals').state, 'ready')
    assert.deepEqual(asked, ['Animals', 'Animals'])
  })

  it('a hover leaves a failed lookup alone for a minute, then asks again', async () => {
    let t = 1_000_000
    setEditionsClockForTests(() => t)
    fail.add('Wish')
    await loadEditions('Pink Floyd', 'Wish')
    assert.deepEqual(asked, ['Wish'])
    await sleep(300)
    t += FAILED_QUIET_MS - 1
    const quiet = await loadEditions('Pink Floyd', 'Wish')
    assert.equal(quiet.ok, false)
    assert.deepEqual(asked, ['Wish'], 'not asked again by a hover inside the minute')
    assert.equal(editionsState('Pink Floyd', 'Wish').state, 'failed')
    t += 2
    fail.delete('Wish')
    assert.equal((await loadEditions('Pink Floyd', 'Wish')).ok, true)
    assert.deepEqual(asked, ['Wish', 'Wish'], 'a minute on, a hover asks again')
  })

  it('a Save album inside that minute still asks', async () => {
    let t = 5_000_000
    setEditionsClockForTests(() => t)
    fail.add('Obscured')
    await loadEditions('Pink Floyd', 'Obscured')
    fail.delete('Obscured')
    await sleep(300)
    t += 1000
    const s = await editionToSave('Pink Floyd', 'Obscured')
    assert.equal(s.from, 'resolved')
    assert.deepEqual(asked, ['Obscured', 'Obscured'])
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

describe('a subscriber that throws', () => {
  it('never leaves Save album or the line waiting', async () => {
    const off = subscribeEditions(() => { throw new Error('boom') })
    try {
      const first = loadEditions('X', 'T1')
      const second = loadEditions('X', 'T2')
      const r = await Promise.race([Promise.all([first, second]), sleep(2000).then(() => 'hung' as const)])
      assert.notEqual(r, 'hung')
      assert.equal(editionsState('X', 'T1').state, 'ready')
      assert.equal(editionsState('X', 'T2').state, 'ready')
    } finally { off() }
  })
})

const ed = (id: number) => ({ collectionId: id, name: `E${id}`, label: 'Standard', trackCount: 9 })
const st = (o: Partial<EditionsState>): EditionsState => ({ state: 'idle', editions: [], chosenId: null, picked: false, ...o })

describe('the Edition menu shows only when there is a choice', () => {
  it('ready with two or more editions, and nothing else', () => {
    assert.equal(showEditionMenu(st({})), false)
    assert.equal(showEditionMenu(st({ state: 'loading' })), false)
    assert.equal(showEditionMenu(st({ state: 'failed' })), false)
    assert.equal(showEditionMenu(st({ state: 'ready', editions: [ed(1)], chosenId: 1 })), false)
    assert.equal(showEditionMenu(st({ state: 'ready', editions: [ed(1), ed(2)], chosenId: 1 })), true)
  })
})

describe('the songs sheet keeps its songs and ticks', () => {
  it('loads nothing while looking, by name on a failure, the edition when ready', () => {
    assert.equal(tracklistSource(null, st({ state: 'loading' })), null)
    assert.equal(tracklistSource(null, st({ state: 'failed' })), 'name')
    assert.equal(tracklistSource(null, st({ state: 'ready', editions: [ed(7)], chosenId: 7 })), 7)
    assert.equal(tracklistSource(null, st({ state: 'ready', editions: [] })), 'name')
  })

  it('a failed lookup asked again (loading, then an answer) keeps the by-name songs', () => {
    assert.equal(tracklistSource('name', st({ state: 'loading' })), 'name')
    assert.equal(tracklistSource('name', st({ state: 'failed' })), 'name')
    assert.equal(tracklistSource('name', st({ state: 'ready', editions: [ed(7), ed(8)], chosenId: 7 })), 'name')
  })

  it('only a real change of edition reloads: Jake\'s pick', () => {
    assert.equal(tracklistSource(7, st({ state: 'ready', editions: [ed(7), ed(8)], chosenId: 7 })), 7)
    assert.equal(tracklistSource(7, st({ state: 'loading' })), 7)
    assert.equal(tracklistSource(7, st({ state: 'ready', editions: [ed(7), ed(8)], chosenId: 8, picked: true })), 8)
    assert.equal(tracklistSource('name', st({ state: 'ready', editions: [ed(7), ed(8)], chosenId: 8, picked: true })), 8)
  })

  it('end to end on the store: fail, re-ask, answer — the source never moves', async () => {
    fail.add('Relics')
    await loadEditions('Pink Floyd', 'Relics')
    let src = tracklistSource(null, editionsState('Pink Floyd', 'Relics'))
    assert.equal(src, 'name')
    fail.delete('Relics')
    await sleep(300)
    const p = loadEditions('Pink Floyd', 'Relics', { front: true })
    src = tracklistSource(src, editionsState('Pink Floyd', 'Relics'))
    assert.equal(src, 'name')
    await p
    src = tracklistSource(src, editionsState('Pink Floyd', 'Relics'))
    assert.equal(src, 'name')
    pickEdition('Pink Floyd', 'Relics', 'Relics'.length)
    assert.equal(tracklistSource(src, editionsState('Pink Floyd', 'Relics')), 'Relics'.length)
  })
})
