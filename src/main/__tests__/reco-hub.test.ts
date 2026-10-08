/**
 * The acceptance harness must isolate recommendation MUTATIONS as well as
 * reads: a fixture jot's completion → release → delete must never reach the
 * real hub. Locks the transport seam (reco-hub.ts) and the selection rule.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureRecoHub, liveRecoHub, selectRecoHub, type HubRecord } from '../reco-hub.ts'
import { identitiesForDelete } from '../reco-sync.ts'

type Call = { url: string; init?: Record<string, unknown> }
function fetchSpy(reply: unknown = { ok: true }) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: Record<string, unknown>) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => reply } }
  return { calls, fetchImpl }
}

const SEED: HubRecord[] = [
  { id: 'fixture-lc-album', album: 'Little Creatures', artist: 'Talking Heads', kind: 'album', createdAt: '2026-09-06T20:00:00.000Z' },
  { id: 'fixture-nobody-song', song: 'Song That Does Not Exist', artist: 'Nobody Lives Here', kind: 'track', createdAt: '2026-09-06T20:00:01.000Z' },
]

describe('recommendation hub transport', () => {
  it('completion-triggered cleanup on a fixture record stays inside the fixture — the network is never touched', async () => {
    const { calls, fetchImpl } = fetchSpy()
    const hub = selectRecoHub({ fixturePath: '/tmp/seed.json', packaged: false, loadSeed: () => SEED, baseUrl: 'http://homemini:3000', fetchImpl })
    assert.equal(hub.mode, 'fixture'); assert.equal(hub.nasFallback, false)
    // The Listen List releases a record once the job completes and the
    // library owns it: delete by id + the same identity keys main sends.
    const all = (await hub.list()) as unknown as Parameters<typeof identitiesForDelete>[1]
    const plan = identitiesForDelete(all[0], all)
    const reply = await hub.remove('fixture-lc-album', plan.identities)
    assert.equal(reply.ok, true)
    const fx = hub as ReturnType<typeof fixtureRecoHub>
    assert.deepEqual(fx.records().map((r) => r.id), ['fixture-nobody-song'])
    assert.ok(fx.tombstones().includes('fixture-lc-album'))
    assert.ok(fx.tombstones().some((k) => k.startsWith('identity:album:talkingheads~littlecreatures')), 'the identity tombstone lands in the fixture, not on homemini')
    assert.deepEqual(await hub.deletedKeys(), fx.tombstones())
    assert.equal(calls.length, 0, 'no HTTP call of any kind')
    // Reads and adds are fixture-local too.
    await hub.add({ song: 'Later', artist: 'Someone', origin: 'user' })
    assert.equal((await hub.list())!.length, 2)
    assert.equal(calls.length, 0)
    assert.deepEqual(fx.calls, ['list', 'remove:fixture-lc-album', 'deleted', 'add', 'list'])
  })

  it('live fulfilment is unchanged: the same cleanup is one DELETE to the hub carrying the identity keys', async () => {
    const { calls, fetchImpl } = fetchSpy({ ok: true, existed: true })
    const hub = liveRecoHub('http://homemini:3000', fetchImpl)
    assert.equal(hub.mode, 'live'); assert.equal(hub.nasFallback, true)
    await hub.remove('abc', ['album:talkingheads~littlecreatures', 'artist:talkingheads'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init?.method, 'DELETE')
    assert.equal(calls[0].url, 'http://homemini:3000/api/recommendations/abc?identity=album%3Atalkingheads~littlecreatures&identity=artist%3Atalkingheads')
    await hub.add({ song: 'x', artist: 'y', origin: 'user' })
    assert.equal(calls[1].init?.method, 'POST'); assert.equal(calls[1].url, 'http://homemini:3000/api/recommendations')
    await hub.list(); await hub.deletedKeys()
    assert.equal(calls[3].url, 'http://homemini:3000/api/recommendations/deleted')
  })

  it('fixture mode needs the env var AND an unpackaged build', () => {
    const { fetchImpl } = fetchSpy()
    const base = { loadSeed: () => SEED, baseUrl: 'http://homemini:3000', fetchImpl }
    assert.equal(selectRecoHub({ ...base, fixturePath: undefined, packaged: false }).mode, 'live')
    assert.equal(selectRecoHub({ ...base, fixturePath: '/tmp/seed.json', packaged: true }).mode, 'live')
    assert.equal(selectRecoHub({ ...base, fixturePath: '/tmp/seed.json', packaged: false }).mode, 'fixture')
  })
})
