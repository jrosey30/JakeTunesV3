/**
 * One take per break: what RadioEngine decides, with its effects passed in
 * (one-take.ts). Grouping, the announcer staying separate, captions from
 * voice_segments, the fallback when a call fails, the finishCurrent contract, and
 * the wires no test can call. The engine itself runs in radio-engine.test.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CUE_POLL_MS,
  SPEAKER_BEAT_MS,
  captionCues,
  cueFollower,
  planRuns,
  playUnits,
  startTake,
  synthesizeUnits,
  type SynthDeps,
} from '../../renderer/radio/one-take.ts'
import type { CaptionCue, RadioLine, RadioUnit, SpeakerId } from '../../renderer/radio/types.ts'
import { CALLERS, RADIO_CAST, musicManVoiceId, radioCastForRenderer } from '../cast.ts'
import { LARRY_VOICE_ID } from '../../common/cohost.ts'
import { ANNOUNCER_OUTPUT_GAIN, buildAnnouncerFx } from '../../renderer/audio/announcer-fx.ts'

const SRC = join(import.meta.dirname, '../..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8')
const line = (speaker: SpeakerId, text: string): RadioLine => ({ speaker, text })
const shape = (lines: RadioLine[]): string[] => planRuns(lines).map((step) =>
  step.kind === 'announcer' ? 'A' : step.lines.map((l) => l.speaker).join('+'))

describe('grouping', () => {
  it('consecutive hosts and callers are one run', () => {
    assert.deepEqual(shape([line('mm', 'a'), line('larry', 'b'), line('giovanni', 'c'), line('mm', 'd'), line('stephen', 'e')]), ['mm+larry+giovanni+mm+stephen'])
  })

  it('the announcer is never in a run, and he splits the runs around him', () => {
    assert.deepEqual(shape([line('announcer', 'id'), line('announcer', 'id'), line('mm', 'a'), line('larry', 'b'), line('announcer', 'id'), line('mm', 'c')]),
      ['A', 'A', 'mm+larry', 'A', 'mm'])
  })

  it('order within a run is the script order, the same objects', () => {
    const lines = [line('larry', 'first'), line('mm', 'second')]
    const [step] = planRuns(lines)
    assert.ok(step.kind === 'run')
    assert.equal(step.lines[0], lines[0])
    assert.equal(step.lines[1], lines[1])
  })

  it('a run past the character limit starts another run, never past the limit', () => {
    const lines = [line('mm', 'x'.repeat(60)), line('larry', 'y'.repeat(60)), line('mm', 'z'.repeat(60)), line('larry', 'w'.repeat(60))]
    assert.deepEqual(planRuns(lines, 130).map((s) => (s.kind === 'run' ? s.lines.length : 0)), [2, 2], 'each run counts from zero')
    assert.equal(planRuns(lines).length, 1, 'the default limit is ElevenLabs 2,000')
  })

  it('one line past the limit is a run of its own: main refuses it and the fallback splits it', () => {
    const lines = [line('mm', 'short'), line('larry', 'x'.repeat(200))]
    assert.deepEqual(planRuns(lines, 100).map((s) => (s.kind === 'run' ? s.lines.length : 0)), [1, 1])
  })

  it('an empty break plans nothing', () => {
    assert.deepEqual(planRuns([]), [])
  })
})

/** Fake IPC: `dialogue` and `speak` behave as told, every call recorded. */
function fakes(behave: { dialogue?: SynthDeps['dialogue']; speak?: SynthDeps['speak'] } = {}) {
  const voice: Record<string, string> = { mm: 'VOICE-MM', larry: 'VOICE-LARRY', announcer: 'VOICE-ANN', giovanni: 'VOICE-GIO', bernard: 'VOICE-DEAD' }
  const calls = { dialogue: [] as Array<Array<{ text: string; voiceId: string }>>, speak: [] as Array<{ text: string; voiceId?: string }>, warned: [] as string[] }
  const deps: SynthDeps = {
    voiceIdFor: (speaker) => voice[speaker],
    dialogue: async (inputs) => {
      calls.dialogue.push(inputs)
      if (behave.dialogue) return behave.dialogue(inputs)
      return { ok: true, audio: 'TAKE', segments: inputs.map((_, input) => ({ input, startSec: input, endSec: input + 1 })) }
    },
    speak: async (text, voiceId) => {
      calls.speak.push({ text, voiceId })
      if (behave.speak) return behave.speak(text, voiceId)
      return { ok: true, audio: `SOLO:${text}` }
    },
    warn: (message) => { calls.warned.push(message) },
  }
  return { deps, calls }
}

describe('synthesis', () => {
  it('one dialogue call per run, with each line in its own voice; the announcer goes alone', async () => {
    const { deps, calls } = fakes()
    const lines = [line('announcer', 'station id'), line('mm', 'hi'), line('larry', 'what'), line('giovanni', 'am I on?')]
    const units = await synthesizeUnits(lines, deps)
    assert.equal(calls.dialogue.length, 1)
    assert.deepEqual(calls.dialogue[0], [
      { text: 'hi', voiceId: 'VOICE-MM' },
      { text: 'what', voiceId: 'VOICE-LARRY' },
      { text: 'am I on?', voiceId: 'VOICE-GIO' },
    ])
    assert.deepEqual(calls.speak, [{ text: 'station id', voiceId: 'VOICE-ANN' }])
    assert.deepEqual(units.map((u) => u.kind), ['line', 'take'])
    assert.equal((units[0] as Extract<RadioUnit, { kind: 'line' }>).line.audio, 'SOLO:station id')
    const take = units[1] as Extract<RadioUnit, { kind: 'take' }>
    assert.equal(take.audio, 'TAKE')
    assert.deepEqual(take.cues.map((c) => c.line.text), ['hi', 'what', 'am I on?'])
  })

  it('a failed call falls back to one call per line, everyone in their own voice', async () => {
    const { deps, calls } = fakes({ dialogue: async () => ({ ok: false, error: 'api-failed' }) })
    const lines = [line('mm', 'one'), line('larry', 'two'), line('mm', 'three')]
    const units = await synthesizeUnits(lines, deps)
    assert.equal(calls.dialogue.length, 1)
    assert.deepEqual(calls.speak.map((c) => c.voiceId), ['VOICE-MM', 'VOICE-LARRY', 'VOICE-MM'])
    assert.deepEqual(units.map((u) => (u.kind === 'line' ? u.line.text : 'TAKE')), ['one', 'two', 'three'])
  })

  it('an IPC that throws falls back too', async () => {
    const { deps } = fakes({ dialogue: async () => { throw new Error('channel gone') } })
    const units = await synthesizeUnits([line('mm', 'one')], deps)
    assert.deepEqual(units.map((u) => u.kind), ['line'])
  })

  it('a take back with no timing falls back: captions and trims need it', async () => {
    const { deps } = fakes({ dialogue: async () => ({ ok: true, audio: 'TAKE', segments: [] }) })
    const units = await synthesizeUnits([line('mm', 'one')], deps)
    assert.deepEqual(units.map((u) => u.kind), ['line'])
  })

  it('one dead voice cannot lose the rest of the break', async () => {
    // Bernard's voice 404s at ElevenLabs, and a dialogue call with a dead voice
    // fails whole. Everyone else still has to play, in order.
    const { deps, calls } = fakes({
      dialogue: async (inputs) => (inputs.some((i) => i.voiceId === 'VOICE-DEAD')
        ? { ok: false, error: 'api-failed' }
        : { ok: true, audio: 'TAKE', segments: [{ input: 0, startSec: 0, endSec: 1 }] }),
      speak: async (text, voiceId) => (voiceId === 'VOICE-DEAD'
        ? { ok: false, error: 'api-failed' }
        : { ok: true, audio: `SOLO:${text}` }),
    })
    const lines = [line('mm', 'we got Bernard'), line('bernard', 'with respect'), line('mm', 'go on'), line('larry', 'he stopped')]
    const units = await synthesizeUnits(lines, deps)
    assert.deepEqual(units.map((u) => (u.kind === 'line' ? u.line.text : 'TAKE')), ['we got Bernard', 'go on', 'he stopped'])
    assert.equal(calls.warned.filter((w) => w.includes('[bernard]')).length, 1, 'the drop is logged')
  })

  it('a speak call that throws drops only that line', async () => {
    const { deps, calls } = fakes({
      dialogue: async () => ({ ok: false, error: 'api-failed' }),
      speak: async (text) => {
        if (text === 'with respect') throw new Error('channel gone')
        return { ok: true, audio: `SOLO:${text}` }
      },
    })
    const units = await synthesizeUnits([line('mm', 'we got Bernard'), line('bernard', 'with respect'), line('larry', 'he stopped')], deps)
    assert.deepEqual(units.map((u) => (u.kind === 'line' ? u.line.text : 'TAKE')), ['we got Bernard', 'he stopped'])
    assert.equal(calls.warned.filter((w) => w.includes('[bernard]')).length, 1)
  })

  it('the voice switched off in Settings is not a failure: no fallback, nothing to play', async () => {
    const { deps, calls } = fakes({ dialogue: async () => ({ ok: true, audio: '' }), speak: async () => ({ ok: true, audio: '' }) })
    const units = await synthesizeUnits([line('announcer', 'id'), line('mm', 'one')], deps)
    assert.deepEqual(units, [])
    assert.equal(calls.speak.length, 1, 'only the announcer, who was always alone')
    assert.deepEqual(calls.warned, [])
  })

  it('order holds however the calls finish', async () => {
    const { deps } = fakes({
      speak: async (text) => {
        await new Promise((r) => setTimeout(r, text === 'late id' ? 20 : 0))
        return { ok: true, audio: text }
      },
    })
    const units = await synthesizeUnits([line('announcer', 'late id'), line('mm', 'one'), line('announcer', 'quick id')], deps)
    assert.deepEqual(units.map((u) => (u.kind === 'line' ? u.line.text : 'TAKE')), ['late id', 'TAKE', 'quick id'])
  })

  it('never more than 4 calls at once, however the fallback fans out', async () => {
    let active = 0
    let peak = 0
    const { deps } = fakes({
      dialogue: async () => ({ ok: false, error: 'x' }),
      speak: async (text) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 2))
        active -= 1
        return { ok: true, audio: text }
      },
    })
    await synthesizeUnits(Array.from({ length: 12 }, (_, i) => line('mm', `line ${i}`)), deps)
    assert.equal(peak, 4)
  })
})

describe('calls at once', () => {
  it('never more than 4, takes and announcer lines together', async () => {
    let active = 0
    let peak = 0
    const busy = async <T>(answer: T): Promise<T> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active -= 1
      return answer
    }
    const { deps, calls } = fakes({
      dialogue: (inputs) => busy({ ok: true, audio: 'TAKE', segments: inputs.map((_, input) => ({ input, startSec: 0, endSec: 1 })) }),
      speak: (text) => busy({ ok: true, audio: text }),
    })
    const lines = Array.from({ length: 12 }, (_, i) => [line('mm', `run ${i}`), line('announcer', `id ${i}`)]).flat()
    await synthesizeUnits(lines, deps)
    assert.equal(calls.dialogue.length, 12)
    assert.equal(calls.speak.length, 12)
    assert.equal(peak, 4)
  })
})

describe('captions from voice_segments', () => {
  const lines = [line('mm', 'one'), line('larry', 'two'), line('mm', 'three')]

  it('each line gets the time its input is speaking', () => {
    const cues = captionCues(lines, [
      { input: 0, startSec: 0, endSec: 7.12 },
      { input: 1, startSec: 7.12, endSec: 10.88 },
      { input: 2, startSec: 10.88, endSec: 13.28 },
    ])
    assert.deepEqual(cues.map((c) => [c.line.text, c.startSec, c.endSec]), [
      ['one', 0, 7.12],
      ['two', 7.12, 10.88],
      ['three', 10.88, 13.28],
    ])
  })

  it('more than one segment for a line is one cue, first start to last end', () => {
    const cues = captionCues(lines, [{ input: 1, startSec: 3, endSec: 4 }, { input: 1, startSec: 5, endSec: 6 }])
    assert.deepEqual(cues.map((c) => [c.line.text, c.startSec, c.endSec]), [['two', 3, 6]])
  })

  it('out of order comes back in time order; an input the run does not have is ignored', () => {
    const cues = captionCues(lines, [{ input: 2, startSec: 5, endSec: 6 }, { input: 9, startSec: 1, endSec: 2 }, { input: 0, startSec: 0, endSec: 5 }])
    assert.deepEqual(cues.map((c) => c.line.text), ['one', 'three'])
  })

  it('the caption changes when the clock reaches the cue, once each', () => {
    const cues: CaptionCue[] = [
      { line: lines[0], startSec: 0, endSec: 2 },
      { line: lines[1], startSec: 2, endSec: 4 },
      { line: lines[2], startSec: 4, endSec: 6 },
    ]
    const shown: string[] = []
    const follow = cueFollower(cues, (cue) => shown.push(cue.line.text))
    follow(0)
    assert.deepEqual(shown, ['one'])
    follow(1.99)
    assert.deepEqual(shown, ['one'])
    follow(2)
    assert.deepEqual(shown, ['one', 'two'])
    follow(2.5)
    assert.deepEqual(shown, ['one', 'two'], 'no replay')
    follow(1)
    assert.deepEqual(shown, ['one', 'two'], 'never back')
    follow(4.2)
    assert.deepEqual(shown, ['one', 'two', 'three'])
  })

  it('a late look (a throttled timer) jumps to the newest cue due', () => {
    const cues: CaptionCue[] = [
      { line: lines[0], startSec: 0, endSec: 2 },
      { line: lines[1], startSec: 2, endSec: 4 },
      { line: lines[2], startSec: 4, endSec: 6 },
    ]
    const shown: string[] = []
    const follow = cueFollower(cues, (cue) => shown.push(cue.line.text))
    follow(5)
    assert.deepEqual(shown, ['three'])
  })
})

/** Timers and an audio element you drive by hand. */
function fakeTake(cues: CaptionCue[], overrides: { playRejects?: boolean; live?: () => boolean } = {}) {
  const log: string[] = []
  let tick: (() => void) | null = null
  let pollMs: number | null = null
  const audio = {
    currentTime: 0,
    play: async () => {
      log.push('play')
      if (overrides.playRejects) throw new Error('refused')
    },
    onended: null as unknown,
    onerror: null as unknown,
  }
  let ready: () => void = () => {}
  const finish = startTake(audio, cues, {
    waitReady: () => new Promise<void>((resolve) => { ready = resolve }),
    live: overrides.live ?? (() => true),
    show: (cue) => log.push(`show:${cue.line.text}`),
    done: () => log.push('done'),
    every: (fn, ms) => { tick = fn; pollMs = ms; return 1 as unknown as ReturnType<typeof setInterval> },
    cancel: () => { tick = null; log.push('cancel') },
  })
  const flush = () => new Promise((r) => setImmediate(r))
  return { audio, log, finish, flush, ready: () => ready(), tick: () => tick?.(), ticking: () => tick !== null, pollMs: () => pollMs }
}

describe('playing a take', () => {
  const cues: CaptionCue[] = [
    { line: line('mm', 'one'), startSec: 0, endSec: 2 },
    { line: line('larry', 'two'), startSec: 2, endSec: 4 },
  ]

  it('first caption, then play, then the caption follows the clock', async () => {
    const t = fakeTake(cues)
    t.ready()
    await t.flush()
    assert.deepEqual(t.log, ['show:one', 'play'])
    t.audio.currentTime = 2.01
    t.tick()
    assert.deepEqual(t.log, ['show:one', 'play', 'show:two'])
  })

  it('the caption looks at the clock often enough to change on time', async () => {
    const t = fakeTake(cues)
    t.ready()
    await t.flush()
    assert.equal(t.pollMs(), CUE_POLL_MS)
    assert.equal(CUE_POLL_MS, 50)
  })

  it('ending settles it once and stops the clock', async () => {
    const t = fakeTake(cues)
    t.ready()
    await t.flush()
    ;(t.audio.onended as () => void)()
    ;(t.audio.onended as () => void)()
    assert.deepEqual(t.log, ['show:one', 'play', 'cancel', 'done'])
    assert.equal(t.ticking(), false)
  })

  it('stop mid-take settles it through the function finishCurrent holds, and no caption comes after', async () => {
    const t = fakeTake(cues)
    t.ready()
    await t.flush()
    t.finish()
    assert.deepEqual(t.log, ['show:one', 'play', 'cancel', 'done'])
    t.audio.currentTime = 3
    t.tick()
    assert.equal(t.log.includes('show:two'), false)
  })

  it('stop during the metadata wait neither captions nor plays, and still settles', async () => {
    let live = true
    const t = fakeTake(cues, { live: () => live })
    live = false
    t.finish()
    t.ready()
    await t.flush()
    assert.deepEqual(t.log, ['done'])
  })

  it('an element let go of without finish settles instead of playing', async () => {
    const t = fakeTake(cues, { live: () => false })
    t.ready()
    await t.flush()
    assert.deepEqual(t.log, ['done'])
  })

  it('a refused play settles it, so the break never hangs', async () => {
    const t = fakeTake(cues, { playRejects: true })
    t.ready()
    await t.flush()
    assert.deepEqual(t.log, ['show:one', 'play', 'cancel', 'done'])
  })

  it('an error during the metadata wait settles it, and it never plays', async () => {
    const t = fakeTake(cues)
    ;(t.audio.onerror as () => void)()
    t.ready()
    await t.flush()
    assert.deepEqual(t.log, ['done'])
  })

  it('a playback error settles it', async () => {
    const t = fakeTake(cues)
    t.ready()
    await t.flush()
    ;(t.audio.onerror as () => void)()
    assert.deepEqual(t.log, ['show:one', 'play', 'cancel', 'done'])
  })
})

describe('the sequencer', () => {
  const solo = (speaker: SpeakerId, text = speaker): RadioUnit => ({ kind: 'line', line: line(speaker, text) })
  const take = (...speakers: SpeakerId[]): RadioUnit => ({ kind: 'take', lines: speakers.map((s) => line(s, s)), audio: 'A', cues: [] })

  function run(units: RadioUnit[], stopWhen?: (entry: string) => boolean) {
    const log: string[] = []
    let stopped = false
    const note = (entry: string): void => {
      log.push(entry)
      if (stopWhen?.(entry)) stopped = true
    }
    return playUnits(units, {
      playTake: async (t) => note(`take:${t.lines.map((l) => l.speaker).join('+')}`),
      playLine: async (l) => note(`line:${l.speaker}`),
      sleep: async (ms) => note(`beat:${ms}`),
      isStopped: () => stopped,
    }).then(() => log)
  }

  it('the fallback leaves about 150 ms between speakers, none for the same speaker', async () => {
    assert.ok(SPEAKER_BEAT_MS >= 120 && SPEAKER_BEAT_MS <= 180)
    assert.deepEqual(await run([solo('mm'), solo('larry'), solo('larry'), solo('mm')]), [
      'line:mm', `beat:${SPEAKER_BEAT_MS}`, 'line:larry', 'line:larry', `beat:${SPEAKER_BEAT_MS}`, 'line:mm',
    ])
  })

  it('no beat around the announcer: he has stingers', async () => {
    assert.deepEqual(await run([solo('announcer'), take('mm', 'larry'), solo('announcer'), take('mm')]), [
      'line:announcer', 'take:mm+larry', 'line:announcer', 'take:mm',
    ])
  })

  it('a beat between two recordings hands from the last voice of one to the first of the next', async () => {
    assert.deepEqual(await run([take('mm', 'larry'), take('larry', 'mm'), take('larry')]), [
      'take:mm+larry', 'take:larry+mm', `beat:${SPEAKER_BEAT_MS}`, 'take:larry',
    ])
  })

  it('stop ends the sequence, during a unit or during a beat', async () => {
    assert.deepEqual(await run([take('mm'), solo('larry')], (e) => e === 'take:mm'), ['take:mm'])
    assert.deepEqual(await run([solo('mm'), solo('larry')], (e) => e.startsWith('beat')), ['line:mm', `beat:${SPEAKER_BEAT_MS}`])
  })
})

describe('the voice bug', () => {
  it('the cast the renderer gets carries the Music Man\'s real voice id', () => {
    const cast = radioCastForRenderer('REAL-MM-VOICE')
    assert.equal(cast.find((m) => m.id === 'mm')?.voiceId, 'REAL-MM-VOICE')
    assert.equal(cast.find((m) => m.id === 'larry')?.voiceId, LARRY_VOICE_ID)
    assert.ok(cast.every((m) => !!m.voiceId), 'nobody left to the active host\'s default')
    assert.equal(cast.length, RADIO_CAST.length)
    assert.deepEqual(Object.keys(cast[0]).sort(), ['id', 'kind', 'label', 'tag', 'voiceId'])
  })

  it('the Music Man\'s voice is ELEVENLABS_VOICE_ID, then the code default', () => {
    const saved = process.env.ELEVENLABS_VOICE_ID
    try {
      process.env.ELEVENLABS_VOICE_ID = 'FROM-ENV'
      assert.equal(musicManVoiceId(), 'FROM-ENV')
      delete process.env.ELEVENLABS_VOICE_ID
      assert.equal(musicManVoiceId(), 'ljX1ZrXuDIIRVcmiVSyR')
    } finally {
      if (saved === undefined) delete process.env.ELEVENLABS_VOICE_ID
      else process.env.ELEVENLABS_VOICE_ID = saved
    }
  })

  it('every caller still has a voice id; Bernard keeps his until Jake picks another', () => {
    assert.ok(Object.values(CALLERS).every((c) => !!c.voiceId))
    assert.equal(CALLERS.bernard.voiceId, 'Q0HZwrR1H2SmRvd5cX3U')
  })
})

/** Records nodes and connections, like the Web Audio calls buildAnnouncerFx makes. */
function fakeAudioContext() {
  const nodes: Array<Record<string, any>> = []
  const param = (value = 0) => ({ value })
  const node = (kind: string, extra: Record<string, unknown>) => {
    const n: Record<string, any> = { kind, targets: [] as unknown[], connect(to: unknown) { this.targets.push(to) }, ...extra }
    nodes.push(n)
    return n
  }
  return {
    nodes,
    sampleRate: 100,
    createGain: () => node('gain', { gain: param(1) }),
    createDynamicsCompressor: () => node('compressor', { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createBiquadFilter: () => node('biquad', { frequency: param(), gain: param(), Q: param() }),
    createConvolver: () => node('convolver', { buffer: null }),
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return { getChannelData: (c: number) => data[c] }
    },
  }
}

describe('the announcer chain', () => {
  it('output gain is about 0.7, the FX chain still in place, ending in the preamp', () => {
    assert.ok(ANNOUNCER_OUTPUT_GAIN >= 0.6 && ANNOUNCER_OUTPUT_GAIN <= 0.8, `gain ${ANNOUNCER_OUTPUT_GAIN}`)
    const ctx = fakeAudioContext()
    const preamp = { name: 'preamp' }
    const fx = buildAnnouncerFx(ctx as unknown as BaseAudioContext, preamp as unknown as AudioNode)
    assert.equal(fx.output.gain.value, ANNOUNCER_OUTPUT_GAIN)
    assert.deepEqual((fx.output as unknown as { targets: unknown[] }).targets, [preamp])
    const kinds = ctx.nodes.map((n) => n.kind)
    assert.equal(kinds.filter((k) => k === 'compressor').length, 1)
    assert.equal(kinds.filter((k) => k === 'convolver').length, 1)
    assert.equal(kinds.filter((k) => k === 'biquad').length, 3)
    assert.equal(ctx.nodes.find((n) => n.kind === 'compressor')?.threshold.value, -22)
    const ir = ctx.nodes.find((n) => n.kind === 'convolver')?.buffer as { getChannelData: (c: number) => Float32Array } | null
    assert.ok(ir, 'the reverb has its impulse response')
    // Decaying noise, not silence. The fake context runs at 100 Hz, so these are the
    // first and last 0.3 s.
    const energy = (from: number, to: number): number => ir.getChannelData(0).slice(from, to).reduce((sum, v) => sum + v * v, 0)
    assert.equal(ir.getChannelData(0).length, 150, '1.5 s')
    assert.ok(energy(0, 30) > 0.5, `early energy ${energy(0, 30)}`)
    assert.ok(energy(120, 150) < energy(0, 30) / 10, 'and it dies away')
    // The sound of the chain: input, dry, wet ("too wet sounds like a bathroom"), output.
    assert.deepEqual(ctx.nodes.filter((n) => n.kind === 'gain').map((n) => n.gain.value), [1, 0.85, 0.18, ANNOUNCER_OUTPUT_GAIN])
    const comp = ctx.nodes.find((n) => n.kind === 'compressor') as Record<string, { value: number }>
    assert.deepEqual([comp.knee.value, comp.ratio.value, comp.attack.value, comp.release.value], [10, 8, 0.002, 0.18])
    assert.deepEqual(ctx.nodes.filter((n) => n.kind === 'biquad').map((n) => [n.type, n.frequency.value, n.gain.value, n.Q.value]), [
      ['lowshelf', 180, 4, 0],
      ['peaking', 2800, 5, 0.7],
      ['highshelf', 8000, 2, 0],
    ])
    // Walk the graph from the input: every path goes through the compressor, the
    // three filters and the output, the wet one through the reverb as well.
    const paths = (from: Record<string, any>): string[][] => (from.targets ?? []).flatMap((to: Record<string, any>) => {
      if (!to.kind) return [[from.kind]]
      return paths(to).map((rest) => [from.kind, ...rest])
    })
    assert.deepEqual(paths(fx.input as unknown as Record<string, any>).map((path) => path.join('>')).sort(), [
      'gain>compressor>biquad>biquad>biquad>convolver>gain>gain',
      'gain>compressor>biquad>biquad>biquad>gain>gain',
    ])
  })
})

describe('the wires', () => {
  // The engine and the handlers run for real in radio-engine.test.ts and
  // speech-ipc.test.ts. These are what no test can call: the preload's channel
  // name, the renderer's types, and what must never come back.
  const aiIpc = read('main/ipc/ai-ipc.ts')

  it('the preload and the renderer\'s types carry the channel', () => {
    assert.match(read('preload/index.ts'), /radioDialogue: .*\n\s*ipcRenderer\.invoke\('radio-dialogue', inputs\)/)
    assert.match(read('renderer/types.ts'), /radioDialogue: \(inputs: DialogueInput\[\]\)/)
  })

  it('no pitch or speed on musicman-speak, and only mixtape talkovers still use the pitch chain', () => {
    assert.doesNotMatch(aiIpc, /voice-pitch|pitchShiftMp3|MUSIC_MAN_PITCH|MUSIC_MAN_SPEED/)
    assert.doesNotMatch(read('main/eleven-speech.ts'), /voice-pitch|pitchShiftMp3|asetrate|atempo/)
    const main = join(SRC, 'main')
    const users = readdirSync(main)
      .filter((f) => f.endsWith('.ts') && statSync(join(main, f)).isFile() && f !== 'voice-pitch.ts')
      .filter((f) => /from '\.\/voice-pitch/.test(readFileSync(join(main, f), 'utf-8')))
    assert.deepEqual(users, ['mixtapes.ts'])
  })

  it('v3, Turbo and the old switch are gone from every speech path', () => {
    for (const rel of ['main/ipc/ai-ipc.ts', 'main/eleven-speech.ts', 'main/cast.ts', 'renderer/radio/RadioEngine.ts', 'renderer/radio/one-take.ts']) {
      const source = read(rel)
      assert.doesNotMatch(source, /'eleven_v3'|'eleven_turbo_v2_5'|ELEVENLABS_V3/, rel)
    }
  })

  it('nobody teaches the prompts that v3 is performing them', () => {
    for (const rel of ['main/personas.ts', 'main/radio-script-prompt.ts', 'main/index.ts']) {
      assert.doesNotMatch(read(rel), /ElevenLabs v3|v3 performs|performed by v3|use v3 performance/, rel)
    }
  })
})
