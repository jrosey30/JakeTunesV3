/**
 * gapless-trim — read the encoder priming an AAC/MP3 file carries, so the
 * player can skip it instead of playing it as silence.
 *
 * THE BUG THIS FIXES (2026-08-08). Jake, on a tape made from one album:
 * "clearly i can hear the track change." Every AAC file has silence the
 * encoder prepended (priming/delay) and appended (padding). The exact
 * counts are written into the file's `iTunSMPB` tag precisely so a player
 * can strip them — the iPod does, which is why the same album is seamless
 * there. Web Audio's decodeAudioData does NOT: it hands the priming back
 * as real samples, and seamScheduler was starting each incoming buffer at
 * offset 0, i.e. at the start of the silence.
 *
 * Measured on his files: 2112 samples of head delay — 47.9 ms — on every
 * track, plus 4–23 ms of tail padding. So ~52–71 ms of dead air at every
 * seam, which no amount of scheduling accuracy can remove. Sample-accurate
 * scheduling was working perfectly; it was accurately playing silence.
 *
 * This module reports the counts. The renderer applies HEAD trim on the
 * incoming BufferSource (skip delay samples) and TAIL trim by firing the
 * seam `paddingSec` early so the next track starts at music-end, not at
 * encoder-padding EOF. See `src/renderer/audio/gapless-timing.ts`.
 *
 * MP3 without iTunSMPB: LAME/Xing Info tag carries the same two 12-bit
 * fields (encoder delay + padding). Same units, same player contract.
 *
 * ⚠️ This is a READ. It never modifies audio files.
 */
import { execFile } from 'child_process'
import type { IpcRegistrar } from './ipc-register.ts'
import { promisify } from 'util'
import { lstat, open, stat } from 'fs/promises'

const execP = promisify(execFile)

export interface GaplessTrim {
  /** Samples of encoder priming at the head — skip these on playback. */
  delaySamples: number
  /** Samples of padding at the tail — fire the next seam this early. */
  paddingSamples: number
  sampleRate: number
  /** Head trim in SECONDS — what the renderer actually needs. */
  delaySec: number
  /** Tail trim in SECONDS — subtract from Howler remaining at the seam. */
  paddingSec: number
}

export interface ParsedGapless {
  delaySamples: number
  paddingSamples: number
  /** iTunSMPB field 3 — original PCM sample count. 0 when unknown (LAME). */
  originalSamples: number
}

// path -> { mtimeMs, value }. Probing costs an ffprobe spawn (~50-200ms);
// a track's priming never changes unless the file itself does.
const cache = new Map<string, { mtimeMs: number; value: GaplessTrim | null }>()

/**
 * iTunSMPB is a space-separated hex string. Field 1 is the encoder delay,
 * field 2 the end padding, field 3 the real frame count:
 *   " 00000000 00000840 000000CE 00000000002CB2D4 ... "
 *                ^delay    ^padding  ^frames
 * 0x840 = 2112, the standard AAC-LC priming.
 */
export function parseSMPB(raw: string): ParsedGapless | null {
  const parts = String(raw || '').trim().split(/\s+/)
  if (parts.length < 4) return null
  const delay = parseInt(parts[1], 16)
  const padding = parseInt(parts[2], 16)
  const original = parseInt(parts[3], 16)
  if (!Number.isFinite(delay) || !Number.isFinite(padding)) return null
  if (delay < 0 || padding < 0) return null
  return {
    delaySamples: delay,
    paddingSamples: padding,
    originalSamples: Number.isFinite(original) && original > 0 ? original : 0,
  }
}

/**
 * LAME/Xing Info tag: 12-bit encoder delay + 12-bit padding.
 * `frame` must start at the MPEG sync word (after ID3).
 *
 * Layout: MPEG header → side info → "Xing"/"Info" + flags + optional
 * fields → LAME extra. Delay/padding lives at LAME extra + 0x15.
 */
export function parseLameGapless(frame: Uint8Array): ParsedGapless | null {
  if (frame.length < 8) return null
  if (frame[0] !== 0xff || (frame[1] & 0xe0) !== 0xe0) return null
  const versionId = (frame[1] >> 3) & 3
  const layer = (frame[1] >> 1) & 3
  if (layer !== 1) return null
  const mono = ((frame[3] >> 6) & 3) === 3
  const mpeg1 = versionId === 3
  const xingOff = mpeg1 ? (mono ? 21 : 36) : (mono ? 13 : 21)
  if (xingOff + 8 > frame.length) return null
  const tag = String.fromCharCode(
    frame[xingOff], frame[xingOff + 1], frame[xingOff + 2], frame[xingOff + 3],
  )
  if (tag !== 'Xing' && tag !== 'Info') return null
  const flags = ((frame[xingOff + 4] << 24) | (frame[xingOff + 5] << 16) |
    (frame[xingOff + 6] << 8) | frame[xingOff + 7]) >>> 0
  let off = xingOff + 8
  if (flags & 0x1) off += 4
  if (flags & 0x2) off += 4
  if (flags & 0x4) off += 100
  if (flags & 0x8) off += 4
  return readLameDelayPadding(frame, off) ?? scanLameTag(frame)
}

function readLameDelayPadding(frame: Uint8Array, lameOff: number): ParsedGapless | null {
  const delayPadOff = lameOff + 0x15
  if (delayPadOff + 3 > frame.length) return null
  const b0 = frame[delayPadOff]
  const b1 = frame[delayPadOff + 1]
  const b2 = frame[delayPadOff + 2]
  const delay = (b0 << 4) | (b1 >> 4)
  const padding = ((b1 & 0x0f) << 8) | b2
  if (delay === 0 && padding === 0) return null
  // LAME's own max is a couple of MPEG frames (~1152–2205). Anything in
  // the many-thousands is a misaligned read, not a real encoder delay.
  if (delay > 7200 || padding > 7200) return null
  return { delaySamples: delay, paddingSamples: padding, originalSamples: 0 }
}

function scanLameTag(frame: Uint8Array): ParsedGapless | null {
  for (let i = 0; i + 4 < frame.length; i++) {
    if (frame[i] === 0x4c && frame[i + 1] === 0x41 &&
        frame[i + 2] === 0x4d && frame[i + 3] === 0x45) {
      return readLameDelayPadding(frame, i)
    }
  }
  return null
}

/** True when a delay or padding count is in the "real encoder, not a misread" band. */
export function isSaneTrimSamples(samples: number, sampleRate: number): boolean {
  return Number.isFinite(samples) && samples >= 0 && samples < sampleRate / 2
}

export function toGaplessTrim(
  parsed: ParsedGapless,
  sampleRate: number,
): GaplessTrim | null {
  const sr = sampleRate > 0 ? sampleRate : 44100
  if (!isSaneTrimSamples(parsed.delaySamples, sr)) return null
  if (!isSaneTrimSamples(parsed.paddingSamples, sr)) return null
  if (parsed.delaySamples === 0 && parsed.paddingSamples === 0) return null
  return {
    delaySamples: parsed.delaySamples,
    paddingSamples: parsed.paddingSamples,
    sampleRate: sr,
    delaySec: parsed.delaySamples / sr,
    paddingSec: parsed.paddingSamples / sr,
  }
}

function findSMPB(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null
  const key = Object.keys(tags).find((k) => k.toLowerCase().includes('itunsmpb'))
  return key ? tags[key] : null
}

async function readMp3LameGapless(absPath: string): Promise<ParsedGapless | null> {
  const fh = await open(absPath, 'r')
  try {
    const head = Buffer.alloc(10)
    const r = await fh.read(head, 0, 10, 0)
    if (r.bytesRead < 10) return null
    let pos = 0
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) |
        ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
      pos = 10 + size
      if (head[5] & 0x10) pos += 10
    }
    const frame = Buffer.alloc(2048)
    const n = await fh.read(frame, 0, 2048, pos)
    if (n.bytesRead < 4) return null
    const buf = frame.subarray(0, n.bytesRead)
    let i = 0
    while (i + 4 < buf.length && !(buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0)) i++
    return parseLameGapless(buf.subarray(i))
  } finally {
    await fh.close()
  }
}

export async function readGaplessTrim(absPath: string): Promise<GaplessTrim | null> {
  // Skip farm symlinks — ffprobe/stat follow into SMB and pinwheel workmini
  // on every gapless decode. Priming trim is a polish; silence beats a hang.
  try {
    if ((await lstat(absPath)).isSymbolicLink()) return null
  } catch { return null }

  const st = await stat(absPath).catch(() => null)
  if (!st) return null
  const hit = cache.get(absPath)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value

  let value: GaplessTrim | null = null
  try {
    const { stdout } = await execP('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'format_tags:stream=sample_rate,codec_name:stream_tags',
      '-of', 'json', absPath,
    ], { timeout: 8000 })
    const probe = JSON.parse(stdout || '{}') as {
      format?: { tags?: Record<string, string> }
      streams?: Array<{ sample_rate?: string; codec_name?: string; tags?: Record<string, string> }>
    }
    const stream = probe.streams?.[0]
    const sampleRate = Number(stream?.sample_rate) || 44100
    const smpb = findSMPB(probe.format?.tags) || findSMPB(stream?.tags)
    if (smpb) {
      const parsed = parseSMPB(smpb)
      // Sanity gate. Real AAC priming is ~1024-2112 samples; anything past
      // half a second means we misread the tag, and trimming on a misread
      // would cut the front off the actual music. Better to play the tiny
      // gap than to eat someone's downbeat. Padding-only tags are accepted
      // so tail trim can still fire when delay is 0.
      if (parsed) value = toGaplessTrim(parsed, sampleRate)
    }
    if (!value) {
      const codec = String(stream?.codec_name || '').toLowerCase()
      if (codec === 'mp3' || codec === 'mp2') {
        const lame = await readMp3LameGapless(absPath).catch(() => null)
        if (lame) value = toGaplessTrim(lame, sampleRate)
      }
    }
  } catch {
    value = null   // no ffprobe, unreadable file, weird container → no trim
  }
  cache.set(absPath, { mtimeMs: st.mtimeMs, value })
  return value
}

export function registerGaplessTrimIpc(ipc: IpcRegistrar): void {
  // Path-based ffprobe — main-window only. Guest frames must not probe
  // arbitrary files. Refuse with null (same as "no trim") so the player
  // degrades to today's untrimmed seam rather than throwing.
  ipc.handle('gapless-trim', async (_e, absPath: string) => {
    if (!absPath || typeof absPath !== 'string') return null
    return readGaplessTrim(absPath)
  }, { refuse: null })
}
