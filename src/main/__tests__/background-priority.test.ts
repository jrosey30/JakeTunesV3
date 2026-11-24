/**
 * The iPod sync's conversions run at background priority (2026-11-20: Jake's
 * music popped during iPod syncs). background-priority.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { atBackgroundPriority, TASKPOLICY } from '../background-priority.ts'

const execP = promisify(execFile)

describe('atBackgroundPriority', () => {
  it('macOS: through taskpolicy -b; Linux: nice 15; Windows: as it was', () => {
    assert.deepEqual(atBackgroundPriority('ffmpeg', ['-i', 'a.flac', 'b.wav'], 'darwin'), [TASKPOLICY, ['-b', 'ffmpeg', '-i', 'a.flac', 'b.wav']])
    assert.deepEqual(atBackgroundPriority('afconvert', ['-d', 'alac'], 'darwin'), [TASKPOLICY, ['-b', 'afconvert', '-d', 'alac']])
    assert.deepEqual(atBackgroundPriority('ffmpeg', ['-y'], 'linux'), ['nice', ['-n', '15', 'ffmpeg', '-y']])
    assert.deepEqual(atBackgroundPriority('ffmpeg', ['-y'], 'win32'), ['ffmpeg', ['-y']])
  })

  it('on this machine the wrapped command really runs, finds its program on PATH, and keeps its pid (a timeout kills the converter itself)', { skip: process.platform !== 'darwin' && process.platform !== 'linux' }, async () => {
    const [file, args] = atBackgroundPriority('sh', ['-c', 'echo "$$ $PPID"'])
    const child = execFile(file, args)
    const out = await new Promise<string>((resolve, reject) => {
      let s = ''
      child.stdout!.on('data', (d) => { s += d })
      child.on('error', reject)
      child.on('close', () => resolve(s))
    })
    const [pid] = out.trim().split(' ').map(Number)
    assert.equal(pid, child.pid, 'exec in place, not a child of the wrapper')
    const r = await execP(...atBackgroundPriority('sh', ['-c', 'echo ok']))
    assert.equal(r.stdout.trim(), 'ok')
  })
})

describe('the iPod sync’s converters go through it', () => {
  it('the sync-convert cache (buildAacMirror, and buildMp3Mirror for Gen 1): every ffmpeg and afconvert', async () => {
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf-8')
    const body = src.slice(src.indexOf('async function buildAacMirror('), src.indexOf('async function buildIpodSafeAlacMirror('))
    assert.match(body, /const bgExec = \(cmd: string, args: string\[\], o: \{ timeout: number \}\) => \{ const \[f, a\] = atBackgroundPriority\(cmd, args\); return execP\(f, a, o\) \}/)
    assert.doesNotMatch(body, /execP\('(ffmpeg|afconvert)'/, 'no converter at normal priority')
    assert.equal((body.match(/bgExec\('(ffmpeg|afconvert)'/g) || []).length, 4)
  })

  it('the iPod-safe ALAC mirror (convertToIpodSafeAlac): the decode and the encode', async () => {
    const src = await readFile(new URL('../platform.ts', import.meta.url), 'utf-8')
    const body = src.slice(src.indexOf('async function convertToIpodSafeAlac('), src.indexOf('export interface SourceAudioLayout'))
    assert.match(body, /atBackgroundPriority\('ffmpeg', \[/)
    assert.match(body, /atBackgroundPriority\('afconvert', \[/)
    assert.doesNotMatch(body, /execP\('(ffmpeg|afconvert)'/)
  })

  it('the play cache stays at normal priority: it serves the song being played', async () => {
    const src = await readFile(new URL('../play-cache.ts', import.meta.url), 'utf-8')
    assert.doesNotMatch(src, /atBackgroundPriority/)
  })
})
