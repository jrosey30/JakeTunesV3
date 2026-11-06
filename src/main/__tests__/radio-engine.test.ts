/**
 * The real RadioEngine.ts, run through its public calls. radio-one-take.test.ts covers
 * the decisions in one-take.ts; this covers what the engine does with them: the
 * voice each line asks for, what the pill is told, what the prefetch cache saves,
 * and what stop() lets go of.
 *
 * Fakes: IPC (window.electronAPI), the audio element, and the Web Audio and pill
 * modules at the import boundary (speech-test-hooks.mjs). The cast is the real one.
 * Time: a fixed sleep only before checking that something did NOT happen.
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { resolveObjectURL } from 'node:buffer'
import { CALLERS, RADIO_CAST_BY_ID, radioCastForRenderer } from '../cast.ts'
import { LARRY_VOICE_ID } from '../../common/cohost.ts'
import { CUE_POLL_MS, SPEAKER_BEAT_MS } from '../../renderer/radio/one-take.ts'
import { waitFor } from './wait-for.ts'

register('./speech-test-hooks.mjs', import.meta.url)
const { RadioEngine } = await import('../../renderer/radio/RadioEngine.ts')

const MM_VOICE = 'REAL-MM-VOICE'
const ANNOUNCER_VOICE = RADIO_CAST_BY_ID.announcer.voiceId
const REQ = { track: { title: 'Song', artist: 'Band', album: 'Album', genre: 'Rock', year: 1999 } }
const b64 = (text: string): string => Buffer.from(text).toString('base64')

type Effect = [string, ...unknown[]]
let effects: Effect[] = []
const named = (name: string): Effect[] => effects.filter((e) => e[0] === name)
const captions = (): Array<{ speaker: string; text: string; ms: number }> => named('caption').map(([, caption, ms]) => ({
  ...(caption as { speaker: string; text: string }),
  ms: Math.round(ms as number),
}))
const beatTaken = (): boolean => timeouts.includes(SPEAKER_BEAT_MS)

/** The parts of an audio element the engine touches, driven by hand. */
class FakeAudio {
  static made: FakeAudio[] = []
  /** Plays to its end by itself, for tests about what comes after. */
  static autoEnd = false
  /** NaN = its metadata hasn't arrived, so the engine has to wait for it. */
  static nextDuration = 12
  /** The browser says no to play(). */
  static refusePlay = false

  currentTime = 0
  duration = FakeAudio.nextDuration
  paused = true
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string
  readonly bytes: Promise<string>
  private listeners = new Map<string, Set<() => void>>()

  constructor(url: string) {
    this.url = url
    // The real audioFromBase64Mpeg made this url: read back what it decoded.
    const blob = resolveObjectURL(url)
    assert.ok(blob, 'a blob url')
    this.bytes = blob.text()
    FakeAudio.made.push(this)
  }

  listening(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(fn)
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }

  play(): Promise<void> {
    this.paused = false
    effects.push(['play', this])
    if (FakeAudio.refusePlay) return Promise.reject(new Error('refused'))
    if (FakeAudio.autoEnd) setImmediate(() => this.end())
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
    effects.push(['pause', this])
  }

  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }

  end(): void {
    this.paused = true
    this.fire('ended')
    this.onended?.()
  }

  fail(): void {
    this.paused = true
    this.fire('error')
    this.onerror?.()
  }
}

interface Behave {
  script?: string | null
  dialogue?: (inputs: Array<{ text: string; voiceId: string }>) => Promise<unknown>
  speak?: (text: string, fast: boolean | undefined, voiceId: string | undefined) => Promise<unknown>
}

/** Fake IPC with every call recorded. By default a run's lines take 2 s each. */
function fakeApi(behave: Behave = {}) {
  const calls = {
    radio: [] as unknown[][],
    dialogue: [] as Array<Array<{ text: string; voiceId: string }>>,
    speak: [] as Array<{ text: string; fast: boolean | undefined; voiceId: string | undefined }>,
  }
  ;(globalThis as Record<string, unknown>).window = {
    electronAPI: {
      radioGetCast: async () => ({ ok: true, cast: radioCastForRenderer(MM_VOICE) }),
      musicmanRadio: async (...args: unknown[]) => {
        calls.radio.push(args)
        return behave.script === null ? { ok: false, text: '' } : { ok: true, text: behave.script ?? '[MM] One.\n[LARRY] Two.' }
      },
      radioDialogue: async (inputs: Array<{ text: string; voiceId: string }>) => {
        calls.dialogue.push(inputs)
        if (behave.dialogue) return behave.dialogue(inputs)
        return { ok: true, audio: b64('THE TAKE'), segments: inputs.map((_, input) => ({ input, startSec: input * 2, endSec: (input + 1) * 2 })) }
      },
      musicmanSpeak: async (text: string, fast: boolean | undefined, voiceId: string | undefined) => {
        calls.speak.push({ text, fast, voiceId })
        if (behave.speak) return behave.speak(text, fast, voiceId)
        return { ok: true, audio: b64(`SOLO ${text}`) }
      },
    },
  }
  return calls
}

async function newEngine(behave: Behave = {}) {
  const calls = fakeApi(behave)
  const engine = new RadioEngine()
  await engine.init()
  return { engine, calls }
}

const playing = (index = 0): Promise<FakeAudio> => waitFor(() => {
  const audio = FakeAudio.made[index]
  return audio && !audio.paused ? audio : null
}, `audio ${index} to start`)

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(() => { done = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return done
}

let timeouts: number[] = []
const realSetTimeout = globalThis.setTimeout
const realWarn = console.warn

beforeEach(() => {
  effects = []
  timeouts = []
  console.warn = () => {} // the fallback paths warn, on purpose
  FakeAudio.made = []
  FakeAudio.autoEnd = false
  FakeAudio.nextDuration = 12
  FakeAudio.refusePlay = false
  ;(globalThis as Record<string, unknown>).__radioEffects = (...effect: Effect) => { effects.push(effect) }
  ;(globalThis as Record<string, unknown>).Audio = FakeAudio
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    timeouts.push(ms ?? 0)
    return realSetTimeout(fn, ms, ...rest)
  }) as typeof setTimeout
})

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  console.warn = realWarn
})

describe('a script becomes speech', () => {
  it('a run goes to main as one call, each line in its own speaker\'s real voice', async () => {
    const { engine, calls } = await newEngine({ script: '[MM] [softer] One.\n[LARRY] Two.\n[GIOVANNI] Am I on?' })
    const seg = await engine.generateSegment(REQ)
    assert.ok(seg)
    await engine.synthesize(seg)
    assert.deepEqual(calls.dialogue, [[
      { text: '[softer] One.', voiceId: MM_VOICE },
      { text: 'Two.', voiceId: LARRY_VOICE_ID },
      { text: 'Am I on?', voiceId: CALLERS.giovanni.voiceId },
    ]])
    assert.deepEqual(calls.speak, [])
    assert.deepEqual(seg.units?.map((u) => u.kind), ['take'])
  })

  it('the announcer goes alone, in his voice, off the Scotus fast path', async () => {
    const { engine, calls } = await newEngine({ script: '[ANNOUNCER] WJLR.\n[MM] One.' })
    const seg = await engine.generateSegment(REQ)
    assert.ok(seg)
    await engine.synthesize(seg)
    assert.deepEqual(calls.speak, [{ text: 'WJLR.', fast: false, voiceId: ANNOUNCER_VOICE }])
    assert.deepEqual(calls.dialogue, [[{ text: 'One.', voiceId: MM_VOICE }]])
    assert.deepEqual(seg.units?.map((u) => u.kind), ['line', 'take'])
  })

  it('a failed take is spoken line by line, each in its own voice, off the fast path', async () => {
    const { engine, calls } = await newEngine({ dialogue: async () => ({ ok: false, error: 'api-failed' }) })
    const seg = await engine.generateSegment(REQ)
    assert.ok(seg)
    await engine.synthesize(seg)
    assert.deepEqual(calls.speak, [
      { text: 'One.', fast: false, voiceId: MM_VOICE },
      { text: 'Two.', fast: false, voiceId: LARRY_VOICE_ID },
    ])
    assert.deepEqual(seg.units?.map((u) => u.kind), ['line', 'line'])
  })

  it('a generator that failed is believed, whatever text came with it', async () => {
    const { engine } = await newEngine()
    const api = (globalThis as unknown as { window: { electronAPI: { musicmanRadio: unknown } } }).window.electronAPI
    api.musicmanRadio = async () => ({ ok: false, text: '[MM] Half a thought.' })
    assert.equal(await engine.generateSegment(REQ), null)
  })

  it('a script with no speaker in it is no break', async () => {
    const { engine } = await newEngine({ script: 'Nobody is tagged in this at all.\n[NOBODY] Or this.' })
    assert.equal(await engine.generateSegment(REQ), null)
  })

  it('each break has its own id', async () => {
    const { engine } = await newEngine()
    const [one, two] = [await engine.generateSegment(REQ), await engine.generateSegment(REQ)]
    assert.equal(one?.id, 'seg-1')
    assert.equal(two?.id, 'seg-2')
  })

  it('the script\'s tags pick the speakers: any case, stray lines fold into the line before', async () => {
    const { engine } = await newEngine({ script: 'nobody said this\n[mm] One.\nstill one.\n\n[LaRRy] Two.' })
    const seg = await engine.generateSegment(REQ)
    assert.deepEqual(seg?.lines, [{ speaker: 'mm', text: 'One. still one.' }, { speaker: 'larry', text: 'Two.' }])
  })
})

describe('what plays', () => {
  it('a take plays its own bytes through the clip routing, with no stingers, then lets go', async () => {
    const { engine } = await newEngine()
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    assert.equal(await audio.bytes, 'THE TAKE')
    assert.deepEqual(effects.filter((e) => e[0] !== 'caption').map((e) => e[0]), ['attachClip', 'play'])
    assert.equal(effects[0][1], audio)
    audio.end()
    assert.equal(await done, true)
    assert.deepEqual(named('detach'), [['detach', audio]])
    assert.deepEqual(named('stinger'), [])
    assert.deepEqual(named('attachAnnouncer'), [])
  })

  it('a take lets go of its memory when it ends or errors', async () => {
    const { engine } = await newEngine()
    const ended = engine.handleTransition(REQ, 'k')
    const first = await playing()
    assert.ok(resolveObjectURL(first.url), 'held while it plays')
    first.end()
    await ended
    assert.equal(resolveObjectURL(first.url), undefined)

    const errored = engine.handleTransition(REQ, 'k')
    const second = await playing(1)
    second.fail()
    await errored
    assert.equal(resolveObjectURL(second.url), undefined)
  })

  it('a line on its own (the fallback) plays through the clip routing with no stingers', async () => {
    FakeAudio.autoEnd = true
    const { engine } = await newEngine({ script: '[MM] One.', dialogue: async () => ({ ok: false }) })
    assert.equal(await engine.handleTransition(REQ, 'k'), true)
    assert.equal(await FakeAudio.made[0].bytes, 'SOLO One.')
    assert.deepEqual(named('attachClip').map((e) => e[1]), [FakeAudio.made[0]])
    assert.deepEqual(named('stinger'), [])
  })

  it('the announcer keeps his FX chain and both stingers', async () => {
    const { engine } = await newEngine({ script: '[ANNOUNCER] WJLR.' })
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    assert.equal(await audio.bytes, 'SOLO WJLR.')
    assert.deepEqual(named('attachAnnouncer').map((e) => e[1]), [audio])
    assert.deepEqual(named('attachClip'), [])
    assert.deepEqual(named('stinger'), [['stinger', 'pre-stinger']])
    assert.deepEqual(captions(), [{ speaker: 'WJLR', text: 'WJLR.', ms: 12_000 }])
    audio.end()
    assert.equal(await done, true)
    assert.deepEqual(named('stinger'), [['stinger', 'pre-stinger'], ['stinger', 'end-stinger']])
    assert.deepEqual(named('detach').map((e) => e[1]), [audio])
  })

  // Each of these used to leave the caller waiting for good: the next song never starts.
  for (const [who, script] of [['a host\'s line', '[LARRY] Two.'], ['the announcer', '[ANNOUNCER] WJLR.']] as const) {
    it(`${who} that errors or is refused settles, and the break goes on`, async () => {
      const { engine } = await newEngine({ script, dialogue: async () => ({ ok: false }) })
      const errored = engine.handleTransition(REQ, 'k')
      const audio = await playing()
      audio.onerror?.()
      assert.equal(await errored, true)

      FakeAudio.refusePlay = true
      assert.equal(await engine.handleTransition(REQ, 'k'), true)
      assert.equal(FakeAudio.made.length, 2)
    })
  }

  it('in order: the announcer, then the take, with no beat around him', async () => {
    FakeAudio.autoEnd = true
    const { engine } = await newEngine({ script: '[ANNOUNCER] WJLR.\n[MM] One.\n[LARRY] Two.' })
    assert.equal(await engine.handleTransition(REQ, 'k'), true)
    assert.equal(await FakeAudio.made[0].bytes, 'SOLO WJLR.')
    assert.equal(await FakeAudio.made[1].bytes, 'THE TAKE')
    assert.equal(FakeAudio.made.length, 2)
    assert.equal(beatTaken(), false)
  })

  it('one dead voice: everyone else plays, in order, with a beat between speakers', async () => {
    FakeAudio.autoEnd = true
    const dead = CALLERS.bernard.voiceId
    const { engine, calls } = await newEngine({
      script: '[MM] We got Bernard.\n[BERNARD] With respect.\n[LARRY] He stopped.',
      dialogue: async () => ({ ok: false, error: 'api-failed' }),
      speak: async (text, _fast, voiceId) => (voiceId === dead ? { ok: false, error: 'api-failed' } : { ok: true, audio: b64(`SOLO ${text}`) }),
    })
    assert.equal(await engine.handleTransition(REQ, 'k'), true)
    assert.equal(calls.speak.length, 3)
    assert.deepEqual(await Promise.all(FakeAudio.made.map((a) => a.bytes)), ['SOLO We got Bernard.', 'SOLO He stopped.'])
    assert.equal(beatTaken(), true)
  })
})

describe('what the pill is told', () => {
  it('each speaker\'s label, the words with no tags, for as long as that line lasts', async () => {
    const { engine } = await newEngine({
      script: '[MM] [softer] One [laughs] more.\n[LARRY] Two.',
      dialogue: async () => ({ ok: true, audio: b64('THE TAKE'), segments: [{ input: 0, startSec: 0, endSec: 7.12 }, { input: 1, startSec: 7.12, endSec: 10.88 }] }),
    })
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    assert.deepEqual(captions(), [{ speaker: 'The Music Man', text: 'One more.', ms: 7120 }])
    audio.currentTime = 7.2
    await waitFor(() => captions().length === 2, 'the second caption')
    assert.deepEqual(captions()[1], { speaker: 'Larry', text: 'Two.', ms: 3760 })
    audio.end()
    await done
  })

  it('a take\'s line remembers how long it lasted', async () => {
    const { engine } = await newEngine()
    const seg = await engine.generateSegment(REQ)
    assert.ok(seg)
    await engine.synthesize(seg)
    const done = engine.playSegment(seg)
    const audio = await playing()
    assert.equal(seg.lines[0].durationMs, 2000)
    assert.equal(seg.lines[1].durationMs, undefined, 'not yet: it has not started')
    audio.currentTime = 2
    await waitFor(() => captions().length === 2, 'the second caption')
    assert.equal(seg.lines[1].durationMs, 2000)
    audio.end()
    await done
  })

  it('metadata that never comes: a second later it plays anyway, and the break goes on', async () => {
    FakeAudio.nextDuration = NaN
    const { engine } = await newEngine()
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    assert.deepEqual(captions()[0], { speaker: 'The Music Man', text: 'One.', ms: 2000 })
    audio.end()
    assert.equal(await done, true)
  })

  it('metadata that comes late: a line waits for it, then captions from it', async () => {
    FakeAudio.nextDuration = NaN
    const { engine } = await newEngine({ script: '[LARRY] Two.', dialogue: async () => ({ ok: false }) })
    const done = engine.handleTransition(REQ, 'k')
    const audio = await waitFor(() => FakeAudio.made[0], 'the line to load')
    assert.equal(audio.listening('loadedmetadata'), 1, 'it is listening for it')
    assert.deepEqual(captions(), [], 'nothing to go on yet')
    assert.deepEqual(named('play'), [])
    audio.duration = 5
    audio.fire('loadedmetadata')
    await playing()
    assert.equal(audio.listening('loadedmetadata'), 0, 'and has stopped listening')
    assert.deepEqual(captions(), [{ speaker: 'Larry', text: 'Two.', ms: 5000 }])
    audio.end()
    await done
  })

  it('a line on its own with no metadata gets a three-second caption and still plays', async () => {
    FakeAudio.nextDuration = NaN
    const { engine } = await newEngine({ script: '[LARRY] Two.', dialogue: async () => ({ ok: false }) })
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    assert.deepEqual(captions(), [{ speaker: 'Larry', text: 'Two.', ms: 3000 }])
    audio.end()
    await done
  })

  it('a caption can\'t change a cue early, and looks at the clock often enough to be on time', async () => {
    assert.ok(CUE_POLL_MS <= 100, `polling every ${CUE_POLL_MS} ms`)
    const { engine } = await newEngine()
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    audio.currentTime = 1.9
    await new Promise((resolve) => setTimeout(resolve, CUE_POLL_MS * 3))
    assert.equal(captions().length, 1, 'still the first line')
    audio.end()
    await done
  })

  it('a line on its own gets a caption that lasts as long as its clip, and remembers it', async () => {
    FakeAudio.nextDuration = 5
    const { engine } = await newEngine({ script: '[LARRY] [scoffs] Two.', dialogue: async () => ({ ok: false }) })
    const seg = await engine.generateSegment(REQ)
    assert.ok(seg)
    await engine.synthesize(seg)
    const done = engine.playSegment(seg)
    const audio = await playing()
    assert.deepEqual(captions(), [{ speaker: 'Larry', text: 'Two.', ms: 5000 }])
    assert.equal(seg.lines[0].durationMs, 5000)
    audio.end()
    await done
  })
})

describe('prefetch and transition', () => {
  it('a prefetched break plays with no second generation and no second voice call', async () => {
    FakeAudio.autoEnd = true
    const { engine, calls } = await newEngine()
    await engine.prefetch(REQ, 'k')
    assert.equal(calls.radio.length, 1)
    assert.equal(calls.dialogue.length, 1)
    assert.equal(FakeAudio.made.length, 0, 'nothing plays until the transition')
    assert.equal(await engine.handleTransition(REQ, 'k'), true)
    assert.equal(calls.radio.length, 1)
    assert.equal(calls.dialogue.length, 1)
    assert.equal(await FakeAudio.made[0].bytes, 'THE TAKE')
  })

  it('a prefetched break plays once: the next transition generates its own', async () => {
    FakeAudio.autoEnd = true
    const { engine, calls } = await newEngine()
    await engine.prefetch(REQ, 'k')
    await engine.handleTransition(REQ, 'k')
    await engine.handleTransition(REQ, 'k')
    assert.equal(calls.radio.length, 2)
    assert.equal(FakeAudio.made.length, 2)
  })

  it('two prefetches of one key make one break', async () => {
    const { engine, calls } = await newEngine()
    await Promise.all([engine.prefetch(REQ, 'k'), engine.prefetch(REQ, 'k')])
    assert.equal(calls.radio.length, 1)
    assert.equal(calls.dialogue.length, 1)
  })

  it('a key already cached isn\'t fetched again; once played, it can be', async () => {
    FakeAudio.autoEnd = true
    const { engine, calls } = await newEngine()
    await engine.prefetch(REQ, 'k')
    await engine.prefetch(REQ, 'k')
    assert.equal(calls.radio.length, 1)
    await engine.handleTransition(REQ, 'k')
    await engine.prefetch(REQ, 'k')
    assert.equal(calls.radio.length, 2)
  })

  it('a prefetch that fails caches nothing, and the key can be tried again', async () => {
    const { engine, calls } = await newEngine()
    const api = (globalThis as unknown as { window: { electronAPI: { musicmanRadio: unknown } } }).window.electronAPI
    const working = api.musicmanRadio
    api.musicmanRadio = async () => { throw new Error('channel gone') }
    await engine.prefetch(REQ, 'k')
    api.musicmanRadio = working
    await engine.prefetch(REQ, 'k')
    assert.equal(calls.radio.length, 1, 'the second try reached the generator')
    assert.equal(calls.dialogue.length, 1)
  })

  it('a break with nothing to play isn\'t cached: the transition generates again', async () => {
    FakeAudio.autoEnd = true
    let voiced = false
    const { engine, calls } = await newEngine({
      dialogue: async (inputs) => (voiced
        ? { ok: true, audio: b64('THE TAKE'), segments: inputs.map((_, input) => ({ input, startSec: input, endSec: input + 1 })) }
        : { ok: true, audio: '' }),
    })
    await engine.prefetch(REQ, 'k')
    voiced = true
    assert.equal(await engine.handleTransition(REQ, 'k'), true)
    assert.equal(calls.radio.length, 2)
  })

  it('nothing prefetched: generate, voice and play, and the answer waits for the audio', async () => {
    const { engine, calls } = await newEngine()
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    assert.equal(calls.radio.length, 1)
    assert.equal(await settled(done), false, 'the next song waits for the break to end')
    audio.end()
    assert.equal(await done, true)
  })

  it('the generator has nothing: the answer is false and nothing plays', async () => {
    const { engine } = await newEngine({ script: null })
    assert.equal(await engine.handleTransition(REQ, 'k'), false)
    assert.equal(await engine.playOpener(REQ), false)
    assert.equal(FakeAudio.made.length, 0)
  })

  it('the voice is off in Settings: the answer is false and nothing plays', async () => {
    const { engine } = await newEngine({ dialogue: async () => ({ ok: true, audio: '' }) })
    assert.equal(await engine.handleTransition(REQ, 'k'), false)
    assert.equal(await engine.playOpener(REQ), false)
    assert.equal(FakeAudio.made.length, 0)
  })

  it('the opener asks for an opener, voices it and plays it', async () => {
    FakeAudio.autoEnd = true
    const { engine, calls } = await newEngine()
    assert.equal(await engine.playOpener(REQ), true)
    assert.equal(calls.radio[0][2], true, 'the generator\'s opener flag')
    assert.equal(await FakeAudio.made[0].bytes, 'THE TAKE')
  })
})

describe('stop', () => {
  it('mid-take: the audio pauses, the routing lets go, the caller is released, nothing else plays or captions', async () => {
    const { engine } = await newEngine({ script: '[MM] One.\n[LARRY] Two.\n[ANNOUNCER] WJLR.\n[MM] Three.' })
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    const captionsBefore = captions().length
    engine.stop()
    assert.equal(audio.paused, true)
    assert.ok(named('detach').some((e) => e[1] === audio))
    assert.deepEqual(named('radio'), [['radio', null]], 'the pill status clears')
    assert.equal(await done, true, 'the caller is not left hanging')
    audio.currentTime = 3
    await new Promise((resolve) => setTimeout(resolve, CUE_POLL_MS * 3))
    assert.equal(FakeAudio.made.length, 1, 'the next unit never starts')
    assert.equal(captions().length, captionsBefore, 'no caption after stop')
  })

  it('stop then a later ended event does nothing twice', async () => {
    const { engine } = await newEngine()
    const done = engine.handleTransition(REQ, 'k')
    const audio = await playing()
    engine.stop()
    await done
    const detaches = named('detach').length
    audio.onended?.()
    assert.equal(named('detach').length, detaches)
  })

  for (const [who, script] of [['a host\'s line', '[LARRY] Two.'], ['the announcer', '[ANNOUNCER] WJLR.']] as const) {
    it(`mid-line, ${who}: the audio pauses, the routing lets go, the caller is released`, async () => {
      const { engine } = await newEngine({ script, dialogue: async () => ({ ok: false }) })
      const done = engine.handleTransition(REQ, 'k')
      const audio = await playing()
      engine.stop()
      assert.equal(audio.paused, true)
      assert.ok(named('detach').some((e) => e[1] === audio))
      assert.equal(await done, true)
    })
  }

  for (const [who, script] of [['a host\'s line', '[LARRY] Two.'], ['the announcer', '[ANNOUNCER] WJLR.']] as const) {
    it(`during the metadata wait, ${who}: no caption, no play, and the caller is released`, async () => {
      FakeAudio.nextDuration = NaN
      const { engine } = await newEngine({ script, dialogue: async () => ({ ok: false }) })
      const done = engine.handleTransition(REQ, 'k')
      const audio = await waitFor(() => FakeAudio.made[0], 'the line to load')
      engine.stop()
      audio.fire('loadedmetadata')
      assert.equal(await done, true)
      await new Promise((resolve) => setTimeout(resolve, 150)) // past the stinger's wait
      assert.deepEqual(captions(), [])
      assert.deepEqual(named('play'), [])
    })

    it(`stop then a later ended event, ${who}: it settles once`, async () => {
      const { engine } = await newEngine({ script, dialogue: async () => ({ ok: false }) })
      const done = engine.handleTransition(REQ, 'k')
      const audio = await playing()
      engine.stop()
      await done
      const detaches = named('detach').length
      audio.onended?.()
      await new Promise((resolve) => setTimeout(resolve, 250)) // past the announcer's end-of-line wait
      assert.equal(named('detach').length, detaches)
    })
  }

  it('during the metadata wait: no caption, no play, and the caller is released', async () => {
    FakeAudio.nextDuration = NaN
    const { engine } = await newEngine()
    const done = engine.handleTransition(REQ, 'k')
    const audio = await waitFor(() => FakeAudio.made[0], 'the take to load')
    engine.stop()
    audio.fire('loadedmetadata')
    assert.equal(await done, true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(audio.paused, true)
    assert.deepEqual(captions(), [])
    assert.deepEqual(named('play'), [])
  })

  it('during the announcer\'s stinger: he never starts, and the caller is released', async () => {
    const { engine } = await newEngine({ script: '[ANNOUNCER] WJLR.' })
    const done = engine.handleTransition(REQ, 'k')
    await waitFor(() => named('stinger').length === 1, 'the opening stinger')
    engine.stop()
    assert.equal(await done, true)
    await new Promise((resolve) => setTimeout(resolve, 150)) // past the stinger's wait
    assert.deepEqual(named('play'), [])
  })

  it('during the beat between two fallback lines: the second never starts', async () => {
    const { engine } = await newEngine({ dialogue: async () => ({ ok: false }) })
    const done = engine.handleTransition(REQ, 'k')
    const first = await playing()
    first.end()
    await waitFor(() => beatTaken(), 'the beat')
    engine.stop()
    assert.equal(await done, true)
    assert.equal(FakeAudio.made.length, 1)
  })

  it('drops the prefetched break, and the next transition generates a new one', async () => {
    FakeAudio.autoEnd = true
    const { engine, calls } = await newEngine()
    await engine.prefetch(REQ, 'k')
    engine.stop()
    assert.equal(await engine.handleTransition(REQ, 'k'), true)
    assert.equal(calls.radio.length, 2)
    assert.equal(FakeAudio.made.length, 1)
  })

  it('forgets a prefetch still running, so the next one can start', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { engine, calls } = await newEngine({
      dialogue: async (inputs) => {
        await gate
        return { ok: true, audio: b64('THE TAKE'), segments: inputs.map((_, input) => ({ input, startSec: input, endSec: input + 1 })) }
      },
    })
    const first = engine.prefetch(REQ, 'k')
    await waitFor(() => calls.dialogue.length === 1, 'the first prefetch to reach the voice')
    engine.stop()
    const second = engine.prefetch(REQ, 'k')
    await waitFor(() => calls.dialogue.length === 2, 'the second prefetch to reach the voice')
    release()
    await Promise.all([first, second])
    assert.equal(calls.radio.length, 2)
  })

  it('the radio can start again after a stop', async () => {
    const { engine } = await newEngine()
    const first = engine.handleTransition(REQ, 'k')
    await playing()
    engine.stop()
    await first
    FakeAudio.autoEnd = true
    assert.equal(await engine.playOpener(REQ), true)
    assert.equal(FakeAudio.made.length, 2)
    assert.equal(FakeAudio.made[1].paused, true, 'it played to its end')
    assert.deepEqual(named('play').map((e) => e[1]), [FakeAudio.made[0], FakeAudio.made[1]])
  })

  it('a newer recording takes over: the one it replaced, still loading, never starts', async () => {
    const { engine } = await newEngine()
    FakeAudio.nextDuration = NaN
    const older = await engine.generateSegment(REQ)
    assert.ok(older)
    await engine.synthesize(older)
    const olderDone = engine.playSegment(older)
    const olderAudio = await waitFor(() => FakeAudio.made[0], 'the older take to load')
    FakeAudio.nextDuration = 12
    const newer = await engine.generateSegment(REQ)
    assert.ok(newer)
    await engine.synthesize(newer)
    const newerDone = engine.playSegment(newer)
    const newerAudio = await playing(1)
    olderAudio.fire('loadedmetadata')
    await olderDone
    assert.equal(olderAudio.paused, true)
    assert.ok(named('detach').some((e) => e[1] === olderAudio), 'it lets go of its routing')
    newerAudio.end()
    await newerDone
  })
})
