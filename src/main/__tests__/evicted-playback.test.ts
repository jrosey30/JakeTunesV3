import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { serveEvictedFromHomemini, type EvictedServeDeps } from '../evicted-playback.ts'

// The retry decision table, exercised without Electron. The Response
// objects are stand-ins — the module only passes them through.

function fakeResponse(tag: string): Response {
  return { headers: { get: () => tag } } as unknown as Response
}

function deps(overrides: Partial<EvictedServeDeps> & { calls?: Array<[string | number, boolean]> }): EvictedServeDeps {
  const calls = overrides.calls ?? []
  return {
    trackIdForAbsPath: overrides.trackIdForAbsPath ?? (async () => 42),
    fetchAudioFromHomemini: overrides.fetchAudioFromHomemini ?? (async (id, _r, f) => { calls.push([id, f]); return null }),
    wantsFlac: overrides.wantsFlac ?? (() => false),
  }
}

describe('serveEvictedFromHomemini', () => {
  test('unknown path (no library id) → null, homemini never asked', async () => {
    const calls: Array<[string | number, boolean]> = []
    const d = deps({ trackIdForAbsPath: async () => null, calls })
    assert.equal(await serveEvictedFromHomemini('/x/F00/A.m4a', null, d), null)
    assert.equal(calls.length, 0)
  })

  test('homemini hit → response passed through untouched', async () => {
    const hit = fakeResponse('hit')
    const d = deps({ fetchAudioFromHomemini: async () => hit })
    assert.equal(await serveEvictedFromHomemini('/x/F00/A.m4a', 'bytes=0-1', d), hit)
  })

  test('FLAC miss retries exactly once as raw and serves the raw hit', async () => {
    const rawHit = fakeResponse('raw')
    const calls: Array<[string | number, boolean]> = []
    const d = deps({
      wantsFlac: () => true,
      fetchAudioFromHomemini: async (id, _r, f) => { calls.push([id, f]); return f ? null : rawHit },
    })
    assert.equal(await serveEvictedFromHomemini('/x/F00/A.m4a', null, d), rawHit)
    assert.deepEqual(calls, [[42, true], [42, false]])
  })

  test('non-FLAC miss → single attempt, null (no pointless raw retry)', async () => {
    const calls: Array<[string | number, boolean]> = []
    const d = deps({ calls })
    assert.equal(await serveEvictedFromHomemini('/x/F00/A.m4a', null, d), null)
    assert.deepEqual(calls, [[42, false]])
  })

  test('both FLAC and raw miss → null (caller keeps its clean 404)', async () => {
    const calls: Array<[string | number, boolean]> = []
    const d = deps({ wantsFlac: () => true, calls })
    assert.equal(await serveEvictedFromHomemini('/x/F00/A.m4a', null, d), null)
    assert.equal(calls.length, 2)
  })

  test('range header reaches homemini verbatim', async () => {
    let seen: string | null = 'unset'
    const d = deps({ fetchAudioFromHomemini: async (_i, r) => { seen = r; return fakeResponse('x') } })
    await serveEvictedFromHomemini('/x/F00/A.m4a', 'bytes=100-200', d)
    assert.equal(seen, 'bytes=100-200')
  })
})
