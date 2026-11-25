import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  auditChoiceForKey, auditDoorLabel, auditProgressLine, auditRestingLine, foldWaiting, parseAuditNext, parseAuditProgress,
  AUDIT_DONE_LINE,
} from '../../common/top1000-audit-doc.ts'
import { AUDIT_PENDING_FILE, createTop1000Audit, restingNotBefore, sendOutcome } from '../top1000-audit-outbox.ts'
import { claimTransportKeys, shouldYieldToClaim } from '../../renderer/input-mode.ts'
import type { FetchLike } from '../top1000-client.ts'

const progress = { answered: 12, total: 282, today: 12, perDay: 15 }
const track = (id: number) => ({ id, title: `Song ${id}`, artist: `Artist ${id}`, album: 'Album', duration: 200000, playCount: 99, rating: 100 })
const question = (qid: string, a = 1, b = 2) => ({ qid, repeat: false, songs: [{ track: track(a), hookMs: 60000 }, { track: track(b), hookMs: 0 }] })

describe('blind check: reading /next', () => {
  it('reads a question: two songs, only cover, title and artist kept from the track', () => {
    const s = parseAuditNext({ progress, question: { ...question('q1'), repeat: true } })
    assert.equal(s?.kind, 'ask')
    if (s?.kind !== 'ask') return
    assert.equal(s.question.qid, 'q1')
    assert.equal(s.question.repeat, true)
    assert.deepEqual(s.question.songs.map((x) => x.id), [1, 2])
    assert.equal(s.question.songs[0].hookMs, 60000)
    // the song ref never carries plays or stars, so the screen can't show them
    assert.deepEqual(Object.keys(s.question.songs[0]).sort(), ['album', 'artist', 'hookMs', 'id', 'title'])
    assert.deepEqual(s.progress, progress)
  })

  it('reads off, done, resting (with and without a time), and refuses junk', () => {
    assert.deepEqual(parseAuditNext({ off: true }), { kind: 'off' })
    assert.deepEqual(parseAuditNext({ done: true, progress: { ...progress, answered: 282 } }), { kind: 'done', progress: { ...progress, answered: 282 } })
    assert.deepEqual(parseAuditNext({ done: true }), { kind: 'done', progress: null })
    assert.deepEqual(parseAuditNext({ progress, restingUntil: '2026-11-25T05:00:00.000Z' }), { kind: 'resting', until: '2026-11-25T05:00:00.000Z', progress })
    assert.deepEqual(parseAuditNext({ progress }), { kind: 'resting', until: null, progress })
    assert.deepEqual(parseAuditNext({ progress, restingUntil: 'soon' }), { kind: 'resting', until: null, progress })
    assert.equal(parseAuditNext(null), null)
    assert.equal(parseAuditNext({}), null)
    assert.equal(parseAuditNext({ progress: { answered: 1, total: 'x', today: 0, perDay: 15 } }), null)
    assert.equal(parseAuditNext({ progress, question: { qid: 'q', songs: [{ track: track(1), hookMs: 0 }] } }), null)
    assert.equal(parseAuditNext({ progress, question: question('q', 3, 3) }), null)
    assert.equal(parseAuditNext({ progress, question: { ...question('q'), qid: '' } }), null)
    assert.equal(parseAuditProgress({ answered: -1, total: 1, today: 0, perDay: 1 }), null)
  })
})

describe('blind check: a 429 holds until homemini\'s next day', () => {
  const now = new Date('2026-11-24T20:00:00.000Z')
  it('waits until restingUntil, at most 26 hours; none or unreadable is an hour', () => {
    assert.equal(restingNotBefore('2026-11-25T05:00:00.000Z', now), '2026-11-25T05:00:00.000Z')
    assert.equal(restingNotBefore('2026-12-30T05:00:00.000Z', now), '2026-11-25T22:00:00.000Z')
    assert.equal(restingNotBefore(null, now), '2026-11-24T21:00:00.000Z')
    assert.equal(restingNotBefore('tomorrow', now), '2026-11-24T21:00:00.000Z')
  })
})

describe('blind check: Space belongs to the preview while a question is up', () => {
  const src = readFileSync(join(import.meta.dirname, '../../renderer/views/Top1000AuditPanel.tsx'), 'utf-8')
  it('claims Space (so the app\'s play/pause stands aside) and takes keys as a layer on the keyboard host', () => {
    assert.match(src, /claimTransportKeys\('top1000-audit', \['Space'\]\)/)
    assert.match(src, /if \(!asking\) return\s*\n\s*return claimTransportKeys/)
    assert.match(src, /return addKeyLayer\('top1000-audit', onKey\)/)
  })
  it('the claim makes the app\'s play/pause yield on Space only', () => {
    const release = claimTransportKeys('top1000-audit', ['Space'])
    try {
      assert.equal(shouldYieldToClaim('Space'), true)
      assert.equal(shouldYieldToClaim('ArrowLeft'), false)
    } finally { release() }
    assert.equal(shouldYieldToClaim('Space'), false)
  })
})

describe('blind check: keys and words', () => {
  it('maps the keys to the four choices', () => {
    assert.equal(auditChoiceForKey('1'), 'first')
    assert.equal(auditChoiceForKey('2'), 'second')
    assert.equal(auditChoiceForKey('='), 'equal')
    assert.equal(auditChoiceForKey('?'), 'unknown')
    for (const k of ['3', 'b', 'n', ' ', 'Enter', '+']) assert.equal(auditChoiceForKey(k), null)
  })

  it('says progress, rest and done plainly', () => {
    assert.equal(auditProgressLine(progress), '12 of 282 · 3 left today')
    assert.equal(auditProgressLine({ ...progress, today: 20 }), '12 of 282 · 0 left today')
    assert.equal(auditProgressLine({ answered: 280, total: 282, today: 0, perDay: 15 }), '280 of 282 · 2 left today')
    assert.equal(auditRestingLine(progress), 'That’s today’s 15. More tomorrow.')
    assert.equal(AUDIT_DONE_LINE, 'All done. Thank you.')
  })

  it('shows the door only while there is a check to do', () => {
    assert.equal(auditDoorLabel(parseAuditNext({ progress, question: question('q') })), 'Blind check · 3 left today')
    // resting, or nothing left today: no door
    assert.equal(auditDoorLabel({ kind: 'resting', until: null, progress }), null)
    assert.equal(auditDoorLabel({ kind: 'resting', until: null, progress: { ...progress, today: 15 } }), null)
    const ask = parseAuditNext({ progress: { ...progress, today: 15 }, question: question('q') })
    assert.equal(auditDoorLabel(ask), null)
    assert.equal(auditDoorLabel({ kind: 'off' }), null)
    assert.equal(auditDoorLabel({ kind: 'done', progress }), null)
    assert.equal(auditDoorLabel(null), null)
  })

  it('counts answers still on this Mac as given', () => {
    assert.deepEqual(foldWaiting(progress, 2), { ...progress, answered: 14, today: 14 })
    assert.deepEqual(foldWaiting(progress, 0), progress)
    assert.equal(foldWaiting({ ...progress, answered: 281 }, 5).answered, 282)
  })

  it('reads what a POST answer means', () => {
    assert.deepEqual(sendOutcome(200, { ok: true, progress }), { kind: 'sent', progress })
    assert.deepEqual(sendOutcome(409, { error: 'not-due' }), { kind: 'not-due' })
    assert.deepEqual(sendOutcome(404, { off: true }), { kind: 'off' })
    assert.deepEqual(sendOutcome(400, { error: 'bad choice' }), { kind: 'refused', error: 'bad choice' })
    assert.deepEqual(sendOutcome(429, { restingUntil: '2026-11-25T05:00:00.000Z' }), { kind: 'resting', until: '2026-11-25T05:00:00.000Z' })
    assert.deepEqual(sendOutcome(429, null), { kind: 'resting', until: null })
    // no body (a proxy's page), a 5xx, a 404 that isn't homemini's "off": not final
    for (const [st, b] of [[502, null], [500, { error: 'x' }], [404, null], [404, { error: 'nope' }], [200, null]] as const) {
      assert.deepEqual(sendOutcome(st, b), { kind: 'retry' })
    }
  })
})

// ── the outbox against a fake homemini ──────────────────────────────────

interface Seen { method: string; url: string; body: { qid?: unknown; choice?: unknown } | null; headers: Record<string, string> }

function fakeHomemini() {
  const seen: Seen[] = []
  const state = {
    online: true,
    off: false,
    answered: 12,
    /** qids homemini will say aren't due */
    notDue: new Set<string>(),
    fail5xx: 0,
    /** answers past this many today get a 429 */
    capToday: Infinity,
    restingUntil: undefined as string | undefined,
    nextQuestion: question('q13', 3, 4) as unknown,
  }
  const fetchImpl: FetchLike = async (url, init) => {
    const method = String(init?.method ?? 'GET')
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Seen['body'] : null
    const h = new Headers(init?.headers as HeadersInit | undefined)
    const headers: Record<string, string> = {}
    h.forEach((v, k) => { headers[k] = v })
    seen.push({ method, url, body, headers })
    if (!state.online) throw new Error('offline')
    const reply = (status: number, b: unknown) => ({ ok: status === 200, status, json: async () => b })
    if (state.off) return reply(404, { off: true })
    if (url.endsWith('/api/top1000/audit/next')) {
      return reply(200, { progress: { answered: state.answered, total: 282, today: state.answered, perDay: 15 }, question: state.nextQuestion })
    }
    if (url.endsWith('/api/top1000/audit/answer')) {
      if (state.fail5xx > 0) { state.fail5xx--; return reply(503, { error: 'busy' }) }
      if (state.notDue.has(String(body?.qid))) return reply(409, { error: 'not-due' })
      if (state.answered >= state.capToday) return reply(429, state.restingUntil ? { restingUntil: state.restingUntil } : { error: 'resting' })
      state.answered++
      return reply(200, { ok: true, progress: { answered: state.answered, total: 282, today: state.answered, perDay: 15 } })
    }
    return reply(404, null)
  }
  return { seen, state, fetchImpl }
}

describe('blind check: answers go on disk first and leave in order', () => {
  let dir = ''
  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 't1k-audit-'))
  })
  let clock = new Date('2026-11-24T20:00:00.000Z')
  const make = (fetchImpl: FetchLike) => createTop1000Audit({ baseUrl: 'http://homemini:3000/', stateDir: dir, fetchImpl, now: () => clock, warn: () => undefined })
  const waitingFile = () => existsSync(join(dir, AUDIT_PENDING_FILE)) ? JSON.parse(readFileSync(join(dir, AUDIT_PENDING_FILE), 'utf-8')) as { answers: Array<{ qid: string; choice: string }> } : null

  it('sends at once with signal and leaves nothing waiting', async () => {
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    const r = await audit.answer({ qid: 'q12', choice: 'first' })
    assert.deepEqual(r, { ok: true, value: { progress: { answered: 13, total: 282, today: 13, perDay: 15 }, waiting: 0 } })
    const post = hm.seen.find((s) => s.method === 'POST')!
    assert.equal(post.url, 'http://homemini:3000/api/top1000/audit/answer')
    assert.deepEqual(post.body, { qid: 'q12', choice: 'first' })
    assert.deepEqual(waitingFile()?.answers, [])
  })

  it('with no signal keeps answers on disk and sends them in the order given when homemini answers', async () => {
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    await audit.next()   // learns progress 12
    hm.state.online = false
    const a = await audit.answer({ qid: 'q12', choice: 'second' })
    const b = await audit.answer({ qid: 'q13', choice: 'equal' })
    const c = await audit.answer({ qid: 'q14', choice: 'unknown' })
    assert.equal(a.ok && b.ok && c.ok, true)
    assert.deepEqual(c.ok && c.value, { progress: { answered: 15, total: 282, today: 15, perDay: 15 }, waiting: 3 })
    assert.deepEqual(waitingFile()?.answers.map((x) => [x.qid, x.choice]), [['q12', 'second'], ['q13', 'equal'], ['q14', 'unknown']])
    const offline = await audit.next()
    assert.equal(offline.ok, false)
    assert.match(!offline.ok ? offline.error : '', /saved/)

    hm.seen.length = 0
    hm.state.online = true
    const n = await audit.next()
    assert.equal(n.ok && n.value.kind, 'ask')
    assert.deepEqual(hm.seen.filter((s) => s.method === 'POST').map((s) => s.body?.qid), ['q12', 'q13', 'q14'])
    // all three POSTs before the GET: the next question comes after the answers
    assert.equal(hm.seen[hm.seen.length - 1]?.method, 'GET')
    assert.deepEqual(waitingFile()?.answers, [])
  })

  it('a 409 is final: that answer leaves and the rest still go', async () => {
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    hm.state.online = false
    await audit.answer({ qid: 'q1', choice: 'first' })
    await audit.answer({ qid: 'q2', choice: 'second' })
    hm.state.online = true
    hm.state.notDue.add('q1')
    assert.equal(await audit.flush(), 0)
    assert.deepEqual(hm.seen.filter((s) => s.method === 'POST' && s.url.endsWith('/answer')).map((s) => s.body?.qid).slice(-2), ['q1', 'q2'])
    assert.equal(hm.state.answered, 13)
    // never sent again
    hm.seen.length = 0
    await audit.flush()
    assert.equal(hm.seen.length, 0)
  })

  it('a 5xx keeps the answer and everything behind it, in order', async () => {
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    hm.state.fail5xx = 1
    const r = await audit.answer({ qid: 'q1', choice: 'first' })
    assert.equal(r.ok && r.value.waiting, 1)
    hm.state.fail5xx = 1
    const r2 = await audit.answer({ qid: 'q2', choice: 'equal' })
    assert.equal(r2.ok && r2.value.waiting, 2)
    assert.deepEqual(waitingFile()?.answers.map((x) => x.qid), ['q1', 'q2'])
    assert.equal(await audit.flush(), 0)
    assert.deepEqual(hm.seen.filter((s) => s.method === 'POST' && s.url.endsWith('/answer')).map((s) => s.body?.qid), ['q1', 'q1', 'q1', 'q2'])
  })

  it('survives a restart: a new client sends what the old one kept', async () => {
    const hm = fakeHomemini()
    hm.state.online = false
    await make(hm.fetchImpl).answer({ qid: 'q7', choice: 'second' })
    hm.state.online = true
    hm.seen.length = 0
    assert.equal(await make(hm.fetchImpl).flush(), 0)
    assert.deepEqual(hm.seen.map((s) => s.body?.qid), ['q7'])
  })

  it('off keeps what is waiting, in order, and sends it when the check is back; any no longer due leave on their 409', async () => {
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    hm.state.online = false
    await audit.answer({ qid: 'q1', choice: 'first' })
    await audit.answer({ qid: 'q2', choice: 'first' })
    hm.state.online = true
    hm.state.off = true
    const n = await audit.next()
    assert.deepEqual(n, { ok: true, value: { kind: 'off', waiting: 2 } })
    assert.deepEqual(waitingFile()?.answers.map((x) => x.qid), ['q1', 'q2'])
    hm.state.off = false
    hm.state.notDue.add('q1')
    hm.seen.length = 0
    assert.equal(await audit.flush(), 0)
    assert.deepEqual(hm.seen.map((x) => x.body?.qid), ['q1', 'q2'])
    assert.equal(hm.state.answered, 13)
    assert.deepEqual(waitingFile()?.answers, [])
    const old: FetchLike = async () => ({ ok: false, status: 404, json: async () => { throw new Error('html') } })
    assert.deepEqual(await make(old).next(), { ok: true, value: { kind: 'off', waiting: 0 } })
  })

  it('a 429 holds the answer and the rest, sends nothing until restingUntil, then sends them in order', async () => {
    clock = new Date('2026-11-24T20:00:00.000Z')
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    hm.state.capToday = 12
    hm.state.restingUntil = '2026-11-25T05:00:00.000Z'
    const r = await audit.answer({ qid: 'q13', choice: 'second' })
    assert.equal(r.ok && r.value.waiting, 1)
    hm.state.online = false
    await audit.answer({ qid: 'q14', choice: 'equal' })
    hm.state.online = true
    const file = waitingFile() as { answers: Array<{ qid: string }>; notBefore?: string } | null
    assert.deepEqual(file?.answers.map((x) => x.qid), ['q13', 'q14'])
    assert.equal(file?.notBefore, '2026-11-25T05:00:00.000Z')
    // the 5-minute retry, and an hour later: nothing goes
    hm.seen.length = 0
    assert.equal(await audit.flush(), 2)
    clock = new Date('2026-11-24T21:00:00.000Z')
    assert.equal(await audit.flush(), 2)
    assert.equal(hm.seen.length, 0)
    // homemini's next day: both go, in order, and the hold is gone
    clock = new Date('2026-11-25T05:00:01.000Z')
    hm.state.capToday = Infinity
    assert.equal(await audit.flush(), 0)
    assert.deepEqual(hm.seen.map((x) => x.body?.qid), ['q13', 'q14'])
    assert.equal((waitingFile() as { notBefore?: string } | null)?.notBefore, undefined)
  })

  it('a 429 with no time holds for an hour', async () => {
    clock = new Date('2026-11-24T20:00:00.000Z')
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    hm.state.capToday = 12
    await audit.answer({ qid: 'q13', choice: 'first' })
    assert.equal((waitingFile() as { notBefore?: string } | null)?.notBefore, '2026-11-24T21:00:00.000Z')
    clock = new Date('2026-11-24T21:00:00.000Z')
    hm.state.capToday = Infinity
    assert.equal(await audit.flush(), 0)
  })

  it('refuses an incomplete answer and keeps nothing; one answer per question', async () => {
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    for (const bad of [{ qid: 'q', choice: 'both' }, { qid: '', choice: 'first' }, { qid: null, choice: 'first' }]) {
      assert.equal((await audit.answer(bad)).ok, false)
    }
    assert.equal(waitingFile(), null)
    hm.state.online = false
    await audit.answer({ qid: 'q1', choice: 'first' })
    await audit.answer({ qid: 'q1', choice: 'second' })
    assert.deepEqual(waitingFile()?.answers.map((x) => [x.qid, x.choice]), [['q1', 'first']])
  })

  it('never shows a question whose answer is still waiting', async () => {
    const hm = fakeHomemini()
    const audit = make(hm.fetchImpl)
    hm.state.fail5xx = 5
    await audit.answer({ qid: 'q13', choice: 'first' })
    hm.state.fail5xx = 5
    const n = await audit.next()
    assert.equal(n.ok, false)
  })

  it('sends the companion header from main and never puts the token in a URL', async () => {
    const hm = fakeHomemini()
    const prev = process.env.MOBILE_API_TOKEN
    process.env.MOBILE_API_TOKEN = 'test-token-value'
    try {
      const audit = make(hm.fetchImpl)
      await audit.answer({ qid: 'q1', choice: 'first' })
      await audit.next()
      for (const s of hm.seen) {
        assert.equal(s.headers['x-jaketunes-companion'], 'test-token-value')
        assert.equal(s.url.includes('test-token-value'), false)
      }
    } finally {
      if (prev === undefined) delete process.env.MOBILE_API_TOKEN
      else process.env.MOBILE_API_TOKEN = prev
    }
  })
})
