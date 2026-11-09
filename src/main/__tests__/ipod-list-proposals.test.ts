/**
 * The brain's picks waiting for Jake (2026-11-09: punkPod's additions become
 * proposals he approves; nothing goes on the list without his OK).
 *
 *   • the parser: homemini's answer, a bad row dropped, the wrong iPod refused
 *   • the panel's decisions: last decision wins, decided rows leave the panel
 *   • the offline queue: on disk first, kept while homemini is away, sent in
 *     order when it's back, dropped on a refusal homemini means
 *   • the notice: once per set, hub only, "punkPod: 10 picks to review", and
 *     the click opens that iPod's list
 *   • the client: the routes, the companion header, what counts as retry
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideProposalNotice, openIpodListAction, parseDecisionQueue, parseOpenIpodListAction, parseProposalSet, proposalLine,
  proposalNoticeText, proposalsHeading, queueDecision, waitingProposals, type IpodProposalSet,
} from '../../common/ipod-list-proposals.ts'
import { DECISIONS_FILE, PROPOSAL_NOTICE_FILE, createProposalNotice, createProposalsDesk, type ProposalsAnswer } from '../ipod-list-proposals.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { buildDeviceMarker } from '../../common/ipod-identity.ts'

const PUNK_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const stamp = '2026-11-09T00:00:00.000Z'
const original = buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now: stamp })!
const punk = buildDeviceMarker({ id: PUNK_ID, name: 'punkPod', color: 'red', purpose: 'punk', primary: false, now: stamp })!

const tmps: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ipod-proposals-')); tmps.push(d); return d }
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

const at = '2026-11-09T14:00:00.000Z'
const wire = (ids: number[], proposedAt: string | null = at) => ({
  id: PUNK_ID, name: 'punkPod', mode: 'propose', proposedAt,
  proposals: ids.map((id) => ({ id, why: `Pop-Punk, reason ${id}`, at, artist: `Band ${id}`, title: `Song ${id}` })),
})
const set = (ids: number[], proposedAt: string | null = at): IpodProposalSet => parseProposalSet(wire(ids, proposedAt))!

describe('parseProposalSet', () => {
  it('reads homemini\'s answer', () => {
    const s = parseProposalSet(wire([5, 6]), PUNK_ID)!
    assert.equal(s.name, 'punkPod')
    assert.equal(s.proposedAt, at)
    assert.deepEqual(s.proposals[0], { id: 5, why: 'Pop-Punk, reason 5', at, artist: 'Band 5', title: 'Song 5' })
  })
  it('drops a bad row or a repeat, never the set; names are optional', () => {
    const raw = wire([5])
    raw.proposals.push({ id: -1, why: 'x', at, artist: '', title: '' }, { id: 5, why: 'again', at, artist: '', title: '' })
    ;(raw.proposals as unknown[]).push({ id: 9, at }, 'junk', { id: 10, why: 'no at' })
    const s = parseProposalSet(raw)!
    assert.deepEqual(s.proposals.map((p) => p.id), [5, 9])
    assert.deepEqual(s.proposals[1], { id: 9, why: '', at })
  })
  it('refuses the wrong iPod, no name, no list; a missing proposedAt is null', () => {
    assert.equal(parseProposalSet(wire([5]), 'another-ipod'), null)
    assert.equal(parseProposalSet({ ...wire([5]), name: ' ' }), null)
    assert.equal(parseProposalSet({ ...wire([5]), proposals: null }), null)
    assert.equal(parseProposalSet(null), null)
    assert.equal(parseProposalSet(wire([5], null))!.proposedAt, null)
  })
})

describe('the panel\'s decisions', () => {
  it('the last decision on a song wins; an empty decision leaves no entry', () => {
    let q = queueDecision({}, PUNK_ID, { approve: [5, 6] })
    q = queueDecision(q, PUNK_ID, { reject: [6, 7] })
    assert.deepEqual(q[PUNK_ID], { approve: [5], reject: [6, 7] })
    q = queueDecision(q, PUNK_ID, { approve: [7] })
    assert.deepEqual(q[PUNK_ID], { approve: [5, 7], reject: [6] })
    assert.deepEqual(queueDecision({}, PUNK_ID, {}), {})
  })
  it('decided rows leave the panel; the rest stay in homemini\'s order', () => {
    assert.deepEqual(waitingProposals(set([5, 6, 7, 8]), { approve: [6], reject: [8] }).map((p) => p.id), [5, 7])
    assert.deepEqual(waitingProposals(null, undefined), [])
  })
  it('a queue file that is junk reads as empty', () => {
    assert.deepEqual(parseDecisionQueue('x'), {})
    assert.deepEqual(parseDecisionQueue({ [PUNK_ID]: { approve: [5, 'x', 5], reject: [5, 6] }, 'Bad Id!': { approve: [1] } }), { [PUNK_ID]: { approve: [5], reject: [6] } })
  })
  it('the words: heading, row, notice', () => {
    assert.equal(proposalsHeading(10), 'Picks to review (10)')
    assert.equal(proposalLine(set([5]).proposals[0]), 'Band 5 — Song 5')
    assert.equal(proposalLine({ id: 9, why: '', at }, { artist: 'Rancid', title: 'Time Bomb' }), 'Rancid — Time Bomb')
    assert.equal(proposalLine({ id: 9, why: '', at }), 'Song 9')
    assert.deepEqual(proposalNoticeText('punkPod', 10), { title: 'JakeTunes', body: 'punkPod: 10 picks to review' })
    assert.deepEqual(proposalNoticeText('punkPod', 1), { title: 'JakeTunes', body: 'punkPod: 1 pick to review' })
  })
  it('the click opens that iPod\'s list', () => {
    assert.equal(parseOpenIpodListAction(openIpodListAction(PUNK_ID)), PUNK_ID)
    assert.equal(parseOpenIpodListAction('view-device'), null)
    assert.equal(parseOpenIpodListAction('open-ipod-list:../etc'), null)
  })
})

describe('the offline queue', () => {
  function desk(dir: string, opts: { up: () => boolean; status?: () => 'done' | 'retry' | 'drop'; ids?: () => number[] }) {
    const sent: Array<{ deviceId: string; approve: number[]; reject: number[] }> = []
    const d = createProposalsDesk({
      stateDir: dir,
      get: async (): Promise<ProposalsAnswer> => (opts.up() ? { kind: 'ok', set: set(opts.ids?.() ?? [5, 6, 7, 8]) } : { kind: 'offline', error: 'ETIMEDOUT' }),
      send: async (deviceId, body) => {
        if (!opts.up()) return 'retry'
        sent.push({ deviceId, ...body })
        return opts.status?.() ?? 'done'
      },
      log: () => {},
    })
    return { d, sent }
  }
  const queueOnDisk = (dir: string) => (existsSync(join(dir, DECISIONS_FILE)) ? JSON.parse(readFileSync(join(dir, DECISIONS_FILE), 'utf-8')) : null)

  it('homemini answering: the decision goes at once and nothing waits', async () => {
    const dir = tmp()
    const { d, sent } = desk(dir, { up: () => true })
    assert.deepEqual(await d.decide(PUNK_ID, { approve: [5], reject: [6] }), { ok: true, sent: true })
    assert.deepEqual(sent, [{ deviceId: PUNK_ID, approve: [5], reject: [6] }])
    assert.deepEqual(queueOnDisk(dir), {})
  })

  it('homemini away: the decision waits on disk, the panel hides it, and it goes when homemini is back', async () => {
    const dir = tmp()
    let up = false
    const { d, sent } = desk(dir, { up: () => up })
    assert.deepEqual(await d.decide(PUNK_ID, { approve: [5] }), { ok: true, sent: false })
    assert.deepEqual(await d.decide(PUNK_ID, { reject: [6] }), { ok: true, sent: false })
    assert.deepEqual(queueOnDisk(dir), { [PUNK_ID]: { approve: [5], reject: [6] } })
    // a restart: a new desk reads the same file
    const again = desk(dir, { up: () => up })
    const v = await again.d.view(PUNK_ID)
    assert.equal(v.offline, true)
    assert.equal(v.queued, 2)
    assert.deepEqual(v.proposals, []) // nothing seen yet on this run
    up = true
    const back = await again.d.view(PUNK_ID)
    assert.deepEqual(again.sent, [{ deviceId: PUNK_ID, approve: [5], reject: [6] }])
    assert.deepEqual([back.offline, back.queued, back.proposals.map((p) => p.id)], [false, 0, [5, 6, 7, 8]])
    assert.deepEqual(queueOnDisk(dir), {})
    assert.equal(sent.length, 0)
  })

  it('the last set seen stays in the panel while homemini is away', async () => {
    const dir = tmp()
    let up = true
    const { d } = desk(dir, { up: () => up })
    assert.deepEqual((await d.view(PUNK_ID)).proposals.map((p) => p.id), [5, 6, 7, 8])
    up = false
    await d.decide(PUNK_ID, { approve: [7] })
    const v = await d.view(PUNK_ID)
    assert.deepEqual([v.offline, v.proposals.map((p) => p.id)], [true, [5, 6, 8]])
  })

  it('a refusal homemini means (400 / 404) is dropped; a retry keeps it', async () => {
    const dir = tmp()
    let status: 'done' | 'retry' | 'drop' = 'retry'
    const { d } = desk(dir, { up: () => true, status: () => status })
    assert.deepEqual(await d.decide(PUNK_ID, { approve: [5] }), { ok: true, sent: false })
    assert.equal(await d.flush(), 1)
    status = 'drop'
    assert.equal(await d.flush(), 0)
    assert.deepEqual(queueOnDisk(dir), {})
  })

  it('nothing to decide, or a bad iPod id, is refused before anything is written', async () => {
    const dir = tmp()
    const { d } = desk(dir, { up: () => true })
    assert.equal((await d.decide(PUNK_ID, {})).ok, false)
    assert.equal((await d.decide('Bad Id!', { approve: [1] })).ok, false)
    assert.equal(queueOnDisk(dir), null)
  })
})

describe('the notice', () => {
  function notice(dir: string, opts: { hub?: boolean; answer: () => ProposalsAnswer }) {
    const told: Array<{ title: string; body: string; deviceId: string }> = []
    const pushed: Array<{ title: string; body: string }> = []
    const n = createProposalNotice({
      stateDir: dir,
      isHub: async () => opts.hub ?? true,
      devices: async () => [original, punk],
      get: async () => opts.answer(),
      notify: (x) => told.push(x),
      push: async (x) => { pushed.push(x) },
      log: () => {},
    })
    return { n, told, pushed }
  }

  it('once per set: "punkPod: 10 picks to review", a notification and a push, the click names the iPod', async () => {
    const dir = tmp()
    let answer: ProposalsAnswer = { kind: 'ok', set: set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }
    const { n, told, pushed } = notice(dir, { answer: () => answer })
    await n.check()
    await n.check()
    assert.deepEqual(told, [{ title: 'JakeTunes', body: 'punkPod: 10 picks to review', deviceId: PUNK_ID }])
    assert.deepEqual(pushed, [{ title: 'JakeTunes', body: 'punkPod: 10 picks to review' }])
    // a restart doesn't tell again
    const again = notice(dir, { answer: () => answer })
    await again.n.check(PUNK_ID)
    assert.equal(again.told.length, 0)
    // Jake decides some: the same set, fewer waiting — still not told again
    answer = { kind: 'ok', set: set([1, 2]) }
    await n.check()
    assert.equal(told.length, 1)
    // two weeks on, a new set
    answer = { kind: 'ok', set: set([20, 21, 22], '2026-11-23T14:00:00.000Z') }
    await n.check()
    assert.deepEqual(told.map((t) => t.body), ['punkPod: 10 picks to review', 'punkPod: 3 picks to review'])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, PROPOSAL_NOTICE_FILE), 'utf-8')), { [PUNK_ID]: '2026-11-23T14:00:00.000Z' })
  })

  it('nothing waiting, homemini away, no list, or not the hub: says nothing', async () => {
    for (const [hub, answer] of [
      [true, { kind: 'ok', set: set([]) }],
      [true, { kind: 'ok', set: set([5], null) }],
      [true, { kind: 'offline', error: 'x' }],
      [true, { kind: 'none' }],
      [false, { kind: 'ok', set: set([5]) }],
    ] as Array<[boolean, ProposalsAnswer]>) {
      const { n, told, pushed } = notice(tmp(), { hub, answer: () => answer })
      await n.check()
      assert.equal(told.length + pushed.length, 0, JSON.stringify(answer))
    }
    assert.deepEqual(decideProposalNotice('a', set([5], 'a')), { notify: false, told: 'a' })
  })
})

describe('the client', () => {
  it('GET …/proposals and POST …/proposals/decide, behind the companion header', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    let status = 200
    const client = createIpodListClient({
      baseUrl: 'http://homemini:3000/',
      warn: () => {},
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} })
        return { status, ok: status === 200, json: async () => wire([5]) } as never
      },
    })
    const got = await client.proposals(PUNK_ID)
    assert.equal(got.kind, 'ok')
    assert.equal(calls[0]!.url, `http://homemini:3000/api/ipod-lists/${PUNK_ID}/proposals`)
    assert.equal(await client.decide(PUNK_ID, { approve: [5], reject: [] }), 'done')
    assert.equal(calls[1]!.url, `http://homemini:3000/api/ipod-lists/${PUNK_ID}/proposals/decide`)
    assert.equal(calls[1]!.init.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { approve: [5], reject: [] })
    for (const [s, want] of [[400, 'drop'], [404, 'drop'], [401, 'retry'], [500, 'retry'], [503, 'retry']] as const) {
      status = s
      assert.equal(await client.decide(PUNK_ID, { approve: [5], reject: [] }), want, String(s))
    }
    status = 404
    assert.equal((await client.proposals(PUNK_ID)).kind, 'none')
    const down = createIpodListClient({ baseUrl: 'http://homemini:3000', warn: () => {}, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    assert.equal((await down.proposals(PUNK_ID)).kind, 'offline')
    assert.equal(await down.decide(PUNK_ID, { approve: [5], reject: [] }), 'retry')
  })
})
