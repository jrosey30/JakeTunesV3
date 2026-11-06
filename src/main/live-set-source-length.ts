/**
 * live-set-source-length — how many decoded frames of a source are the song.
 *
 * AAC encoders add a silent lead-in (priming) and a silent tail-out (padding).
 * ffmpeg drops the lead-in and decodes the tail-out as audio. Inside a merged
 * concert that tail-out plays in the middle of the show: the blip audit of
 * 2026-11-05 measured holes of up to 22.9 ms at 90 song joins in 8 shows.
 *
 * The file says where the song ends, and this module reads that:
 *   - iTunes AAC: the iTunSMPB tag, 4th field, hex. On all 154 iTunes AAC
 *     sources the decode was exactly that count plus the declared padding.
 *   - ffmpeg-made AAC: the sample table total minus the edit list's start
 *     (the last packet's table entry is the real remainder, while the decoder
 *     still emits a whole 1024-frame packet).
 *   - MP3 and ALAC: nothing to do. ffmpeg honours the LAME tag (16 of 16 files
 *     exact), and ALAC's last packet is its true length.
 *
 * The merge clamps BYTES of the decoded WAV to this count. It does not use
 * ffmpeg's atrim: `-af atrim` differed by 1 LSB on 3 frames at the end in the
 * audit's test, and the merge's promise is that a song's samples are the
 * decode's samples.
 *
 * ⚠️ This is a READ. It never modifies audio files.
 */
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { promisify } from 'node:util'
import { parseSMPB } from './gapless-trim.ts'

const execP = promisify(execFile)

export interface DeclaredLength {
  /** The song's frames, at the source's own sample rate. */
  frames: number
  sampleRate: number
  source: 'iTunSMPB' | 'sample-table'
}

/** Priming (2112) plus one packet (1024) is the most a real tail-out can be.
 *  A declared length further from the decode than this is not padding: it is
 *  a stale tag or a misread, and cutting on it would cut music. */
export const MAX_PADDING_FRAMES = 4096

/**
 * Bytes of the decoded segment that are the song. The clamp only ever
 * shortens, and only by what could be padding; every other answer keeps the
 * decode as it is. `decodedBytes` is at `targetRate`, so a declared count at
 * another rate is scaled first (the merge resamples everything to one rate).
 */
export function realSegmentBytes(
  decodedBytes: number,
  declared: DeclaredLength | null,
  targetRate: number,
  frameBytes: number,
): number {
  if (!declared || !(declared.frames > 0)) return decodedBytes
  const rate = declared.sampleRate > 0 ? declared.sampleRate : targetRate
  const frames = rate === targetRate ? declared.frames : Math.round((declared.frames * targetRate) / rate)
  const want = frames * frameBytes
  const trim = decodedBytes - want
  if (trim <= 0 || trim > MAX_PADDING_FRAMES * frameBytes) return decodedBytes
  return want
}

interface Mp4AudioTable {
  /** Sum of the stts table, in media timescale units. */
  sampleCount: number
  /** First edit's media_time (0 when the track has no edit list). */
  editStart: number
  timescale: number
}

interface AtomSpan { name: string; start: number; end: number }

function childAtoms(b: Buffer, start: number, end: number): AtomSpan[] {
  const out: AtomSpan[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = b.readUInt32BE(pos)
    let header = 8
    if (size === 1) {
      if (pos + 16 > end) break
      size = Number(b.readBigUInt64BE(pos + 8))
      header = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < header || pos + size > end) break
    out.push({ name: b.toString('latin1', pos + 4, pos + 8), start: pos + header, end: pos + size })
    pos += size
  }
  return out
}

function child(b: Buffer, parent: AtomSpan, name: string): AtomSpan | undefined {
  return childAtoms(b, parent.start, parent.end).find((a) => a.name === name)
}

/** Sample table facts of the first sound track in a moov payload. Pure. */
export function audioTableFromMoov(moov: Buffer): Mp4AudioTable | null {
  for (const trak of childAtoms(moov, 0, moov.length)) {
    if (trak.name !== 'trak') continue
    const mdia = child(moov, trak, 'mdia')
    if (!mdia) continue
    const hdlr = child(moov, mdia, 'hdlr')
    if (!hdlr || moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'soun') continue
    const mdhd = child(moov, mdia, 'mdhd')
    const minf = child(moov, mdia, 'minf')
    const stbl = minf && child(moov, minf, 'stbl')
    const stts = stbl && child(moov, stbl, 'stts')
    if (!mdhd || !stts) return null
    const timescale = moov[mdhd.start] === 1 ? moov.readUInt32BE(mdhd.start + 20) : moov.readUInt32BE(mdhd.start + 12)
    let sampleCount = 0
    const entries = moov.readUInt32BE(stts.start + 4)
    for (let i = 0; i < entries; i++) {
      const at = stts.start + 8 + i * 8
      if (at + 8 > stts.end) return null
      sampleCount += moov.readUInt32BE(at) * moov.readUInt32BE(at + 4)
    }
    let editStart = 0
    const edts = child(moov, trak, 'edts')
    const elst = edts && child(moov, edts, 'elst')
    if (elst) {
      const version = moov[elst.start]
      const n = moov.readUInt32BE(elst.start + 4)
      const stride = version === 1 ? 20 : 12
      for (let i = 0; i < n; i++) {
        const at = elst.start + 8 + i * stride
        if (at + stride > elst.end) break
        const mediaTime = version === 1 ? Number(moov.readBigInt64BE(at + 8)) : moov.readInt32BE(at + 4)
        if (mediaTime === -1) continue   // an empty edit: a delay, not a start
        editStart = mediaTime
        break
      }
    }
    return { sampleCount, editStart, timescale }
  }
  return null
}

/** The moov payload of an MP4 file, wherever it sits. Null when there is none. */
async function readMoovPayload(absPath: string): Promise<Buffer | null> {
  const fh = await open(absPath, 'r')
  try {
    const fileSize = (await fh.stat()).size
    const head = Buffer.alloc(16)
    let pos = 0
    while (pos + 8 <= fileSize) {
      const { bytesRead } = await fh.read(head, 0, 16, pos)
      if (bytesRead < 8) return null
      let size = head.readUInt32BE(0)
      let header = 8
      if (size === 1) {
        if (bytesRead < 16) return null
        size = Number(head.readBigUInt64BE(8))
        header = 16
      } else if (size === 0) {
        size = fileSize - pos
      }
      if (size < header) return null
      if (head.toString('latin1', 4, 8) === 'moov') {
        const payload = Buffer.alloc(size - header)
        const r = await fh.read(payload, 0, payload.length, pos + header)
        return r.bytesRead === payload.length ? payload : null
      }
      pos += size
    }
    return null
  } finally {
    await fh.close()
  }
}

/** What an AAC source declares its length to be. Null for every other codec,
 *  and for an AAC file that declares nothing (the decode then stands). */
export async function readDeclaredLength(absPath: string): Promise<DeclaredLength | null> {
  const { stdout } = await execP('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'format_tags:stream=codec_name,sample_rate:stream_tags',
    '-of', 'json', absPath,
  ], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
  const probe = JSON.parse(stdout || '{}') as {
    format?: { tags?: Record<string, string> }
    streams?: Array<{ codec_name?: string; sample_rate?: string; tags?: Record<string, string> }>
  }
  const stream = probe.streams?.[0]
  if (String(stream?.codec_name || '').toLowerCase() !== 'aac') return null
  const sampleRate = Number(stream?.sample_rate) || 0

  const smpbOf = (tags?: Record<string, string>): string | null => {
    const key = Object.keys(tags ?? {}).find((k) => k.toLowerCase() === 'itunsmpb')
    return key ? (tags as Record<string, string>)[key] : null
  }
  const raw = smpbOf(probe.format?.tags) ?? smpbOf(stream?.tags)
  const parsed = raw ? parseSMPB(raw) : null
  if (parsed && parsed.delaySamples > 0 && parsed.originalSamples > 0) {
    return { frames: parsed.originalSamples, sampleRate, source: 'iTunSMPB' }
  }

  const moov = await readMoovPayload(absPath)
  const table = moov ? audioTableFromMoov(moov) : null
  if (!table || !(table.editStart > 0) || !(table.timescale > 0)) {
    // Its padding can't be cut. 6 of the 6,896 AAC files in the library on 2026-11-06.
    console.warn(`[live-set] ${absPath}: AAC that declares no length, so its encoder padding stays`)
    return null
  }
  const mediaFrames = table.sampleCount - table.editStart
  if (!(mediaFrames > 0)) return null
  const frames = sampleRate > 0 && table.timescale !== sampleRate
    ? Math.round((mediaFrames * sampleRate) / table.timescale)
    : mediaFrames
  return { frames, sampleRate, source: 'sample-table' }
}
