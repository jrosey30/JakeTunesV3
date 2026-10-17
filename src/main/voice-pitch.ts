/**
 * Music Man voice pitch (Jake, 2026-10-16: the new voice is "pitched a
 * little too high" → "a pinch deeper", same pace and cadence).
 *
 * ElevenLabs has no pitch control, so the Music Man's speech is lowered
 * AFTER synthesis: asetrate drops the pitch, aresample returns to the
 * original rate, atempo restores the original speed — pace and cadence are
 * unchanged, only the pitch moves. The amount lives in the userData .env as
 * MUSIC_MAN_PITCH_SEMITONES (e.g. -1.5); absent / 0 / invalid = untouched.
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

/** The ffmpeg -af chain for a pitch move at constant speed; null = no-op. */
export function pitchFilter(semitones: number, sampleRate: number): string | null {
  if (!semitones || !Number.isFinite(semitones) || !(sampleRate > 0)) return null
  const f = 2 ** (semitones / 12)
  return `asetrate=${sampleRate}*${f.toFixed(6)},aresample=${sampleRate},atempo=${(1 / f).toFixed(6)}`
}

/** Pitch-shift an audio buffer (mp3 in, mp3 out). Returns the input on any failure. */
export async function pitchShiftMp3(input: Buffer, semitones: number): Promise<Buffer> {
  if (!semitones) return input
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'jt-mm-pitch-'))
    const src = join(dir, 'in.mp3')
    const out = join(dir, 'out.mp3')
    await writeFile(src, input)
    const { stdout } = await execP('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', src], { timeout: 10_000 })
    const rate = parseInt(String(stdout).trim(), 10)
    const af = pitchFilter(semitones, rate)
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
