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
  afconvertListsAacInM4af, createAfconvertCheck, isAacEncoderMissing, pcmDecodeArgs, probeAfconvert,
} from '../aac-mirror-recipe.ts'
import { NO_AAC_ENCODER } from '../ipod-activity-engine.ts'

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
  it('reads the listing, not the exit code: `afconvert -hf` exits 2 and still counts', async () => {
    const run = async () => { throw Object.assign(new Error('Command failed: afconvert -hf'), { code: 2, stdout: '', stderr: HELP }) }
    assert.equal(await probeAfconvert(run), 'yes')
  })
  it('a listing on stdout counts too', async () => {
    assert.equal(await probeAfconvert(async () => ({ stdout: HELP, stderr: '' })), 'yes')
  })
  it('no program (ENOENT) is no', async () => {
    const run = async () => { throw Object.assign(new Error('spawn afconvert ENOENT'), { code: 'ENOENT' }) }
    assert.equal(await probeAfconvert(run), 'no')
  })
  it('a check killed by its timeout is unknown, never no', async () => {
    const run = async () => { throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }) }
    assert.equal(await probeAfconvert(run), 'unknown')
  })
  it('an afconvert that lists no AAC in m4af is no', () => {
    assert.equal(afconvertListsAacInM4af(`    'm4af' = Apple MPEG-4 Audio (.m4a)\n               data_formats: 'alac'\n    'WAVE' = WAVE\n               data_formats: 'aac '\n`), false)
    assert.equal(afconvertListsAacInM4af(''), false)
    assert.equal(afconvertListsAacInM4af(HELP), true)
  })
  it('a yes is kept; a timeout is asked again after 30 s and then succeeds', async () => {
    let t = 0
    let calls = 0
    const answers: Array<() => Promise<{ stdout: string; stderr: string }>> = [
      async () => { throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }) },
      async () => ({ stdout: HELP, stderr: '' }),
    ]
    const check = createAfconvertCheck(() => answers[Math.min(calls++, answers.length - 1)](), () => t)
    assert.equal(await check(), 'unknown')
    t += 10_000
    assert.equal(await check(), 'unknown', 'within 30 s the last answer stands')
    assert.equal(calls, 1)
    t += 25_000
    assert.equal(await check(), 'yes', 'asked again after 30 s')
    assert.equal(calls, 2)
    t += 10 * 60_000
    assert.equal(await check(), 'yes')
    assert.equal(calls, 2, 'a yes is never asked again')
  })
  it('a no is asked again too (afconvert can come back)', async () => {
    let t = 0
    let calls = 0
    const check = createAfconvertCheck(async () => { calls++; return calls === 1 ? { stdout: '', stderr: 'nothing' } : { stdout: HELP, stderr: '' } }, () => t)
    assert.equal(await check(), 'no')
    t += 31_000
    assert.equal(await check(), 'yes')
  })
  it('callers at the same moment share one check', async () => {
    let calls = 0
    const check = createAfconvertCheck(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { stdout: HELP, stderr: '' } })
    assert.deepEqual(await Promise.all([check(), check(), check()]), ['yes', 'yes', 'yes'])
    assert.equal(calls, 1)
  })
  it('on this Mac the real afconvert is found (the old --help check said it was missing)', { skip: process.platform !== 'darwin' }, async () => {
    const execP = promisify(execFile)
    assert.equal(await probeAfconvert(() => execP('afconvert', ['-hf'], { timeout: 8000 })), 'yes')
    await assert.rejects(execP('afconvert', ['--help'], { timeout: 8000 }), 'afconvert --help exits non-zero: the old check could never pass')
  })
})

describe('the refusal', () => {
  it('is an error the engines can tell apart, naming the song and the encoder', () => {
    const e = new AacEncoderMissingError('/Music/F27/imported_14677.m4a')
    assert.equal(isAacEncoderMissing(e), true)
    assert.match(e.message, /afconvert/)
    assert.match(e.message, /imported_14677\.m4a/)
    const slow = new AacEncoderMissingError('/Music/a.m4a', 'unknown')
    assert.equal(isAacEncoderMissing(slow), true)
    assert.match(slow.message, /didn't answer in time/)
    assert.equal(isAacEncoderMissing(new Error('ffmpeg failed')), false)
    assert.equal(isAacEncoderMissing(null), false)
  })

  it('buildAacMirror refuses with no afconvert and has no ffmpeg AAC encoder at all', async () => {
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf-8')
    const body = src.slice(src.indexOf('async function buildAacMirror('), src.indexOf('async function buildMp3Mirror('))
    assert.match(body, /const encoder = await afconvertCheck\(\)\s*\n\s*if \(encoder !== 'yes'\) \{[\s\S]{0,300}throw new AacEncoderMissingError\(srcPath/)
    assert.doesNotMatch(body, /'-c:a', 'aac'/, 'no ffmpeg AAC encoder path')
    assert.doesNotMatch(body, /'aac'\s*,\s*'-b:a'/)
    const probe = src.slice(src.indexOf('const afconvertCheck = createAfconvertCheck('), src.indexOf('async function buildAacMirror('))
    assert.ok(probe.length > 0)
    assert.doesNotMatch(probe, /'--help'/)
    assert.match(probe, /'-hf'/)
  })

  it('both engines skip and name a refused song instead of copying the master', async () => {
    const sync = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    const act = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    assert.match(sync, /if \(isAacEncoderMissing\(err\)\) \{[\s\S]{0,300}copyErrors\+\+[\s\S]{0,200}continue/)
    assert.match(act, /if \(isAacEncoderMissing\(err\)\) \{[\s\S]{0,200}kind: 'no-encoder', why: NO_AAC_ENCODER/)
    assert.match(sync, /notConverted\.push\(/)
    assert.match(sync, /\.\.\.\(notConverted\.length > 0 \? \{ notConverted \} : \{\}\)/)
  })

  it('in the activity sync it is its own reason, not a damaged file: the sync stops before the card is touched, no reserve fill', async () => {
    const act = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    assert.equal(NO_AAC_ENCODER, "Apple's AAC encoder isn't available on this Mac")
    const stopAt = act.indexOf("if (out.kind === 'no-encoder') {")
    const reserveAt = act.indexOf('skipUnconvertible(title, String(track.artist')
    assert.ok(stopAt > 0 && reserveAt > stopAt, 'the no-encoder stop comes before the damaged-file reserve path')
    assert.match(act.slice(stopAt, stopAt + 300), /return fail\(\{ copied: 0, target, error: `\$\{NO_AAC_ENCODER\}/)
    assert.match(act, /if \(out\.kind === 'no-encoder'\) lateWhy\.set\(e\.id, NO_AAC_ENCODER\)/)
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
