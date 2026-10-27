import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTop1000Client, type FetchLike } from '../top1000-client.ts'
import { parseProgress, parseQuizNext, parseQuizUndo } from '../../common/top1000-doc.ts'

const progress = { answered: 3, settled: 200, moving: 800 }
const track = (id: number) => ({ id, title: `Song ${id}`, artist: 'A', album: 'B', duration: 200000 })

function fake(replies: Record<string, { status: number; body: unknown }>, seen: Array<{ url: string; init?: Record<string, unknown> }> = []): FetchLike {
  return async (url, init) => {
    seen.push({ url, init })
    const key = Object.keys(replies).find((k) => url.endsWith(k))
    if (!key) throw new Error('offline')
    const r = replies[key]!
    return { ok: r.status === 200, status: r.status, json: async () => r.body }
  }
}

describe('top1000 doc', () => {
  it('parses a question and refuses the wrong number of songs', () => {
    const ok = parseQuizNext({ question: { kind: 'pick', songs: [{ track: track(1), hookMs: 60000 }, { track: track(2), hookMs: 0 }] }, progress })
    assert.equal(ok?.question?.songs[0]?.hookMs, 60000)
    assert.equal(parseQuizNext({ question: { kind: 'pick', songs: [{ track: track(1), hookMs: 1 }] }, progress }), null)
    assert.equal(parseQuizNext({ question: { kind: 'nope', songs: [] }, progress }), null)
    assert.deepEqual(parseQuizNext({ question: null, progress }), { question: null, progress })
  })

  it('parses heats (with their quota) and duels; refuses a heat without a sensible quota', () => {
    const songs = (n: number) => Array.from({ length: n }, (_, i) => ({ track: track(i + 1), hookMs: 0 }))
    const heat = parseQuizNext({ question: { kind: 'heat', songs: songs(5), quota: 3 }, progress: { ...progress, round: 2, heatsLeft: 31, duelsLeft: 0 } })
    assert.equal(heat?.question?.quota, 3)
    assert.equal(heat?.progress.round, 2)
    assert.equal(heat?.progress.heatsLeft, 31)
    assert.equal(parseQuizNext({ question: { kind: 'heat', songs: songs(5), quota: 5 }, progress }), null)
    assert.equal(parseQuizNext({ question: { kind: 'heat', songs: songs(2), quota: 1 }, progress }), null)
    assert.equal(parseQuizNext({ question: { kind: 'duel', songs: songs(2) }, progress })?.question?.kind, 'duel')
  })

  it('reads the seats the lists hold and the songs competing — and older homeminis without them', () => {
    const now = parseProgress({ answered: 3465, settled: 612, moving: 388, fixed: 252, contenders: 250 })
    assert.deepEqual(now, { answered: 3465, settled: 612, moving: 388, fixed: 252, contenders: 250 })
    const fin = parseProgress({ answered: 1, settled: 2, moving: 3, round: 2, totalRounds: 3, heatsLeft: 35, duelsLeft: 0, roundDone: 0.41, out: 412, sure: 0.91 })
    assert.deepEqual(fin, { answered: 1, settled: 2, moving: 3, round: 2, totalRounds: 3, heatsLeft: 35, duelsLeft: 0, roundDone: 0.41, out: 412, sure: 0.91 })
    assert.deepEqual(parseProgress(progress), progress)
    assert.equal(parseProgress({ answered: 1, settled: 'x', moving: 2 }), null)
  })

  it('reads the genre brackets: which bracket a question is from, the two genres of a final, and the tour in the progress', () => {
    const songs = (n: number) => Array.from({ length: n }, (_, i) => ({ track: track(i + 1), hookMs: 0 }))
    const tour = { ...progress, round: 7, totalRounds: 3, stage: 'brackets', bracket: { name: 'Post-Punk', index: 4, total: 31 }, duelsLeft: 2 }
    const heat = parseQuizNext({ question: { kind: 'heat', songs: songs(5), quota: 2, stage: 'bracket', bracket: 'Post-Punk' }, progress: tour })
    assert.equal(heat?.question?.stage, 'bracket')
    assert.equal(heat?.question?.bracket, 'Post-Punk')
    assert.deepEqual(heat?.progress.bracket, { name: 'Post-Punk', index: 4, total: 31 })
    assert.equal(heat?.progress.stage, 'brackets')
    const fin = parseQuizNext({ question: { kind: 'duel', songs: songs(2), stage: 'final', brackets: ['Classic Rock', 'House'] }, progress: { ...progress, round: 7, totalRounds: 3, stage: 'finals', finalsLeft: 9 } })
    assert.equal(fin?.question?.stage, 'final')
    assert.deepEqual(fin?.question?.brackets, ['Classic Rock', 'House'])
    assert.equal(fin?.progress.stage, 'finals')
    assert.equal(fin?.progress.finalsLeft, 9)
    // junk is dropped, never fatal: an unknown stage, genres that don't line up with the songs, a bracket without a name
    const odd = parseQuizNext({ question: { kind: 'duel', songs: songs(2), stage: 'semi', brackets: ['Rock'] }, progress: { ...progress, stage: 'later', bracket: { index: 1, total: 2 } } })
    assert.deepEqual(odd?.question, { kind: 'duel', songs: odd!.question!.songs })
    assert.deepEqual(odd?.progress, progress)
  })

  it('parses an undo: the undone answer and its question asked again', () => {
    const q = { kind: 'pick', songs: [{ track: track(1), hookMs: 1 }, { track: track(2), hookMs: 2 }] }
    const u = parseQuizUndo({ ok: true, undone: { kind: 'pick', ids: [1, 2], choice: '2' }, question: q, progress })
    assert.deepEqual(u?.undone, { kind: 'pick', ids: ['1', '2'], choice: '2' })
    assert.equal(u?.question?.songs[1]?.id, 2)
    assert.deepEqual(parseQuizUndo({ ok: true, undone: null, question: null, progress }), { undone: null, question: null, progress })
    assert.equal(parseQuizUndo({ ok: true, undone: { kind: 'pick', ids: ['1', '2'], choice: '2' }, question: { kind: 'pick', songs: [] }, progress }), null)
    assert.equal(parseQuizUndo({ ok: false, progress }), null)
    assert.equal(parseQuizUndo({ ok: true, undone: { kind: 'nope', ids: [], choice: 'x' }, progress }), null)
  })
})

describe('top1000 client', () => {
  it('next → question; answer posts JSON and returns progress', async () => {
    const seen: Array<{ url: string; init?: Record<string, unknown> }> = []
    const c = createTop1000Client({
      baseUrl: 'http://homemini:3000/',
      warn: () => {},
      fetchImpl: fake({
        '/api/top1000/next?mode=tournament': { status: 200, body: { question: { kind: 'inout', songs: [{ track: track(9), hookMs: 50000 }] }, progress } },
        '/api/top1000/answer': { status: 200, body: { ok: true, progress: { ...progress, answered: 4 } } },
      }, seen),
    })
    const n = await c.next()
    assert.ok(n.ok && n.value.question?.kind === 'inout')
    const a = await c.answer({ kind: 'inout', ids: ['9'], choice: 'in' })
    assert.ok(a.ok && a.value.answered === 4)
    const post = seen.find((s) => s.url.endsWith('/answer'))!
    assert.equal(post.init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(post.init?.body)), { kind: 'inout', ids: ['9'], choice: 'in' })
    assert.equal(seen[0]!.url, 'http://homemini:3000/api/top1000/next?mode=tournament')
  })

  it('says plainly when an answer was not saved', async () => {
    const offline = createTop1000Client({ baseUrl: 'http://x', warn: () => {}, fetchImpl: fake({}) })
    const a = await offline.answer({ kind: 'pick', ids: ['1', '2'], choice: '1' })
    assert.ok(!a.ok && /wasn’t saved/.test(a.error))
    const gone = createTop1000Client({ baseUrl: 'http://x', warn: () => {}, fetchImpl: fake({ '/answer': { status: 409, body: { ok: false, error: 'that song is no longer in the quiz' } } }) })
    const b = await gone.answer({ kind: 'pick', ids: ['1', '2'], choice: '1' })
    assert.ok(!b.ok && /no longer in the quiz/.test(b.error))
    const n = await offline.next()
    assert.ok(!n.ok && /homemini/.test(n.error))
  })

  it('undo posts and returns the undone question; a 404 means not deployed yet', async () => {
    const seen: Array<{ url: string; init?: Record<string, unknown> }> = []
    const body = { ok: true, undone: { kind: 'inout', ids: ['9'], choice: 'in' }, question: { kind: 'inout', songs: [{ track: track(9), hookMs: 0 }] }, progress }
    const c = createTop1000Client({ baseUrl: 'http://x', warn: () => {}, fetchImpl: fake({ '/api/top1000/undo': { status: 200, body } }, seen) })
    const u = await c.undo()
    assert.ok(u.ok && u.value.undone?.choice === 'in' && u.value.question?.songs[0]?.id === 9)
    assert.equal(seen[0]!.init?.method, 'POST')
    const old = createTop1000Client({ baseUrl: 'http://x', warn: () => {}, fetchImpl: fake({ '/undo': { status: 404, body: null } }) })
    const n = await old.undo()
    assert.ok(!n.ok && n.error === 'Undo isn’t available yet.')
    const offline = createTop1000Client({ baseUrl: 'http://x', warn: () => {}, fetchImpl: fake({}) })
    const o = await offline.undo()
    assert.ok(!o.ok && /homemini/.test(o.error))
  })
})
