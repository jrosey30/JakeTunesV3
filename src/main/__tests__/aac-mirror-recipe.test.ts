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
  AAC_MIRROR_TOKEN, AacConvertFailedError, AacEncoderMissingError, aacMirrorCacheName, afconvertAacArgs,
  afconvertListsAacInM4af, createAfconvertCheck, isAacConvertFailed, isAacEncoderMissing, isTransientFailure, pcmDecodeArgs, probeAfconvert,
} from '../aac-mirror-recipe.ts'
import { AAC_ENCODER_SLOW, NO_AAC_ENCODER } from '../ipod-activity-engine.ts'

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
  it('a yes is kept; two timeouts in a row are asked again after 30 s and then succeed', async () => {
    let t = 0
    let calls = 0
    const timeout = async (): Promise<never> => { throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }) }
    const answers: Array<() => Promise<{ stdout: string; stderr: string }>> = [
      timeout,
      timeout,
      async () => ({ stdout: HELP, stderr: '' }),
    ]
    const check = createAfconvertCheck(() => answers[Math.min(calls++, answers.length - 1)](), () => t)
    assert.equal(await check(), 'unknown')
    assert.equal(calls, 2, 'a timeout is asked once more at once')
    t += 10_000
    assert.equal(await check(), 'unknown', 'within 30 s the last answer stands')
    assert.equal(calls, 2)
    t += 25_000
    assert.equal(await check(), 'yes', 'asked again after 30 s')
    assert.equal(calls, 3)
    t += 10 * 60_000
    assert.equal(await check(), 'yes')
    assert.equal(calls, 3, 'a yes is never asked again')
  })
  it('one timeout under load is retried at once, never taken as missing (Brief 266)', async () => {
    let calls = 0
    const check = createAfconvertCheck(async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' })
      return { stdout: HELP, stderr: '' }
    }, () => 0)
    assert.equal(await check(), 'yes')
    assert.equal(calls, 2)
  })
  it('a no is not retried at once (only a timeout is)', async () => {
    let calls = 0
    const check = createAfconvertCheck(async () => { calls++; return { stdout: '', stderr: 'nothing' } }, () => 0)
    assert.equal(await check(), 'no')
    assert.equal(calls, 1)
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
    assert.match(sync, /if \(isAacEncoderMissing\(err\) \|\| isAacConvertFailed\(err\)\) \{[\s\S]{0,2500}copyErrors\+\+[\s\S]{0,200}continue/)
    assert.match(act, /if \(isAacEncoderMissing\(err\)\) \{[\s\S]{0,300}kind: 'no-encoder', why: slow \? AAC_ENCODER_SLOW : NO_AAC_ENCODER/)
    assert.match(sync, /notConverted\.push\(/)
    assert.match(sync, /\.\.\.\(notConverted\.length > 0 \? \{ notConverted \} : \{\}\)/)
  })

  it('in the activity sync it is its own reason, not a damaged file: the sync stops before the card is touched, no reserve fill', async () => {
    const act = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    assert.equal(NO_AAC_ENCODER, "Apple's AAC encoder isn't available on this Mac")
    const stopAt = act.indexOf("if (out.kind === 'no-encoder') {")
    const reserveAt = act.indexOf('skipUnconvertible(title, String(track.artist')
    assert.ok(stopAt > 0 && reserveAt > stopAt, 'the no-encoder stop comes before the damaged-file reserve path')
    assert.match(act.slice(stopAt, stopAt + 300), /return fail\(\{ copied: 0, target, error: `\$\{out\.why\}/)
    assert.match(act, /if \(out\.kind === 'no-encoder' \|\| out\.kind === 'convert-failed'\) lateWhy\.set\(e\.id, out\.why\)/)
  })

  it('a check that timed out is said as a timeout, never "isn\'t available" (Brief 266)', async () => {
    assert.equal(new AacEncoderMissingError('/a.m4a', 'unknown').why, 'unknown')
    assert.equal(new AacEncoderMissingError('/a.m4a').why, 'missing')
    assert.equal(AAC_ENCODER_SLOW, "Apple's AAC encoder didn't answer in time")
    const act = await readFile(new URL('../ipod-activity-engine.ts', import.meta.url), 'utf-8')
    assert.match(act, /\.why === 'unknown'\s*\n\s*return \{ ok: false, kind: 'no-encoder', why: slow \? AAC_ENCODER_SLOW : NO_AAC_ENCODER \}/)
  })
})

describe('one song whose conversion fails (Brief 266)', () => {
  it('is its own error, told apart from a missing encoder', () => {
    const e = new AacConvertFailedError('/Music/F01/Breeze.flac', new Error('ffmpeg exited 1'))
    assert.equal(isAacConvertFailed(e), true)
    assert.equal(isAacEncoderMissing(e), false)
    assert.equal(isAacConvertFailed(new AacEncoderMissingError('/a.m4a')), false)
    assert.match(e.message, /Breeze\.flac/)
    assert.match(e.message, /ffmpeg exited 1/)
  })
  it('buildAacMirror throws it from the transcode, never a null that means "copy the master"', async () => {
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf-8')
    const body = src.slice(src.indexOf('async function buildAacMirror('), src.indexOf('async function buildMp3Mirror('))
    const transcode = body.slice(body.indexOf("await bgExec('ffmpeg', pcmDecodeArgs("))
    assert.match(transcode, /\} catch \(err\) \{[\s\S]{0,400}throw new AacConvertFailedError\(srcPath, err\)/)
    assert.doesNotMatch(transcode.slice(0, transcode.indexOf('} finally {')), /return null/)
  })
  it('the full-library sync leaves it off and names it, like a refused one', async () => {
    const sync = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    assert.match(sync, /if \(isAacEncoderMissing\(err\) \|\| isAacConvertFailed\(err\)\) \{[\s\S]{0,2500}notConverted\.push\([\s\S]{0,200}copyErrors\+\+[\s\S]{0,200}continue/)
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

describe('a failure that was the Mac\'s, not the file\'s (review of #519)', () => {
  it('a killed or timed-out encoder, a full disk: transient', () => {
    assert.equal(isTransientFailure(Object.assign(new Error('Command failed: ffmpeg'), { killed: true, signal: 'SIGTERM' })), true)
    assert.equal(isTransientFailure(Object.assign(new Error('write'), { code: 'ENOSPC' })), true)
    assert.equal(isTransientFailure(new Error('operation timed out')), true)
    assert.equal(new AacConvertFailedError('/a.flac', Object.assign(new Error('x'), { killed: true })).transient, true)
  })
  it('a decoder that says the file is bad: not transient', () => {
    assert.equal(isTransientFailure(Object.assign(new Error('Invalid data found when processing input'), { code: 1 })), false)
    assert.equal(new AacConvertFailedError('/a.flac', new Error('afconvert exited 1')).transient, false)
  })
})
