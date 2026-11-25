/**
 * The AAC that goes onto an iPod is Apple's, or none (Brief 265, 2026-11-24).
 *
 * What happened: the iPod sync's AAC mirrors (buildAacMirror in index.ts) were
 * meant to be ffmpeg decode → Apple's afconvert encode since the 2026-07-11
 * squeaks, with ffmpeg's own AAC encoder only as a fallback "where afconvert is
 * missing". The check for afconvert ran `afconvert --help`, which exits 2 on
 * every Mac, so the check always said "missing" and EVERY mirror was ffmpeg's
 * own AAC under the afconvert cache key. Jake's IndieSleaze nano squeaked on
 * those (119 songs; "Do I Wanna Know?" and "Human" byte for byte the ffmpeg
 * recipe) and played the same song clean once it was Apple's encode.
 *
 * So, here:
 *   • the check reads what `afconvert -hf` lists (it exits 2 too; the exit code
 *     says nothing), and only an afconvert that lists AAC in an m4af file counts;
 *   • there is no ffmpeg AAC fallback: with no afconvert the conversion is
 *     REFUSED (AacEncoderMissingError) and the sync says so, never a quiet
 *     ffmpeg file;
 *   • the cache key's recipe token moved to v4, so a v3 mirror (made by ffmpeg)
 *     is never reused as an Apple one. The v3 files stay on disk: nothing here
 *     deletes cache files (Jake: never trim the convert cache without his yes).
 *
 * Pure apart from probeAfconvert's injected runner; node --test loads it.
 */
import { createHash } from 'node:crypto'

/** The recipe token in every AAC mirror's cache key. Bump it whenever the recipe changes.
 *  v3 = what the cache held up to 2026-11-24: ffmpeg's own AAC, under an Apple name. */
export const AAC_MIRROR_TOKEN = 'afenc-cbr-44100-2-v4'

/** The MP3 mirror's recipe token (Gen 1), and the iPod-safe 16-bit / 44.1 kHz ALAC mirror's. */
export const MP3_MIRROR_TOKEN = 'mp3-lame-cbr-44100-2-v1'
export const IPOD_ALAC_MIRROR_TOKEN = 'ipod-alac-16-44100-v1'

/** The cache file name for one source at one bitrate: sha1(src|kbps|token)[:16].m4a */
export function aacMirrorCacheName(srcPath: string, targetKbps: number): string {
  const hash = createHash('sha1').update(`${srcPath}|${targetKbps}|${AAC_MIRROR_TOKEN}`).digest('hex').slice(0, 16)
  return `${hash}.m4a`
}

/** Stage 1: ffmpeg decodes any source (FLAC/ALAC/WAV/AIFF, hi-res too) to 44.1 kHz / 16-bit / stereo WAV. */
export function pcmDecodeArgs(srcPath: string, pcmPath: string): string[] {
  return ['-nostdin', '-y', '-i', srcPath, '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', pcmPath]
}

/** Stage 2: Apple's encoder. AAC-LC in an MPEG-4 audio file, true CBR (-s 0), max quality. */
export function afconvertAacArgs(pcmPath: string, outPath: string, targetKbps: number): string[] {
  return [
    pcmPath, '-o', outPath,
    '-d', 'aac',                    // AAC-LC (not aach/HE: iPod-safe)
    '-f', 'm4af',                   // MPEG-4 Audio container (.m4a)
    '-b', String(targetKbps * 1000),
    '-q', '127',                    // max encoder quality
    '-s', '0',                      // true CBR, the iTunes-era mode the iPods shipped against
  ]
}

export class AacEncoderMissingError extends Error {
  readonly code = 'AAC_ENCODER_MISSING'
  constructor(srcPath: string, why: 'missing' | 'unknown' = 'missing') {
    const name = srcPath.split(/[\\/]/).pop()
    super(why === 'unknown'
      ? `Apple's AAC encoder (afconvert) didn't answer in time, so "${name}" was not converted this time. iPod AAC is never made with another encoder (Brief 265).`
      : `Apple's AAC encoder (afconvert) is not available on this Mac, so "${name}" was not converted. iPod AAC is never made with another encoder (Brief 265).`)
    this.name = 'AacEncoderMissingError'
  }
}

export function isAacEncoderMissing(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'AAC_ENCODER_MISSING'
}

/** Does `afconvert -hf` list AAC as a data format of the m4af file type? */
export function afconvertListsAacInM4af(helpText: string): boolean {
  const lines = String(helpText || '').split('\n')
  const i = lines.findIndex((l) => /'m4af'\s*=/.test(l))
  if (i < 0) return false
  // The data_formats line follows the file-type line (it may wrap onto more lines).
  for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
    if (/'[A-Za-z0-9 .]{4}'\s*=/.test(lines[j])) break   // next file type ('WAVE', 'm4af', …)
    if (/'aac '/.test(lines[j])) return true
  }
  return false
}

export type RunForText = () => Promise<{ stdout?: string; stderr?: string }>

export type AfconvertAnswer = 'yes' | 'no' | 'unknown'

/**
 * Ask afconvert what it can write. `afconvert -hf` exits 2 (as --help does), so a
 * runner that rejects on a non-zero exit still carries the text on its error: read it
 * from either. A missing program (ENOENT) or no AAC-in-m4af in the text = 'no'. A run that
 * was killed (the timeout) or failed with no text = 'unknown': never taken as "missing".
 */
export async function probeAfconvert(run: RunForText): Promise<AfconvertAnswer> {
  let text = ''
  try {
    const r = await run()
    text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown }
    if (e && e.code === 'ENOENT') return 'no'
    text = `${typeof e?.stdout === 'string' ? e.stdout : ''}\n${typeof e?.stderr === 'string' ? e.stderr : ''}`
    if (afconvertListsAacInM4af(text)) return 'yes'
    if (e?.killed || e?.signal || e?.code === 'ETIMEDOUT' || !text.trim()) return 'unknown'
  }
  return afconvertListsAacInM4af(text) ? 'yes' : 'no'
}

/** How long a 'no' or 'unknown' is believed before afconvert is asked again. */
export const AFCONVERT_RECHECK_MS = 30_000

/**
 * The answer a sync uses: a 'yes' is kept for the session; a 'no' or 'unknown' is asked
 * again after AFCONVERT_RECHECK_MS, so one slow check can't refuse every conversion until
 * the app restarts. Concurrent callers share one probe.
 */
export function createAfconvertCheck(run: RunForText, now: () => number = Date.now, recheckMs = AFCONVERT_RECHECK_MS) {
  let yes = false
  let last: { answer: AfconvertAnswer; at: number } | null = null
  let inFlight: Promise<AfconvertAnswer> | null = null
  return async (): Promise<AfconvertAnswer> => {
    if (yes) return 'yes'
    if (last && now() - last.at < recheckMs) return last.answer
    if (!inFlight) {
      inFlight = probeAfconvert(run).then((a) => {
        last = { answer: a, at: now() }
        if (a === 'yes') yes = true
        return a
      }).finally(() => { inFlight = null })
    }
    return inFlight
  }
}
