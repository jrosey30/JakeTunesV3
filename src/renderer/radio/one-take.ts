/**
 * One take per break (Jake, 2026-11-05: "the voices dont sound cohesive").
 *
 * Each line used to be its own recording, so the hosts shared no room and no
 * timing: about 130 ms between speakers, a fifth of the changes under 60 ms.
 * Now each run of consecutive host and caller lines is one dialogue call, the
 * way Jake's site takes are made (240-370 ms, none under 60). The announcer stays
 * a call of his own, because he has stingers and an FX chain.
 *
 * The decisions live here with their effects passed in, so node --test can run
 * them with no DOM: RadioEngine.ts owns the audio element and the pill.
 *
 * If a call fails (one voice gone from ElevenLabs fails the whole call), the run
 * is spoken line by line with a beat between speakers, so one bad call or one dead
 * voice can't lose a break.
 */
import { MAX_DIALOGUE_CHARS, type DialogueInput, type DialogueResult, type DialogueSegment } from '../../common/speech.ts'
import type { CaptionCue, RadioLine, RadioUnit, SpeakerId } from './types.ts'

/** The beat between speakers when a run falls back to line by line. Added to a
 *  clip's own tail and lead (about 130 ms) it lands where one-take gaps sit. */
export const SPEAKER_BEAT_MS = 150
/** How often a take's captions look at the clock. */
export const CUE_POLL_MS = 50
/** Calls at once for one break (matches V1). ElevenLabs allows this account 5. */
const CALL_CAP = 4

export type PlanStep =
  | { kind: 'announcer'; line: RadioLine }
  | { kind: 'run'; lines: RadioLine[] }

/** Split a break into runs of consecutive host and caller lines, the announcer
 *  on his own between them. A run that won't fit one call starts a new one. */
export function planRuns(lines: RadioLine[], maxChars = MAX_DIALOGUE_CHARS): PlanStep[] {
  const steps: PlanStep[] = []
  let run: RadioLine[] | null = null
  let chars = 0
  for (const line of lines) {
    if (line.speaker === 'announcer') {
      steps.push({ kind: 'announcer', line })
      run = null
      continue
    }
    if (!run || chars + line.text.length > maxChars) {
      run = []
      chars = 0
      steps.push({ kind: 'run', lines: run })
    }
    run.push(line)
    chars += line.text.length
  }
  return steps
}

/** voice_segments → when each line of a take is speaking. A line can come back
 *  as more than one segment; it gets one cue, first start to last end. */
export function captionCues(lines: RadioLine[], segments: DialogueSegment[]): CaptionCue[] {
  const spans = new Map<number, { startSec: number; endSec: number }>()
  for (const s of segments) {
    if (!lines[s.input]) continue
    const seen = spans.get(s.input)
    spans.set(s.input, seen
      ? { startSec: Math.min(seen.startSec, s.startSec), endSec: Math.max(seen.endSec, s.endSec) }
      : { startSec: s.startSec, endSec: s.endSec })
  }
  return [...spans.entries()]
    .map(([input, span]) => ({ line: lines[input], ...span }))
    .sort((a, b) => a.startSec - b.startSec)
}

export interface SynthDeps {
  voiceIdFor: (speaker: SpeakerId) => string | undefined
  dialogue: (inputs: DialogueInput[]) => Promise<DialogueResult>
  speak: (text: string, voiceId: string | undefined) => Promise<{ ok: boolean; audio?: string; error?: string }>
  warn: (message: string, detail?: unknown) => void
}

function callGate(cap: number): <T>(call: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async (call) => {
    if (active >= cap) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await call()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

/** Voice a break: one call per run, one per announcer line. Returns what can
 *  play, in order. A line whose voice is gone is dropped and everyone else plays. */
export async function synthesizeUnits(lines: RadioLine[], deps: SynthDeps): Promise<RadioUnit[]> {
  const gate = callGate(CALL_CAP)

  const speakLine = async (line: RadioLine): Promise<RadioUnit | null> => {
    try {
      const tts = await gate(() => deps.speak(line.text, deps.voiceIdFor(line.speaker)))
      if (tts.ok && tts.audio) {
        line.audio = tts.audio
        return { kind: 'line', line }
      }
      // ok with no audio is the voice switched off in Settings: nothing dropped.
      if (!tts.ok) deps.warn(`[radioV2] TTS dropped [${line.speaker}]:`, tts.error || '')
    } catch (err) {
      deps.warn(`[radioV2] TTS error [${line.speaker}]:`, err)
    }
    return null
  }

  const speakRun = async (run: RadioLine[]): Promise<RadioUnit[]> => {
    try {
      const inputs = run.map((line) => ({ text: line.text, voiceId: deps.voiceIdFor(line.speaker) ?? '' }))
      const take = await gate(() => deps.dialogue(inputs))
      if (take.ok && !take.audio) return []
      const cues = take.ok && take.segments ? captionCues(run, take.segments) : []
      if (take.ok && take.audio && cues.length) return [{ kind: 'take', lines: run, audio: take.audio, cues }]
      deps.warn('[radioV2] one take failed, speaking the run line by line:', take.error || 'no timing')
    } catch (err) {
      deps.warn('[radioV2] one take threw, speaking the run line by line:', err)
    }
    const spoken = await Promise.all(run.map(speakLine))
    return spoken.filter((unit): unit is RadioUnit => unit !== null)
  }

  const perStep = await Promise.all(planRuns(lines).map(async (step) => {
    if (step.kind === 'run') return speakRun(step.lines)
    const unit = await speakLine(step.line)
    return unit ? [unit] : []
  }))
  return perStep.flat()
}

function speakerAt(unit: RadioUnit, end: 'first' | 'last'): SpeakerId {
  if (unit.kind === 'line') return unit.line.speaker
  return unit.lines[end === 'first' ? 0 : unit.lines.length - 1].speaker
}

export interface PlayDeps {
  playTake: (take: Extract<RadioUnit, { kind: 'take' }>) => Promise<void>
  playLine: (line: RadioLine) => Promise<void>
  sleep: (ms: number) => Promise<void>
  isStopped: () => boolean
}

/** Play a break's units in order, with a beat where one voice hands to another
 *  across two recordings. Inside a take the model has already timed it, and the
 *  announcer has his stingers. */
export async function playUnits(units: RadioUnit[], deps: PlayDeps): Promise<void> {
  let previous: SpeakerId | null = null
  for (const unit of units) {
    if (deps.isStopped()) return
    const next = speakerAt(unit, 'first')
    if (previous && previous !== next && previous !== 'announcer' && next !== 'announcer') {
      await deps.sleep(SPEAKER_BEAT_MS)
      if (deps.isStopped()) return
    }
    if (unit.kind === 'take') await deps.playTake(unit)
    else await deps.playLine(unit.line)
    previous = speakerAt(unit, 'last')
  }
}

/** Show each cue once as the clock reaches it. A late look (a throttled timer)
 *  jumps to the newest due cue; it never goes back and never replays one. */
export function cueFollower(cues: CaptionCue[], show: (cue: CaptionCue) => void): (timeSec: number) => void {
  let next = 0
  return (timeSec) => {
    let due: CaptionCue | null = null
    while (next < cues.length && cues[next].startSec <= timeSec) {
      due = cues[next]
      next += 1
    }
    if (due) show(due)
  }
}

/** What a take's playback needs from an audio element. */
export interface TakeAudio {
  currentTime: number
  play: () => Promise<void>
  onended: unknown
  onerror: unknown
}

export interface TakeDeps {
  waitReady: () => Promise<void>
  /** false once stop() has let go of this element. */
  live: () => boolean
  show: (cue: CaptionCue) => void
  done: () => void
  every?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  cancel?: (timer: ReturnType<typeof setInterval>) => void
}

/** Start one take: captions follow the clock until it ends, errors or is stopped.
 *  Returns the function that settles it, for RadioEngine's finishCurrent: pause()
 *  fires neither 'ended' nor 'error', so stop() has to be able to call it. */
export function startTake(audio: TakeAudio, cues: CaptionCue[], deps: TakeDeps): () => void {
  const every = deps.every ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const cancel = deps.cancel ?? ((timer: ReturnType<typeof setInterval>) => clearInterval(timer))
  let settled = false
  let timer: ReturnType<typeof setInterval> | null = null
  const finish = (): void => {
    if (settled) return
    settled = true
    if (timer !== null) cancel(timer)
    deps.done()
  }
  audio.onended = finish
  audio.onerror = finish
  void deps.waitReady().then(() => {
    if (settled) return
    if (!deps.live()) { finish(); return }
    const follow = cueFollower(cues, deps.show)
    follow(0)
    timer = every(() => follow(audio.currentTime), CUE_POLL_MS)
    audio.play().catch(() => finish())
  })
  return finish
}
