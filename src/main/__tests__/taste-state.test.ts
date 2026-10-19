/**
 * Learned taste on the desktop (2026-10-19): adopt homemini's taste-state.json
 * from the NAS when it changes — or, with no NAS mount (workmini), from
 * homemini's GET /api/taste-state; usable only while promoted and fresh.
 * ⚠️ TWIN of JakeTunesMobile backend/src/util/__tests__/tasteState.test.ts and
 * backend/src/routes/__tests__/tasteState.test.ts (the route this calls).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTasteState, isUsable, pullTasteStateOnce, currentTasteState, TASTE_STATE_FRESH_MS, TASTE_STATE_FILE } from '../taste-state.ts'
import { buildTasteProfile, tasteScore } from '../../renderer/utils/tasteScore.ts'

const file = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, builtAt: '2026-10-20T08:40:00Z', promoted: true, why: 'promoted: test',
  tracks: { '7': [0.91, 0.99, 0], '8': [0.05, 0.02, 8], bad: [2, 9] }, ...over,
})

describe('taste-state', () => {
  it('parses, validates, and is usable only while promoted and fresh', () => {
    const s = parseTasteState(file())!
    assert.deepEqual(s.tracks.get('7'), [0.91, 0.99, 0])
    assert.equal(s.tracks.has('bad'), false)
    assert.equal(isUsable(s, s.builtAtMs + 1000), true)
    assert.equal(isUsable({ ...s, promoted: false }, s.builtAtMs), false)
    assert.equal(isUsable(s, s.builtAtMs + TASTE_STATE_FRESH_MS + 1), false)
    assert.equal(parseTasteState('{"v":2}'), null)
  })

  it('adopts a new NAS copy into the local dir, ignores malformed or older ones', async () => {
    const nas = mkdtempSync(join(tmpdir(), 'ts-nas-'))
    const local = mkdtempSync(join(tmpdir(), 'ts-local-'))
    const host = { localDir: local, nasDir: nas, nasAvailable: async () => true, log: () => {} }
    writeFileSync(join(nas, TASTE_STATE_FILE), file())
    assert.equal(await pullTasteStateOnce(host), true)
    assert.ok(existsSync(join(local, TASTE_STATE_FILE)))
    assert.equal(currentTasteState()?.tracks.size, 2)
    writeFileSync(join(nas, TASTE_STATE_FILE), '{broken')
    utimesSync(join(nas, TASTE_STATE_FILE), new Date(), new Date(Date.now() + 5000))
    assert.equal(await pullTasteStateOnce(host), false)
    assert.equal(JSON.parse(readFileSync(join(local, TASTE_STATE_FILE), 'utf8')).why, 'promoted: test')
    writeFileSync(join(nas, TASTE_STATE_FILE), file({ builtAt: '2026-10-01T00:00:00Z' }))
    utimesSync(join(nas, TASTE_STATE_FILE), new Date(), new Date(Date.now() + 10000))
    assert.equal(await pullTasteStateOnce(host), false, 'an older build never replaces a newer one')
  })
})

describe('taste-state with no NAS mount (workmini) — homemini /api/taste-state', () => {
  it('adopts homemini\'s copy, revalidates with its ETag, refuses malformed or older builds', async () => {
    const local = mkdtempSync(join(tmpdir(), 'ts-local-'))
    const calls: Array<{ url: string; inm: string | null }> = []
    let reply: () => Response = () => new Response('', { status: 404 })
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, inm: new Headers(init?.headers).get('If-None-Match') })
      return reply()
    }) as unknown as typeof fetch
    const logs: string[] = []
    const host = { localDir: local, nasDir: '/nonexistent', nasAvailable: async () => false, hubBase: () => 'http://homemini:3000', fetchImpl, log: (m: string) => { logs.push(m) } }
    const served = (body: string, etag: string) => () => new Response(body, { status: 200, headers: { etag, 'content-type': 'application/json' } })

    assert.equal(await pullTasteStateOnce(host), false, '404 before homemini has read a copy')
    assert.equal(await pullTasteStateOnce(host), false)
    assert.equal(logs.filter((m) => m.includes('HTTP 404')).length, 1, 'a repeating problem is logged once')

    const newest = file({ builtAt: '2026-10-25T08:40:00Z', why: 'promoted: via hub' })
    reply = served(newest, '"b1"')
    assert.equal(await pullTasteStateOnce(host), true)
    assert.equal(calls.at(-1)?.url, 'http://homemini:3000/api/taste-state')
    assert.equal(readFileSync(join(local, TASTE_STATE_FILE), 'utf8'), newest, 'written verbatim into the local state dir')
    assert.equal(currentTasteState()?.why, 'promoted: via hub')

    reply = () => new Response(null, { status: 304 })
    assert.equal(await pullTasteStateOnce(host), false)
    assert.equal(calls.at(-1)?.inm, '"b1"', 'the repeat poll sends the ETag, so an unchanged build is not downloaded')

    reply = served('{broken', '"b2"')
    assert.equal(await pullTasteStateOnce(host), false)
    reply = served(file({ builtAt: '2026-10-01T00:00:00Z' }), '"b3"')
    assert.equal(await pullTasteStateOnce(host), false, 'an older build never replaces a newer one')
    reply = () => { throw new TypeError('fetch failed') }
    assert.equal(await pullTasteStateOnce(host), false, 'homemini unreachable — next tick')
    assert.equal(currentTasteState()?.why, 'promoted: via hub')
    assert.equal(readFileSync(join(local, TASTE_STATE_FILE), 'utf8'), newest)

    const before = calls.length
    const nas = mkdtempSync(join(tmpdir(), 'ts-nas-'))
    assert.equal(await pullTasteStateOnce({ ...host, nasDir: nas, nasAvailable: async () => true }), false)
    assert.equal(calls.length, before, 'with the NAS mounted, homemini is never asked')
    assert.equal(await pullTasteStateOnce({ ...host, hubBase: undefined }), false)
    assert.equal(calls.length, before, 'no hub configured = NAS only')
  })
})

describe('renderer tasteScore learned path (twin of the backend)', () => {
  it('uses the learned score for covered songs, v5 otherwise', () => {
    const lib = [
      { id: 7, title: 'a', artist: 'A', album: 'X', genre: 'Rock', year: 1999, rating: 0, playCount: 1, dateAdded: '2025-01-01' },
      { id: 9, title: 'b', artist: 'B', album: 'Y', genre: 'Pop', year: 2010, rating: 5, playCount: 9, dateAdded: '2025-01-01' },
    ] as unknown as Parameters<typeof buildTasteProfile>[0]
    const plain = buildTasteProfile(lib)
    const learned = new Map([['7', 0.91]])
    const p = { ...plain, learned: () => learned }
    assert.equal(tasteScore(lib[0], p), 0.91)
    assert.equal(tasteScore(lib[1], p), tasteScore(lib[1], plain))
    assert.equal(tasteScore(lib[0], { ...plain, learned: () => null }), tasteScore(lib[0], plain))
  })
})
