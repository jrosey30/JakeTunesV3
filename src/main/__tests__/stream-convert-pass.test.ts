/**
 * One pass over the offload queue (2026-11-09): the library's record NOW
 * decides, dead rows leave, homemini is asked instead of downloaded, a refusal
 * is remembered, and away from home nothing is downloaded to check.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ASK_AHEAD, mergeQueuedDuringPass, PENDING_PASSES_BEFORE_WAIT, QUEUE_ORPHAN_GRACE_MS, reconcileQueueWithLibrary, runConvertPass,
  type ConvertOutcome, type ConvertPassDeps, type QueueRow, type StreamConvertItem,
} from '../stream-convert-pass.ts'
import type { HomeminiIdentity, IdentityAnswer, OneIdentity } from '../audio-identity.ts'

const HOUR = 60 * 60 * 1000
const NOW = 100 * 24 * HOUR
const colon = (id: number): string => `:iPod_Control:Music:F01:s${id}.m4a`
const row = (id: number, extra: Partial<StreamConvertItem> = {}): StreamConvertItem => ({ ipodPath: colon(id), fingerprint: `sha1:queued${id}|1`, enqueuedAt: NOW - 30 * 24 * HOUR, ...extra })
const track = (id: number, fp = `sha1:now${id}|1`) => ({ id, path: colon(id), audioFingerprint: fp })
const ident = (n: number): HomeminiIdentity => ({ size: n, sha1: String(n % 10).repeat(40), etag: `"${n}"` })

interface Seen { asked: Array<Array<string | number>>; converts: Array<{ id: string | number; fp?: string; identity: OneIdentity; allowWholeFile: boolean }>; logs: string[] }
function pass(over: Partial<ConvertPassDeps<StreamConvertItem>> & { items: StreamConvertItem[] }, answer: IdentityAnswer | ((ids: Array<string | number>) => IdentityAnswer), outcome: (r: QueueRow) => ConvertOutcome = () => ({ ok: true })) {
  const seen: Seen = { asked: [], converts: [], logs: [] }
  const p = runConvertPass<StreamConvertItem>({
    now: NOW, tracks: [1, 2, 3, 4, 5].map((id) => track(id)), maxAgeMs: 30 * 60 * 1000, batch: null,
    kept: () => false,
    away: async () => false,
    askIdentity: async (ids) => { seen.asked.push(ids); return typeof answer === 'function' ? answer(ids) : answer },
    convert: async (r, identity, allowWholeFile) => { seen.converts.push({ id: r.id, fp: r.fingerprint, identity, allowWholeFile }); return outcome(r) },
    log: (m) => seen.logs.push(m),
    ...over,
  })
  return p.then((result) => ({ result, seen }))
}
const answers = (...ids: number[]): IdentityAnswer => ({ kind: 'answers', byId: new Map(ids.map((id) => [String(id), ident(id)])) })

describe('reconcileQueueWithLibrary', () => {
  it('a row gets the library’s id and fingerprint as they are now, never the queued one', () => {
    const rec = reconcileQueueWithLibrary([row(1)], [track(1, 'sha1:retagged|1')], NOW)!
    const r = [...rec.rows.values()][0]
    assert.equal(r.id, 1)
    assert.equal(r.fingerprint, 'sha1:retagged|1')
    assert.notEqual(r.fingerprint, r.item.fingerprint)
  })
  it('a row whose path left the library is dropped; a young one waits', () => {
    const old = row(9)
    const young = row(8, { enqueuedAt: NOW - QUEUE_ORPHAN_GRACE_MS + 1000 })
    const undated = { ipodPath: colon(7) } as StreamConvertItem
    const rec = reconcileQueueWithLibrary([row(1), old, young, undated], [track(1)], NOW)!
    assert.deepEqual(rec.dropped, [old])
    assert.deepEqual(rec.waiting, [young, undated], 'an import is queued before the library is saved; no date is no proof of age')
    assert.equal(rec.rows.size, 1)
  })
  it('the match is the exact path of a song that has an id: nothing looser keeps or drops a row', () => {
    const upper = { ...row(1), ipodPath: colon(1).toUpperCase() }
    const spaced = { ...row(2), ipodPath: `${colon(2)} ` }
    const noId = row(3)
    const rec = reconcileQueueWithLibrary([row(1), upper, spaced, noId], [track(1), track(2), { path: colon(3), audioFingerprint: 'sha1:x|1' }, { id: '', path: colon(3) }], NOW)!
    assert.deepEqual([...rec.rows.values()].map((r) => [r.id, r.item.ipodPath]), [[1, colon(1)]], 'the row is tied to that song’s id')
    assert.deepEqual(rec.dropped, [upper, spaced, noId], 'another spelling of a path is another path; a song with no id is not a match')
  })
  it('an empty library read says nothing about any row', () => {
    assert.equal(reconcileQueueWithLibrary([row(1), row(9)], [], NOW), null)
    assert.equal(reconcileQueueWithLibrary([row(1)], [{ id: 1 }, { path: '' }], NOW), null)
  })
})

describe('runConvertPass', () => {
  it('asks homemini once for the due rows, converts on its answer, and never allows a whole-file check', async () => {
    const { result, seen } = await pass({ items: [row(1), row(2)] }, answers(1, 2))
    assert.deepEqual(seen.asked, [[1, 2]])
    assert.deepEqual(seen.converts, [
      { id: 1, fp: 'sha1:now1|1', identity: ident(1), allowWholeFile: false },
      { id: 2, fp: 'sha1:now2|1', identity: ident(2), allowWholeFile: false },
    ])
    assert.deepEqual(result, { keep: [], changed: true, converted: 2, dropped: 0, tried: 2, pending: 0 })
  })

  it('dead rows leave the queue even when nothing else is due', async () => {
    const waiting = row(1, { retryAfter: NOW + HOUR })
    const { result, seen } = await pass({ items: [row(9), waiting, row(10)] }, answers())
    assert.deepEqual(result.keep, [waiting])
    assert.equal(result.dropped, 2)
    assert.equal(result.changed, true)
    assert.equal(seen.asked.length, 0, 'nothing due: homemini is not asked')
    assert.match(seen.logs.join('\n'), /2 queue row\(s\) dropped: the path is no longer in the library/)
    for (const id of [9, 10]) assert.ok(seen.logs.some((l) => l.includes('dropped from the queue') && l.endsWith(colon(id))), 'each dropped path is logged')
    assert.equal(seen.converts.length, 0, 'a dropped row is never handed to the step that replaces a file')
  })

  it('dropping a row cannot touch an audio file: the module has no file access at all', () => {
    const src = readFileSync(new URL('../stream-convert-pass.ts', import.meta.url), 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    assert.deepEqual(imports.sort(), ['./audio-identity.ts', './offload-confirm.ts', './stream-convert-retry.ts'])
    assert.match(src, /^import type \{ RefusalMemo \} from '\.\/offload-confirm\.ts'$/m, 'the module that reads files is a type here, never code')
    for (const dep of ['audio-identity.ts', 'stream-convert-retry.ts']) {
      const depSrc = readFileSync(new URL(`../${dep}`, import.meta.url), 'utf8')
      assert.equal(/from '(node:)?(fs|fs\/promises|child_process)'/.test(depSrc), false, `${dep} has no file access either`)
    }
    assert.equal(/\b(unlink|rm|rmSync|rename|writeFile|trashItem|symlink)\b/.test(src), false)
  })

  it('a file homemini hasn’t hashed yet is not a try: nothing is done to the file, the wait is not lengthened', async () => {
    const items = [row(1, { tries: 2, retryAfter: NOW - 1 })]
    const { result, seen } = await pass({ items }, { kind: 'answers', byId: new Map([['1', { pending: true as const, size: 5, etag: '"5"' }]]) })
    assert.equal(seen.converts.length, 0)
    assert.deepEqual(result.keep, [{ ...items[0], pendingPasses: 1 }])
    assert.equal(result.tried, 0)
  })

  it('an empty library read touches nothing', async () => {
    const items = [row(1), row(9)]
    const { result, seen } = await pass({ items, tracks: [] }, answers(1))
    assert.deepEqual(result, { keep: items, changed: false, converted: 0, dropped: 0, tried: 0, pending: 0 })
    assert.equal(seen.asked.length + seen.converts.length, 0)
  })

  it('rows waiting out a retry, and iPod songs, are neither asked about nor tried', async () => {
    const waiting = row(1, { retryAfter: NOW + 1 })
    const ipod = row(2)
    const { result, seen } = await pass({ items: [waiting, ipod, row(3)], kept: (it) => it === ipod }, answers(3))
    assert.deepEqual(seen.asked, [[3]])
    assert.deepEqual(result.keep, [waiting, ipod])
  })

  it('the batch limit counts tries, in queue order', async () => {
    const items = [row(1), row(2), row(3)]
    const { result, seen } = await pass({ items, batch: 2 }, answers(1, 2, 3))
    assert.deepEqual(seen.asked, [[1, 2, 3]], 'asked about further than it will try')
    assert.deepEqual(seen.converts.map((c) => c.id), [1, 2])
    assert.deepEqual(result.keep, [items[2]], 'the third is untouched')
    const many = Array.from({ length: 40 }, (_, i) => row(i + 1))
    const big = await pass({ items: many, batch: 2, tracks: many.map((_, i) => track(i + 1)) }, answers())
    assert.equal(big.seen.asked[0].length, 2 * ASK_AHEAD, 'and no further than that')
  })

  // The review's starvation case: the head of the queue is not hashed yet on homemini.
  it('songs homemini hasn’t hashed don’t use the batch: the songs behind them are tried the same pass', async () => {
    const items = [row(1), row(2), row(3), row(4)]
    const byId = new Map<string, HomeminiIdentity | { pending: true } | null>([['1', { pending: true }], ['2', { pending: true }], ['3', ident(3)], ['4', ident(4)]])
    const { result, seen } = await pass({ items, batch: 2 }, { kind: 'answers', byId })
    assert.deepEqual(seen.converts.map((c) => c.id), [3, 4], 'both places in the batch went to songs that could be tried')
    assert.equal(result.converted, 2)
    assert.equal(result.pending, 2)
    assert.deepEqual(result.keep.map((k) => [k.ipodPath, k.pendingPasses, k.retryAfter]), [[colon(1), 1, undefined], [colon(2), 1, undefined]])
    assert.match(seen.logs.join('\n'), /2 song\(s\) waiting for homemini to hash its copy/)
  })

  it('a song still not hashed after several passes waits like any miss, and says so', async () => {
    const stuck = row(1, { pendingPasses: PENDING_PASSES_BEFORE_WAIT - 1, tries: 1 })
    const byId = new Map([['1', { pending: true as const }]])
    const { result, seen } = await pass({ items: [stuck] }, { kind: 'answers', byId })
    const kept = result.keep[0]
    assert.ok((kept.retryAfter ?? 0) > NOW, 'it waits')
    assert.equal(kept.tries, 2, 'and the next wait is longer')
    assert.equal('pendingPasses' in kept, false, 'the count starts over after the wait')
    assert.match(seen.logs.join('\n'), /1 asked 5 passes running, now waiting longer/)
    assert.equal(seen.converts.length, 0)
  })

  it('the count of not-hashed passes ends when homemini answers', async () => {
    const { result } = await pass({ items: [row(1, { pendingPasses: 3 })] }, answers(1), () => ({ ok: false, reason: 'different', refused: { local: 'a', remote: 'b' } }))
    assert.equal('pendingPasses' in result.keep[0], false)
  })

  it('a song queued while the pass ran is not lost when the queue is written back', () => {
    const a = row(1), b = row(2), c = row(3)
    const queuedMeanwhile = row(4)
    // the pass read [a, b, c], converted b, changed a
    const a2 = { ...a, tries: 1 }
    assert.deepEqual(mergeQueuedDuringPass([a, b, c], [a2, c], [a, b, c, queuedMeanwhile]), [a2, c, queuedMeanwhile])
    assert.deepEqual(mergeQueuedDuringPass([a, b], [], [a, b]), [], 'a converted row stays out')
    assert.deepEqual(mergeQueuedDuringPass([a], [a], [a, queuedMeanwhile, { ...queuedMeanwhile }]), [a, queuedMeanwhile], 'once')
    assert.deepEqual(mergeQueuedDuringPass([a], [a], []), [a], 'an unreadable file loses nothing the pass kept')
  })

  it('homemini not answering leaves every row exactly as it was', async () => {
    const items = [row(1, { tries: 3, retryAfter: NOW - 1 }), row(2)]
    const { result, seen } = await pass({ items }, { kind: 'unreachable' })
    assert.deepEqual(result.keep, items)
    assert.equal(result.changed, false)
    assert.equal(seen.converts.length, 0)
    const thrown = await pass({ items, askIdentity: async () => { throw new Error('down') } }, answers())
    assert.deepEqual(thrown.result.keep, items)
  })

  it('a song homemini has no file for is a plain miss', async () => {
    const { seen } = await pass({ items: [row(1)] }, answers(), () => ({ ok: false, reason: 'missing' }))
    assert.equal(seen.converts[0].identity, null)
  })

  it('a refusal is written on the row with a longer wait, and said once', async () => {
    const memo = { local: '10-5', remote: 'r1' }
    const first = await pass({ items: [row(1)] }, answers(1), () => ({ ok: false, reason: 'different', refused: memo }))
    const kept = first.result.keep[0]
    assert.deepEqual(kept.refused, memo)
    assert.ok((kept.retryAfter ?? 0) > NOW)
    assert.equal(kept.tries, 1)
    assert.equal(first.seen.logs.filter((l) => /holds other bytes/.test(l)).length, 1)
    // held next time: same memo, nothing said again, the wait doubles
    const due = { ...kept, retryAfter: NOW - 1 }
    const second = await pass({ items: [due] }, answers(1), () => ({ ok: false, reason: 'held', refused: memo }))
    assert.deepEqual(second.result.keep[0].refused, memo)
    assert.equal(second.result.keep[0].tries, 2)
    assert.equal(second.seen.logs.filter((l) => /holds other bytes/.test(l)).length, 0)
    // the row's memo is what the next check is given
  })

  it('a refusal that no longer describes what was found is taken off the row', async () => {
    const stale = row(1, { refused: { local: 'a', remote: 'b' } })
    const { result } = await pass({ items: [stale] }, answers(), () => ({ ok: false, reason: 'missing' }))
    assert.equal('refused' in result.keep[0], false)
  })

  it('an older backend at home: the old check runs, whole file allowed', async () => {
    const { seen, result } = await pass({ items: [row(1)] }, { kind: 'unsupported' })
    assert.deepEqual(seen.converts, [{ id: 1, fp: 'sha1:now1|1', identity: 'unsupported', allowWholeFile: true }])
    assert.equal(result.converted, 1)
  })

  it('an older backend away from home: nothing is checked, rows untouched, dead rows still leave', async () => {
    const items = [row(1, { tries: 2, retryAfter: NOW - 1 }), row(9), row(2)]
    const { seen, result } = await pass({ items, away: async () => true }, { kind: 'unsupported' })
    assert.equal(seen.converts.length, 0)
    assert.deepEqual(result.keep, [items[0], items[2]])
    assert.match(seen.logs.join('\n'), /away from home/)
    // an away check that fails reads as away
    const broken = await pass({ items: [row(1)], away: async () => { throw new Error('route') } }, { kind: 'unsupported' })
    assert.equal(broken.seen.converts.length, 0)
  })

  it('away from home with homemini answering: the cheap check runs', async () => {
    const { result } = await pass({ items: [row(1)], away: async () => true }, answers(1))
    assert.equal(result.converted, 1)
  })

  it('a convert that throws is a miss, not a lost row', async () => {
    const { result } = await pass({ items: [row(1)] }, answers(1), () => { throw new Error('boom') })
    assert.equal(result.keep.length, 1)
    assert.equal(result.converted, 0)
  })

  it('index.ts runs the queue through it, on the library as it is now', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const passSrc = index.slice(index.indexOf('async function runStreamConvertPass('), index.indexOf('function ensureStreamConvertWorker('))
    assert.match(passSrc, /await runConvertPass\(\{/)
    assert.match(passSrc, /const left = mergeQueuedDuringPass\(items, keep, await readStreamConvertQueue\(\)\)\s*if \(changed \|\| left\.length !== items\.length\) await writeStreamConvertQueue\(left\)\s*if \(!left\.length && streamConvertTimer\)/, 'written back merged, and the worker only stops on a queue that is really empty')
    assert.match(passSrc, /tracks: \(\(\(await libraryCache\.get\(\)\) as CachedLibrary\)\.tracks \|\| \[\]\) as QueueTrack\[\]/)
    assert.match(passSrc, /away: isAwayFromHome,/)
    assert.match(passSrc, /askIdentity: \(ids\) => askAudioIdentity\(/)
    assert.match(passSrc, /convertTrackToStreamed\(row\.item\.ipodPath, row\.fingerprint, \{ forId: row\.id, identity, remembered: row\.item\.refused, allowWholeFile \}\)/)
    assert.equal(/it\.fingerprint/.test(passSrc), false, 'the fingerprint saved in the queue row is never what a row is judged on')
    const convert = index.slice(index.indexOf('async function convertTrackToStreamed('), index.indexOf('async function laptopFreeBytes('))
    const gate = convert.indexOf('await confirmHomeminiHoldsFile({')
    assert.ok(gate > 0 && gate < convert.indexOf('await symlink(sentinel, tmp)'), 'the gate comes before the file is replaced')
    assert.match(convert, /if \(!match\.ok\) return \{ ok: false, error: keptLocalMessage\(match\.reason\),/)
    assert.match(convert, /pendingRetries: ask\.identity === undefined \? USER_PENDING_RETRIES : 0,/, 'only a request waits on homemini’s hash; the queue never does')
    assert.equal(index.includes('does not yet serve the full file'), false, 'the one message that was said for every reason is gone')
    assert.match(convert, /String\(ask\.forId\) !== String\(id\)/, 'the answer must be about this id')
    assert.equal(index.includes('confirmRawHomeminiMatch'), false, 'the whole-file gate is reached only through offload-confirm.ts')
  })
})
