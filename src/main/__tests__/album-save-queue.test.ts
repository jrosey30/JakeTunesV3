/**
 * Brief 255 — the album preflight on the one scheduler, with main stubbed.
 *
 *  - A "no" ends the album job in seconds, with its plain line, and the walk
 *    (streamripDownloadByQuery) is never called.
 *  - "found", "unknown", a thrown preflight and a preflight that never
 *    answers all run today's walk: a broken question never blocks a download.
 *  - The question runs beside the download in flight: a "no" lands while a
 *    song is still downloading, and the one-at-a-time order is kept.
 *  - Songs never ask.
 *  - One `shop.album-save` usage line per save, at the first answer.
 *  - A Listen List album saves in one click with the edition main named.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { enqueue, getQueue, clearFinished, albumQueryId, trackQueryId, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import { albumJobFor, resetEditionsForTests, songJobsFor, saveSongsLabel, ownedKey } from '../../renderer/views/DownloadStore/albumEditions.ts'
import { saveRecoAlbum, getLtlDownloadStatus } from '../../renderer/listen-to-the-list/ltlDownload.ts'
import type { AlbumPreflight, AlbumEditions } from '../../common/album-preflight.ts'
import type { Recommendation } from '../../renderer/types.ts'

type Answer = { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const walkCalls: Array<Record<string, unknown>> = []
const preflightCalls: Array<Record<string, unknown>> = []
const usage: Array<Record<string, unknown>> = []
const preflight = new Map<string, AlbumPreflight | (() => Promise<AlbumPreflight>) | 'throw'>()
const walk = new Map<string, () => Promise<Answer>>()
let editions: AlbumEditions = { ok: true, editions: [], chosenId: null }

;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: async (opts: Record<string, unknown>) => {
      walkCalls.push(opts)
      const w = walk.get(String(opts.title ?? opts.album))
      return w ? w() : { ok: true, imported: 3, dupes: 0 }
    },
    checkQobuzAlbum: async (opts: Record<string, unknown>) => {
      preflightCalls.push(opts)
      const p = preflight.get(String(opts.album))
      if (p === 'throw') throw new Error('main went away')
      if (typeof p === 'function') return p()
      return p ?? { answer: 'found' }
    },
    listAlbumEditions: async () => editions,
    usageLog: (batch: Array<Record<string, unknown>>) => { usage.push(...batch) },
  },
}

const settle = async () => { for (let i = 0; i < 200; i++) { await sleep(5); if (!getQueue().some((q) => q.status === 'queued' || q.status === 'downloading')) return } }
const album = (name: string, o: Partial<QResult> = {}): QResult => ({ kind: 'query', source: 'qobuz', mediaType: 'album', id: albumQueryId('MJ Lenderman', name), desc: name, artist: 'MJ Lenderman', album: name, collectionId: 1749088991, trackCount: 9, clickedAt: Date.now(), surface: 'search', editionFrom: 'card', ...o })
const song = (title: string): QResult => ({ kind: 'query', source: 'qobuz', mediaType: 'track', id: trackQueryId('A', title), desc: title, artist: 'A', title })
const job = (name: string) => getQueue().find((q) => (q.result.album ?? q.result.title) === name)

beforeEach(async () => {
  await settle()
  clearFinished()
  walkCalls.length = 0; preflightCalls.length = 0; usage.length = 0
  preflight.clear(); walk.clear(); resetEditionsForTests()
  editions = { ok: true, editions: [], chosenId: null }
})

describe('the album preflight on the scheduler', () => {
  it('a "no" ends the job with its line, and nothing downloads', async () => {
    preflight.set('Manning Fireworks', { answer: 'no', why: 'partial', have: 6, of: 9 })
    enqueue(album('Manning Fireworks'))
    await settle()
    const it = job('Manning Fireworks')!
    assert.equal(it.status, 'failed')
    assert.equal(it.primary, 'Qobuz has 6 of 9 songs')
    assert.equal(it.outcome, 'exact-not-found')
    assert.match(it.detail || '', /Nothing was downloaded/)
    assert.equal(walkCalls.length, 0, 'the walk never ran')
    // the edition the card named went to the question
    assert.equal(preflightCalls[0].collectionId, 1749088991)
    assert.equal(preflightCalls[0].trackCount, 9)
  })

  it('found, unknown, a thrown question: the walk runs, unchanged', async () => {
    preflight.set('Found', { answer: 'found' })
    preflight.set('Unknown', { answer: 'unknown', why: 'no-token' })
    preflight.set('Broken', 'throw')
    enqueue(album('Found')); enqueue(album('Unknown')); enqueue(album('Broken'))
    await settle()
    assert.deepEqual(walkCalls.map((c) => c.album), ['Found', 'Unknown', 'Broken'])
    for (const n of ['Found', 'Unknown', 'Broken']) assert.equal(job(n)!.status, 'done')
  })

  it('the "no" lands while a song is still downloading; the order is kept', async () => {
    let release!: () => void
    walk.set('Long Song', () => new Promise<Answer>((res) => { release = () => res({ ok: true, imported: 1 }) }))
    preflight.set('Not There', async () => { await sleep(20); return { answer: 'no', why: 'not-on-qobuz' } })
    enqueue(song('Long Song'))
    enqueue(album('Not There'))
    await sleep(60)
    assert.equal(job('Long Song')!.status, 'downloading')
    assert.equal(job('Not There')!.status, 'failed', 'answered without waiting its turn')
    assert.equal(job('Not There')!.primary, 'Not on Qobuz')
    release()
    await settle()
    assert.deepEqual(walkCalls.map((c) => c.title ?? c.album), ['Long Song'])
  })

  it('the pump waits for an album’s answer before starting it, then goes on in order', async () => {
    preflight.set('Slow Answer', async () => { await sleep(40); return { answer: 'found' } })
    enqueue(album('Slow Answer'))
    enqueue(song('After It'))
    await sleep(10)
    assert.equal(walkCalls.length, 0, 'nothing jumps the album while it is asked about')
    await settle()
    assert.deepEqual(walkCalls.map((c) => c.title ?? c.album), ['Slow Answer', 'After It'])
  })

  it('songs never ask', async () => {
    enqueue(song('Just A Song'))
    await settle()
    assert.equal(preflightCalls.length, 0)
  })

  it('one usage line per save, at the first answer, never a title', async () => {
    preflight.set('Quick No', { answer: 'no', why: 'edition-differs', other: 'Deluxe' })
    preflight.set('Quick Yes', { answer: 'found' })
    preflight.set('Walk Decides', { answer: 'unknown', why: 'timeout' })
    walk.set('Walk Decides', async () => ({ ok: false, outcome: 'exact-not-found', error: 'x' }))
    enqueue(album('Quick No')); enqueue(album('Quick Yes')); enqueue(album('Walk Decides', { surface: 'for-you', editionFrom: 'resolved' }))
    await settle()
    const lines = usage.filter((u) => u.name === 'shop.album-save')
    assert.equal(lines.length, 3)
    const by = (a: string) => lines.find((l) => (l.detail as Record<string, unknown>).answer === a)!
    assert.deepEqual(by('no').detail, { answer: 'no', by: 'preflight', why: 'edition-differs', surface: 'search', edition: 'card' })
    assert.equal((by('found').detail as Record<string, unknown>).by, 'preflight')
    assert.deepEqual(by('failed').detail, { answer: 'failed', by: 'walk', why: 'timeout', surface: 'for-you', edition: 'resolved' })
    for (const l of lines) assert.equal(typeof l.ms, 'number')
    assert.doesNotMatch(JSON.stringify(lines), /Quick|Walk Decides|Lenderman/)
  })

  it('re-saving a refused album asks again', async () => {
    preflight.set('Try Twice', { answer: 'no', why: 'not-on-qobuz' })
    enqueue(album('Try Twice'))
    await settle()
    assert.equal(job('Try Twice')!.status, 'failed')
    preflight.set('Try Twice', { answer: 'found' })
    enqueue(album('Try Twice'))
    await settle()
    assert.equal(job('Try Twice')!.status, 'done')
    assert.equal(preflightCalls.filter((c) => c.album === 'Try Twice').length, 2)
  })
})

describe('Save album from a Listen List row, in one click', () => {
  const rec = (o: Partial<Recommendation>): Recommendation => ({ id: `r-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString(), ...o })

  it('takes the edition main named, with its id, size and year, and carries the row', async () => {
    editions = { ok: true, chosenId: 2, editions: [
      { collectionId: 2, name: 'Little Creatures', label: 'Standard', trackCount: 9, releaseYear: 1985, explicitness: 'notExplicit' },
      { collectionId: 3, name: 'Little Creatures (Deluxe Version)', label: 'Deluxe Version', trackCount: 15, releaseYear: 2006 },
    ] }
    const r = rec({ kind: 'album', artist: 'Talking Heads', album: 'Little Creatures' })
    await saveRecoAlbum(r, 'listen-list')
    await settle()
    assert.equal(walkCalls.length, 1)
    assert.equal(walkCalls[0].collectionId, 2); assert.equal(walkCalls[0].trackCount, 9); assert.equal(walkCalls[0].releaseYear, 1985)
    assert.equal(walkCalls[0].album, 'Little Creatures'); assert.equal(walkCalls[0].title, undefined)
    assert.equal(getLtlDownloadStatus(r.id).state, 'done')
    const line = usage.find((u) => u.name === 'shop.album-save')!
    assert.deepEqual(line.detail, { answer: 'found', by: 'preflight', surface: 'listen-list', edition: 'resolved' })
  })

  it('with no edition to name, the record goes by name, as main always resolved it', async () => {
    const r = rec({ kind: 'album', artist: 'Black Flag', album: 'Damaged' })
    await saveRecoAlbum(r, 'for-you')
    await settle()
    assert.equal(walkCalls[0].album, 'Damaged'); assert.equal(walkCalls[0].collectionId, undefined)
  })

  it('a running job is shown, not doubled', async () => {
    let release!: () => void
    walk.set('Remain in Light', () => new Promise<Answer>((res) => { release = () => res({ ok: true, imported: 8 }) }))
    const r = rec({ kind: 'album', artist: 'Talking Heads', album: 'Remain in Light' })
    assert.deepEqual(await saveRecoAlbum(r, 'listen-list'), {})
    await sleep(20)
    const again = await saveRecoAlbum(r, 'listen-list')
    assert.ok(again.existingKey)
    assert.equal(getQueue().filter((q) => q.result.album === 'Remain in Light').length, 1)
    release()
    await settle()
  })

  it('albumJobFor: the Search tab’s album job for that edition', () => {
    const q = albumJobFor({ artist: 'Wire', album: 'Pink Flag', edition: { collectionId: 9, name: 'Pink Flag - EP', label: 'Standard', trackCount: 21, explicitness: 'explicit' }, editionFrom: 'picked', surface: 'for-you', clickedAt: 5 })
    assert.equal(q.album, 'Pink Flag'); assert.equal(q.collectionId, 9); assert.equal(q.explicitSource, true); assert.equal(q.cleanedSource, false)
    assert.equal(q.id, albumQueryId('Wire', 'Pink Flag - EP')); assert.equal(q.editionFrom, 'picked'); assert.equal(q.mediaType, 'album')
  })
})

describe('a few songs from the album', () => {
  const tracks = [
    { song: 'Zoom 97', artist: 'Kurt Vile', album: "Philadelphia's been good to me", durationSecs: 294, releaseYear: 2026, explicitness: 'notExplicit', trackNumber: 1 },
    { song: '99 BPM', artist: 'Kurt Vile', album: "Philadelphia's been good to me", durationSecs: 285, releaseYear: 2026, trackNumber: 2 },
    { song: 'Rock o\u2019 Stone', artist: 'Kurt Vile', album: "Philadelphia's been good to me", durationSecs: 335, explicitness: 'cleaned', trackNumber: 3 },
  ]
  it('each ticked song is a song save of this edition\u2019s row, its length pinning the recording', () => {
    const jobs = songJobsFor({ tracks, ticked: [0, 2, 0], owned: new Set() })
    assert.equal(jobs.length, 2)
    assert.deepEqual(jobs.map((j) => [j.mediaType, j.title, j.album, j.durationMs]), [['track', 'Zoom 97', "Philadelphia's been good to me", 294000], ['track', 'Rock o\u2019 Stone', "Philadelphia's been good to me", 335000]])
    assert.equal(jobs[1].cleanedSource, true, 'a clean row says so, and main drops its length')
    assert.equal(jobs[0].id, trackQueryId('Kurt Vile', 'Zoom 97'))
  })
  it('songs already in the library are never saved again', () => {
    assert.deepEqual(songJobsFor({ tracks, ticked: [0, 1], owned: new Set([ownedKey('99 BPM', 'Kurt Vile')]) }).map((j) => j.title), ['Zoom 97'])
  })
  it('a row\u2019s sender rides along, but not the row: a few songs don\u2019t fulfil the album jot', () => {
    const [j] = songJobsFor({ tracks, ticked: [0], owned: new Set(), origin: { recommendationIds: ['r1'], entryId: 'r1', sourceKind: 'person', sourceLabel: 'Alex', addedVia: 'tiktok' } })
    assert.deepEqual(j.origin, { recommendationIds: [], entryId: undefined, sourceKind: 'person', sourceLabel: 'Alex', addedVia: 'tiktok' })
  })
  it('the button says how many, plainly', () => {
    assert.equal(saveSongsLabel(1), 'Save 1 song'); assert.equal(saveSongsLabel(3), 'Save 3 songs')
  })
  it('songs queued from the album never ask the album question', async () => {
    for (const j of songJobsFor({ tracks, ticked: [0, 1], owned: new Set() })) enqueue(j)
    await settle()
    assert.equal(preflightCalls.length, 0)
    assert.deepEqual(walkCalls.map((c) => c.title), ['Zoom 97', '99 BPM'])
  })
})
