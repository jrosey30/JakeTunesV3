/**
 * Compare editions, action A — the matching-track Gets ride the ONE
 * scheduler with a stubbed main. Mixed ownership, cancellation, partial
 * failure, repeat clicks, a candidate that fails verification after
 * staging, and the rule that nothing here can fulfil the album jot.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enqueue, getQueue, cancel, retry, clearFinished, queueKey, type QResult, type QItem } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import { planMatchingTrackGets } from '../../common/near-edition-actions.ts'
import { downloadsPanelRows, panelSummary } from '../../common/downloads-panel-model.ts'
import { projectRecoStatus } from '../../renderer/listen-to-the-list/ltlDownload.ts'
import type { CompareEditionsResult, TrackRow } from '../../common/near-edition-types.ts'

type Answer = { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string; primary?: string; detail?: string; alternatives?: unknown[] }
const answers = new Map<string, Answer | (() => Promise<Answer>)>()
const calls: Array<Record<string, unknown>> = []
const inFlight = new Set<(a: Answer) => void>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = async () => { for (let i = 0; i < 80; i++) { await sleep(5); if (!getQueue().some((q) => q.status === 'queued' || q.status === 'downloading')) return } }
;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: async (opts: Record<string, unknown>) => {
      calls.push(opts)
      const a = answers.get(String(opts.title)) ?? { ok: true, imported: 1, dupes: 0 }
      if (typeof a !== 'function') return a
      return new Promise<Answer>((res) => { inFlight.add(res); void a().then((v) => { inFlight.delete(res); res(v) }) })
    },
    streamripCancelActive: async () => { for (const res of inFlight) res({ ok: false, error: 'canceled', outcome: 'canceled' }); inFlight.clear() },
  },
  dispatchEvent: () => true,
}

const TITLES = ['Straylight', 'The Music', 'Mindless Tides', 'Here We Go', 'If You Open Up', 'Chord Progression', 'Looking Beyond', 'Magic Prison', 'Back to Reception', "Let's Jazz", 'Dètente', 'Nightshift']
const SECS = [400, 347, 409, 410, 302, 430, 423, 354, 344, 352, 310, 397]
function cmpFixture(owned: number[] = []): CompareEditionsResult {
  const rows: TrackRow[] = TITLES.map((t, i) => ({ n: i + 1, wantTitle: t, gotTitle: t, wantSec: SECS[i], gotSec: i === 3 ? 483.6 : SECS[i], deltaSec: i === 3 ? 74 : 0, verdict: i === 3 ? 'mismatch' : 'exact', reason: i === 3 ? 'runtime mismatch (8:04 found, 6:50 picked)' : null, owned: owned.includes(i + 1) }))
  return { ok: true, picked: { label: 'iTunes 96265705', trackCount: 12, releaseYear: 1997, collectionId: 96265705 }, found: { provider: 'bandcamp', label: 'Bandcamp edition', source: 'terryleebrownjunior.bandcamp.com/album/chocolate-chords', trackCount: 12, releaseYear: 1997 }, rows, summary: { total: 12, exact: 11, mismatch: 1, unknown: 0, owned: owned.length, toAcquire: 11 - owned.length, differing: [{ n: 4, title: 'Here We Go', wantSec: 410, gotSec: 483.6, reason: 'runtime mismatch (8:04 found, 6:50 picked)' }], matchingSentence: '', editionSentence: '' }, toleranceSec: 20 }
}
const PARENT: QResult = { kind: 'query', source: 'qobuz', mediaType: 'album', id: 'q|album|terryleebrownjunior|chocolatechords', desc: 'Chocolate Chords — Terry Lee Brown Junior (album)', artist: 'Terry Lee Brown Junior', album: 'Chocolate Chords', collectionId: 96265705, trackCount: 12, releaseYear: 1997, origin: { recommendationIds: ['jot-cc'], entryId: 'jot-cc', sourceKind: 'person', sourceLabel: 'Alex' } }
const REFUSE: Answer = { ok: false, outcome: 'exact-not-found', primary: 'Exact edition not found', alternatives: [{ provider: 'bandcamp', desc: 'Chocolate Chords — Terry Lee Brown Junior (12 tracks)', reason: 'track 4 “Here We Go” runs 8:04; the edition you picked runs 6:50' }] }
const ctx = { parentKey: queueKey(PARENT), artist: 'Terry Lee Brown Junior', album: 'Chocolate Chords', releaseYear: 1997, sourceKind: 'person', sourceLabel: 'Alex' }
const drain = () => { for (const q of getQueue()) q.status = 'failed'; clearFinished() }
async function refusedParent(): Promise<QItem> { answers.set('undefined', REFUSE); enqueue(PARENT); await settle(); return getQueue().find((q) => q.key === queueKey(PARENT))! }

describe('action A — matching-track Gets', () => {
  beforeEach(async () => { await settle(); drain(); answers.clear(); calls.length = 0; inFlight.clear() })

  it('the plan pins each selected recording (title as picked, runtime as picked), skips owned, never selects the mismatch, carries no recommendationIds', () => {
    const plan = planMatchingTrackGets(cmpFixture([2, 7]), ctx)
    assert.equal(plan.jobs.length, 9); assert.equal(plan.skippedOwned.length, 2)
    assert.equal(plan.notAcquired.length, 1)
    assert.equal(plan.notAcquired[0].position, 4); assert.equal(plan.notAcquired[0].title, 'Here We Go'); assert.equal(plan.notAcquired[0].reason, 'runtime mismatch (8:04 found, 6:50 picked)')
    assert.ok(!plan.jobs.some((j) => j.title === 'Here We Go' || j.title === 'The Music' || j.title === 'Looking Beyond'))
    const j = plan.jobs[0]
    assert.equal(j.mediaType, 'track'); assert.equal(j.title, 'Straylight'); assert.equal(j.durationMs, 400_000); assert.equal(j.album, 'Chocolate Chords')
    assert.deepEqual(j.origin.recommendationIds, []); assert.equal(j.origin.group.parentKey, ctx.parentKey); assert.equal(j.origin.group.position, 1); assert.equal(j.origin.group.skippedOwned, 2)
    assert.match(plan.sentence, /^Gets 9 songs now \(2 already in your library skipped\); 1 not acquired\./)
    assert.equal(planMatchingTrackGets(cmpFixture([1,2,3,5,6,7,8,9,10,11,12]), ctx).jobs.length, 0)
  })

  it('mixed ownership: the eleven land as songs grouped under the refused request; the album stays refused and the jot is never fulfilled', async () => {
    const parent = await refusedParent()
    assert.equal(parent.status, 'failed')
    const plan = planMatchingTrackGets(cmpFixture([10]), ctx)
    for (const j of plan.jobs) enqueue(j as unknown as QResult)
    await settle()
    const rows = downloadsPanelRows(getQueue(), Date.now())
    assert.equal(rows.length, 1, 'children fold under the parent')
    const top = rows[0]
    assert.equal(top.status, 'refused'); assert.ok(top.group)
    assert.equal(top.group!.children.length, 10); assert.equal(top.group!.done, 10); assert.equal(top.group!.skippedOwned, 1)
    assert.equal(top.group!.line, '11 of 12 in your library · track 4 not acquired (runtime mismatch (8:04 found, 6:50 picked))')
    assert.ok(!top.group!.line.includes('complete'))
    const trackCalls = calls.filter((c) => c.title !== undefined)
    assert.equal(trackCalls.length, 10); assert.ok(trackCalls.every((c) => typeof c.durationMs === 'number' && c.album === 'Chocolate Chords'))
    // the album jot: still on the refused album job, not on any child
    const st = projectRecoStatus(getQueue(), { id: 'jot-cc', artist: 'Terry Lee Brown Junior', album: 'Chocolate Chords' })
    assert.equal(st.state, 'error'); assert.equal(st.jobKey, parent.key)
    assert.ok(getQueue().filter((q) => q.result.origin?.group).every((q) => q.result.origin!.recommendationIds.length === 0))
    assert.deepEqual(panelSummary(rows), { active: 0, queued: 0, done: 10, failed: 1, canceled: 0 })
  })

  it('cancellation of one child shows in the group, the others land, and Retry re-arms only it', async () => {
    await refusedParent()
    answers.set('Mindless Tides', () => new Promise(() => {}))   // never resolves on its own
    const plan = planMatchingTrackGets(cmpFixture(), ctx)
    for (const j of plan.jobs) enqueue(j as unknown as QResult)
    await sleep(15)
    const stuck = getQueue().find((q) => q.result.title === 'Mindless Tides')!
    assert.equal(stuck.status, 'downloading')
    await cancel(stuck.key); await settle()
    let top = downloadsPanelRows(getQueue(), Date.now())[0]
    assert.equal(top.group!.canceled, 1); assert.equal(top.group!.done, 10); assert.ok(top.actions.includes('retryGroup'))
    assert.match(top.group!.line, /10 of 12 in your library · 1 canceled/)
    answers.delete('Mindless Tides')
    const before = calls.length
    for (const c of top.group!.children) if (c.status === 'canceled' || c.status === 'failed') retry(c.key)
    await settle()
    top = downloadsPanelRows(getQueue(), Date.now())[0]
    assert.equal(calls.length - before, 1, 'only the canceled track was retried'); assert.equal(top.group!.done, 11); assert.ok(!top.actions.includes('retryGroup'))
  })

  it('partial failure and a candidate that fails verification after staging: failed rows carry the verdict, the rest land, Retry targets only them', async () => {
    await refusedParent()
    answers.set('Magic Prison', { ok: false, outcome: 'provider-failed', primary: 'Download failed', detail: 'transfer failed' })
    answers.set('Nightshift', { ok: false, outcome: 'unverifiable', primary: 'Couldn’t verify recording', detail: 'A file arrived but its runtime could not be read; it was not imported.' })
    const plan = planMatchingTrackGets(cmpFixture(), ctx)
    for (const j of plan.jobs) enqueue(j as unknown as QResult)
    await settle()
    let top = downloadsPanelRows(getQueue(), Date.now())[0]
    assert.equal(top.group!.failed, 2); assert.equal(top.group!.done, 9)
    const bad = top.group!.children.filter((c) => c.status === 'failed' || c.status === 'refused').map((c) => [c.title, c.primary])
    assert.deepEqual(bad, [['Magic Prison', 'Download failed'], ['Nightshift', 'Couldn’t verify recording']])
    assert.match(top.group!.line, /9 of 12 in your library · 2 failed · track 4 not acquired/)
    answers.delete('Magic Prison'); answers.delete('Nightshift')
    const before = calls.length
    for (const c of top.group!.children) if (c.status === 'failed' || c.status === 'refused' || c.status === 'canceled') retry(c.key)
    await settle()
    top = downloadsPanelRows(getQueue(), Date.now())[0]
    assert.equal(calls.length - before, 2); assert.equal(top.group!.done, 11); assert.equal(top.group!.failed, 0)
  })

  it('repeat clicks never duplicate: done and in-flight children are untouched, a failed one is re-armed', async () => {
    await refusedParent()
    answers.set('Straylight', { ok: false, outcome: 'provider-failed', primary: 'Download failed' })
    const plan = planMatchingTrackGets(cmpFixture(), ctx)
    for (const j of plan.jobs) enqueue(j as unknown as QResult)
    await settle()
    const n1 = getQueue().length; const c1 = calls.length
    answers.delete('Straylight')
    for (const j of plan.jobs) enqueue(j as unknown as QResult)   // the second click
    await settle()
    assert.equal(getQueue().length, n1, 'no duplicate jobs')
    assert.equal(calls.length - c1, 1, 'only the failed track ran again')
    assert.equal(downloadsPanelRows(getQueue(), Date.now())[0].group!.done, 11)
  })

  it('nothing is acquired before the one inline click: the table is pure, and the panel enqueues only inside getMatching', () => {
    const table = readFileSync(join(import.meta.dirname, '../../renderer/components/NearEditionTable.tsx'), 'utf8')
    for (const banned of ['downloadQueue', 'enqueue(', 'startGet', 'jaketunes-download-prefill', 'streamripDownload']) assert.ok(!table.includes(banned), `table must not reference ${banned}`)
    const panel = readFileSync(join(import.meta.dirname, '../../renderer/components/DownloadsPanel.tsx'), 'utf8')
    const enqueues = panel.split('enqueue(').length - 1
    assert.equal(enqueues, 1, 'exactly one enqueue site — the Get N matching tracks click')
    assert.ok(!panel.includes('Confirm —') && !panel.includes('onGetEdition'), 'the alternate-edition action and its confirmation are gone')
  })
})
