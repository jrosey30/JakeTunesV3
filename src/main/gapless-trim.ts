/**
 * gapless-trim — read the encoder priming an AAC file carries, so the
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
 * This module reports the counts. The renderer's seamScheduler applies the
 * HEAD trim (the dominant term). Tail padding needs the seam to fire
 * earlier, which lives in the do-not-touch useAudio.ts, and is deliberately
 * left alone here.
 *
 * ⚠️ This is a READ. It never modifies audio files.
 */
import { execFile } from 'child_process'
import type { IpcRegistrar } from './ipc-register.ts'
import { promisify } from 'util'
import { lstat, stat } from 'fs/promises'

const execP = promisify(execFile)

export interface GaplessTrim {
  /** Samples of encoder priming at the head — skip these on playback. */
  delaySamples: number
  /** Samples of padding at the tail. Reported, not yet applied. */
  paddingSamples: number
  sampleRate: number
  /** Head trim in SECONDS — what the renderer actually needs. */
  delaySec: number
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
function parseSMPB(raw: string): { delaySamples: number; paddingSamples: number } | null {
  const parts = String(raw || '').trim().split(/\s+/)
  if (parts.length < 4) return null
  const delay = parseInt(parts[1], 16)
  const padding = parseInt(parts[2], 16)
  if (!Number.isFinite(delay) || !Number.isFinite(padding)) return null
  if (delay < 0 || padding < 0) return null
  return { delaySamples: delay, paddingSamples: padding }
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
      '-show_entries', 'format_tags:stream=sample_rate',
      '-of', 'json', absPath,
    ], { timeout: 8000 })
    const probe = JSON.parse(stdout || '{}') as {
      format?: { tags?: Record<string, string> }
      streams?: Array<{ sample_rate?: string }>
    }
    const tags = probe.format?.tags || {}
    const key = Object.keys(tags).find((k) => k.toLowerCase().includes('itunsmpb'))
    const sampleRate = Number(probe.streams?.[0]?.sample_rate) || 44100
    if (key) {
      const parsed = parseSMPB(tags[key])
      // Sanity gate. Real AAC priming is ~1024-2112 samples; anything past
      // half a second means we misread the tag, and trimming on a misread
      // would cut the front off the actual music. Better to play the tiny
      // gap than to eat someone's downbeat.
      if (parsed && parsed.delaySamples > 0 && parsed.delaySamples < sampleRate / 2) {
        value = {
          delaySamples: parsed.delaySamples,
          paddingSamples: parsed.paddingSamples,
          sampleRate,
          delaySec: parsed.delaySamples / sampleRate,
        }
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
