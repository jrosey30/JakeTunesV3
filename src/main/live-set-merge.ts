/**
 * V5 Live Concert Mode — the merge engine.
 *
 * Takes a live album's tracks and produces ONE continuous ALAC file (the
 * "live set") plus exact per-song cue offsets, so the renderer can show
 * which song of the set is playing. The originals are never touched —
 * sources are read-only inputs; everything happens in a scratch dir.
 *
 * Pipeline (per the shipped convertToIpodSafeAlac precedent in
 * platform.ts — ffmpeg IS the established macOS decode step):
 *
 *   1. ffmpeg decodes each source → uniform PCM WAV
 *      (s16 / 44100 / forced stereo, so mixed-format albums — ALAC, AAC,
 *      MP3, even mono oddities — concatenate byte-safely)
 *   2. RIFF chunk-walk each WAV to find its `data` payload (never assume
 *      a 44-byte header — ffmpeg can emit LIST chunks), stream-append the
 *      payloads into one combined WAV, and derive each song's startMs
 *      from EXACT cumulative PCM byte counts
 *   3. convertAudio(combined, out, 'alac', tags) — the existing two-step
 *      afconvert encode + mutagen tag embed, iPod-safe bitstream and all
 *
 * The caller (the 'live-set-merge' IPC in index.ts) owns progress
 * forwarding, artwork aliasing, and handing the finished file to the
 * renderer's import queue. This module never writes library state.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, stat, statfs, open } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { convertAudio, type AudioTags } from './platform'

const execP = promisify(execFile)

// Uniform PCM the whole pipeline speaks: 16-bit stereo 44.1 kHz.
const SAMPLE_RATE = 44100
const CHANNELS = 2
const BYTES_PER_SAMPLE = 2
const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE   // 176,400
// RIFF sizes are uint32 — a combined payload past ~4 GB (≈ 6.7 h of PCM)
// can't be represented. Real concerts fit comfortably; guard anyway.
const MAX_DATA_BYTES = 0xfffff000

export interface LiveSetMergeInput {
  id: number
  title: string
  artist: string
  absPath: string
  durationMs: number
}

export interface LiveSetCue {
  trackId: number
  title: string
  artist: string
  startMs: number
  durationMs: number
}

export interface LiveSetProgress {
  stage: 'decode' | 'concat' | 'encode'
  current: number   // 1-based unit within the stage (decode: track n)
  total: number
  label: string     // human line for the button/panel UI
}

export interface LiveSetMergeResult {
  mergedPath: string
  cues: LiveSetCue[]
  totalDurationMs: number
}

/** Walk RIFF chunks to locate the `data` payload. Returns byte offset + size. */
async function findWavData(path: string): Promise<{ offset: number; size: number }> {
  const fh = await open(path, 'r')
  try {
    const head = Buffer.alloc(12)
    await fh.read(head, 0, 12, 0)
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`not a RIFF/WAVE file: ${path}`)
    }
    const fileSize = (await fh.stat()).size
    let pos = 12
    const chunkHead = Buffer.alloc(8)
    while (pos + 8 <= fileSize) {
      await fh.read(chunkHead, 0, 8, pos)
      const id = chunkHead.toString('ascii', 0, 4)
      const size = chunkHead.readUInt32LE(4)
      if (id === 'data') {
        // Streamed writers sometimes leave size as 0xFFFFFFFF; trust the
        // file length instead (ffmpeg file output writes real sizes, this
        // is belt-and-suspenders).
        const realSize = size === 0xffffffff ? fileSize - (pos + 8) : Math.min(size, fileSize - (pos + 8))
        return { offset: pos + 8, size: realSize }
      }
      // Chunks are word-aligned: odd sizes carry a pad byte.
      pos += 8 + size + (size % 2)
    }
    throw new Error(`no data chunk found in ${path}`)
  } finally {
    await fh.close()
  }
}

/** Canonical 44-byte PCM WAV header for our uniform format. */
function wavHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)                    // fmt chunk size
  b.writeUInt16LE(1, 20)                     // PCM
  b.writeUInt16LE(CHANNELS, 22)
  b.writeUInt32LE(SAMPLE_RATE, 24)
  b.writeUInt32LE(BYTES_PER_SEC, 28)         // byte rate
  b.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32)  // block align
  b.writeUInt16LE(16, 34)                    // bits per sample
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(dataBytes, 40)
  return b
}

export async function mergeLiveSet(
  tracks: LiveSetMergeInput[],
  album: { name: string; artist: string; genre?: string; year?: string | number },
  scratchDir: string,
  onProgress: (p: LiveSetProgress) => void,
): Promise<LiveSetMergeResult> {
  if (tracks.length === 0) throw new Error('no tracks to merge')

  // Fresh scratch space per run — a previous crash's leftovers get wiped
  // here rather than accumulating.
  await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(scratchDir, { recursive: true })

  // Pre-flight 1: every source must exist (identity = exact path).
  for (const t of tracks) {
    try {
      await stat(t.absPath)
    } catch {
      throw new Error(`source file missing for "${t.title}": ${t.absPath}`)
    }
  }

  // Pre-flight 2: disk headroom. PCM size is duration-derived (exact for
  // our uniform format); we hold per-track WAVs + the combined WAV at
  // once, plus the ALAC output (~55% of PCM) → require ~2.8× PCM free.
  const totalMs = tracks.reduce((s, t) => s + (t.durationMs || 0), 0)
  const pcmBytes = Math.ceil((totalMs / 1000) * BYTES_PER_SEC)
  if (pcmBytes > MAX_DATA_BYTES) {
    throw new Error('this set would exceed the 4 GB WAV limit (~6.7 hours) — split the album into two live sets')
  }
  const fsInfo = await statfs(scratchDir)
  const freeBytes = fsInfo.bavail * fsInfo.bsize
  if (freeBytes < pcmBytes * 2.8) {
    const needGB = ((pcmBytes * 2.8) / 1e9).toFixed(1)
    throw new Error(`not enough free disk space to merge (~${needGB} GB needed)`)
  }

  try {
    // ── Stage 1: decode every track to uniform PCM ──
    const segs: { path: string; input: LiveSetMergeInput }[] = []
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      onProgress({ stage: 'decode', current: i + 1, total: tracks.length, label: `Decoding ${i + 1}/${tracks.length} — ${t.title}` })
      const segPath = join(scratchDir, `seg-${String(i).padStart(3, '0')}.wav`)
      await execP('ffmpeg', [
        '-y', '-i', t.absPath,
        '-map', '0:a:0',
        '-ac', String(CHANNELS),
        '-ar', String(SAMPLE_RATE),
        '-sample_fmt', 's16',
        '-f', 'wav',
        '-loglevel', 'error',
        segPath,
      ], { timeout: 300000, maxBuffer: 64 * 1024 * 1024 })
      segs.push({ path: segPath, input: t })
    }

    // ── Stage 2: chunk-walk + stream-concat, computing exact cues ──
    onProgress({ stage: 'concat', current: 1, total: 1, label: 'Joining the set…' })
    const combinedPath = join(scratchDir, 'combined.wav')
    const cues: LiveSetCue[] = []
    let cumBytes = 0

    // Header first with a placeholder size; patched after the payloads.
    const out = createWriteStream(combinedPath)
    out.write(wavHeader(0))
    for (const seg of segs) {
      const { offset, size } = await findWavData(seg.path)
      cues.push({
        trackId: seg.input.id,
        title: seg.input.title,
        artist: seg.input.artist,
        startMs: Math.round((cumBytes / BYTES_PER_SEC) * 1000),
        durationMs: Math.round((size / BYTES_PER_SEC) * 1000),
      })
      await pipeline(
        createReadStream(seg.path, { start: offset, end: offset + size - 1 }),
        out,
        { end: false },
      )
      cumBytes += size
      if (cumBytes > MAX_DATA_BYTES) throw new Error('combined audio exceeded the 4 GB WAV limit mid-merge')
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))

    // Patch the real sizes into the header.
    const fh = await open(combinedPath, 'r+')
    try {
      const riffSize = Buffer.alloc(4)
      riffSize.writeUInt32LE(36 + cumBytes, 0)
      await fh.write(riffSize, 0, 4, 4)
      const dataSize = Buffer.alloc(4)
      dataSize.writeUInt32LE(cumBytes, 0)
      await fh.write(dataSize, 0, 4, 40)
    } finally {
      await fh.close()
    }

    // ── Stage 3: encode to ALAC + embed tags (existing pipeline) ──
    onProgress({ stage: 'encode', current: 1, total: 1, label: 'Encoding the live set…' })
    const safeName = album.name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 120)
    const mergedPath = join(scratchDir, `${safeName} — Full Set.m4a`)
    const tags: AudioTags = {
      title: `${album.name} — Full Set`,
      artist: album.artist,
      album: `${album.name} (Live Set)`,
      albumArtist: album.artist,
      genre: album.genre || 'Live',
      year: album.year,
      trackNumber: 1,
      trackCount: 1,
    }
    // Encode timeout scales with set length (a 2 h set decodes+encodes in
    // minutes; the 300s default that's right for single tracks is not
    // right here). Floor at the default; ~6× realtime headroom.
    const encodeTimeoutMs = Math.max(300000, Math.ceil(totalMs / 6))
    await convertAudio(combinedPath, mergedPath, 'alac', tags, { timeoutMs: encodeTimeoutMs })

    // Per-track WAV + combined WAV cleanup happens NOW (success path) so
    // the multi-GB intermediates never outlive the merge; the caller
    // deletes mergedPath itself after the import queue copies it in.
    for (const seg of segs) await rm(seg.path, { force: true }).catch(() => {})
    await rm(combinedPath, { force: true }).catch(() => {})

    const totalDurationMs = Math.round((cumBytes / BYTES_PER_SEC) * 1000)
    return { mergedPath, cues, totalDurationMs }
  } catch (err) {
    // Failure path: wipe the whole scratch dir — no half-merged litter,
    // and the sidecar entry is never written by the caller on error.
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
