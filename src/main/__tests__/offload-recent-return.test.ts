/**
 * Songs Jake just got come back (2026-11-10), without ever becoming a download
 * loop (review of PR 409, 2026-11-12): homemini is asked before anything is
 * downloaded, a refusal is remembered, what came back stays, and the disk is
 * walked across the edge both ways.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  emptyLedger, parseLedger, recentReturnCandidates, returnAllowed, returnedLately, returnRecentSongs, roomToReturn,
  REFUSED_RECHECK_MS, RETURN_ASK, RETURN_HOLD_DAYS, RETURN_MAX_BYTES, RETURN_PER_PASS, type ReturnLedger,
} from '../offload-recent-return.ts'
import type { OffloadReplacementRecord } from '../offload-audio.ts'
import type { IdentityAnswer, IdentityEntry } from '../audio-identity.ts'
import { addedLately, buildRecentKeep, createKeepWindowState, ROOMY_ENTER_BYTES, ROOMY_FREE_BYTES } from '../offload-keep-recent.ts'

const DAY = 24 * 60 * 60 * 1000
const GB = 1024 ** 3
const NOW = Date.parse('2026-11-12T12:00:00.000Z')
const colon = (n: number): string => `:iPod_Control:Music:F01:s${n}.m4a`
const body = (n: number): Buffer => Buffer.from(`song-${n}-bytes`)
const sha = (b: Buffer): string => createHash('sha1').update(b).digest('hex')
const rec = (n: number, ts = '2026-11-10T13:18:00.000Z'): OffloadReplacementRecord => ({ ts, id: n, path: colon(n), fingerprint: `sha1:f${n}|1`, bytes: body(n).length, fullSha1: sha(body(n)), sentinel: '/lib/.jt-streamed' })
const same = (n: number): IdentityEntry => ({ size: body(n).length, sha1: sha(body(n)), etag: `"e${n}"` })
const retagged = (n: number, v = 1): IdentityEntry => ({ size: body(n).length + 40, sha1: String(v).repeat(40), etag: `"t${n}-${v}"` })

interface World {
  kinds: Record<number, 'symlink' | 'file' | 'missing'>
  identities: Record<number, IdentityEntry>
  inUse: Set<number>
  free: number
  ledger: ReturnLedger
  seen: { asked: number[][]; fetched: number[]; written: number[]; requeued: number[]; logs: string[] }
  /** Runs when a download of this id finishes (to tap a song mid-download). */
  onFetched?: (id: number) => void
  sends?: (id: number) => Buffer | null
  identityAnswer?: IdentityAnswer
}
function world(ids: number[], over: Partial<World> = {}): World {
  return {
    kinds: Object.fromEntries(ids.map((n) => [n, 'symlink' as const])),
    identities: Object.fromEntries(ids.map((n) => [n, same(n)])),
    inUse: new Set(), free: 251 * GB, ledger: emptyLedger(),
    seen: { asked: [], fetched: [], written: [], requeued: [], logs: [] },
    ...over,
  }
}
async function pass(w: World, records: OffloadReplacementRecord[], over: { hub?: boolean; roomy?: boolean; away?: boolean; now?: number; added?: Set<string> } = {}) {
  const r = await returnRecentSongs({
    hub: over.hub ?? true, roomy: over.roomy ?? true, away: over.away ?? false,
    records, added: over.added ?? new Set(records.map((x) => x.path)), ledger: w.ledger, now: over.now ?? NOW,
    inUse: (p) => [...w.inUse].some((n) => colon(n) === p),
    currentKind: async (x) => w.kinds[Number(x.id)] ?? 'missing',
    askIdentity: async (ids) => { w.seen.asked.push(ids.map(Number)); return w.identityAnswer ?? { kind: 'answers', byId: new Map(ids.map((id) => [String(id), w.identities[Number(id)] ?? null])) } },
    freeBytes: async () => w.free,
    fetchFull: async (id) => { w.seen.fetched.push(Number(id)); const b = w.sends ? w.sends(Number(id)) : body(Number(id)); w.onFetched?.(Number(id)); return b },
    writeBack: async (x, bytes) => { w.seen.written.push(Number(x.id)); w.kinds[Number(x.id)] = 'file'; w.free -= bytes.length },
    requeue: async (back) => { w.seen.requeued.push(...back.map((x) => Number(x.id))) },
    log: (m) => { w.seen.logs.push(m) },
  })
  w.ledger = r.ledger
  return r
}

describe('which songs may come back', () => {
  it('only songs in the set, newest first, the newest record of each', () => {
    const got = recentReturnCandidates([rec(1, '2026-11-09T10:00:00Z'), rec(2, '2026-11-10T13:18:00Z'), rec(3, '2026-11-10T13:19:00Z'), rec(1, '2026-11-10T09:00:00Z')], new Set([colon(1), colon(2)]))
    assert.deepEqual(got.map((r) => [r.id, r.ts]), [[2, '2026-11-10T13:18:00Z'], [1, '2026-11-10T09:00:00Z']])
  })
  it('no whole-file sha1, or a show-sized file: never a candidate', () => {
    const noSha = { ...rec(1), fullSha1: undefined }
    const show = { ...rec(2), bytes: RETURN_MAX_BYTES + 1 }
    const empty = { ...rec(3), bytes: 0 }
    assert.deepEqual(recentReturnCandidates([noSha, show, empty, rec(4)], new Set([1, 2, 3, 4].map(colon))).map((r) => r.id), [4])
  })
  it('a played old song is not "just got": it is never fetched', async () => {
    const tracks = [
      { path: colon(1), dateAdded: new Date(NOW - 2 * DAY).toISOString() },
      { path: colon(2), dateAdded: new Date(NOW - 400 * DAY).toISOString(), lastPlayedAt: NOW - DAY },
    ]
    const recent = buildRecentKeep(tracks, NOW, createKeepWindowState().look(251 * GB))
    assert.equal(recent.get(colon(2)), 'played', 'it is still kept from being offloaded')
    const w = world([1, 2])
    await pass(w, [rec(1), rec(2)], { added: addedLately(recent) })
    assert.deepEqual(w.seen.fetched, [1])
  })
})

describe('when it runs at all', () => {
  it('hub, at home, long windows: all three', () => {
    assert.equal(returnAllowed({ hub: true, roomy: true, away: false }), true)
    assert.equal(returnAllowed({ hub: false, roomy: true, away: false }), false)
    assert.equal(returnAllowed({ hub: true, roomy: false, away: false }), false)
    assert.equal(returnAllowed({ hub: true, roomy: true, away: true }), false)
  })
  it('away from home, tight windows, or not the hub: homemini is not even asked', async () => {
    for (const over of [{ away: true }, { roomy: false }, { hub: false }]) {
      const w = world([1])
      const r = await pass(w, [rec(1)], over)
      assert.deepEqual(w.seen.asked, [], JSON.stringify(over))
      assert.deepEqual(w.seen.fetched, [])
      assert.equal(r.restored, 0)
    }
  })
  it('it stops while the disk still has its headroom: a fetch can’t be what turns the windows tight', async () => {
    assert.equal(roomToReturn(ROOMY_ENTER_BYTES + 100, 100), true)
    assert.equal(roomToReturn(ROOMY_ENTER_BYTES + 99, 100), false)
    assert.equal(roomToReturn(Number.NaN, 1), false)
    assert.ok(ROOMY_ENTER_BYTES > ROOMY_FREE_BYTES)
    const w = world([1, 2], { free: ROOMY_ENTER_BYTES + body(1).length + 3 })
    const r = await pass(w, [rec(1, '2026-11-10T02:00:00Z'), rec(2, '2026-11-10T01:00:00Z')])
    assert.deepEqual(w.seen.written, [1])
    assert.deepEqual(w.seen.fetched, [1], 'the second is not even downloaded')
    assert.match(String(r.stoppedBecause), /headroom/)
  })
})

describe('homemini is asked before anything is downloaded', () => {
  it('the same file as the record: downloaded, checked, written, requeued, remembered as back', async () => {
    const w = world([1])
    const r = await pass(w, [rec(1)])
    assert.deepEqual(w.seen.asked, [[1]])
    assert.deepEqual(w.seen.written, [1])
    assert.deepEqual(w.seen.requeued, [1])
    assert.equal(r.restored, 1)
    assert.equal(returnedLately(w.ledger, colon(1), NOW), true)
  })
  it('homemini’s file was re-tagged: not one byte is downloaded, on this pass or the next hundred', async () => {
    const w = world([1], { identities: { 1: retagged(1) } })
    for (let i = 0; i < 100; i++) await pass(w, [rec(1)], { now: NOW + i * 90_000 })
    assert.deepEqual(w.seen.fetched, [])
    assert.equal(w.seen.asked.length, 1 + Math.floor((99 * 90_000) / REFUSED_RECHECK_MS), 'asked once, then once a day')
    assert.equal(w.seen.logs.filter((m) => /stays streamed/.test(m)).length, 1, 'said once')
  })
  it('one song that can’t come back never holds the songs behind it', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1)
    const records = ids.map((n) => rec(n, `2026-11-10T00:00:${String(n).padStart(2, '0')}Z`))
    const w = world(ids, { identities: Object.fromEntries(ids.map((n) => [n, n >= 5 ? retagged(n) : same(n)])) })
    const first = await pass(w, records)
    assert.deepEqual(w.seen.written, [4, 3, 2, 1], 'the newest six were all refused, and the four behind them still came back')
    assert.equal(first.refused, 6)
    assert.deepEqual(w.seen.fetched, [4, 3, 2, 1])
  })
  it('a refusal is asked about again when this Mac’s record changes, or after a day', async () => {
    const w = world([1], { identities: { 1: retagged(1) } })
    await pass(w, [rec(1)])
    await pass(w, [rec(1)], { now: NOW + 60_000 })
    assert.equal(w.seen.asked.length, 1)
    const reoffloaded = { ...rec(1, '2026-11-12T13:00:00Z'), fullSha1: '9'.repeat(40) }
    await pass(w, [reoffloaded], { now: NOW + 120_000 })
    assert.equal(w.seen.asked.length, 2, 'a new record of the file is a new question')
    await pass(w, [reoffloaded], { now: NOW + 120_000 + REFUSED_RECHECK_MS })
    assert.equal(w.seen.asked.length, 3)
  })
  it('not hashed yet, or no file: nothing fetched and nothing remembered, so the next pass asks again', async () => {
    const w = world([1, 2], { identities: { 1: { pending: true }, 2: null } })
    const r = await pass(w, [rec(1), rec(2)])
    assert.deepEqual(w.seen.fetched, [])
    assert.equal(r.ledgerChanged, false)
    await pass(w, [rec(1), rec(2)], { now: NOW + 90_000 })
    assert.equal(w.seen.asked.length, 2)
  })
  it('no answer, or a backend with no such route: nothing is downloaded', async () => {
    for (const kind of ['unreachable', 'unsupported'] as const) {
      const w = world([1], { identityAnswer: { kind } })
      const r = await pass(w, [rec(1)])
      assert.deepEqual(w.seen.fetched, [])
      assert.ok(r.stoppedBecause)
    }
  })
  it('bytes that are not what homemini said it holds are not written, and that is remembered too', async () => {
    const w = world([1, 2], { sends: (id) => (id === 2 ? Buffer.from('other') : body(id)) })
    await pass(w, [rec(1, '2026-11-10T01:00:00Z'), rec(2, '2026-11-10T02:00:00Z')])
    assert.deepEqual(w.seen.written, [1])
    await pass(w, [rec(1), rec(2)], { now: NOW + 90_000 })
    assert.deepEqual(w.seen.fetched, [2, 1], 'not downloaded a second time')
  })
  it('at most a few files a pass, and a bounded question', async () => {
    const ids = Array.from({ length: RETURN_ASK + 10 }, (_, i) => i + 1)
    const w = world(ids)
    await pass(w, ids.map((n) => rec(n, `2026-11-10T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z`)))
    assert.equal(w.seen.written.length, RETURN_PER_PASS)
    assert.equal(w.seen.asked[0].length, RETURN_ASK)
  })
})

describe('a song the player is using', () => {
  it('is not picked', async () => {
    const w = world([1, 2], { inUse: new Set([2]) })
    await pass(w, [rec(1), rec(2)])
    assert.deepEqual(w.seen.written, [1])
    assert.deepEqual(w.seen.asked, [[1]])
  })
  it('tapped while its file was downloading: the link is left alone, and a later pass brings it back', async () => {
    const w = world([1])
    w.onFetched = (id) => { w.inUse.add(id) }
    const r = await pass(w, [rec(1)])
    assert.deepEqual(w.seen.fetched, [1])
    assert.deepEqual(w.seen.written, [], 'the file under a playing song is never swapped')
    assert.equal(r.restored, 0)
    assert.equal(returnedLately(w.ledger, colon(1), NOW), false)
    w.onFetched = undefined
    w.inUse.clear()
    await pass(w, [rec(1)], { now: NOW + 90_000 })
    assert.deepEqual(w.seen.written, [1])
  })
  it('a link that became a real file while downloading is not overwritten', async () => {
    const w = world([1])
    w.onFetched = (id) => { w.kinds[id] = 'file' }
    await pass(w, [rec(1)])
    assert.deepEqual(w.seen.written, [])
  })
})

describe('the ledger', () => {
  it('a song that came back is held for 14 days, to the millisecond', () => {
    const ledger: ReturnLedger = { version: 1, returned: { [colon(1)]: NOW }, refused: {} }
    assert.equal(returnedLately(ledger, colon(1), NOW + RETURN_HOLD_DAYS * DAY - 1), true)
    assert.equal(returnedLately(ledger, colon(1), NOW + RETURN_HOLD_DAYS * DAY), false)
    assert.equal(returnedLately(ledger, colon(2), NOW), false)
  })
  it('a missing or broken file is an empty ledger, never a throw', () => {
    assert.deepEqual(parseLedger(null), emptyLedger())
    assert.deepEqual(parseLedger('{not json'), emptyLedger())
    assert.deepEqual(parseLedger(JSON.stringify({ returned: { a: 5, b: 'x' }, refused: { c: { record: 'r', remote: 'm', at: 1 }, d: { record: 1 } } })), { version: 1, returned: { a: 5 }, refused: { c: { record: 'r', remote: 'm', at: 1 } } })
  })
})

/**
 * The whole thing on a simulated disk: the queue's keep rule and the bring-back
 * run pass after pass while something else fills and empties the disk across
 * both edges. A loop would show as a song fetched twice.
 */
describe('walking the disk across the edge, both ways', () => {
  const SONG = 100 * 1024 * 1024
  const N = 300
  const HOUR = 60 * 60 * 1000
  it('a song is fetched at most once, however the disk moves, and what came back is never dropped inside its 14 days', async () => {
    // One pass an hour for 40 days, with a disk that swings 55 GB ↔ 115 GB free every two days.
    const tracks = Array.from({ length: N }, (_, i) => ({ id: i + 1, path: colon(i + 1), dateAdded: new Date(NOW - (i % 13) * DAY - HOUR).toISOString() }))
    const records = tracks.map((t) => rec(t.id))
    const size = (id: number): number => body(id).length
    const WEIGHT = SONG   // each song counts as 100 MB of disk in the simulation
    const local = new Set<number>()
    const fetches = new Map<number, number>()
    const cameBackAt = new Map<number, number>()
    let ledger = emptyLedger()
    let offloadedInsideHold = 0
    let lowestAfterWrite = Infinity
    let flips = 0
    let was: boolean | null = null
    const state = createKeepWindowState()
    const other = (h: number): number => 85 * GB - 30 * GB * Math.sin((h / 48) * 2 * Math.PI)   // free with no local songs: 55 ↔ 115 GB
    const freeAt = (h: number): number => other(h) - local.size * WEIGHT
    const lastDayFetches: number[] = []
    for (let h = 0; h < 40 * 24; h++) {
      const now = NOW + h * HOUR
      const windows = state.look(freeAt(h))
      if (was !== null && was !== windows.roomy) flips++
      was = windows.roomy
      const recent = buildRecentKeep(tracks, now, windows)
      for (const id of [...local]) {
        if (recent.has(colon(id)) || returnedLately(ledger, colon(id), now)) continue
        local.delete(id)
        if (now - (cameBackAt.get(id) ?? -Infinity) < RETURN_HOLD_DAYS * DAY) offloadedInsideHold++
      }
      let got = 0
      const r = await returnRecentSongs({
        hub: true, roomy: windows.roomy, away: false, records, added: addedLately(recent), ledger, now,
        inUse: () => false,
        currentKind: async (x) => (local.has(Number(x.id)) ? 'file' : 'symlink'),
        askIdentity: async (ids) => ({ kind: 'answers', byId: new Map(ids.map((id) => [String(id), { size: size(Number(id)), sha1: sha(body(Number(id))), etag: '"e"' }])) }),
        // The check is made with the simulated weight, not the test body's few bytes.
        freeBytes: async () => freeAt(h) - WEIGHT,
        fetchFull: async (id) => { fetches.set(Number(id), (fetches.get(Number(id)) ?? 0) + 1); got++; return body(Number(id)) },
        writeBack: async (x) => { local.add(Number(x.id)); cameBackAt.set(Number(x.id), now); lowestAfterWrite = Math.min(lowestAfterWrite, freeAt(h)) },
        requeue: async () => {},
        log: () => {},
      })
      ledger = r.ledger
      if (h >= 39 * 24) lastDayFetches.push(got)
    }
    const most = Math.max(0, ...fetches.values())
    assert.ok(fetches.size > 0, 'the simulation did bring songs back')
    assert.equal(most, 1, `a song was downloaded ${most} times`)
    assert.equal(offloadedInsideHold, 0, 'a song that came back was offloaded again inside its 14 days')
    assert.ok(lowestAfterWrite >= ROOMY_ENTER_BYTES - 1024, `a fetch left the disk at ${(lowestAfterWrite / GB).toFixed(1)} GB free, under the 80 GB edge`)
    assert.ok(flips >= 6, `the disk really crossed both edges (${flips} flips in 40 days)`)
    assert.ok(flips <= 45, `the windows flipped ${flips} times: two edges allow at most two flips per swing`)
    assert.equal(lastDayFetches.reduce((a, b) => a + b, 0), 0, 'long after every song is old, nothing is fetched')
  })
})
