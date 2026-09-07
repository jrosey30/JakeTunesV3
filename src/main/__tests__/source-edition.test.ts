/**
 * Compare editions, action B — the source edition: selected by URL +
 * tracklist snapshot, acquired and verified against that snapshot through
 * the one scheduler; its ownership and completion distinct from the iTunes
 * request. Mixed ownership, repeat clicks, cancellation, partial import, and
 * a source tracklist that changed between comparison and acquisition.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enqueue, getQueue, cancel, clearFinished, queueKey, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import { planSourceEditionGet, planMatchingTrackGets } from '../../common/near-edition-actions.ts'
import { downloadsPanelRows } from '../../common/downloads-panel-model.ts'
import { projectRecoStatus } from '../../renderer/listen-to-the-list/ltlDownload.ts'
import { requestFromSourceEdition, verifySourceEdition } from '../source-edition-verify.ts'
import type { CompareEditionsResult, TrackRow } from '../../common/near-edition-types.ts'
import type { SourceEdition } from '../../common/source-edition.ts'

type Answer = { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string; primary?: string; detail?: string; completion?: string; matchDesc?: string }
let answer: (opts: Record<string, unknown>) => Answer | Promise<Answer> = () => ({ ok: true, imported: 12, dupes: 0, completion: '12 tracks · 12 imported' })
const calls: Array<Record<string, unknown>> = []
const inFlight = new Set<(a: Answer) => void>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = async () => { for (let i = 0; i < 80; i++) { await sleep(5); if (!getQueue().some((q) => q.status === 'queued' || q.status === 'downloading')) return } }
;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: async (opts: Record<string, unknown>) => { calls.push(opts); const a = answer(opts); if (a instanceof Promise) { return new Promise<Answer>((res) => { inFlight.add(res); void a.then((v) => { inFlight.delete(res); res(v) }) }) } return a },
    streamripCancelActive: async () => { for (const res of inFlight) res({ ok: false, error: 'canceled', outcome: 'canceled' }); inFlight.clear() },
  },
  dispatchEvent: () => true,
}

const TITLES = ['Straylight', 'The Music', 'Mindless Tides', 'Here We Go', 'If You Open Up', 'Chord Progression', 'Looking Beyond', 'Magic Prison', 'Back to Reception', 'Let´s Jazz', 'Détente', 'Nightshift']
const PICKED = ['Straylight', 'The Music', 'Mindless Tides', 'Here We Go', 'If You Open Up', 'Chord Progression', 'Looking Beyond', 'Magic Prison', 'Back to Reception', "Let's Jazz", 'Dètente', 'Nightshift']
const SECS = [400, 347, 409, 410, 302, 430, 423, 354, 344, 352, 310, 397]
const URL = 'https://terryleebrownjunior.bandcamp.com/album/chocolate-chords'
function cmpFixture(owned: number[] = [], url: string | null = URL): CompareEditionsResult {
  const rows: TrackRow[] = PICKED.map((t, i) => ({ n: i + 1, wantTitle: t, gotTitle: TITLES[i], wantSec: SECS[i], gotSec: i === 3 ? 483.6 : SECS[i], deltaSec: i === 3 ? 74 : 0, verdict: i === 3 ? 'mismatch' : 'exact', reason: i === 3 ? 'runtime mismatch (8:04 found, 6:50 picked)' : null, owned: owned.includes(i + 1) }))
  return { ok: true, picked: { label: 'iTunes 96265705', trackCount: 12, releaseYear: 1997, collectionId: 96265705 }, found: { provider: 'bandcamp', label: 'Bandcamp edition', source: 'terryleebrownjunior.bandcamp.com/album/chocolate-chords', url: url ?? undefined, trackCount: 12, releaseYear: 1997 }, rows, summary: { total: 12, exact: 11, mismatch: 1, unknown: 0, owned: owned.length, toAcquire: 11 - owned.length, differing: [], matchingSentence: '', editionSentence: '' }, toleranceSec: 20 }
}
const PARENT: QResult = { kind: 'query', source: 'qobuz', mediaType: 'album', id: 'q|album|terryleebrownjunior|chocolatechords', desc: 'Chocolate Chords — Terry Lee Brown Junior (album)', artist: 'Terry Lee Brown Junior', album: 'Chocolate Chords', collectionId: 96265705, trackCount: 12, releaseYear: 1997, origin: { recommendationIds: ['jot-cc'], entryId: 'jot-cc', sourceKind: 'person', sourceLabel: 'Alex' } }
const ctx = { parentKey: queueKey(PARENT), artist: 'Terry Lee Brown Junior', album: 'Chocolate Chords', sourceKind: 'person', sourceLabel: 'Alex' }
const drain = () => { for (const q of getQueue()) q.status = 'failed'; clearFinished() }
async function refusedParent() { answer = () => ({ ok: false, outcome: 'exact-not-found', primary: 'Exact edition not found' }); enqueue(PARENT); await settle() }
const stagedFrom = (se: SourceEdition, over: (t: SourceEdition['tracks'][number], i: number) => Partial<SourceEdition['tracks'][number]> = () => ({})) => ({ provider: 'bandcamp' as const, desc: 'staged', title: se.title, artist: se.artist, staged: true, trackCount: se.tracks.length, tracks: se.tracks.map((t, i) => ({ ...t, ...over(t, i) })) })

describe('action B — the source edition', () => {
  beforeEach(async () => { await settle(); drain(); calls.length = 0; inFlight.clear(); answer = () => ({ ok: true, imported: 12, dupes: 0, completion: '12 tracks · 12 imported' }) })

  it('the plan selects by URL + tracklist snapshot, shows the runtime difference, carries no recommendationIds, and has a key distinct from the iTunes job', () => {
    const plan = planSourceEditionGet(cmpFixture(), ctx)
    assert.ok(!('error' in plan)); if ('error' in plan) return
    assert.equal(plan.job.source, 'bandcamp'); assert.equal(plan.job.id, 'bc|album|terryleebrownjunior.bandcamp.com/album/chocolate-chords')
    assert.notEqual(queueKey(plan.job as unknown as QResult), queueKey(PARENT))
    assert.equal(plan.job.sourceEdition.url, URL); assert.equal(plan.job.sourceEdition.tracks.length, 12)
    assert.equal(plan.job.sourceEdition.tracks[3].durationSec, 483.6); assert.equal(plan.job.sourceEdition.tracks[9].title, 'Let´s Jazz', 'the snapshot keeps the source’s own titles')
    assert.deepEqual(plan.job.origin.recommendationIds, []); assert.equal(plan.job.origin.chosenInsteadOf?.label, 'iTunes 96265705')
    assert.equal(plan.differences.length, 1); assert.match(plan.differences[0].line, /Track 4 “Here We Go”: 8:04 on this edition, 6:50 on the one you picked/)
    assert.match(plan.identityLine, /terryleebrownjunior\.bandcamp\.com\/album\/chocolate-chords · 12 tracks · 1997/)
    assert.match(plan.recordedLine, /Recorded as the Bandcamp edition, 12 of 12; differs from iTunes 96265705 at track 4 \(8:04 vs 6:50\)/)
    assert.match(plan.neverLine, /iTunes 96265705 is not marked as owned by this/)
    assert.ok('error' in planSourceEditionGet(cmpFixture([], null), ctx), 'no URL → cannot be selected')
  })

  it('verification is against the snapshot: the same source tracklist is exact; a changed runtime, title or count is refused', () => {
    const plan = planSourceEditionGet(cmpFixture(), ctx); if ('error' in plan) throw new Error(plan.error)
    const se = plan.job.sourceEdition
    assert.equal(requestFromSourceEdition(se).tracks.length, 12)
    assert.equal(verifySourceEdition(se, stagedFrom(se)).verdict, 'exact')
    const runtime = verifySourceEdition(se, stagedFrom(se, (t, i) => (i === 7 ? { durationSec: 354 + 60 } : {})))
    assert.equal(runtime.verdict, 'reject'); assert.match((runtime as { reason: string }).reason, /tracklist is not the one you compared — track 8 “Magic Prison” runs 6:54/)
    const title = verifySourceEdition(se, stagedFrom(se, (t, i) => (i === 0 ? { title: 'Straylight (Remix)' } : {})))
    assert.equal(title.verdict, 'reject')
    const count = verifySourceEdition(se, { ...stagedFrom(se), trackCount: 11, tracks: stagedFrom(se).tracks.slice(0, 11) })
    assert.equal(count.verdict, 'reject'); assert.match((count as { reason: string }).reason, /not the one you compared/)
  })

  it('mixed ownership: the edition lands through the scheduler as its own job; completion credits owned recordings; the iTunes request stays refused and the jot untouched', async () => {
    await refusedParent()
    answer = (o) => (o.sourceEdition ? { ok: true, imported: 9, dupes: 3, completion: '12 tracks · 9 imported, 3 already in your library', matchDesc: 'Chocolate Chords — Terry Lee Brown Junior (Bandcamp edition)' } : { ok: false, outcome: 'exact-not-found' })
    const plan = planSourceEditionGet(cmpFixture([1, 2, 3]), ctx); if ('error' in plan) throw new Error(plan.error)
    enqueue(plan.job as unknown as QResult); await settle()
    const sent = calls.find((c) => c.sourceEdition) as { sourceEdition: SourceEdition; album: string; collectionId?: number }
    assert.equal(sent.sourceEdition.url, URL); assert.equal(sent.sourceEdition.tracks.length, 12); assert.equal(sent.collectionId, undefined, 'no iTunes edition rides on the source request')
    const rows = downloadsPanelRows(getQueue(), Date.now())
    assert.equal(rows.length, 2, 'the source edition is its own row, not a child of the refused request')
    const bc = rows.find((r) => r.status === 'done')!; const it = rows.find((r) => r.status === 'refused')!
    assert.equal(bc.edition, 'Bandcamp edition · terryleebrownjunior.bandcamp.com/album/chocolate-chords · 12 tracks · 1997')
    assert.equal(bc.editionNote, 'chosen instead of iTunes 96265705 · differs at track 4 (8:04 vs 6:50)')
    assert.equal(bc.counts, '9 imported · 3 already in your library'); assert.match(bc.completion!, /12 tracks · 9 imported, 3 already/)
    assert.equal(it.status, 'refused'); assert.equal(it.edition, 'album · 12 tracks · 1997 · iTunes 96265705')
    const st = projectRecoStatus(getQueue(), { id: 'jot-cc', artist: 'Terry Lee Brown Junior', album: 'Chocolate Chords' })
    assert.equal(st.state, 'error'); assert.equal(st.jobKey, queueKey(PARENT))
  })

  it('repeat clicks never duplicate the job; cancellation mid-flight is honest; a partial import is refused, not claimed', async () => {
    await refusedParent()
    const plan = planSourceEditionGet(cmpFixture(), ctx); if ('error' in plan) throw new Error(plan.error)
    answer = (o) => (o.sourceEdition ? new Promise(() => {}) : { ok: false, outcome: 'exact-not-found' })
    enqueue(plan.job as unknown as QResult); await sleep(10)
    enqueue(plan.job as unknown as QResult)              // second click while in flight
    assert.equal(getQueue().filter((q) => q.result.sourceEdition).length, 1)
    const job = getQueue().find((q) => q.result.sourceEdition)!
    assert.equal(job.status, 'downloading')
    await cancel(job.key); await settle()
    assert.equal(job.status, 'canceled')
    // partial import → the engine refuses (not calling this done); the row says so
    answer = (o) => (o.sourceEdition ? { ok: false, outcome: 'provider-failed', primary: 'Album import incomplete', error: '12 tracks · 10 imported, 2 missing', completion: '12 tracks · 10 imported, 2 missing' } : { ok: false, outcome: 'exact-not-found' })
    enqueue(plan.job as unknown as QResult); await settle()  // re-arm the canceled one (that IS the repeat click)
    const rows = downloadsPanelRows(getQueue(), Date.now())
    const bc = rows.find((r) => r.kind === 'album' && r.editionNote)!
    assert.equal(bc.status, 'failed'); assert.equal(bc.primary, 'Album import incomplete'); assert.equal(bc.completion, null, 'nothing is claimed as complete')
    assert.equal(calls.filter((c) => c.sourceEdition).length, 2, 'one call per attempt, never a duplicate')
  })

  it('a source tracklist that changed between comparison and acquisition is refused by the engine path with the snapshot named', async () => {
    await refusedParent()
    const plan = planSourceEditionGet(cmpFixture(), ctx); if ('error' in plan) throw new Error(plan.error)
    // main's answer when verifySourceEdition rejects (the engine builds exactly this)
    answer = (o) => (o.sourceEdition ? { ok: false, outcome: 'exact-not-found', primary: 'Source edition changed', error: 'the bandcamp tracklist is not the one you compared — track 8 “Magic Prison” runs 6:54; the edition you picked runs 5:54', detail: 'Nothing was imported. Compare editions again to see the current tracklist.' } : { ok: false, outcome: 'exact-not-found' })
    enqueue(plan.job as unknown as QResult); await settle()
    const bc = downloadsPanelRows(getQueue(), Date.now()).find((r) => r.editionNote)!
    assert.equal(bc.status, 'refused'); assert.equal(bc.primary, 'Source edition changed'); assert.match(bc.detail!, /Nothing was imported/)
  })

  it('actions A and B stay distinct: a matching-track plan and a source-edition plan from the same comparison never share keys or recommendation ids', () => {
    const a = planMatchingTrackGets(cmpFixture(), ctx); const b = planSourceEditionGet(cmpFixture(), ctx); if ('error' in b) throw new Error(b.error)
    const keys = new Set([...a.jobs.map((j) => queueKey(j as unknown as QResult)), queueKey(b.job as unknown as QResult), queueKey(PARENT)])
    assert.equal(keys.size, a.jobs.length + 2)
    assert.deepEqual(b.job.origin.recommendationIds, [])
  })

  it('the sheet still never touches the queue; the confirm step exists before the edition is queued', () => {
    const src = readFileSync(join(import.meta.dirname, '../../renderer/components/CompareEditionsSheet.tsx'), 'utf8')
    for (const banned of ['downloadQueue', 'enqueue(', 'startGet', 'jaketunes-download-prefill', 'streamripDownload']) assert.ok(!src.includes(banned), `sheet must not reference ${banned}`)
    assert.ok(src.includes('Confirm — get') && src.includes('onGetEdition'), 'confirmation precedes the delegated enqueue')
  })
})
