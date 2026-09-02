/**
 * concert-crowd-extract — lift "that night's crowd" out of a declared show.
 *
 * LC-7 (2026-07-10) swelled the room's own audience into the gaps between
 * songs, but the 7 s clip it needs was cut by hand once (Nassau '80) and
 * never for any other show — so the Crowd button did nothing on every other
 * concert (Jake, 2026-09-02: "does crowd feature even work???").
 *
 * This is the hand recipe, automated. Around every cue boundary (and the
 * show's edges) it scores 7 s windows by how much they sound like a ROOM
 * rather than a band: high spectral flatness (applause and crowd noise are
 * broadband; music is tonal), a plausible level (not silence, not the mix),
 * and a steady envelope. The best window is loudness-normalised, faded at
 * both ends and written as AAC next to the tuning file, keyed by the merged
 * track id — exactly what get-concert-crowd already serves.
 *
 * Pure scoring lives in scoreWindow() so it can be unit-tested; ffmpeg does
 * the measuring. Nothing here touches the show's audio.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const execP = promisify(execFile)

export const CLIP_SECONDS = 7
const SCAN_BEFORE_S = 10   // how far before a boundary to start looking
const SCAN_AFTER_S = 4     // …and after
const STEP_S = 1

export interface WindowStats { startSec: number; flatness: number; flatnessSd: number; rmsDb: number; rmsSd: number }

/** Candidate 7 s window starts, in seconds, around every seam + the show's edges. */
export function candidateStarts(cueStartsMs: number[], totalMs: number, clip = CLIP_SECONDS): number[] {
  const total = totalMs / 1000
  const out = new Set<number>()
  const push = (s: number): void => { const v = Math.round(Math.max(0, Math.min(total - clip, s))); if (total - clip >= 0) out.add(v) }
  for (const ms of cueStartsMs.slice(1)) {
    const b = ms / 1000
    for (let s = b - SCAN_BEFORE_S; s <= b + SCAN_AFTER_S; s += STEP_S) push(s)
  }
  for (let s = 0; s <= 8; s += STEP_S) push(s)                       // the walk-on
  for (let s = total - 24; s <= total - clip; s += STEP_S) push(s)    // the walk-off
  return [...out].sort((a, b) => a - b)
}

/**
 * Higher = more like a room. Flatness carries it (crowd ≈ 0.25–0.6, music
 * ≈ 0.03–0.15); silence and mix-level windows are pushed out; a jumpy
 * envelope (a count-in, a downbeat) costs.
 */
export function scoreWindow(w: WindowStats): number {
  if (!Number.isFinite(w.flatness) || !Number.isFinite(w.rmsDb)) return -Infinity
  if (w.rmsDb < -48) return -Infinity                    // effectively silence
  let s = w.flatness * 10                                // 0..~6
  if (w.rmsDb > -14) s -= (w.rmsDb + 14) * 0.6           // that's the band, not the room
  if (w.rmsDb < -36) s -= (-36 - w.rmsDb) * 0.15         // a whisper of a crowd is worth less
  s -= Math.min(3, w.rmsSd * 0.35)                       // jumpy envelope
  s -= Math.min(2, w.flatnessSd * 6)                     // flickering timbre (music with pauses)
  return s
}

async function measure(src: string, startSec: number, durSec: number): Promise<WindowStats> {
  // One ffmpeg pass: per-frame spectral flatness + per-half-second RMS via astats metadata.
  const af = [
    'aspectralstats=measure=flatness',
    'astats=metadata=1:reset=22:measure_perchannel=none:measure_overall=RMS_level',
    'ametadata=print:file=-',
  ].join(',')
  const { stdout } = await execP('ffmpeg', ['-v', 'error', '-ss', String(startSec), '-t', String(durSec), '-i', src, '-af', af, '-f', 'null', '-'],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
  const flat: number[] = []
  const rms: number[] = []
  for (const line of stdout.split('\n')) {
    let m = /aspectralstats\.\d+\.flatness=([\d.eE+-]+)/.exec(line)
    if (m) { flat.push(Number(m[1])); continue }
    m = /astats\.Overall\.RMS_level=([\d.eE+-]+)/.exec(line)
    if (m) { const v = Number(m[1]); if (Number.isFinite(v)) rms.push(v) }
  }
  const stats = (xs: number[]): { mean: number; sd: number } => {
    if (xs.length === 0) return { mean: NaN, sd: NaN }
    const mean = xs.reduce((t, x) => t + x, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((t, x) => t + (x - mean) ** 2, 0) / xs.length)
    return { mean, sd }
  }
  const f = stats(flat), r = stats(rms)
  return { startSec, flatness: f.mean, flatnessSd: f.sd, rmsDb: r.mean, rmsSd: r.sd }
}

export interface ExtractResult { startSec: number; score: number; outPath: string; scanned: number }

/**
 * Score every candidate (4 at a time), cut the winner to `outPath` (AAC,
 * 44.1 kHz, loudness-normalised, 0.5 s fades). Throws if no window is a room.
 */
export async function extractCrowdClip(
  src: string, cueStartsMs: number[], totalMs: number, outPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ExtractResult> {
  const starts = candidateStarts(cueStartsMs, totalMs)
  if (starts.length === 0) throw new Error('show too short for a crowd window')
  const results: Array<{ s: number; score: number }> = []
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < starts.length) {
      const s = starts[i++]
      try { results.push({ s, score: scoreWindow(await measure(src, s, CLIP_SECONDS)) }) } catch { results.push({ s, score: -Infinity }) }
      onProgress?.(results.length, starts.length)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  results.sort((a, b) => b.score - a.score)
  const best = results[0]
  if (!best || !Number.isFinite(best.score) || best.score < 1.0) throw new Error('no window on this tape sounds like a room')
  await mkdir(dirname(outPath), { recursive: true })
  const tmp = outPath + '.partial.m4a'
  await execP('ffmpeg', ['-y', '-v', 'error', '-ss', String(best.s), '-t', String(CLIP_SECONDS), '-i', src,
    '-af', `loudnorm=I=-20:TP=-2:LRA=9,afade=t=in:st=0:d=0.5,afade=t=out:st=${CLIP_SECONDS - 0.5}:d=0.5`,
    '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], { timeout: 120_000 })
  await rename(tmp, outPath).catch(async (err) => { await unlink(tmp).catch(() => {}); throw err })
  return { startSec: best.s, score: best.score, outPath, scanned: starts.length }
}
