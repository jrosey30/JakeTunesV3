/**
 * Music Man voice pitch (Jake, 2026-10-16: the new voice is "pitched a
 * little too high" → "a pinch deeper", same pace and cadence).
 *
 * ElevenLabs has no pitch control, so the Music Man's speech is lowered
 * AFTER synthesis: asetrate drops the pitch, aresample returns to the
 * original rate, atempo sets the speed. The amount lives in the userData
 * .env as MUSIC_MAN_PITCH_SEMITONES (e.g. -1.4); absent / 0 / invalid =
 * untouched. MUSIC_MAN_SPEED (default 1) sets his pace relative to the
 * synthesized take: Jake picked "somewhere in between" same-speed (1.0) and
 * tape-style (pitch and speed drop together, ~0.92) → ~0.96. Less stretch
 * also means fewer time-stretch artifacts (the "double voice" he heard).
 * Any failure returns the ORIGINAL audio — the Music Man never goes silent
 * over a pitch tweak.
 *
 * No Electron imports, no extensionless siblings: node --test loads it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const execP = promisify(execFile)

/** Parse MUSIC_MAN_PITCH_SEMITONES; clamped to ±6 so a typo can't wreck him. */
export function pitchSemitonesFromEnv(raw: string | undefined): number {
  const n = Number(String(raw ?? '').trim())
  if (!Number.isFinite(n) || n === 0) return 0
  return Math.max(-6, Math.min(6, n))
}

/** Parse MUSIC_MAN_SPEED; 1 = the take's own pace; clamped to [0.8, 1.2]. */
export function speedFromEnv(raw: string | undefined): number {
  const n = Number(String(raw ?? '').trim())
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.max(0.8, Math.min(1.2, n))
}

/**
 * The ffmpeg -af chain: pitch moves by `semitones`, final speed = `speed` ×
 * the take's own pace. null = no-op (0 semitones at speed 1, or no rate).
 */
export function pitchFilter(semitones: number, sampleRate: number, speed = 1): string | null {
  if (!(sampleRate > 0)) return null
  const st = Number.isFinite(semitones) ? semitones : 0
  const sp = Number.isFinite(speed) && speed > 0 ? speed : 1
  if (st === 0 && sp === 1) return null
  const f = 2 ** (st / 12)
  const parts: string[] = []
  if (st !== 0) parts.push(`asetrate=${sampleRate}*${f.toFixed(6)}`, `aresample=${sampleRate}`)
  const tempo = sp / f // asetrate already slowed by f; atempo lands the requested speed
  if (Math.abs(tempo - 1) > 1e-4) parts.push(`atempo=${tempo.toFixed(6)}`)
  return parts.length ? parts.join(',') : null
}

/** Pitch/speed-shape an audio buffer (mp3 in, mp3 out). Returns the input on any failure. */
export async function pitchShiftMp3(input: Buffer, semitones: number, speed = 1): Promise<Buffer> {
  if (!semitones && speed === 1) return input
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'jt-mm-pitch-'))
    const src = join(dir, 'in.mp3')
    const out = join(dir, 'out.mp3')
    await writeFile(src, input)
    const { stdout } = await execP('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', src], { timeout: 10_000 })
    const rate = parseInt(String(stdout).trim(), 10)
    const af = pitchFilter(semitones, rate, speed)
    if (!af) return input
    await execP('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', src, '-af', af, '-c:a', 'libmp3lame', '-b:a', '128k', out], { timeout: 20_000 })
    const shifted = await readFile(out)
    return shifted.length > 0 ? shifted : input
  } catch (err) {
    console.warn('[voice-pitch] pitch shift failed — playing the original:', err instanceof Error ? err.message : err)
    return input
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch((e: unknown) => console.warn('[voice-pitch] temp cleanup:', e instanceof Error ? e.message : e))
  }
}
