/**
 * One scheduler (6.0 Record Shop, 2026-09-05): the Listen List no longer owns a
 * queue. These tests drive the REAL downloadQueue with a stubbed main and
 * check that a recommendation becomes the same job a Download-view Get
 * would, that provenance rides on it, that a loose album is sent to edition
 * selection instead of being downloaded blind, and that status, cancel and
 * retry are projected back by recommendation id.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { enqueue, getQueue, clearFinished, cancel, queueKey, trackQueryId, albumQueryId, itemForRecommendation, mergeOrigin, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import {
  recoToQueueResult, recoKind, recoOrigin, queueRecoDownload, queueAllRecoDownloads, projectRecoStatus,
  getLtlDownloadSnapshot, getLtlDownloadStatus, isLtlDownloadBusy, cancelRecoDownload, retryRecoDownload, canDownloadReco, prefillQueryFor,
} from '../../renderer/listen-to-the-list/ltlDownload.ts'
import type { Recommendation } from '../../renderer/types.ts'

type Answer = { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string; primary?: string; detail?: string; matchDesc?: string; completion?: string }
const answers = new Map<string, Answer | (() => Promise<Answer>)>()
const calls: Array<Record<string, unknown>> = []
let cancelCalls = 0
// In-flight rips main would end on streamripCancelActive — the stub must end
// them too, or the scheduler's serial pump (correctly) never moves on.
const inFlight = new Set<(a: Answer) => void>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = async () => { for (let i = 0; i < 40; i++) { await sleep(5); if (!getQueue().some((q) => q.status === 'queued' || q.status === 'downloading')) return } }

// The renderer modules reach main only through window.electronAPI.
;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: async (opts: Record<string, unknown>) => {
      calls.push(opts)
      const a = answers.get(String(opts.title ?? opts.album)) ?? { ok: false, error: 'no answer stubbed' }
      if (typeof a !== 'function') return a
      return new Promise<Answer>((res) => { inFlight.add(res); void a().then((v) => { inFlight.delete(res); res(v) }) })
    },
    streamripCancelActive: async () => { cancelCalls++; for (const res of inFlight) res({ ok: false, error: 'canceled', outcome: 'canceled' }); inFlight.clear() },
  },
  dispatchEvent: () => true,
}

const rec = (over: Partial<Recommendation>): Recommendation => ({ id: 'r-' + Math.random().toString(36).slice(2, 8), createdAt: '2026-09-05T00:00:00Z', ...over })
const drain = () => { for (const q of getQueue()) { q.status = 'failed' } ; clearFinished() }

describe('the Listen List rides the one Downloads scheduler', () => {
  beforeEach(() => { drain(); answers.clear(); calls.length = 0; cancelCalls = 0 })

  it('a song recommendation becomes exactly the job a Download-view Get would, plus provenance', () => {
    const r = rec({ song: 'Helicopter', artist: 'XTC', album: 'Drums and Wires', note: 'from Alex · https://x.y/z', source: 'user' })
    const d = recoToQueueResult(r)
    assert.equal(d.kind, 'queue')
    if (d.kind !== 'queue') return
    assert.equal(d.result.id, trackQueryId('XTC', 'Helicopter'))
    assert.equal(d.result.mediaType, 'track')
    assert.equal(d.result.album, 'Drums and Wires')        // the album door hint, not an album request
    assert.deepEqual(d.result.origin, { recommendationIds: [r.id], entryId: r.id, sourceKind: 'person', sourceLabel: 'Alex' })
    assert.equal(recoOrigin(rec({ song: 'x', artist: 'y', source: 'radar' })).sourceKind, 'radar')
    // the identity key is what the Download view builds for the same click
    const fromView: QResult = { kind: 'query', source: 'qobuz', mediaType: 'track', id: trackQueryId('XTC ', 'Helicopter!'), desc: 'x' }
    assert.equal(queueKey(fromView), queueKey(d.result))
  })

  it('a loose album is sent to edition selection; artists and concerts are browse-only; nothing is downloaded blind', () => {
    assert.deepEqual(recoToQueueResult(rec({ kind: 'album', album: 'Little Creatures', artist: 'Talking Heads' })), { kind: 'select-edition', artist: 'Talking Heads', album: 'Little Creatures' })
    assert.deepEqual(recoToQueueResult(rec({ album: 'Little Creatures', artist: 'Talking Heads' })), { kind: 'select-edition', artist: 'Talking Heads', album: 'Little Creatures' })
    assert.deepEqual(recoToQueueResult(rec({ artist: 'Talking Heads' })), { kind: 'browse-only', reason: 'artist' })
    assert.deepEqual(recoToQueueResult(rec({ kind: 'concert', song: 'Live at CBGB', artist: 'Talking Heads', externalId: 'archive:x' })), { kind: 'browse-only', reason: 'concert' })
    assert.equal(recoKind(rec({ matchedTitle: 'Song', album: 'Record' })), 'song')
    const before = getQueue().length
    const d = queueRecoDownload(rec({ kind: 'album', album: 'Little Creatures', artist: 'Talking Heads' }))
    assert.equal(d.kind, 'select-edition')
    assert.equal(getQueue().length, before)
    assert.equal(calls.length, 0)
    assert.ok(canDownloadReco(rec({ artist: 'Only An Artist' })))    // the row still has an action: browse
  })

  it('status is projected by recommendation id through queued → downloading → done, with the completion line', async () => {
    let release!: () => void
    answers.set('Helicopter', () => new Promise<Answer>((res) => { release = () => res({ ok: true, imported: 1, dupes: 0, matchDesc: 'Helicopter by XTC' }) }))
    const r = rec({ song: 'Helicopter', artist: 'XTC' })
    const d = queueRecoDownload(r)
    assert.equal(d.kind, 'queue')
    await sleep(10)
    assert.equal(getLtlDownloadStatus(r.id).state, 'downloading')
    assert.ok(isLtlDownloadBusy(r.id))
    release!()
    await settle()
    const s = getLtlDownloadStatus(r.id)
    assert.equal(s.state, 'done'); assert.equal(s.imported, 1); assert.equal(s.matchDesc, 'Helicopter by XTC')
    // the snapshot is stable between queue changes (useSyncExternalStore contract)
    assert.equal(getLtlDownloadSnapshot(), getLtlDownloadSnapshot())
    // the payload main saw carried the identity fields, not just words
    assert.equal(calls[0].artist, 'XTC'); assert.equal(calls[0].title, 'Helicopter')
  })

  it('already owned counts as done; a failure carries the structured verdict; nothing imported is not success', async () => {
    answers.set('Owned Song', { ok: true, imported: 0, dupes: 1 })
    answers.set('Missing Song', { ok: false, outcome: 'exact-not-found', primary: 'Exact version not found', detail: 'Sources answered…', error: 'Exact version not found: …' })
    answers.set('Hollow Song', { ok: true, imported: 0, dupes: 0 })
    const a = rec({ song: 'Owned Song', artist: 'A' }), b = rec({ song: 'Missing Song', artist: 'B' }), c = rec({ song: 'Hollow Song', artist: 'C' })
    const res = queueAllRecoDownloads([a, b, c, rec({ kind: 'album', album: 'X', artist: 'Y' }), rec({ artist: 'Z' })])
    assert.deepEqual(res, { queued: 3, needSelection: 1, browseOnly: 1 })
    await settle()
    assert.deepEqual({ ...getLtlDownloadStatus(a.id), jobKey: undefined }, { state: 'done', imported: 0, alreadyOwned: 1, matchDesc: undefined, completion: undefined, primary: undefined, detail: undefined, outcome: undefined, jobKey: undefined })
    const sb = getLtlDownloadStatus(b.id)
    assert.equal(sb.state, 'error'); assert.equal(sb.primary, 'Exact version not found'); assert.equal(sb.outcome, 'exact-not-found'); assert.match(sb.error || '', /Exact version not found/)
    assert.equal(getLtlDownloadStatus(c.id).state, 'error')
  })

  it('the same recording from two recommenders is ONE job with both ids; a Download-view job is found by identity', async () => {
    answers.set('Shared Song', () => new Promise<Answer>(() => { /* never resolves: stays downloading */ }))
    const r1 = rec({ song: 'Shared Song', artist: 'Band', note: 'from Alex' }), r2 = rec({ song: 'Shared Song', artist: 'Band', note: 'from Sam' })
    queueRecoDownload(r1); queueRecoDownload(r2)
    await sleep(10)
    const jobs = getQueue().filter((q) => q.result.title === 'Shared Song')
    assert.equal(jobs.length, 1)
    assert.deepEqual(jobs[0].result.origin?.recommendationIds, [r1.id, r2.id])
    assert.equal(jobs[0].result.origin?.sourceLabel, 'Alex')     // first source kept, second adopted
    assert.equal(getLtlDownloadStatus(r2.id).state, 'downloading')
    // a job that started from the Download view (no origin yet) is still visible to a matching recommendation
    const view: QResult = { kind: 'query', source: 'qobuz', mediaType: 'track', id: trackQueryId('Band', 'View Song'), desc: 'View Song — Band', artist: 'Band', title: 'View Song' }
    mergeOrigin(view, undefined)
    const st = projectRecoStatus([{ key: queueKey(view), result: view, status: 'queued' }], { id: 'r-x', song: 'View Song', artist: 'Band' })
    assert.equal(st.state, 'queued')
    assert.equal(projectRecoStatus([], { id: 'nope' }).state, 'idle')
    // an album job made in the Download view from a prefilled selection carries the id back
    const alb: QResult = { kind: 'query', source: 'qobuz', mediaType: 'album', id: albumQueryId('Talking Heads', 'Little Creatures (Deluxe Version)'), desc: 'x', artist: 'Talking Heads', album: 'Little Creatures (Deluxe Version)', collectionId: 124906778, trackCount: 12, origin: { recommendationIds: ['r-album'] } }
    enqueue(alb)
    assert.equal(itemForRecommendation('r-album')?.result.collectionId, 124906778)
    assert.equal(getLtlDownloadStatus('r-album').state, 'queued')
    await cancel(queueKey(alb))
    await cancel(jobs[0].key)
  })

  it('the prefilled catalogue query drops decoration and feature credits; the full name still names the edition (live 2026-09-05)', () => {
    assert.equal(prefillQueryFor('Sting & Bedouin', 'Desert Rose (Reimagined) [feat. Cheb Mami]'), 'Sting Desert Rose')   // enriched form (the view now prefers the jot's raw fields: 'Bedouin Desert Rose')
    assert.equal(prefillQueryFor('Bedouin', 'Desert Rose (Reimagined)'), 'Bedouin Desert Rose')
    assert.equal(prefillQueryFor('Talking Heads', 'Little Creatures (Deluxe Version)'), 'Talking Heads Little Creatures')
    assert.equal(prefillQueryFor('XTC', 'Drums and Wires'), 'XTC Drums and Wires')
    assert.equal(prefillQueryFor('', '(Untitled)'), '(Untitled)')
  })

  it('cancel stops the owning job and retry re-arms it for the same identity', async () => {
    answers.set('Slow Song', () => new Promise<Answer>(() => { /* in flight until canceled */ }))
    const r = rec({ song: 'Slow Song', artist: 'Band' })
    queueRecoDownload(r)
    await sleep(10)
    assert.equal(getLtlDownloadStatus(r.id).state, 'downloading')
    await cancelRecoDownload(r.id)
    assert.equal(cancelCalls, 1)
    assert.equal(itemForRecommendation(r.id)?.status, 'canceled')
    assert.equal(getLtlDownloadStatus(r.id).state, 'idle')
    answers.set('Slow Song', { ok: true, imported: 1 })
    retryRecoDownload(r.id)
    await settle()
    assert.equal(getLtlDownloadStatus(r.id).state, 'done')
    assert.equal(getQueue().filter((q) => q.result.title === 'Slow Song').length, 1)   // same job, second attempt
  })
})
