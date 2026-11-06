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
 *      a 44-byte header — ffmpeg can emit LIST chunks), clamp it to the
 *      song's real length (AAC decodes its encoder padding as audio; see
 *      live-set-source-length.ts), stream-append the payloads into one
 *      combined WAV, and derive each song's startMs from EXACT cumulative
 *      PCM byte counts
 *   3. convertAudio(combined, out, 'alac', tags) — the existing two-step
 *      afconvert encode + mutagen tag embed, iPod-safe bitstream and all.
 *      Then the zeros mutagen leaves in the moov come out, so a show's map
 *      is only its map (mp4-moov-padding.ts).
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
import { convertAudio, type AudioTags } from './platform.ts'
import { planSeam, mixSeam, mixEdges, bufferRmsDb, bytesForMs, type SeamPlan } from './live-set-seams.ts'
import { readDeclaredLength, realSegmentBytes, type DeclaredLength } from './live-set-source-length.ts'
import { dropMoovPadding } from './mp4-moov-padding.ts'

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
    const segs: { path: string; input: LiveSetMergeInput; declared: DeclaredLength | null }[] = []
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
      // Where the file says the song ends. A file that can't answer keeps its
      // decode as it is: a hole is better than cutting music on a guess.
      const declared = await readDeclaredLength(t.absPath).catch((err: unknown) => {
        console.warn(`[live-set] no declared length for "${t.title}":`, err instanceof Error ? err.message : err)
        return null
      })
      segs.push({ path: segPath, input: t, declared })
    }

    // ── Stage 2: chunk-walk + stream-concat, computing exact cues ──
    onProgress({ stage: 'concat', current: 1, total: 1, label: 'Joining the set…' })
    const combinedPath = join(scratchDir, 'combined.wav')
    const cues: LiveSetCue[] = []
    let cumBytes = 0

    // Header first with a placeholder size; patched after the payloads.
    // Seams (2026-09-02): each seam is measured — a track that fades the
    // room out is overlapped with the next track's fade-in for the length
    // of the fade (capped at 4 s), so the crowd stays continuous; a
    // soundboard cut with no fades stays a gapless butt splice, and so does
    // a cut where both sides are still in the room (2026-11-06); a join that
    // would leave a hole or a click gets a few ms, no more. See
    // live-set-seams.ts. `pendingTail` is the previous segment's last 8 s,
    // held back until the next head arrives to be summed with it.
    const FRAME = CHANNELS * BYTES_PER_SAMPLE
    const PROBE_BYTES = bytesForMs(8000, BYTES_PER_SEC, FRAME)
    const readRange = async (path: string, start: number, len: number): Promise<Buffer> => {
      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, start)
        return bytesRead === len ? buf : buf.subarray(0, bytesRead)
      } finally { await fh.close() }
    }
    const out = createWriteStream(combinedPath)
    out.write(wavHeader(0))
    const writeBuf = (b: Buffer): Promise<void> => new Promise((resolve, reject) => {
      out.write(b, (err) => (err ? reject(err) : resolve()))
    })
    let pendingTail: Buffer | null = null
    let seamsCrossfaded = 0
    let joinsClosed = 0
    let paddingBytesCut = 0
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si]
      const { offset, size: decodedSize } = await findWavData(seg.path)
      // Only the song: the encoder's tail-out never reaches the show.
      const size = realSegmentBytes(decodedSize, seg.declared, SAMPLE_RATE, FRAME)
      paddingBytesCut += decodedSize - size
      if (seg.declared && size === decodedSize && seg.declared.frames * FRAME < decodedSize) {
        console.warn(`[live-set] "${seg.input.title}" declares ${seg.declared.frames} frames (${seg.declared.source}) but decodes to ${decodedSize / FRAME}: too far apart to be padding, keeping the decode`)
      }
      // What this seam needs. Nothing to measure when either song is too short
      // to have held 8 s back.
      let seam: SeamPlan = { mix: 'none', overlapBytes: 0, cueBytes: 0 }
      if (pendingTail && size > PROBE_BYTES * 2) {
        const head = await readRange(seg.path, offset, PROBE_BYTES)
        seam = planSeam(pendingTail, head, BYTES_PER_SEC, FRAME)
        if (seam.unclosed) console.warn(`[live-set] the join into "${seg.input.title}" keeps a fault nothing here could close: ${seam.unclosed.holeMs.toFixed(1)} ms hole, step ${seam.unclosed.jumpOverSlope.toFixed(2)} x the local slope`)
      }
      const overlap = seam.overlapBytes
      // The cue sits where the next song takes over, not where the overlap
      // begins — otherwise the setlist flips to the next song while the old
      // tail is still audible (Jake: "it jumped to Jet before the end of
      // Drive My Car"). The held-back tail hasn't been counted in cumBytes
      // yet, and the next song starts after it. Durations become spans
      // cue→cue below.
      const cueStart = cumBytes + (pendingTail?.length ?? 0) - overlap + seam.cueBytes
      cues.push({
        trackId: seg.input.id,
        title: seg.input.title,
        artist: seg.input.artist,
        startMs: Math.round((cueStart / BYTES_PER_SEC) * 1000),
        durationMs: Math.round((size / BYTES_PER_SEC) * 1000),
      })
      if (pendingTail) {
        if (overlap > 0) {
          const keep = pendingTail.subarray(0, pendingTail.length - overlap)
          await writeBuf(keep)
          const head = await readRange(seg.path, offset, overlap)
          const tailEnd = pendingTail.subarray(pendingTail.length - overlap)
          if (seam.mix === 'fade') {
            // The previous tail's un-overlapped part, then the mixed seam:
            // tapered edges + make-up gain toward the quieter body level of
            // the two neighbours (measured 2 s either side of the overlap).
            const afterBytes = bytesForMs(2000, BYTES_PER_SEC, FRAME)
            const after = await readRange(seg.path, offset + overlap, afterBytes)
            const refBefore = bufferRmsDb(keep.subarray(Math.max(0, keep.length - afterBytes)))
            const refAfter = bufferRmsDb(after)
            const refDb = Math.min(refBefore, refAfter)
            await writeBuf(mixSeam(tailEnd, head, BYTES_PER_SEC, FRAME, refDb))
            seamsCrossfaded++
          } else {
            await writeBuf(mixEdges(tailEnd, head, FRAME, seam.mix === 'ramp'))
            joinsClosed++
          }
          cumBytes += pendingTail.length
        } else {
          await writeBuf(pendingTail)
          cumBytes += pendingTail.length
        }
        pendingTail = null
      }
      // Body: from after the overlapped head to before the held-back tail.
      const isLast = si === segs.length - 1
      const holdBack = isLast || size <= PROBE_BYTES * 2 ? 0 : PROBE_BYTES
      const bodyStart = offset + overlap
      const bodyEnd = offset + size - holdBack
      if (bodyEnd > bodyStart) {
        await pipeline(
          createReadStream(seg.path, { start: bodyStart, end: bodyEnd - 1 }),
          out,
          { end: false },
        )
        cumBytes += bodyEnd - bodyStart
      }
      if (holdBack > 0) pendingTail = await readRange(seg.path, bodyEnd, holdBack)
      if (cumBytes > MAX_DATA_BYTES) throw new Error('combined audio exceeded the 4 GB WAV limit mid-merge')
    }
    if (pendingTail) { await writeBuf(pendingTail); cumBytes += pendingTail.length; pendingTail = null }
    // Durations as SPANS (cue → next cue; last → end of set), so a song's
    // progress bar ends exactly where the next song's cue begins.
    const totalMsNow = Math.round((cumBytes / BYTES_PER_SEC) * 1000)
    for (let i = 0; i < cues.length; i++) {
      const next = i + 1 < cues.length ? cues[i + 1].startMs : totalMsNow
      cues[i].durationMs = Math.max(0, next - cues[i].startMs)
    }
    console.log(`[live-set] ${seamsCrossfaded}/${Math.max(0, segs.length - 1)} seams crossfaded (album fades measured), ${joinsClosed} joins closed (a hole or a click), ${paddingBytesCut / FRAME} frames of encoder padding cut`)
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

    // mutagen leaves 0.1% of the file as zeros in the moov: 62-71% of a show's
    // map, and the phone downloads the map before the first note. Tags stay in
    // the file and a later re-tag just pads again. Failing here keeps the
    // padded file, which plays exactly the same.
    await dropMoovPadding(mergedPath).catch((err: unknown) => {
      console.warn('[live-set] moov padding kept:', err instanceof Error ? err.message : err)
    })

    const totalDurationMs = Math.round((cumBytes / BYTES_PER_SEC) * 1000)
    return { mergedPath, cues, totalDurationMs }
  } catch (err) {
    // Failure path: wipe the whole scratch dir — no half-merged litter,
    // and the sidecar entry is never written by the caller on error.
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
