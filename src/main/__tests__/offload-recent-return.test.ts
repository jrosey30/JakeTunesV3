/**
 * Recent songs that were already offloaded come back (2026-11-10), and only
 * from this Mac's own record of what it replaced.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recentReturnCandidates, returnRecentSongs, RETURN_MAX_BYTES, RETURN_PER_PASS } from '../offload-recent-return.ts'
import type { OffloadReplacementRecord, RehydrateResult } from '../offload-audio.ts'

const colon = (n: number): string => `:iPod_Control:Music:F01:s${n}.m4a`
const rec = (n: number, ts: string, sha = String(n % 10).repeat(40)): OffloadReplacementRecord => ({ ts, id: n, path: colon(n), fingerprint: `sha1:f${n}|1`, bytes: 100 + n, fullSha1: sha, sentinel: '/lib/.jt-streamed' })

describe('recentReturnCandidates', () => {
  it('only songs in the keep set, newest first, the newest record of each', () => {
    const keep = new Set([colon(1), colon(2), colon(4)])
    const got = recentReturnCandidates([
      rec(1, '2026-11-09T10:00:00.000Z', 'a'.repeat(40)), rec(2, '2026-11-10T13:18:00.000Z'), rec(3, '2026-11-10T13:19:00.000Z'),
      rec(1, '2026-11-10T09:00:00.000Z', 'b'.repeat(40)),
    ], keep)
    assert.deepEqual(got.map((r) => [r.id, r.fullSha1]), [[2, '2'.repeat(40)], [1, 'b'.repeat(40)]])
  })
  it('a record with no whole-file sha1 can restore nothing, so it is not a candidate', () => {
    const noSha = { ...rec(1, '2026-11-10T00:00:00.000Z'), fullSha1: undefined }
    const short = rec(2, '2026-11-10T00:00:00.000Z', 'abc')
    assert.deepEqual(recentReturnCandidates([noSha, short], new Set([colon(1), colon(2)])), [])
  })
  it('a show-sized file is never pulled into memory: it stays streamed', () => {
    const show = { ...rec(1, '2026-11-10T00:00:00.000Z'), bytes: RETURN_MAX_BYTES + 1 }
    const song = { ...rec(2, '2026-11-10T00:00:00.000Z'), bytes: RETURN_MAX_BYTES }
    const empty = { ...rec(3, '2026-11-10T00:00:00.000Z'), bytes: 0 }
    assert.deepEqual(recentReturnCandidates([show, song, empty], new Set([colon(1), colon(2), colon(3)])).map((r) => r.id), [2])
  })
})

function world(records: OffloadReplacementRecord[], kinds: Record<number, 'symlink' | 'file' | 'missing'>, over: { inUse?: number[]; fails?: number[]; stop?: string; max?: number } = {}) {
  const seen = { rehydrated: [] as number[], requeued: [] as number[], logs: [] as string[] }
  const run = returnRecentSongs({
    records, keep: new Set(records.map((r) => r.path)), max: over.max,
    inUse: (p) => (over.inUse ?? []).some((n) => colon(n) === p),
    currentKind: async (r) => kinds[Number(r.id)] ?? 'missing',
    rehydrate: async (picked): Promise<RehydrateResult> => {
      let restored = 0
      for (const r of picked) {
        seen.rehydrated.push(Number(r.id))
        if ((over.fails ?? []).includes(Number(r.id))) continue
        kinds[Number(r.id)] = 'file'
        restored++
      }
      return { restored, skipped: picked.length - restored, stoppedBecause: over.stop ?? null }
    },
    requeue: async (back) => { seen.requeued.push(...back.map((r) => Number(r.id))) },
    log: (m) => { seen.logs.push(m) },
  })
  return run.then((result) => ({ result, seen }))
}

describe('returnRecentSongs', () => {
  it('a link comes back and goes on the queue again; a real file is left alone', async () => {
    const { result, seen } = await world([rec(1, '2026-11-10T01:00:00Z'), rec(2, '2026-11-10T02:00:00Z')], { 1: 'symlink', 2: 'file' })
    assert.deepEqual(seen.rehydrated, [1])
    assert.deepEqual(seen.requeued, [1])
    assert.equal(result.restored, 1)
    assert.match(seen.logs.join('\n'), /1 recent song\(s\) are back on this Mac: 1/)
  })
  it('a song the player asked for lately is never touched', async () => {
    const { seen } = await world([rec(1, '2026-11-10T01:00:00Z'), rec(2, '2026-11-10T02:00:00Z')], { 1: 'symlink', 2: 'symlink' }, { inUse: [2] })
    assert.deepEqual(seen.rehydrated, [1])
  })
  it('a missing file is not this job’s to restore', async () => {
    const { result, seen } = await world([rec(1, '2026-11-10T01:00:00Z')], { 1: 'missing' })
    assert.deepEqual(seen.rehydrated, [])
    assert.equal(result.restored, 0)
  })
  it('at most a few a pass, newest first', async () => {
    const records = Array.from({ length: RETURN_PER_PASS + 4 }, (_, i) => rec(i + 1, `2026-11-10T00:00:${String(i).padStart(2, '0')}Z`))
    const kinds = Object.fromEntries(records.map((r) => [Number(r.id), 'symlink' as const]))
    const { seen } = await world(records, kinds)
    assert.equal(seen.rehydrated.length, RETURN_PER_PASS)
    assert.equal(seen.rehydrated[0], RETURN_PER_PASS + 4, 'the newest replacement first')
  })
  it('bytes that don’t match the record are not written, and that song is not requeued', async () => {
    const { result, seen } = await world([rec(1, '2026-11-10T01:00:00Z'), rec(2, '2026-11-10T02:00:00Z')], { 1: 'symlink', 2: 'symlink' }, { fails: [2] })
    assert.deepEqual(seen.rehydrated, [2, 1])
    assert.deepEqual(seen.requeued, [1])
    assert.equal(result.restored, 1)
  })
  it('a stop (the free-disk floor) is said', async () => {
    const { result, seen } = await world([rec(1, '2026-11-10T01:00:00Z')], { 1: 'symlink' }, { fails: [1], stop: 'free disk would drop below 10.0 GB' })
    assert.equal(result.stoppedBecause, 'free disk would drop below 10.0 GB')
    assert.deepEqual(seen.requeued, [])
    assert.match(seen.logs.join('\n'), /stopped: free disk/)
  })
})
