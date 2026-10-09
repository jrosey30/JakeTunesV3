/**
 * Library import keeps lossless sources lossless.
 *
 * 2026-05-22 (8f6bd26) forced FLAC and WAV to 256 kbps AAC and called it
 * Jake's policy. That was an abandoned iPod AAC idea, wrongly applied to
 * library import. These tests lock the reversal: default 'alac', the
 * setting is honored, MP3/AAC are copied, and ALAC matches the source
 * bit depth and sample rate bit-for-bit.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AFCONVERT_LIBRARY_ALAC_DATA_FORMAT,
  DEFAULT_IMPORT_FORMAT,
  alacSampleFmt,
  afconvertLibraryAlacArgs,
  convertAudio,
  ffmpegPreserveAlacArgs,
  nativePcmCodec,
  resolveImportFormat,
} from '../platform.ts'
import {
  clearSessionImportedFingerprints,
  codecForCopiedSource,
  fingerprintTrack,
  importDownloadedFiles,
  importOneFile,
  initImportPipeline,
  loadDupeFingerprintsFromLibrary,
  shouldConvertOnImport,
  sourceIsKeptLossy,
  type ImportPipelineDeps,
} from '../import-pipeline.ts'

const exec = promisify(execFile)

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function ffprobeAudio(path: string): Promise<{ codec: string; rate: number; bits: number; video: number; title: string; artist: string }> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_fmt,sample_rate,bits_per_raw_sample',
    '-show_entries', 'format_tags=title,artist', '-of', 'json', path,
  ], { maxBuffer: 1024 * 1024 })
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; sample_fmt?: string; sample_rate?: string; bits_per_raw_sample?: string }>
    format?: { tags?: { title?: string; artist?: string } }
  }
  const audio = (parsed.streams || []).find((s) => s.codec_type === 'audio')
  const video = (parsed.streams || []).filter((s) => s.codec_type === 'video').length
  const sampleFmt = audio?.sample_fmt || ''
  let bits = Number(audio?.bits_per_raw_sample) || 0
  // WAV/PCM often leaves bits_per_raw_sample unset and reports it via sample_fmt.
  if (!bits && sampleFmt.startsWith('s16')) bits = 16
  else if (!bits && (sampleFmt.startsWith('s32') || sampleFmt.startsWith('s24'))) bits = 24
  return {
    codec: audio?.codec_name || '',
    rate: Number(audio?.sample_rate) || 0,
    bits,
    video,
    title: parsed.format?.tags?.title || '',
    artist: parsed.format?.tags?.artist || '',
  }
}

async function decodePcm(path: string, sampleFmt: 's16le' | 's24le'): Promise<Buffer> {
  const out = `${path}.${sampleFmt}.pcm`
  await exec('ffmpeg', ['-y', '-v', 'error', '-i', path, '-f', sampleFmt, out], { maxBuffer: 1024 * 1024 })
  return readFile(out)
}

async function makeCover(dir: string): Promise<string> {
  const png = join(dir, 'cover.png')
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=1', '-frames:v', '1', png])
  return png
}

async function makeFlac(dir: string, name: string, opts: { bits: 16 | 24; rate: number; title: string; artist: string; album: string; duration?: number }): Promise<string> {
  const wav = join(dir, `${name}.wav`)
  const flac = join(dir, `${name}.flac`)
  const pcm = opts.bits === 16 ? 'pcm_s16le' : 'pcm_s24le'
  const duration = opts.duration ?? 0.5
  await exec('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${opts.rate}:duration=${duration}`,
    '-ac', '2', '-c:a', pcm, wav,
  ])
  const png = await makeCover(dir)
  await exec('ffmpeg', [
    '-y', '-v', 'error', '-i', wav, '-i', png,
    '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'mjpeg',
    '-disposition:v:0', 'attached_pic',
    '-metadata', `title=${opts.title}`,
    '-metadata', `artist=${opts.artist}`,
    '-metadata', `album=${opts.album}`,
    flac,
  ])
  return flac
}

function pipeline(dir: string, over: Partial<ImportPipelineDeps> = {}): { musicDir: string; lib: string } {
  const musicDir = join(dir, 'iPod_Control', 'Music')
  const lib = join(dir, 'library.json')
  initImportPipeline({
    musicDir: () => musicDir,
    libraryPath: () => lib,
    defaultImportFormat: async () => 'alac',
    computeAudioFingerprint: async () => null,
    setCodecForPath: () => {},
    extractEmbeddedArtwork: async (pictures) => {
      const list = pictures as unknown[] | undefined
      if (!Array.isArray(list) || list.length === 0) return null
      return { key: 'probe|masters', hash: 'cover' }
    },
    readStreamSource: async () => null,
    enqueueStreamConvert: () => {},
    enqueueAnalysis: () => {},
    prewarmAlacCache: async () => {},
    trashItem: async () => {},
    emitToRenderer: () => {},
    ...over,
  })
  return { musicDir, lib }
}

describe('the May 22 FLAC→AAC override is gone', () => {
  test('the default is ALAC, and the setting is what the file becomes', () => {
    assert.equal(DEFAULT_IMPORT_FORMAT, 'alac')
    // 8f6bd26 returned aac-256 for this pair. That was the bug.
    assert.equal(resolveImportFormat('/album/01.flac', 'alac'), 'alac')
    assert.equal(resolveImportFormat('/album/01.wav', 'alac'), 'alac')
    assert.equal(resolveImportFormat('/album/01.aiff', 'alac'), 'alac')
    assert.equal(resolveImportFormat('/album/01.flac', 'wav'), 'wav')
    assert.equal(resolveImportFormat('/album/01.flac', 'aac-256'), 'aac-256')
  })

  test('encoder args keep bit depth and do not resample', () => {
    assert.equal(alacSampleFmt(16), 's16p')
    assert.equal(alacSampleFmt(24), 's32p')
    assert.equal(nativePcmCodec(16), 'pcm_s16le')
    assert.equal(nativePcmCodec(24), 'pcm_s24le')
    const hi = ffmpegPreserveAlacArgs('in.flac', 'out.m4a', 24)
    assert.deepEqual(hi, [
      '-y', '-i', 'in.flac', '-map', '0:a:0', '-map', '0:v?', '-c:v', 'copy', '-c:a', 'alac',
      '-sample_fmt', 's32p', 'out.m4a',
    ])
    assert.equal(hi.includes('-ar'), false)
    assert.equal(hi.includes('44100'), false)
    assert.equal(ffmpegPreserveAlacArgs('in.flac', 'out.m4a', 16).includes('s16p'), true)
    // No probed depth: omit -sample_fmt rather than guess 16-bit.
    assert.equal(ffmpegPreserveAlacArgs('in.flac', 'out.m4a', null).includes('-sample_fmt'), false)
    assert.equal(AFCONVERT_LIBRARY_ALAC_DATA_FORMAT, 'alac')
    assert.deepEqual(afconvertLibraryAlacArgs('native.wav', 'out.m4a'), ['-f', 'm4af', '-d', 'alac', 'native.wav', 'out.m4a'])
  })

  test('MP3 and AAC are not re-encoded; lossless sources that are already the target are copied', () => {
    assert.equal(shouldConvertOnImport('.flac', 'flac', 'alac'), true)
    assert.equal(shouldConvertOnImport('.wav', 'pcm_s24le', 'alac'), true)
    assert.equal(shouldConvertOnImport('.aiff', 'pcm_s16be', 'alac'), true)
    assert.equal(shouldConvertOnImport('.mp3', 'mp3', 'alac'), false)
    assert.equal(shouldConvertOnImport('.m4a', 'aac', 'alac'), false)
    assert.equal(shouldConvertOnImport('.m4a', 'alac', 'alac'), false)
    assert.equal(shouldConvertOnImport('.wav', 'pcm_s16le', 'wav'), false)
    assert.equal(sourceIsKeptLossy('.mp3', 'mp3'), true)
    assert.equal(codecForCopiedSource('.mp3', 'mp3'), 'mp3')
    assert.equal(codecForCopiedSource('.m4a', 'aac'), 'aac')
    assert.equal(codecForCopiedSource('.m4a', 'alac'), 'alac')
  })
})

describe('import writes ALAC that decodes bit-exact', () => {
  test('16-bit/44.1 and 24-bit/96 FLAC become matching ALAC, tags and cover included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-alac-'))
    await mkdir(join(dir, 'iPod_Control', 'Music'), { recursive: true })
    await writeFile(join(dir, 'library.json'), JSON.stringify({ tracks: [] }))
    clearSessionImportedFingerprints()
    let sawCover = false
    pipeline(dir, {
      extractEmbeddedArtwork: async (pictures) => {
        const list = pictures as unknown[] | undefined
        sawCover = Array.isArray(list) && list.length > 0
        return sawCover ? { key: 'probe|masters', hash: 'cover' } : null
      },
    })

    const flac16 = await makeFlac(dir, 'cd', { bits: 16, rate: 44100, title: 'Sixteen', artist: 'Probe', album: 'Masters' })
    const flac24 = await makeFlac(dir, 'hi', { bits: 24, rate: 96000, title: 'Twenty Four', artist: 'Probe', album: 'Masters' })
    const empty = new Set<string>()

    const r16 = await importOneFile(flac16, 1, resolveImportFormat(flac16, 'alac'), empty)
    const r24 = await importOneFile(flac24, 2, resolveImportFormat(flac24, 'alac'), empty)
    assert.equal(r16.ok, true)
    assert.equal(r24.ok, true)
    assert.equal(r16.track?.codec, 'alac')
    assert.equal(r24.track?.codec, 'alac')
    assert.equal(String(r16.track?.path).endsWith('.m4a'), true)
    assert.equal(String(r24.track?.path).endsWith('.m4a'), true)
    assert.equal(r16.track?.title, 'Sixteen')
    assert.equal(sawCover, true, 'embedded cover still reaches the artwork extractor')
    assert.equal(r16.artwork?.hash, 'cover')

    const music = join(dir, 'iPod_Control', 'Music')
    const out16 = join(music, 'F01', 'imported_1.m4a')
    const out24 = join(music, 'F02', 'imported_2.m4a')
    const p16 = await ffprobeAudio(out16)
    const p24 = await ffprobeAudio(out24)
    assert.equal(p16.codec, 'alac')
    assert.equal(p16.bits, 16)
    assert.equal(p16.rate, 44100)
    assert.equal(p16.title, 'Sixteen')
    assert.equal(p16.artist, 'Probe')
    assert.ok(p16.video >= 1, 'cover art is still in the ALAC file')
    assert.equal(p24.codec, 'alac')
    assert.equal(p24.bits, 24)
    assert.equal(p24.rate, 96000)
    assert.equal(p24.title, 'Twenty Four')

    const src16 = await decodePcm(flac16, 's16le')
    const alac16 = await decodePcm(out16, 's16le')
    assert.deepEqual(alac16, src16)
    const src24 = await decodePcm(flac24, 's24le')
    const alac24 = await decodePcm(out24, 's24le')
    assert.deepEqual(alac24, src24)
  })

  test('MP3 and AAC imports are byte-identical copies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-lossy-'))
    await mkdir(join(dir, 'iPod_Control', 'Music'), { recursive: true })
    await writeFile(join(dir, 'library.json'), JSON.stringify({ tracks: [] }))
    clearSessionImportedFingerprints()
    pipeline(dir)
    const mp3 = join(dir, 'song.mp3')
    const aac = join(dir, 'song.m4a')
    await exec('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.4',
      '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k',
      '-metadata', 'title=Lossy', '-metadata', 'artist=Probe', mp3,
    ])
    await exec('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.4',
      '-ac', '2', '-c:a', 'aac', '-b:a', '128k',
      '-metadata', 'title=Also Lossy', '-metadata', 'artist=Probe', aac,
    ])
    const mp3Bytes = await readFile(mp3)
    const aacBytes = await readFile(aac)
    const empty = new Set<string>()
    const rm = await importOneFile(mp3, 3, 'alac', empty)
    const ra = await importOneFile(aac, 4, 'alac', empty)
    assert.equal(rm.track?.codec, 'mp3')
    assert.equal(ra.track?.codec, 'aac')
    assert.equal(String(rm.track?.path).endsWith('.mp3'), true)
    assert.equal(String(ra.track?.path).endsWith('.m4a'), true)
    const music = join(dir, 'iPod_Control', 'Music')
    assert.equal(sha256(await readFile(join(music, 'F03', 'imported_3.mp3'))), sha256(mp3Bytes))
    assert.equal(sha256(await readFile(join(music, 'F04', 'imported_4.m4a'))), sha256(aacBytes))
  })

  test('defaultImportFormat is the format a download batch actually writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-batch-'))
    await mkdir(join(dir, 'iPod_Control', 'Music'), { recursive: true })
    await writeFile(join(dir, 'library.json'), JSON.stringify({ tracks: [] }))
    clearSessionImportedFingerprints()
    const flac = await makeFlac(dir, 'zip', { bits: 16, rate: 44100, title: 'From Zip', artist: 'Probe', album: 'Masters' })
    pipeline(dir, { defaultImportFormat: async () => 'wav' })
    const batch = await importDownloadedFiles([flac], 'streamrip')
    assert.equal(batch.tracks.length, 1)
    assert.equal(batch.tracks[0].codec, 'wav')
    assert.equal(String(batch.tracks[0].path).endsWith('.wav'), true)
    const wav = join(dir, 'iPod_Control', 'Music', 'F01', 'imported_1.wav')
    const probed = await ffprobeAudio(wav)
    assert.equal(probed.rate, 44100)
    assert.equal(probed.bits, 16)
    const src = await decodePcm(flac, 's16le')
    const out = await decodePcm(wav, 's16le')
    assert.deepEqual(out, src)
  })

  test('a lossless re-import of a lossy library row is the same text dupe as before, and the lossy file stays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-dupe-'))
    const musicDir = join(dir, 'iPod_Control', 'Music')
    await mkdir(join(musicDir, 'F07'), { recursive: true })
    const existing = join(musicDir, 'F07', 'imported_7.mp3')
    await writeFile(existing, 'lossy-bytes')
    const lib = join(dir, 'library.json')
    await writeFile(lib, JSON.stringify({ tracks: [
      { id: 7, title: 'Shared Song', artist: 'Probe', duration: 1000, path: ':iPod_Control:Music:F07:imported_7.mp3' },
    ] }))
    clearSessionImportedFingerprints()
    pipeline(dir)
    const set = await loadDupeFingerprintsFromLibrary()
    const key = fingerprintTrack({ title: 'Shared Song', artist: 'Probe', duration: 1000 })
    assert.ok(key && set.has(key), 'the lossy row still claims the text signature — codec is not part of the key')

    const flac = await makeFlac(dir, 'upgrade', {
      bits: 24, rate: 44100, title: 'Shared Song', artist: 'Probe', album: 'Masters', duration: 1,
    })
    const r = await importOneFile(flac, 8, 'alac', set)
    assert.equal(r.dupe?.matchedTitle, 'Shared Song')
    assert.equal((await readFile(existing)).toString(), 'lossy-bytes')
    await assert.rejects(() => stat(join(musicDir, 'F08', 'imported_8.m4a')))
  })

  test('the existing Mini mirror still asks for 16-bit 44.1 ALAC; library import does not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-ipod-'))
    const flac = await makeFlac(dir, 'hires', {
      bits: 24, rate: 96000, title: 'Mini', artist: 'Probe', album: 'Masters',
    })
    const mirrored = join(dir, 'mini.m4a')
    await convertAudio(flac, mirrored, 'alac', undefined, { ipodSafe: true })
    const probed = await ffprobeAudio(mirrored)
    assert.equal(probed.codec, 'alac')
    assert.equal(probed.bits, 16)
    assert.equal(probed.rate, 44100)
    const library = join(dir, 'library.m4a')
    await convertAudio(flac, library, 'alac')
    const kept = await ffprobeAudio(library)
    assert.equal(kept.bits, 24)
    assert.equal(kept.rate, 96000)
  })
})
