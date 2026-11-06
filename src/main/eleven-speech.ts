/**
 * ElevenLabs speech (Jake, 2026-11-05: "the voices dont sound cohesive. the
 * voices do not sound like how they are in eleven labs").
 *
 * The app was on eleven_v3 with one recording per line, a different settings
 * branch per speaker and a pitch chain on the Music Man; Jake's site work is
 * eleven_v4 in one take. Jake compared them on one real break and picked: v4,
 * one call for the whole break, 0.47 / 0.66, the app's current Music Man voice. So
 * everything except Scotus now goes through one door: the dialogue endpoint,
 * those settings, one input or many. No pitch or speed change on anyone.
 *
 *   speakTake(inputs)   a run of lines as one recording, with who speaks when
 *   speakText(text, v)  one voice, however long (split, then joined)
 *   speakFast(text, v)  Scotus: eleven_flash_v2_5, untouched
 *
 * One fixed trim per voice (VOICE_TRIM_DB) after the call, because on v4 clones
 * keep their source recording's loudness and this Music Man reads ~4 LU under
 * Larry in the same take. Fixed, never per line: per-line leveling would flatten
 * the acting. No EQ: it moved Larry away from his site sound. If ffmpeg fails the
 * listener gets the untrimmed audio, never silence.
 *
 * No Electron imports, no extensionless siblings: node --test loads it.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LARRY_VOICE_ID } from '../common/cohost.ts'
import { sentenceEnds } from '../common/sentences.ts'
import { MAX_DIALOGUE_CHARS, type DialogueInput, type DialogueSegment } from '../common/speech.ts'

const API = 'https://api.elevenlabs.io/v1'
export const DIALOGUE_URL = `${API}/text-to-dialogue/with-timestamps`
export const SPEECH_MODEL = 'eleven_v4'
/** The dialogue endpoint's own names: `similarity`, not `similarity_boost`. */
export const SPEECH_SETTINGS = { stability: 0.47, similarity: 0.66 }

/** Scotus only. Speed over everything, so it keeps its own model and endpoint. */
export const FAST_MODEL = 'eleven_flash_v2_5'
const FAST_VOICE_SETTINGS = { stability: 0.2, similarity_boost: 0.7, style: 0.85, use_speaker_boost: true }

// ── Waiting on ElevenLabs ────────────────────────────────────────────────

/** Waits after a 429 with no Retry-After. The list's length bounds the retries. */
const BUSY_BACKOFF_MS = [1000, 2000, 4000]
/** A 429 asking for longer than this gives up instead: nobody sits through it
 *  between two songs, and the caller has its own way out. */
const MAX_BUSY_WAIT_MS = 10_000
/** Turbo used to be the second chance after any failure. One short retry on a
 *  5xx or a dropped connection takes its place, on the same model. */
const BROKEN_RETRY_MS = 1000
/** One 325-character break took 15.7 s, so a hung call is long past this. */
function requestTimeoutMs(chars: number): number {
  return Math.min(180_000, 30_000 + chars * 150)
}

export interface SpeechDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  /** Runs ffmpeg and resolves with its stdout. */
  ffmpeg: (args: string[]) => Promise<Buffer>
}

const realDeps: SpeechDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ffmpeg: (args) => new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 30_000, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  }),
}

/** Retry-After in ms: seconds or an HTTP date. null = absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  const raw = (header ?? '').trim()
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const when = Date.parse(raw)
  return Number.isNaN(when) ? null : Math.max(0, when - now)
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

/**
 * Send, and on a 429 wait and send the SAME request again. It used to fall to
 * Turbo, which made a line sound like a different person (2 of 61 lines on the
 * audit night), and ElevenLabs lists Turbo as deprecated. Returns the last
 * response, whatever it is; only a transport failure throws.
 */
export async function sendWithRetry(send: () => Promise<Response>, deps: Pick<SpeechDeps, 'sleep'>): Promise<Response> {
  let busy = 0
  let broken = false
  for (;;) {
    let res: Response
    try {
      res = await send()
    } catch (err) {
      if (broken || isTimeout(err)) throw err
      broken = true
      await deps.sleep(BROKEN_RETRY_MS)
      continue
    }
    if (res.status === 429 && busy < BUSY_BACKOFF_MS.length) {
      const asked = retryAfterMs(res.headers.get('retry-after'))
      const waitMs = asked ?? BUSY_BACKOFF_MS[busy]
      if (waitMs > MAX_BUSY_WAIT_MS) return res
      busy += 1
      console.warn(`[TTS] busy (429), waiting ${Math.round(waitMs)} ms, retry ${busy} of ${BUSY_BACKOFF_MS.length}`)
      await res.body?.cancel()
      await deps.sleep(waitMs)
      continue
    }
    if (res.status >= 500 && !broken) {
      broken = true
      await res.body?.cancel()
      await deps.sleep(BROKEN_RETRY_MS)
      continue
    }
    return res
  }
}

function authHeaders(): Record<string, string> {
  return { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '', 'Content-Type': 'application/json' }
}

async function failure(res: Response, what: string): Promise<Error> {
  const detail = (await res.text().catch(() => '')).slice(0, 200)
  console.warn(`[TTS] ${what} failed: ${res.status} ${detail}`)
  return new Error(`elevenlabs ${res.status}: ${detail}`)
}

// ── One call ─────────────────────────────────────────────────────────────

interface VoiceSpan extends DialogueSegment {
  voiceId: string
}

interface RawTake {
  audio: Buffer
  spans: VoiceSpan[]
}

/** The API's voice_segments → our spans. Anything malformed is dropped. */
function spansFrom(segments: unknown): VoiceSpan[] {
  if (!Array.isArray(segments)) return []
  const spans: VoiceSpan[] = []
  for (const s of segments as Array<Record<string, unknown>>) {
    const input = s?.dialogue_input_index
    const startSec = s?.start_time_seconds
    const endSec = s?.end_time_seconds
    if (typeof input === 'number' && typeof startSec === 'number' && typeof endSec === 'number' && typeof s.voice_id === 'string') {
      spans.push({ input, startSec, endSec, voiceId: s.voice_id })
    }
  }
  return spans.sort((a, b) => a.startSec - b.startSec)
}

/** `context` carries the words either side of a chunk, so a long reply split in
 *  pieces keeps its intonation across the join. */
async function requestTake(
  inputs: DialogueInput[],
  deps: SpeechDeps,
  context: { previous_text?: string; future_text?: string } = {},
): Promise<RawTake> {
  const chars = inputs.reduce((sum, i) => sum + i.text.length, 0)
  const body = JSON.stringify({
    inputs: inputs.map((i) => ({ text: i.text, voice_id: i.voiceId })),
    model_id: SPEECH_MODEL,
    settings: SPEECH_SETTINGS,
    ...context,
  })
  const res = await sendWithRetry(() => deps.fetch(DIALOGUE_URL, {
    method: 'POST',
    headers: authHeaders(),
    body,
    signal: AbortSignal.timeout(requestTimeoutMs(chars)),
  }), deps)
  if (!res.ok) throw await failure(res, `${SPEECH_MODEL} take of ${inputs.length} (${chars} chars)`)
  const json = (await res.json()) as { audio_base64?: string; voice_segments?: unknown }
  const audio = Buffer.from(json.audio_base64 || '', 'base64')
  if (audio.length === 0) throw new Error('elevenlabs: a take with no audio')
  return { audio, spans: spansFrom(json.voice_segments) }
}

// ── Levels ───────────────────────────────────────────────────────────────

/**
 * dB per voice, chosen by measuring real v4 takes (2026-11-06), speech aimed near
 * -16 LUFS. On v4 a clone keeps its source recording's loudness, and they differ
 * by 13 dB. A voice not listed gets 0 dB.
 *
 * The hosts: five real breaks read -19.1 (Music Man) and -15.3 (Larry) on average.
 * With these two trims they read about -16 each. Any one take still varies by
 * about 1 LU either way: that's the acting, and it stays.
 * Everyone else: one or two short lines each, so these are rough.
 */
export const VOICE_TRIM_DB: Record<string, number> = {
  '3q3z1RplmzZ5UT7BUP61': 4, // the Music Man (Jake's ELEVENLABS_VOICE_ID since 2026-10-16)
  [LARRY_VOICE_ID]: -0.5,
  ApBE43wHy5MiZGz9ihqB: 1, // Stephen
  UOB3uZCEf2cjGpZaGOXq: 1, // Giovanni
  miqykcv8BCUvQnRlIGUV: 1, // Rajiv
  BlgEcC0TfWpBak7FmvHW: 4, // Kristina
  YrAYvOVjAFiqVwBgB4qI: 3, // Devin
  Ib97zM6uFBc71OWgj75I: 7, // Mike
  c8v8wiyiDwyuduufV6kB: 13, // Zoe
}

export function voiceTrimDb(voiceId: string): number {
  return VOICE_TRIM_DB[voiceId] ?? 0
}

/** Nothing above this leaves main. Under full scale because a sample limiter
 *  can't see the peaks between samples and the mp3 encoder adds a little: on real
 *  takes this lands near -1.2 dBTP. */
const CEILING = 0.89 // about -1 dBFS
/** The gain moves over this long, so a switch that can't land in silence doesn't click. */
const GAIN_RAMP_SEC = 0.02
/** How far from a voice_segments boundary to look for the gap between speakers.
 *  Further back than ahead: a speaker's first sound can lead the boundary (50 ms
 *  on the reference break, where the switch would have landed inside "It's"). */
const SNAP_BACK_SEC = 0.25
const SNAP_AHEAD_SEC = 0.15
const QUIET_RMS = 0.001 // -60 dBFS; the gaps between speakers sit below -70
const SNAP_RATE = 22_050

export interface GainStep {
  atSec: number
  db: number
}

/** The trim at each moment of a take: a new step only where the trim changes. */
export function gainTimeline(spans: Array<{ startSec: number; voiceId: string }>): GainStep[] {
  const steps: GainStep[] = []
  for (const s of [...spans].sort((a, b) => a.startSec - b.startSec)) {
    const db = voiceTrimDb(s.voiceId)
    const last = steps[steps.length - 1]
    if (last?.db === db) continue
    steps.push({ atSec: last ? s.startSec : 0, db })
  }
  return steps.length ? steps : [{ atSec: 0, db: 0 }]
}

function linear(db: number): number {
  return 10 ** (db / 20)
}

/** ffmpeg expression for the gain at time t: the first step's gain plus one ramp per change. */
export function gainExpression(steps: GainStep[]): string {
  let expr = linear(steps[0].db).toFixed(5)
  for (let i = 1; i < steps.length; i++) {
    const delta = linear(steps[i].db) - linear(steps[i - 1].db)
    const from = steps[i].atSec - GAIN_RAMP_SEC / 2
    expr += `+(${delta.toFixed(5)})*clip((t-${from.toFixed(3)})/${GAIN_RAMP_SEC},0,1)`
  }
  return expr
}

/** Gain by time range, then the ceiling. `level=0` keeps alimiter from
 *  normalizing on its own; `latency=1` keeps it from shifting the audio. */
export function finishFilter(steps: GainStep[]): string {
  // 256-sample frames: volume re-reads its expression once per frame.
  const gain = steps.length === 1
    ? `volume=${linear(steps[0].db).toFixed(5)}`
    : `asetnsamples=n=256:p=0,volume=volume='${gainExpression(steps)}':eval=frame`
  return `${gain},alimiter=limit=${CEILING}:attack=5:release=50:level=0:latency=1`
}

/**
 * The middle of the quiet nearest `atSec`, or `atSec` when the two voices run
 * together. voice_segments marks where a line's text starts, which is not always
 * where its sound starts, and a gain change there would land inside a word.
 */
export function snapToQuiet(samples: Float32Array, rate: number, atSec: number): number {
  const frame = Math.max(1, Math.round(rate * 0.01))
  const first = Math.max(0, Math.floor(((atSec - SNAP_BACK_SEC) * rate) / frame))
  const end = Math.min(Math.floor(samples.length / frame), Math.ceil(((atSec + SNAP_AHEAD_SEC) * rate) / frame))
  const quietPower = QUIET_RMS * QUIET_RMS
  let best: number | null = null
  let bestDistance = Infinity
  let runStart = -1
  for (let f = first; f <= end; f++) {
    let power = Infinity
    if (f < end) {
      power = 0
      for (let i = f * frame; i < (f + 1) * frame; i++) power += samples[i] * samples[i]
      power /= frame
    }
    if (power < quietPower) {
      if (runStart < 0) runStart = f
      continue
    }
    if (runStart >= 0) {
      if (f - runStart >= 2) { // at least the ramp's length
        const startSec = (runStart * frame) / rate
        const endSec = (f * frame) / rate
        const distance = atSec < startSec ? startSec - atSec : atSec > endSec ? atSec - endSec : 0
        if (distance < bestDistance) {
          bestDistance = distance
          best = (startSec + endSec) / 2
        }
      }
      runStart = -1
    }
  }
  return best ?? atSec
}

/**
 * Trim, limit, encode. `pieces` are one take, or the chunks of one long text
 * joined here. On any ffmpeg failure the listener gets the untrimmed audio.
 */
export async function finishTake(pieces: Buffer[], spans: Array<{ startSec: number; voiceId: string }>, deps: SpeechDeps = realDeps): Promise<Buffer> {
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'jt-speech-'))
    const paths = await Promise.all(pieces.map(async (piece, i) => {
      const path = join(dir as string, `in${i}.mp3`)
      await writeFile(path, piece)
      return path
    }))
    const out = join(dir, 'out.mp3')
    let steps = gainTimeline(spans)
    if (steps.length > 1) {
      const pcm = await deps.ffmpeg(['-nostdin', '-v', 'error', '-i', paths[0], '-ac', '1', '-ar', String(SNAP_RATE), '-f', 'f32le', 'pipe:1'])
      const samples = new Float32Array(new Uint8Array(pcm).buffer, 0, Math.floor(pcm.length / 4))
      steps = steps.map((s, i) => (i === 0 ? s : { ...s, atSec: snapToQuiet(samples, SNAP_RATE, s.atSec) }))
    }
    const chain = finishFilter(steps)
    const inputs = paths.flatMap((p) => ['-i', p])
    const filter = pieces.length > 1
      ? ['-filter_complex', `${pieces.map((_, i) => `[${i}:a]`).join('')}concat=n=${pieces.length}:v=0:a=1,${chain}[out]`, '-map', '[out]']
      : ['-af', chain]
    await deps.ffmpeg(['-nostdin', '-v', 'error', '-y', ...inputs, ...filter, '-c:a', 'libmp3lame', '-b:a', '192k', out])
    const finished = await readFile(out)
    if (finished.length > 0) return finished
    throw new Error('ffmpeg wrote nothing')
  } catch (err) {
    console.warn('[TTS] trim failed, playing the take as it came:', err instanceof Error ? err.message : err)
    return Buffer.concat(pieces)
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch((e: unknown) => console.warn('[TTS] temp cleanup:', e instanceof Error ? e.message : e))
  }
}

// ── The three doors ──────────────────────────────────────────────────────

/** A run of radio lines as one recording. Throws when the call fails (one dead
 *  voice fails the whole call) or the API doesn't say who speaks when: the
 *  renderer then speaks the run line by line, so a break is never lost. */
export async function speakTake(inputs: DialogueInput[], deps: SpeechDeps = realDeps): Promise<{ audio: Buffer; segments: DialogueSegment[] }> {
  const take = await requestTake(inputs, deps)
  if (take.spans.length === 0) throw new Error('elevenlabs: a take with no voice_segments')
  const audio = await finishTake([take.audio], take.spans, deps)
  return { audio, segments: take.spans.map(({ input, startSec, endSec }) => ({ input, startSec, endSec })) }
}

/**
 * `text` in chunks that fit one call, cut on sentence ends. musicman-speak takes
 * 4,000 characters and the dialogue docs say to stay at or under 2,000. A single
 * sentence too long to fit falls back to a clause, then to a word.
 */
export function splitForDialogue(text: string, max = MAX_DIALOGUE_CHARS): string[] {
  const chunks: string[] = []
  const ends = sentenceEnds(text)
  let start = 0
  while (text.length - start > max) {
    const limit = start + max
    let cut = -1
    for (const end of ends) {
      if (end > limit) break
      if (end > start) cut = end
    }
    if (cut < 0) {
      const window = text.slice(start, limit)
      const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '))
      const word = window.lastIndexOf(' ')
      const at = clause > 0 ? clause + 1 : word > 0 ? word : window.length
      cut = start + at
    }
    const chunk = text.slice(start, cut).trim()
    if (chunk) chunks.push(chunk)
    start = cut
  }
  const rest = text.slice(start).trim()
  if (rest) chunks.push(rest)
  return chunks
}

/** How much of the next and previous chunk the API takes as context. */
const CONTEXT_CHARS = 100

/** One voice, any length up to musicman-speak's cap. A long reply that loses a
 *  later chunk still speaks the part before it; only a lost first chunk throws. */
export async function speakText(text: string, voiceId: string, deps: SpeechDeps = realDeps, maxChars = MAX_DIALOGUE_CHARS): Promise<Buffer> {
  const chunks = splitForDialogue(text, maxChars)
  const settled = await Promise.allSettled(chunks.map((chunk, i) => requestTake([{ text: chunk, voiceId }], deps, chunks.length === 1 ? {} : {
    ...(i > 0 ? { previous_text: chunks[i - 1].slice(-CONTEXT_CHARS) } : {}),
    ...(i < chunks.length - 1 ? { future_text: chunks[i + 1].slice(0, CONTEXT_CHARS) } : {}),
  })))
  const pieces: Buffer[] = []
  for (const result of settled) {
    if (result.status === 'rejected') {
      if (pieces.length === 0) throw result.reason
      console.warn(`[TTS] chunk ${pieces.length + 1} of ${chunks.length} lost, speaking the part before it`)
      break
    }
    pieces.push(result.value.audio)
  }
  return finishTake(pieces, [{ startSec: 0, voiceId }], deps)
}

/** Scotus. Its own model and endpoint; only the 429 handling is shared. */
export async function speakFast(text: string, voiceId: string, deps: SpeechDeps = realDeps): Promise<Buffer> {
  const body = JSON.stringify({ text, model_id: FAST_MODEL, voice_settings: FAST_VOICE_SETTINGS })
  const res = await sendWithRetry(() => deps.fetch(`${API}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: authHeaders(),
    body,
    signal: AbortSignal.timeout(requestTimeoutMs(text.length)),
  }), deps)
  if (!res.ok) throw await failure(res, `${FAST_MODEL} for voice ${voiceId.slice(0, 8)}…`)
  return Buffer.from(await res.arrayBuffer())
}
