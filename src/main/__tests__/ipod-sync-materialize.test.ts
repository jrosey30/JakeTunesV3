import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lstat, mkdir, writeFile, rename, unlink } from 'fs/promises'
import { materializeTrackFromHomemini } from '../ipod-sync-materialize.ts'

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
})
