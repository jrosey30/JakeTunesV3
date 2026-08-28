/** Mixtape hub client (2026-08-28) — path-gated audio names, adopt-before-
 *  notify, immutable heal directions, quiet offline. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, writeFile, readFile } from 'fs/promises'
import { referencedAudioNames, convergeMixtapeHub } from '../mixtape-hub-sync.ts'

describe('referencedAudioNames — the path gate', () => {
  const dir = '/Users/x/Library/Application Support/JakeTunes/mixtape-intros'

  test('collects intro + talkover basenames under OUR dir only', () => {
    const tapes = [{
      id: 'mix-1',
      introPath: `${dir}/intro-1.m4a`,
      talkovers: [{ path: `${dir}/intro-2.m4a` }, { path: '/etc/passwd' }, { path: `${dir}/../evil.m4a` }],
    }]
    assert.deepEqual(referencedAudioNames(tapes, dir), ['intro-1.m4a', 'intro-2.m4a'])
  })

  test('non-m4a and traversal-shaped names are refused', () => {
    const tapes = [{ id: 'x', introPath: `${dir}/notaudio.sh` }, { id: 'y', introPath: `${dir}/.hidden.m4a` }]
    assert.deepEqual(referencedAudioNames(tapes, dir), [])
  })
})

describe('convergeMixtapeHub', () => {
  test('adopts hub tapes, pulls missing audio, pushes hub-missing audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tape-hub-'))
    const introsDir = join(dir, 'mixtape-intros')
    const tombstonesFile = join(dir, 'ts.json')
    await writeFile(join(dir, 'seed'), '')  // ensure dir exists
    const localTape = { id: 'mix-local', modifiedAt: '2026-08-28T01:00:00Z', introPath: join(introsDir, 'local-voice.m4a') }
    const hubTape = { id: 'mix-remote', modifiedAt: '2026-08-28T02:00:00Z', introPath: join(introsDir, 'remote-voice.m4a') }
    const { mkdir } = await import('fs/promises')
    await mkdir(introsDir, { recursive: true })
    await writeFile(join(introsDir, 'local-voice.m4a'), 'LOCAL-AUDIO')

    const puts: string[] = []
    const fakeFetch = (async (url: string, init?: { method?: string }) => {
      const u = String(url)
      if (u.endsWith('/converge')) return { ok: true, json: async () => ({ ok: true, mixtapes: [localTape, hubTape], tombstones: [] }) }
      if (u.endsWith('/audio')) return { ok: true, json: async () => ({ names: ['remote-voice.m4a'] }) }
      if (u.includes('/audio/remote-voice.m4a')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('REMOTE-AUDIO').buffer }
      if (init?.method === 'PUT') { puts.push(u); return { ok: true, json: async () => ({ ok: true }) } }
      return { ok: false, status: 404 }
    }) as unknown as typeof fetch

    let adopted: unknown[] = []
    const r = await convergeMixtapeHub({
      hubUrl: 'http://hub', device: 'test',
      getMixtapes: async () => [localTape],
      setMixtapes: async (t) => { adopted = t },
      tombstonesFile, introsDir,
      fetchFn: fakeFetch, log: () => {},
    })
    assert.equal(r.ok, true)
    assert.equal(r.changed, true, 'hub had a tape we lacked')
    assert.equal(adopted.length, 2)
    assert.equal(r.audioPulled, 1)
    assert.equal((await readFile(join(introsDir, 'remote-voice.m4a'))).toString(), 'REMOTE-AUDIO')
    assert.equal(r.audioPushed, 1, 'local-voice.m4a missing from hub inventory → pushed')
    assert.ok(puts[0].includes('local-voice.m4a'))
  })

  test('an unreachable hub is a quiet no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tape-hub-'))
    const r = await convergeMixtapeHub({
      hubUrl: 'http://hub', device: 'test',
      getMixtapes: async () => [],
      setMixtapes: async () => { throw new Error('must not run') },
      tombstonesFile: join(dir, 'ts.json'), introsDir: join(dir, 'intros'),
      fetchFn: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
      log: () => {},
    })
    assert.equal(r.ok, false)
    assert.equal(r.changed, false)
  })
})
