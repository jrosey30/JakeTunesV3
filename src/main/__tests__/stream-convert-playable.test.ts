/**
 * The offload queue and homemini's playable copy (2026-11-10): an ALAC file is
 * not tried until homemini says the copy this Mac would play is ready, and
 * what Jake just got is never tried at all. The sha gate is untouched: these
 * run BEFORE it and can only keep a file.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runConvertPass, type ConvertOutcome, type ConvertPassDeps, type PlayableVerdict, type StreamConvertItem } from '../stream-convert-pass.ts'
import type { HomeminiIdentity, IdentityAnswer } from '../audio-identity.ts'
import { playableVerdicts, type VariantState } from '../flac-variant.ts'

const HOUR = 60 * 60 * 1000
const NOW = 100 * 24 * HOUR
const colon = (id: number, ext = 'm4a'): string => `:iPod_Control:Music:F01:s${id}.${ext}`
const row = (id: number, ext = 'm4a', extra: Partial<StreamConvertItem> = {}): StreamConvertItem => ({ ipodPath: colon(id, ext), fingerprint: `sha1:q${id}|1`, enqueuedAt: NOW - 30 * 24 * HOUR, ...extra })
const ident = (n: number): HomeminiIdentity => ({ size: n, sha1: String(n % 10).repeat(40), etag: `"${n}"` })
const identities = (...ids: number[]): IdentityAnswer => ({ kind: 'answers', byId: new Map(ids.map((id) => [String(id), ident(id)])) })

function pass(items: StreamConvertItem[], states: Record<string, PlayableVerdict> | null | 'throw', over: Partial<ConvertPassDeps<StreamConvertItem>> = {}, outcome: (id: string | number) => ConvertOutcome = () => ({ ok: true })) {
  const seen = { askedPlayable: [] as Array<Array<string | number>>, converted: [] as Array<string | number>, logs: [] as string[] }
  const ids = items.map((it) => Number(/s(\d+)\./.exec(it.ipodPath)![1]))
  return runConvertPass<StreamConvertItem>({
    now: NOW, items, maxAgeMs: 30 * 60 * 1000, batch: null,
    tracks: items.map((it, i) => ({ id: ids[i], path: it.ipodPath, audioFingerprint: `sha1:n${ids[i]}|1` })),
    kept: () => false,
    away: async () => false,
    askIdentity: async () => identities(...ids),
    needsPlayable: (it) => it.ipodPath.endsWith('.m4a'),
    askPlayable: async (asked) => {
      seen.askedPlayable.push(asked)
      if (states === 'throw') throw new Error('net')
      return states ? new Map(Object.entries(states)) : null
    },
    convert: async (r) => { seen.converted.push(r.id); return outcome(r.id) },
    log: (m) => { seen.logs.push(m) },
    ...over,
  }).then((result) => ({ result, seen }))
}

describe('an ALAC file waits for homemini’s playable copy', () => {
  it('ready: tried. Still being built: not tried, and the row is left exactly as it was', async () => {
    const building = row(2)
    const { result, seen } = await pass([row(1), building, row(3)], { '1': 'ready', '2': 'soon', '3': 'ready' })
    assert.deepEqual(seen.converted, [1, 3])
    assert.deepEqual(result.keep, [building])
    assert.equal(result.keep[0], building, 'the same row object: nothing about it changed')
    assert.equal(result.notPlayable, 1)
    assert.equal(result.tried, 2, 'a song kept for this is not a try')
    assert.match(seen.logs.join('\n'), /1 song\(s\) kept local: homemini's playable copy isn't ready yet/)
  })
  it('only the songs that need a copy are asked about; an MP3 goes on its sha alone', async () => {
    const { seen } = await pass([row(1), row(2, 'mp3')], { '1': 'soon' })
    assert.deepEqual(seen.askedPlayable, [[1]])
    assert.deepEqual(seen.converted, [2])
  })
  it('no answer, a throw, an id the answer leaves out: nothing that needs a copy is tried', async () => {
    for (const states of [null, 'throw', {}] as const) {
      const { result, seen } = await pass([row(1), row(2)], states)
      assert.deepEqual(seen.converted, [], String(states))
      assert.equal(result.keep.length, 2)
      assert.equal(result.converted, 0)
    }
  })
  it('homemini says it won’t have one for now: the row waits like a miss, so it can’t hold the songs behind it', async () => {
    const { result, seen } = await pass([row(1), row(2)], { '1': 'never', '2': 'ready' })
    assert.deepEqual(seen.converted, [2])
    assert.equal(result.keep.length, 1)
    assert.ok((result.keep[0].retryAfter ?? 0) > NOW)
    assert.equal(result.keep[0].tries, 1)
    assert.equal(result.changed, true)
    assert.match(seen.logs.join('\n'), /no playable copy of it for now/)
  })
  it('the copy went away between the pass’s ask and the drop: the row stays as it was', async () => {
    const it1 = row(1)
    const { result } = await pass([it1], { '1': 'ready' }, {}, () => ({ ok: false, reason: 'not-playable', error: 'kept local for now' }))
    assert.deepEqual(result.keep, [it1])
    assert.equal(result.converted, 0)
  })
  it('a pass with no playable deps behaves exactly as before', async () => {
    const { result, seen } = await pass([row(1)], { '1': 'soon' }, { needsPlayable: undefined, askPlayable: undefined })
    assert.deepEqual(seen.converted, [1])
    assert.equal(result.notPlayable, undefined)
    assert.deepEqual(seen.askedPlayable, [])
  })
})

describe('homemini’s states, as the queue reads them', () => {
  it('ready and not-needed may be tried; no-room, failed and missing wait like a miss; the rest are asked again next pass', () => {
    const states: Record<string, VariantState | null> = { a: 'ready', b: 'not-needed', c: 'building', d: 'absent', e: 'waiting', f: 'no-room', g: 'failed', h: 'missing', i: null }
    assert.deepEqual([...playableVerdicts({ kind: 'answers', byId: new Map(Object.entries(states)) })!], [
      ['a', 'ready'], ['b', 'ready'], ['c', 'soon'], ['d', 'soon'], ['e', 'soon'], ['f', 'never'], ['g', 'never'], ['h', 'never'], ['i', 'soon'],
    ])
    assert.equal(playableVerdicts({ kind: 'unreachable' }), null)
    assert.equal(playableVerdicts({ kind: 'unsupported' }), null)
  })
})

describe('index.ts wires the two rules in front of the drop', () => {
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const convert = index.slice(index.indexOf('async function convertTrackToStreamed('), index.indexOf('async function laptopFreeBytes('))
  it('the playable check sits after the sha gate and before the link replaces the file', () => {
    const sha = convert.indexOf('confirmHomeminiHoldsFile(')
    const refuse = convert.indexOf('if (!match.ok) return')
    const playable = convert.indexOf('confirmPlayableOnHomemini(')
    const link = convert.indexOf('await symlink(sentinel, tmp)')
    assert.ok(sha > 0 && refuse > sha && playable > refuse && link > playable, 'order: sha gate, its refusal, playable copy, then the link')
    assert.match(convert, /if \(!playable\.ok\) return \{ ok: false,/)
    assert.match(convert, /if \(wantsHomeminiFlac\(fp\)\) \{/)
  })
  it('the sha gate is still the only way to a link: one symlink call, after match.ok', () => {
    assert.equal(convert.split('await symlink(').length - 1, 1)
    assert.match(convert, /fullSha1: match\.fullSha1/)
  })
  it('the pass keeps what Jake just got, what the player asked for, and asks for playable copies', () => {
    const passFn = index.slice(index.indexOf('async function runStreamConvertPass('), index.indexOf('function ensureStreamConvertWorker('))
    assert.match(passFn, /kept: \(it\) => keepsColon\(ipodGate, it\.ipodPath\) \|\| recent\.has\(it\.ipodPath\) \|\| cameBack\.has\(it\.ipodPath\) \|\| playerTouches\.has\(it\.ipodPath, now\)/)
    assert.match(passFn, /const windows = keepWindowState\.look\(await laptopFreeBytes\(\)\)/, 'the two-edge windows, not a fresh look each pass')
    assert.match(passFn, /const cameBack = await returnedHold\(now\)/)
    assert.match(passFn, /needsPlayable: \(it\) => wantsHomeminiFlac\(trackFarmPath\(it\.ipodPath\)\)/)
    assert.match(passFn, /askPlayable:/)
    assert.match(passFn, /const recent = buildRecentKeep\(/)
    assert.match(passFn, /askPlayable: async \(ids\) => playableVerdicts\(await askVariants\(ids, true\)\)/)
  })
  it('the bring-back gets the real disk and network looks, only what was added, and the player’s live answer', () => {
    const passFn = index.slice(index.indexOf('async function runStreamConvertPass('), index.indexOf('function ensureStreamConvertWorker('))
    const call = passFn.slice(passFn.indexOf('returnRecentToDisk({'), passFn.indexOf('\n', passFn.indexOf('returnRecentToDisk({')))
    assert.match(call, /roomy: windows\.roomy/)
    assert.match(call, /away: isAwayFromHome/)
    assert.match(call, /added: addedLately\(recent\)/)
    assert.match(call, /inUse: \(colon\) => playerTouches\.has\(colon, Date\.now\(\)\)/)
    assert.match(passFn, /if \(hub\) void returnRecentToDisk\(/)
    assert.match(passFn, /void keepStreamedWarm\(\{/)
    assert.match(index, /askVariants\(\[id\], false, READY_ASK_MS\)/)
  })
  it('the player’s requests are noted, and a streamed ALAC song goes through the new order on both routes', () => {
    const handler = index.slice(index.indexOf("protocol.handle('ipod-audio'"))
    assert.ok(handler.indexOf('playerTouches.noteAbs(rawPath, Date.now())') > 0)
    assert.ok(handler.indexOf('playerTouches.noteAbs(rawPath, Date.now())') < handler.indexOf('isHomeminiPlaybackClientCached()'))
    assert.equal(handler.split('streamedAlac.serve(').length - 1, 2)
    assert.equal(handler.includes('streamAlacCache.serve('), false, 'no route skips the ready-copy check')
  })
})
