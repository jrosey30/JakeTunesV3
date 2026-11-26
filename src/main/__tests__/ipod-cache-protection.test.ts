/**
 * Brief 265 (review of #504): neither Empty nor a size limit ever takes a copy a song on an iPod
 * was made from, and when those copies can't be worked out NOTHING is taken. Behaviour, on real
 * files: the protection module, the cache functions and the IPC as the app starts it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCache, pruneToCap, writeCapGb, CACHE_SETTINGS_FILE, SYNC_CONVERT_CACHE_SUBDIR } from '../sync-convert-cache.ts'
import { DELETED_SONG_ON_IPOD, protectedMirrorNames } from '../sync-convert-cache-protect.ts'
import { aacMirrorCacheName } from '../aac-mirror-recipe.ts'
import { startSyncConvertCache } from '../ipc/sync-cache-ipc.ts'
import { registerIpodProfileIpc } from '../ipc/ipod-profile-ipc.ts'
import type { IpcRegistrar } from '../ipc-register.ts'
import { buildDeviceMarker } from '../../common/ipod-identity.ts'

const idle = { syncInFlight: () => false }
const SONG = ':iPod_Control:Music:F01:A.m4a'

/** A state folder whose Nano holds song 1, a library, and a cache with that song's AAC copy + one spare copy. */
async function world(opts: { manifest?: string; tracks?: Array<{ id: number; path: string }> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'b265-protect-'))
  const state = join(root, 'state')
  const cache = join(root, 'cache')
  await mkdir(join(state, 'ipod-pools', 'nano'), { recursive: true })
  await mkdir(cache, { recursive: true })
  await writeFile(join(state, 'ipod-pools', 'nano', 'last-sync-manifest.json'), opts.manifest ?? JSON.stringify({ tracks: [{ id: 1 }] }))
  const libraryRoot = join(root, 'lib')
  const onIpod = aacMirrorCacheName(join(libraryRoot, 'iPod_Control', 'Music', 'F01', 'A.m4a'), 256)
  await writeFile(join(cache, onIpod), Buffer.alloc(10))
  await writeFile(join(cache, 'spare.m4a'), Buffer.alloc(10))
  const tracks = opts.tracks ?? [{ id: 1, path: SONG }, { id: 2, path: ':iPod_Control:Music:F02:B.m4a' }]
  const protect = () => protectedMirrorNames({ stateDir: state, libraryRoot, tracks })
  return { root, state, cache, onIpod, protect, libraryRoot }
}

describe('Empty takes only the copies no song on an iPod uses', () => {
  it('the copy a song on the Nano was made from stays; the spare goes', async () => {
    const w = await world()
    const r = await clearCache(w.cache, { ...idle, protect: w.protect })
    assert.deepEqual(r, { ok: true, removed: 1, freedBytes: 10, kept: 1 })
    assert.deepEqual(await readdir(w.cache), [w.onIpod])
  })
  it('when the protected copies can\'t be worked out, Empty refuses and takes nothing', async () => {
    const w = await world({ tracks: [], manifest: '{"tracks": []}' })   // library.json unreadable reads as no songs; nothing else would stop it
    const r = await clearCache(w.cache, { ...idle, protect: w.protect })
    assert.equal(r.ok, false)
    assert.equal((await readdir(w.cache)).length, 2)
  })
})

describe('a limit prunes nothing when the protection is incomplete', () => {
  const over = async (w: Awaited<ReturnType<typeof world>>) => {
    for (const n of await readdir(w.cache)) await truncate(join(w.cache, n), 600_000_000)
  }
  for (const [what, opts] of [
    ['an empty library (library.json unreadable)', { tracks: [], manifest: '{"tracks": []}' }],
    ['an unreadable sync record', { manifest: '{"tracks": [ {"id": 1' }],
    ['a sync record with no song list', { manifest: '{}' }],
    ['a song on an iPod the library doesn\'t have', { tracks: [{ id: 2, path: ':iPod_Control:Music:F02:B.m4a' }] }],
  ] as const) {
    it(what, async () => {
      const w = await world(opts as Parameters<typeof world>[0])
      await over(w)
      const r = await pruneToCap(w.cache, 0.5, { ...idle, protect: w.protect })
      assert.equal(r.pruned, false)
      if (!r.pruned) assert.equal(r.why, 'protection unknown')
      assert.equal((await readdir(w.cache)).length, 2, 'nothing taken')
    })
  }
  it('the library folder not known yet: nothing taken', async () => {
    const w = await world()
    await over(w)
    const r = await pruneToCap(w.cache, 0.5, { ...idle, protect: () => protectedMirrorNames({ stateDir: w.state, libraryRoot: null, tracks: [{ id: 1, path: SONG }] }) })
    assert.equal(r.pruned, false)
    assert.equal((await readdir(w.cache)).length, 2)
  })
  it('with the protection complete, the spare goes and the Nano\'s copy stays even over the limit', async () => {
    const w = await world()
    await over(w)
    const r = await pruneToCap(w.cache, 0.5, { ...idle, protect: w.protect })
    assert.equal(r.pruned, true)
    assert.deepEqual(await readdir(w.cache), [w.onIpod])
  })
})

describe('the startup race: before the library folder is known, the app\'s cache upkeep takes nothing', () => {
  it('startup prune with a limit set, and Empty, before ready: every copy stays', async () => {
    const w = await world()
    const userData = join(w.root, 'userData')
    const cache = join(userData, SYNC_CONVERT_CACHE_SUBDIR)
    await mkdir(cache, { recursive: true })
    for (const n of [w.onIpod, 'spare.m4a']) { await writeFile(join(cache, n), Buffer.alloc(10)); await truncate(join(cache, n), 600_000_000) }
    await writeCapGb(join(userData, CACHE_SETTINGS_FILE), 1)
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<unknown>>()
    const ipc = { handle: (n: string, f: (e: unknown, raw?: unknown) => Promise<unknown>) => { handlers.set(n, f) } } as unknown as IpcRegistrar
    let ready = false
    const up = startSyncConvertCache(ipc, { userData, syncInFlight: () => false, ready: () => ready, protectedNames: w.protect })
    try {
      await new Promise((r) => setTimeout(r, 200))   // the startup prune has run
      assert.equal((await readdir(cache)).length, 2, 'the startup prune took nothing')
      const cleared = await handlers.get('sync-convert-cache:clear')!({}) as { ok: boolean }
      assert.equal(cleared.ok, false, 'Empty refused before ready')
      assert.equal((await readdir(cache)).length, 2)
      ready = true
      const after = await handlers.get('sync-convert-cache:clear')!({}) as { ok: boolean; kept?: number }
      assert.equal(after.ok, true)
      assert.deepEqual(await readdir(cache), [w.onIpod], 'once ready, Empty keeps the Nano\'s copy')
    } finally { up.stop() }
  })
})

describe('the format is saved only for the iPod the page showed', () => {
  it('a different iPod plugged in meanwhile: refused; the same one: saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b265-expected-'))
    const mount = join(root, 'ipod')
    await mkdir(join(mount, 'iPod_Control'), { recursive: true })
    await writeFile(join(mount, 'iPod_Control', 'jaketunes-device.json'), JSON.stringify(buildDeviceMarker({ id: 'nano-0001', name: 'Nano', primary: false, now: '2026-11-25T00:00:00Z' })))
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<unknown>>()
    const ipc = { handle: (n: string, f: (e: unknown, raw?: unknown) => Promise<unknown>) => { handlers.set(n, f) } } as unknown as IpcRegistrar
    registerIpodProfileIpc(ipc, { stateDir: join(root, 'state'), getMount: () => mount, syncInFlight: () => false })
    const set = handlers.get('ipod-audio-profile:set')!
    const wrong = await set({}, { codec: 'aac', kbps: 320, expectedId: 'y2k-0002' }) as { ok: boolean; error?: string }
    assert.equal(wrong.ok, false)
    assert.match(String(wrong.error), /different iPod/)
    const right = await set({}, { codec: 'aac', kbps: 320, expectedId: 'nano-0001' }) as { ok: boolean; profile?: unknown }
    assert.equal(right.ok, true)
    assert.deepEqual(right.profile, { codec: 'aac', kbps: 320, enabled: true })
  })
})

describe('what the page says when nothing could be taken: plain words, never an id or a path', () => {
  /** No path separator, no number (a song id), no file name. */
  const plainOnly = (text: string) => {
    assert.doesNotMatch(text, /[/\\]|\d|\.json|manifest/, `plain words only: ${text}`)
  }
  for (const [what, opts] of [
    ['an empty library', { tracks: [], manifest: '{"tracks": []}' }],
    ['a damaged sync record', { manifest: '{"tracks": [ {"id": 1' }],
    ['a sync record with no song list', { manifest: '{}' }],
    ['a song deleted from the library still on an iPod', { tracks: [{ id: 2, path: ':iPod_Control:Music:F02:B.m4a' }] }],
  ] as const) {
    it(`${what}: Empty and a limit both say it plainly`, async () => {
      const w = await world(opts as Parameters<typeof world>[0])
      const r = await clearCache(w.cache, { ...idle, protect: w.protect })
      assert.equal(r.ok, false)
      if (!r.ok) plainOnly(r.error)
      const p = await pruneToCap(w.cache, 0.000001, { ...idle, protect: w.protect })
      assert.equal(p.pruned, false)
      if (!p.pruned) { assert.ok(p.plain); plainOnly(p.plain!); assert.match(String(p.detail), /manifest|library|record/, 'the log keeps the detail') }
    })
  }
  it('a song deleted from the library still on an iPod: "Sync that iPod, then try again."', async () => {
    const w = await world({ tracks: [{ id: 2, path: ':iPod_Control:Music:F02:B.m4a' }] })
    const r = await clearCache(w.cache, { ...idle, protect: w.protect })
    assert.deepEqual(r, { ok: false, error: `Nothing was emptied. ${DELETED_SONG_ON_IPOD}` })
    assert.match(DELETED_SONG_ON_IPOD, /Sync that iPod, then try again\.$/)
    const p = await pruneToCap(w.cache, 0.000001, { ...idle, protect: w.protect })
    assert.equal(!p.pruned && p.plain, DELETED_SONG_ON_IPOD)
  })
  it('setting a limit says the same, through the IPC', async () => {
    const w = await world({ tracks: [{ id: 2, path: ':iPod_Control:Music:F02:B.m4a' }] })
    const userData = join(w.root, 'userData')
    await mkdir(join(userData, SYNC_CONVERT_CACHE_SUBDIR), { recursive: true })
    await writeFile(join(userData, SYNC_CONVERT_CACHE_SUBDIR, 'x.m4a'), Buffer.alloc(10))
    await truncate(join(userData, SYNC_CONVERT_CACHE_SUBDIR, 'x.m4a'), 1_500_000_000)
    const handlers = new Map<string, (e: unknown, raw?: unknown) => Promise<unknown>>()
    const ipc = { handle: (n: string, f: (e: unknown, raw?: unknown) => Promise<unknown>) => { handlers.set(n, f) } } as unknown as IpcRegistrar
    const up = startSyncConvertCache(ipc, { userData, syncInFlight: () => false, ready: () => true, protectedNames: w.protect })
    try {
      const r = await handlers.get('sync-convert-cache:set-cap')!({}, { capGb: 1 }) as { ok: boolean; note?: string }
      assert.equal(r.note, `Nothing was emptied. ${DELETED_SONG_ON_IPOD}`)
      const before = await handlers.get('sync-convert-cache:clear')!({}) as { ok: boolean; error?: string }
      plainOnly(String(before.error))
    } finally { up.stop() }
  })
})

describe('the app marks the library folder known only once it is resolved (index.ts)', () => {
  it('musicDirResolved goes true on the line right after MUSIC_DIR = await resolveMusicDir(), and nowhere else', async () => {
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf-8')
    const lines = src.split('\n').map((l) => l.trim())
    const sets = lines.flatMap((l, i) => (/^musicDirResolved\s*=\s*true\b/.test(l) ? [i] : []))
    assert.equal(sets.length, 1, 'set true exactly once')
    assert.equal(lines[sets[0] - 1], 'MUSIC_DIR = await resolveMusicDir()')
    assert.equal(lines.filter((l) => /^let musicDirResolved\s*=\s*false\b/.test(l)).length, 1, 'starts false')
    assert.match(src, /ready: \(\) => musicDirResolved/)
    assert.match(src, /libraryRoot: musicDirResolved \? MUSIC_DIR/)
  })
})
