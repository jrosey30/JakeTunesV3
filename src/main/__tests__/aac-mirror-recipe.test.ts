/**
 * Brief 265: iPod AAC is Apple's encode or none (aac-mirror-recipe.ts).
 * The old check ran `afconvert --help`, which exits 2, so every mirror was ffmpeg's
 * own AAC and Jake's nano squeaked on 119 of them.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import {
  AAC_MIRROR_TOKEN, AacEncoderMissingError, aacMirrorCacheName, afconvertAacArgs,
  afconvertListsAacInM4af, isAacEncoderMissing, pcmDecodeArgs, probeAfconvert,
} from '../aac-mirror-recipe.ts'

const HELP = `Audio file and data formats:
    '3gpp' = 3GP Audio (.3gp, .3gpp)
               data_formats: 'aac ' 'aace' 'aacf'
    'm4af' = Apple MPEG-4 Audio (.m4a, .m4r)
               data_formats: '.mp1' '.mp2' '.mp3' 'aac ' 'aace' 'aacf' 'aacg'
                             'aach' 'aacl' 'aacp' 'alac'
    'WAVE' = WAVE (.wav)
               data_formats: lpcm
`

describe('the afconvert check', () => {
  it('reads the listing, not the exit code: `afconvert -hf` exits 1 and still counts', async () => {
    const run = async () => { throw Object.assign(new Error('Command failed: afconvert -hf'), { code: 1, stdout: '', stderr: HELP }) }
    assert.equal(await probeAfconvert(run), true)
  })
  it('a listing on stdout counts too', async () => {
    assert.equal(await probeAfconvert(async () => ({ stdout: HELP, stderr: '' })), true)
  })
  it('no program (ENOENT) is not available', async () => {
    const run = async () => { throw Object.assign(new Error('spawn afconvert ENOENT'), { code: 'ENOENT' }) }
    assert.equal(await probeAfconvert(run), false)
  })
  it('an afconvert that lists no AAC in m4af is not available', async () => {
    assert.equal(afconvertListsAacInM4af(`    'm4af' = Apple MPEG-4 Audio (.m4a)\n               data_formats: 'alac'\n    'WAVE' = WAVE\n               data_formats: 'aac '\n`), false)
    assert.equal(afconvertListsAacInM4af(''), false)
    assert.equal(afconvertListsAacInM4af(HELP), true)
  })
  it('on this Mac the real afconvert is found (the old --help check said it was missing)', { skip: process.platform !== 'darwin' }, async () => {
    const execP = promisify(execFile)
    assert.equal(await probeAfconvert(() => execP('afconvert', ['-hf'], { timeout: 4000 })), true)
    await assert.rejects(execP('afconvert', ['--help'], { timeout: 4000 }), 'afconvert --help exits non-zero: the old check could never pass')
  })
})

describe('the refusal', () => {
  it('is an error the engines can tell apart, naming the song and the encoder', () => {
    const e = new AacEncoderMissingError('/Music/F27/imported_14677.m4a')
    assert.equal(isAacEncoderMissing(e), true)
    assert.match(e.message, /afconvert/)
    assert.match(e.message, /imported_14677\.m4a/)
    assert.equal(isAacEncoderMissing(new Error('ffmpeg failed')), false)
    assert.equal(isAacEncoderMissing(null), false)
  })

  it('buildAacMirror refuses with no afconvert and has no ffmpeg AAC encoder at all', async () => {
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf-8')
    const body = src.slice(src.indexOf('async function buildAacMirror('), src.indexOf('async function buildMp3Mirror('))
    assert.match(body, /if \(!\(await afconvertAvailable\(\)\)\) throw new AacEncoderMissingError\(srcPath\)/)
    assert.doesNotMatch(body, /'-c:a', 'aac'/, 'no ffmpeg AAC encoder path')
    assert.doesNotMatch(body, /'aac'\s*,\s*'-b:a'/)
    const probe = src.slice(src.indexOf('async function afconvertAvailable('), src.indexOf('async function buildAacMirror('))
    assert.doesNotMatch(probe, /--help/)
    assert.match(probe, /probeAfconvert\(/)
  })

  it('both engines skip and name a refused song instead of copying the master', async () => {
    const sync = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    const act = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    assert.match(sync, /if \(isAacEncoderMissing\(err\)\) \{[\s\S]{0,300}copyErrors\+\+[\s\S]{0,200}continue/)
    assert.match(act, /if \(isAacEncoderMissing\(err\)\) \{[\s\S]{0,200}kind: 'unconvertible'/)
  })
})

describe('the cache key', () => {
  it('a v3 mirror (made by ffmpeg) is never the v4 name', () => {
    const src = '/Users/x/Music2/JakeTunesLibrary/iPod_Control/Music/F27/imported_14677.m4a'
    const v3 = createHash('sha1').update(`${src}|256|afenc-cbr-44100-2-v3`).digest('hex').slice(0, 16) + '.m4a'
    assert.equal(AAC_MIRROR_TOKEN, 'afenc-cbr-44100-2-v4')
    assert.notEqual(aacMirrorCacheName(src, 256), v3)
    assert.match(aacMirrorCacheName(src, 256), /^[0-9a-f]{16}\.m4a$/)
    assert.notEqual(aacMirrorCacheName(src, 256), aacMirrorCacheName(src, 192))
  })
  it('no file names the old token or builds its own key: one name, from the recipe module', async () => {
    for (const f of ['../index.ts', '../ipc/sync-ipc.ts', '../sync-engine/index.ts', '../ipod-activity-engine.ts']) {
      const src = await readFile(new URL(f, import.meta.url), 'utf-8')
      assert.doesNotMatch(src, /afenc-cbr-44100-2-v3|afenc-44100-2-v2/, f)
    }
    const ipc = await readFile(new URL('../ipc/sync-ipc.ts', import.meta.url), 'utf-8')
    assert.match(ipc, /aacMirrorCacheName\(localFile, convertOptions\.targetKbps\)/)
  })
})

describe('the recipe (pinned)', () => {
  it('ffmpeg decodes to 44.1 kHz / 16-bit / stereo WAV', () => {
    assert.deepEqual(pcmDecodeArgs('in.flac', 'x.wav'),
      ['-nostdin', '-y', '-i', 'in.flac', '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', 'x.wav'])
  })
  it('afconvert encodes AAC-LC, m4af, true CBR, max quality', () => {
    assert.deepEqual(afconvertAacArgs('x.wav', 'y.m4a', 256),
      ['x.wav', '-o', 'y.m4a', '-d', 'aac', '-f', 'm4af', '-b', '256000', '-q', '127', '-s', '0'])
  })
})
