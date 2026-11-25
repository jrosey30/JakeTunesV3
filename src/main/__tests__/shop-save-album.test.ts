/**
 * Record Shop Phase 2 (Jake's approved picture, 2026-11-24): albums save in
 * one click from wherever they show, and the edition on the card is the one
 * saved.
 *
 *  - Every search card shows Save album and its edition, never only on hover:
 *    one edition known is its name ("Standard"), two or more a small menu,
 *    and the edition picked is the job queued.
 *  - A For You album that isn't on the Listening List saves from its card,
 *    and the button follows that save.
 *  - "Save album" only ever saves; a button that searches says Search.
 *  - A refused save, album or song, has one button: "Choose another…".
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cardEdition, cardEditionLabel, cardSaveEdition, type CardEditionsState, type CardRecord } from '../../common/shop-card-edition.ts'
import { albumSaveButton } from '../../common/shop-save-button.ts'
import { SHOP_WORDS, retiredNamesIn } from '../../common/shop-names.ts'
import type { AlbumEdition, AlbumEditions } from '../../common/album-preflight.ts'

const SRC = join(import.meta.dirname, '..', '..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

const ed = (collectionId: number, name: string, label: string, trackCount?: number, releaseYear?: number): AlbumEdition => ({ collectionId, name, label, trackCount, releaseYear })
const idle: CardEditionsState = { state: 'idle', editions: [], chosenId: null, picked: false }
const ready = (editions: AlbumEdition[], chosenId: number | null = editions[0]?.collectionId ?? null, picked = false): CardEditionsState => ({ state: 'ready', editions, chosenId, picked })

describe('the edition a card names before the lookup answers', () => {
  it('its edition words, else Standard', () => {
    assert.equal(cardEditionLabel('Meddle'), 'Standard')
    assert.equal(cardEditionLabel('Meddle (2011 Remaster)'), '2011 Remaster')
    assert.equal(cardEditionLabel('Wish You Were Here - 2011 Remaster'), '2011 Remaster')
    assert.equal(cardEditionLabel('The Piper at the Gates of Dawn (Mono)'), 'Mono')
    assert.equal(cardEditionLabel('Rumours (Super Deluxe Edition)'), 'Super Deluxe Edition')
  })
  it('a bracket that is the record’s own name, and Apple’s Single / EP stamps, are not editions', () => {
    assert.equal(cardEditionLabel('Enter the Wu-Tang (36 Chambers)'), 'Standard')
    assert.equal(cardEditionLabel('Animals - EP'), 'Standard')
    assert.equal(cardEditionLabel('Sorry (feat. X) - Single'), 'Standard')
  })
  it('a censored edition says so', () => {
    assert.equal(cardEditionLabel('Ready to Die', 'cleaned'), 'Clean')
    assert.equal(cardEditionLabel('Ready to Die (Deluxe)', 'cleaned'), 'Deluxe, clean')
  })
})

describe('what a card shows under Save album', () => {
  const meddle: CardRecord = { collectionId: 4, name: 'Meddle', trackCount: 6, releaseYear: 1971 }
  const editions = [ed(4, 'Meddle', 'Standard', 6, 1971), ed(40, 'Meddle (2011 Remaster)', '2011 Remaster', 6, 2011)]

  it('before any answer: the card’s own edition, in a word', () => {
    assert.deepEqual(cardEdition(meddle, idle), { kind: 'label', label: 'Standard' })
    assert.deepEqual(cardEdition({ ...meddle, name: 'Meddle (2011 Remaster)' }, { ...idle, state: 'loading' }), { kind: 'label', label: '2011 Remaster' })
    assert.deepEqual(cardEdition(meddle, { ...idle, state: 'failed' }), { kind: 'label', label: 'Standard' })
  })
  it('one edition known: main’s name for it, never a menu', () => {
    assert.deepEqual(cardEdition(meddle, ready([ed(4, 'Meddle', 'Standard (US)', 6)])), { kind: 'label', label: 'Standard (US)' })
  })
  it('two or more: a menu, on the card’s own edition until Jake picks', () => {
    const e = cardEdition(meddle, ready(editions, 40))
    assert.equal(e.kind, 'menu')
    if (e.kind !== 'menu') return
    assert.equal(e.selectedId, 4, 'the card is an edition: it is the default, not main’s choice')
    assert.deepEqual(e.options.map((o) => o.label), ['Standard · 6 songs', '2011 Remaster · 6 songs'])
    assert.equal(cardSaveEdition(meddle, e), null, 'the card’s own edition saves as the card’s own job')
  })
  it('the edition picked is the edition saved', () => {
    const e = cardEdition(meddle, ready(editions, 40, true))
    assert.equal(e.kind === 'menu' && e.selectedId, 40)
    assert.equal(cardSaveEdition(meddle, e)?.collectionId, 40)
    const back = cardEdition(meddle, ready(editions, 4, true))
    assert.equal(cardSaveEdition(meddle, back), null)
  })
  it('the card’s own edition is always a choice, even when the name lookup left it out', () => {
    const e = cardEdition({ collectionId: 99, name: 'Meddle (Japan)', trackCount: 7 }, ready(editions))
    assert.equal(e.kind, 'menu')
    if (e.kind !== 'menu') return
    assert.deepEqual(e.options.map((o) => o.id), [99, 4, 40])
    assert.equal(e.selectedId, 99)
  })
  it('a lone answer that is not the card adds the card as a second choice', () => {
    const e = cardEdition({ collectionId: 99, name: 'Meddle (Japan)' }, ready([ed(4, 'Meddle', 'Standard', 6)]))
    assert.equal(e.kind, 'menu')
  })
  it('a card with no edition of its own follows main’s choice', () => {
    const e = cardEdition({ name: 'Meddle' }, ready(editions, 40))
    assert.equal(e.kind === 'menu' && e.selectedId, 40)
    assert.deepEqual(cardEdition({ name: '' }, ready(editions)), { kind: 'none' })
  })
})

describe('the For You card’s Save album button', () => {
  it('saves, then follows its save', () => {
    assert.deepEqual(albumSaveButton(undefined), { label: SHOP_WORDS.saveAlbum, clickable: true, failed: false })
    assert.equal(albumSaveButton(undefined, true).label, 'Saving…')
    assert.equal(albumSaveButton(undefined, true).clickable, false, 'a second click while the edition is named does nothing twice')
    assert.equal(albumSaveButton('queued').label, 'Queued…')
    assert.equal(albumSaveButton('downloading').label, 'Saving…')
    assert.deepEqual(albumSaveButton('done'), { label: 'In your library ✓', clickable: false, failed: false })
    assert.deepEqual(albumSaveButton('failed'), { label: 'Retry', clickable: true, failed: true })
    assert.equal(albumSaveButton('canceled').label, SHOP_WORDS.saveAlbum)
  })
})

// ── saveAlbumNamed hands back the job it queued, so a card can follow it ──
type Answer = { ok: boolean; imported?: number; dupes?: number }
let editions: AlbumEditions = { ok: true, editions: [], chosenId: null }
;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: async (): Promise<Answer> => ({ ok: true, imported: 5, dupes: 0 }),
    checkQobuzAlbum: async () => ({ answer: 'unknown', why: 'no-token' }),
    listAlbumEditions: async () => editions,
    usageLog: () => {},
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
}
const { getQueue, clearFinished } = await import('../../renderer/views/DownloadStore/downloadQueue.ts')
const { resetEditionsForTests } = await import('../../renderer/views/DownloadStore/albumEditions.ts')
const { saveAlbumNamed } = await import('../../renderer/listen-to-the-list/ltlDownload.ts')
const settle = async () => { for (let i = 0; i < 200; i++) { await new Promise((r) => setTimeout(r, 5)); if (!getQueue().some((q) => q.status === 'queued' || q.status === 'downloading')) return } }

describe('a For You album not on the list saves in one click', () => {
  beforeEach(async () => { await settle(); clearFinished(); resetEditionsForTests() })
  it('queues the edition main names and answers that job’s key', async () => {
    editions = { ok: true, editions: [ed(3, 'Animals', 'Standard', 5, 1977), ed(30, 'Animals (2018 Remix)', '2018 Remix', 5, 2022)], chosenId: 3 }
    const r = await saveAlbumNamed('Pink Floyd', 'Animals', 'for-you')
    assert.ok(r.key)
    assert.equal(r.existingKey, undefined)
    const job = getQueue().find((q) => q.key === r.key)
    assert.ok(job, 'the key is the queued job’s')
    assert.equal(job.result.collectionId, 3)
    assert.equal(job.result.surface, 'for-you')
    assert.equal(job.result.origin, undefined, 'nothing put on the list, no row behind it')
    await settle()
    // The same record again, done: Downloads opens on it (existingKey), never a silent no-op.
    const again = await saveAlbumNamed('Pink Floyd', 'Animals', 'for-you')
    assert.equal(again.existingKey, r.key)
    assert.equal(again.key, r.key)
  })
})

describe('the screens', () => {
  it('a search card’s foot is always drawn, and saves the job its edition makes', () => {
    const view = src('renderer/views/DownloadStore/DownloadView.tsx')
    assert.match(view, /<AlbumCardFoot artist=\{a\.artist\} card=\{card\} cardJob=\{qres\} action=\{\(job\) => renderAction\(job, itemFor\(job\)\)\} \/>/)
    assert.doesNotMatch(view, /dl-rel-hover|dl-rel-busy/, 'no Save album that shows only on hover')
    const foot = src('renderer/views/DownloadStore/AlbumCardFoot.tsx')
    assert.match(foot, /const other = cardSaveEdition\(card, ed\)/)
    assert.match(foot, /\{action\(job\)\}/)
  })
  it('a For You album card not on the list has Save album', () => {
    const view = src('renderer/views/NewForYouView.tsx')
    const unlisted = view.slice(view.indexOf('if (!isAdded) {'), view.indexOf('const rec = addedRecs.get(id)'))
    assert.match(unlisted, /c\.type === 'album' && <AlbumSaveButton artist=\{c\.artist\} album=\{c\.title\} surface="for-you"/)
  })
  it('"Save album" only ever saves: no Save album button opens Search', () => {
    const bad: string[] = []
    for (const p of ['renderer/views/ListenToTheListView.tsx', 'renderer/views/NewForYouView.tsx', 'renderer/views/DownloadStore/DownloadView.tsx', 'renderer/views/DownloadStore/ShopAlbumPage.tsx', 'renderer/views/DownloadStore/AlbumTracklistSheet.tsx']) {
      src(p).split('\n').forEach((line, i) => {
        if (/>Save album</.test(line) && /openDownloadForReco|pickInSearch|openBrowse|download-prefill|requestDiscoveryTab/.test(line)) bad.push(`${p}:${i + 1}`)
      })
    }
    assert.deepEqual(bad, [])
  })
  it('a refused save has one button, Choose another…, album or song', () => {
    const panel = src('renderer/components/DownloadsPanel.tsx')
    assert.equal((panel.match(/\{SHOP_WORDS\.chooseAnother\}/g) ?? []).length, 1)
    assert.match(panel, /row\.actions\.includes\('chooseEdition'\) \|\| row\.actions\.includes\('chooseVersion'\)/)
    assert.match(src('renderer/views/DownloadStore/DownloadView.tsx'), /const verb = near \? 'Details' : SHOP_WORDS\.chooseAnother/)
    assert.deepEqual(retiredNamesIn('Choose edition'), ['Choose edition'])
    assert.deepEqual(retiredNamesIn('Choose version…'), ['Choose version'])
  })
})
