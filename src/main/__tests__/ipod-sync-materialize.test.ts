import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lstat, mkdir, writeFile, rename, unlink } from 'fs/promises'
import {
  diskWriteWouldBreachFloor,
  MATERIALIZE_FREE_FLOOR_BYTES,
  materializeTrackFromHomemini,
  stageTrackForSync,
} from '../ipod-sync-materialize.ts'

describe('materializeTrackFromHomemini', () => {
  it('leaves a real local file alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const abs = join(root, 'iPod_Control', 'Music', 'F00', 'OK.m4a')
    await mkdir(join(root, 'iPod_Control', 'Music', 'F00'), { recursive: true })
    writeFileSync(abs, 'already here')
    let fetched = 0
    const r = await materializeTrackFromHomemini({
      colonPath: ':iPod_Control:Music:F00:OK.m4a',
      trackId: 35,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      lstat,
      mkdir,
      writeFile,
      rename,
      unlink,
      fetchAudio: async () => {
        fetched++
        return { ok: true, status: 200, buffer: Buffer.from('nope') }
      },
    })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.pulled, false)
    assert.equal(fetched, 0)
    assert.equal(readFileSync(abs, 'utf-8'), 'already here')
  })

  it('pulls from homemini when the Mac copy was evicted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const abs = join(root, 'iPod_Control', 'Music', 'F46', 'HVEG.m4a')
    const r = await materializeTrackFromHomemini({
      colonPath: ':iPod_Control:Music:F46:HVEG.m4a',
      trackId: 35,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      lstat,
      mkdir,
      writeFile,
      rename,
      unlink,
      fetchAudio: async (url) => {
        assert.equal(url, 'http://homemini:3000/audio/35')
        return { ok: true, status: 200, buffer: Buffer.from('postal service bytes') }
      },
    })
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.pulled, true)
    assert.equal(existsSync(abs), true)
    assert.equal(readFileSync(abs, 'utf-8'), 'postal service bytes')
  })

  it('replaces a NAS symlink with homemini bytes — never follows SMB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const dir = join(root, 'iPod_Control', 'Music', 'F00')
    await mkdir(dir, { recursive: true })
    const abs = join(dir, 'NAS.m4a')
    symlinkSync('/Volumes/JakeShared/would-hang.m4a', abs)
    const r = await materializeTrackFromHomemini({
      colonPath: ':iPod_Control:Music:F00:NAS.m4a',
      trackId: 9,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      lstat,
      mkdir,
      writeFile,
      rename,
      unlink,
      fetchAudio: async () => ({ ok: true, status: 200, buffer: Buffer.from('from homemini') }),
    })
    assert.equal(r.ok, true)
    const st = await lstat(abs)
    assert.equal(st.isSymbolicLink(), false)
    assert.equal(readFileSync(abs, 'utf-8'), 'from homemini')
  })

  it('fails closed when homemini cannot serve the song', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const r = await materializeTrackFromHomemini({
      colonPath: ':iPod_Control:Music:F00:GONE.m4a',
      trackId: 1,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      lstat,
      mkdir,
      writeFile,
      rename,
      unlink,
      fetchAudio: async () => ({ ok: false, status: 404, buffer: Buffer.alloc(0) }),
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /homemini 404/)
  })

  it('refuses a pin that would drop free disk under 10 GB and leaves the symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const dir = join(root, 'iPod_Control', 'Music', 'F00')
    await mkdir(dir, { recursive: true })
    const abs = join(dir, 'NAS.m4a')
    symlinkSync('/Volumes/JakeShared/would-hang.m4a', abs)
    let fetched = 0
    const r = await materializeTrackFromHomemini({
      colonPath: ':iPod_Control:Music:F00:NAS.m4a',
      trackId: 9,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      lstat, mkdir, writeFile, rename, unlink,
      freeBytes: async () => MATERIALIZE_FREE_FLOOR_BYTES - 1,
      fetchAudio: async () => {
        fetched++
        return { ok: true, status: 200, buffer: Buffer.from('should-not-land') }
      },
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /10\.0 GB/)
    assert.equal(fetched, 0)
    assert.equal((await lstat(abs)).isSymbolicLink(), true)
  })

  it('stages a symlink into a temp dir and deletes it without touching the library path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const dir = join(root, 'iPod_Control', 'Music', 'F00')
    await mkdir(dir, { recursive: true })
    const abs = join(dir, 'NAS.m4a')
    symlinkSync('/Volumes/JakeShared/would-hang.m4a', abs)
    const stage = join(root, 'stage')
    const r = await stageTrackForSync({
      colonPath: ':iPod_Control:Music:F00:NAS.m4a',
      trackId: 9,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      stageDir: stage,
      lstat, mkdir, writeFile, rename, unlink,
      freeBytes: async () => MATERIALIZE_FREE_FLOOR_BYTES + 50_000_000,
      fetchAudio: async () => ({ ok: true, status: 200, buffer: Buffer.from('staged-bytes') }),
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.staged, true)
    assert.notEqual(r.abs, abs)
    assert.equal(readFileSync(r.abs, 'utf-8'), 'staged-bytes')
    assert.equal((await lstat(abs)).isSymbolicLink(), true)
    await r.cleanup()
    assert.equal(existsSync(r.abs), false)
    assert.equal((await lstat(abs)).isSymbolicLink(), true)
  })

  it('refuses to stage when the incoming file would cross the floor, and writes nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const stage = join(root, 'stage')
    const buf = Buffer.alloc(1000, 1)
    const r = await stageTrackForSync({
      colonPath: ':iPod_Control:Music:F00:BIG.m4a',
      trackId: 3,
      localMount: root,
      pathSep: '/',
      homeminiAudioBase: 'http://homemini:3000/audio',
      stageDir: stage,
      lstat, mkdir, writeFile, rename, unlink,
      freeBytes: async () => MATERIALIZE_FREE_FLOOR_BYTES + 100,
      fetchAudio: async () => ({ ok: true, status: 200, buffer: buf }),
    })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'free-space')
      assert.match(r.error, /10\.0 GB/)
    }
    assert.equal(existsSync(stage), false)
    assert.equal(diskWriteWouldBreachFloor(MATERIALIZE_FREE_FLOOR_BYTES + 100, 1000), true)
    assert.equal(diskWriteWouldBreachFloor(MATERIALIZE_FREE_FLOOR_BYTES + 1000, 100), false)
  })
})

// Review of #466: the background download and a Sync's fetch could restore the same song at
// once, both through `${abs}.dl.tmp`: one deleted or renamed the other's half-written temp.
describe('two restores of one song at once', () => {
  it('each write has its own temp; both finish and no temp is left behind', async () => {
    const { readdirSync } = await import('node:fs')
    const { materializeTmpPath } = await import('../ipod-sync-materialize.ts')
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-'))
    const dirAbs = join(root, 'iPod_Control', 'Music', 'F00')
    const abs = join(dirAbs, 'Twice.m4a')
    assert.notEqual(materializeTmpPath(abs), materializeTmpPath(abs))
    const temps: string[] = []
    const opts = {
      colonPath: ':iPod_Control:Music:F00:Twice.m4a', trackId: 7, localMount: root, pathSep: '/', homeminiAudioBase: 'http://homemini:3000/audio',
      lstat, mkdir, rename, unlink,
      // Slow writes, so the two overlap.
      writeFile: async (p: string, b: Buffer) => { temps.push(p); await new Promise((r) => setTimeout(r, 20)); await writeFile(p, b) },
      fetchAudio: async () => ({ ok: true, status: 200, buffer: Buffer.from('the song') }),
    }
    const [a, b] = await Promise.all([materializeTrackFromHomemini(opts), materializeTrackFromHomemini(opts)])
    assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]))
    assert.equal(new Set(temps).size, 2)
    assert.equal(readFileSync(abs, 'utf-8'), 'the song')
    assert.deepEqual(readdirSync(dirAbs), ['Twice.m4a'])
  })
})

// Review of #469: a crash mid-write left a song-sized `*.dl-*.tmp` in F## for good.
describe('restore temps a crashed process left', () => {
  it('a restore sweeps its folder of other processes’ temps and the old shared name; this process’s own are never touched', async () => {
    const { readdir, writeFile: wf } = await import('node:fs/promises')
    const { isStaleMaterializeTemp } = await import('../ipod-sync-materialize.ts')
    const root = mkdtempSync(join(tmpdir(), 'jt-mat-sweep-'))
    const dirAbs = join(root, 'iPod_Control', 'Music', 'F00')
    await mkdir(dirAbs, { recursive: true })
    const own = `Other.m4a.dl-${process.pid}-abc123.tmp`
    const crashed = `Other.m4a.dl-${process.pid + 1}-def456.tmp`
    for (const n of ['Keep.m4a', own, crashed, 'Old.m4a.dl.tmp', 'notes.tmp']) await wf(join(dirAbs, n), 'x')
    assert.equal(isStaleMaterializeTemp(own), false)
    assert.equal(isStaleMaterializeTemp(crashed), true)
    assert.equal(isStaleMaterializeTemp('Old.m4a.dl.tmp'), true)
    assert.equal(isStaleMaterializeTemp('notes.tmp'), false)
    const r = await materializeTrackFromHomemini({
      colonPath: ':iPod_Control:Music:F00:Swept.m4a', trackId: 9, localMount: root, pathSep: '/', homeminiAudioBase: 'http://homemini:3000/audio',
      lstat, mkdir, rename, unlink, writeFile, readdir: (p: string) => readdir(p),
      fetchAudio: async () => ({ ok: true, status: 200, buffer: Buffer.from('the song') }),
    })
    assert.equal(r.ok, true)
    assert.deepEqual((await readdir(dirAbs)).sort(), ['Keep.m4a', own, 'Swept.m4a', 'notes.tmp'].sort())
  })

  it('the app’s restore is handed readdir, so the sweep runs', async () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8')
    const opts = src.slice(src.indexOf('function homeminiPullOpts'), src.indexOf('async function materializeLibraryTrack'))
    assert.match(opts, /readdir: \(p: string\) => readdir\(p\)/)
  })
})
