/**
 * The speech door (eleven-speech.ts): every voice but Scotus on eleven_v4 through
 * the dialogue endpoint, the same settings for everyone, 429s waited out on the
 * same model, long text split and joined, one fixed trim per voice by time range.
 * Network is a fake; ffmpeg is real where the question is what it does to audio
 * (skipped on a machine without it).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DIALOGUE_URL,
  FAST_MODEL,
  SPEECH_MODEL,
  SPEECH_SETTINGS,
  VOICE_TRIM_DB,
  finishFilter,
  finishTake,
  gainExpression,
  gainTimeline,
  retryAfterMs,
  sendWithRetry,
  snapToQuiet,
  speakFast,
  speakTake,
  speakText,
  splitForDialogue,
  voiceTrimDb,
  type SpeechDeps,
} from '../eleven-speech.ts'
import { MAX_DIALOGUE_CHARS } from '../../common/speech.ts'
import { LARRY_VOICE_ID } from '../../common/cohost.ts'

const MM = '3q3z1RplmzZ5UT7BUP61'
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

function takeResponse(segments: unknown[] = [], audio = Buffer.from('fake-mp3')): Response {
  return new Response(JSON.stringify({ audio_base64: audio.toString('base64'), voice_segments: segments }), { status: 200 })
}

interface Sent { url: string; body: Record<string, any>; apiKey: string | null; contentType: string | null }

/** Fake network: answers from a list (the last answer repeats), records every request. */
function fakeDeps(answers: Array<() => Response | Promise<Response>>, overrides: Partial<SpeechDeps> = {}): SpeechDeps & { sent: Sent[]; slept: number[]; signals: unknown[] } {
  const sent: Sent[] = []
  const slept: number[] = []
  const signals: unknown[] = []
  let i = 0
  return {
    sent,
    slept,
    signals,
    fetch: (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      sent.push({ url, body: JSON.parse(String(init.body)), apiKey: headers.get('xi-api-key'), contentType: headers.get('content-type') })
      signals.push(init.signal)
      const answer = answers[Math.min(i, answers.length - 1)]
      i += 1
      return answer()
    }) as unknown as typeof fetch,
    sleep: async (ms: number) => { slept.push(ms) },
    ffmpeg: async () => { throw new Error('no ffmpeg in this test') },
    ...overrides,
  }
}

const silenceWarnings = <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn
  console.warn = () => {}
  return fn().finally(() => { console.warn = warn })
}

describe('the request', () => {
  it('a take is the dialogue endpoint, eleven_v4, the chosen settings, the inputs in order', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    const deps = fakeDeps([() => takeResponse([
      { voice_id: MM, start_time_seconds: 0, end_time_seconds: 2, character_start_index: 0, character_end_index: 5, dialogue_input_index: 0 },
    ])])
    await silenceWarnings(() => speakTake([{ text: 'One.', voiceId: MM }, { text: 'Two.', voiceId: LARRY_VOICE_ID }], deps))
    assert.equal(deps.sent.length, 1)
    assert.equal(deps.sent[0].url, 'https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps')
    assert.equal(deps.sent[0].apiKey, 'test-key')
    assert.deepEqual(deps.sent[0].body, {
      inputs: [{ text: 'One.', voice_id: MM }, { text: 'Two.', voice_id: LARRY_VOICE_ID }],
      model_id: 'eleven_v4',
      settings: { stability: 0.47, similarity: 0.66 },
    })
  })

  it('one voice uses the same endpoint, model and settings with one input', async () => {
    const deps = fakeDeps([() => takeResponse()])
    await silenceWarnings(() => speakText('Hello there.', LARRY_VOICE_ID, deps))
    assert.equal(deps.sent[0].url, DIALOGUE_URL)
    assert.equal(deps.sent[0].body.model_id, SPEECH_MODEL)
    assert.deepEqual(deps.sent[0].body.settings, SPEECH_SETTINGS)
    assert.deepEqual(deps.sent[0].body.inputs, [{ text: 'Hello there.', voice_id: LARRY_VOICE_ID }])
  })

  it('the fast path stays on flash and text-to-speech, with no finishing step', async () => {
    const deps = fakeDeps([() => new Response(Buffer.from('flash-mp3'), { status: 200 })])
    const audio = await speakFast('May it please the court.', 'SCOTUSVOICE', deps)
    assert.equal(FAST_MODEL, 'eleven_flash_v2_5')
    assert.equal(deps.sent[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/SCOTUSVOICE')
    assert.equal(deps.sent[0].body.model_id, 'eleven_flash_v2_5')
    assert.deepEqual(deps.sent[0].body.voice_settings, { stability: 0.2, similarity_boost: 0.7, style: 0.85, use_speaker_boost: true })
    assert.equal(audio.toString(), 'flash-mp3')
  })

  it('every call says it is JSON and gives up on a hung answer, by how much it asked for', async () => {
    const asked: number[] = []
    const realTimeout = AbortSignal.timeout
    AbortSignal.timeout = (ms: number) => { asked.push(ms); return realTimeout.call(AbortSignal, ms) }
    try {
      const deps = fakeDeps([() => takeResponse([{ voice_id: MM, start_time_seconds: 0, end_time_seconds: 1, dialogue_input_index: 0 }])])
      await silenceWarnings(() => speakTake([{ text: 'x'.repeat(100), voiceId: MM }, { text: 'y'.repeat(100), voiceId: MM }], deps))
      await silenceWarnings(() => speakText('x'.repeat(2000), MM, deps))
      const fast = fakeDeps([() => new Response(Buffer.from('flash-mp3'), { status: 200 })])
      await speakFast('z'.repeat(100), 'SCOTUSVOICE', fast)
      assert.deepEqual(asked, [60_000, 180_000, 45_000], '30 s + 150 ms a character, never past 3 minutes')
      for (const d of [deps, fast]) {
        assert.ok(d.signals.every((signal) => signal instanceof AbortSignal))
        assert.ok(d.sent.every((request) => request.contentType === 'application/json'))
      }
    } finally {
      AbortSignal.timeout = realTimeout
    }
  })

  it('a take with no voice_segments fails, so the renderer falls back instead of captioning blind', async () => {
    const deps = fakeDeps([() => takeResponse([])])
    await assert.rejects(() => speakTake([{ text: 'One.', voiceId: MM }], deps), /voice_segments/)
  })

  it('a take with no audio fails: an empty answer would read as the voice switched off', async () => {
    const empty = fakeDeps([() => takeResponse([{ voice_id: MM, start_time_seconds: 0, end_time_seconds: 1, dialogue_input_index: 0 }], Buffer.alloc(0))])
    await assert.rejects(() => speakTake([{ text: 'One.', voiceId: MM }], empty), /no audio/)
    await assert.rejects(() => speakText('One.', MM, empty), /no audio/)
  })

  it('one voice needs no timing: an answer with no voice_segments at all still speaks', async () => {
    const deps = fakeDeps([() => new Response(JSON.stringify({ audio_base64: Buffer.from('raw-take').toString('base64') }), { status: 200 })])
    const audio = await silenceWarnings(() => speakText('One.', MM, deps))
    assert.equal(audio.toString(), 'raw-take')
  })

  it('the fast path fails plainly too, and never hands an error page over as audio', async () => {
    const deps = fakeDeps([() => new Response('{"detail":"nope"}', { status: 400 })])
    await silenceWarnings(() => assert.rejects(() => speakFast('Text.', 'V', deps), /elevenlabs 400/))
  })

  it('a dead voice fails the call with its status, for the caller to fall back on', async () => {
    const deps = fakeDeps([() => new Response('{"detail":{"status":"voice_not_found"}}', { status: 404 })])
    await silenceWarnings(() => assert.rejects(() => speakTake([{ text: 'One.', voiceId: 'DEAD' }], deps), /elevenlabs 404/))
    assert.equal(deps.sent.length, 1, 'a 404 is not retried')
  })
})

describe('429s wait and retry the same model', () => {
  const busy = (headers: Record<string, string> = {}) => () => new Response('busy', { status: 429, headers })

  it('reads Retry-After as seconds or a date; absent or garbage is null', () => {
    assert.equal(retryAfterMs('3'), 3000)
    assert.equal(retryAfterMs(' 0 '), 0)
    assert.equal(retryAfterMs('Fri, 06 Nov 2026 12:00:05 GMT', Date.parse('Fri, 06 Nov 2026 12:00:00 GMT')), 5000)
    assert.equal(retryAfterMs(null), null)
    assert.equal(retryAfterMs('soon'), null)
  })

  it('waits as long as Retry-After says, then sends the identical request', async () => {
    const deps = fakeDeps([busy({ 'Retry-After': '3' }), () => takeResponse([
      { voice_id: MM, start_time_seconds: 0, end_time_seconds: 1, dialogue_input_index: 0 },
    ])])
    await silenceWarnings(() => speakTake([{ text: 'One.', voiceId: MM }], deps))
    assert.deepEqual(deps.slept, [3000])
    assert.equal(deps.sent.length, 2)
    assert.deepEqual(deps.sent[1], deps.sent[0], 'same body, same model: never another engine')
  })

  it('with no header backs off, and gives up after a bounded number of tries', async () => {
    const deps = fakeDeps([busy()])
    await silenceWarnings(() => assert.rejects(() => speakTake([{ text: 'One.', voiceId: MM }], deps), /elevenlabs 429/))
    assert.deepEqual(deps.slept, [1000, 2000, 4000])
    assert.equal(deps.sent.length, 4)
    assert.ok(deps.sent.every((s) => s.body.model_id === 'eleven_v4'))
  })

  it('a Retry-After too long to sit through gives up at once instead of hanging a break', async () => {
    const deps = fakeDeps([busy({ 'Retry-After': '120' })])
    await silenceWarnings(() => assert.rejects(() => speakTake([{ text: 'One.', voiceId: MM }], deps), /elevenlabs 429/))
    assert.deepEqual(deps.slept, [])
    assert.equal(deps.sent.length, 1)
  })

  it('the fast path gets the same 429 handling, on flash', async () => {
    const deps = fakeDeps([busy({ 'Retry-After': '1' }), () => new Response(Buffer.from('ok'), { status: 200 })])
    await silenceWarnings(() => speakFast('Text.', 'V', deps))
    assert.deepEqual(deps.slept, [1000])
    assert.deepEqual(deps.sent.map((s) => s.body.model_id), ['eleven_flash_v2_5', 'eleven_flash_v2_5'])
  })

  it('a 5xx or a dropped connection gets one short retry, a timeout none', async () => {
    let slept: number[] = []
    const deps = { sleep: async (ms: number) => { slept.push(ms) } }
    let calls = 0
    const after500 = await sendWithRetry(async () => { calls += 1; return new Response('', { status: calls === 1 ? 503 : 200 }) }, deps)
    assert.equal(after500.status, 200)
    assert.equal(calls, 2)
    assert.deepEqual(slept, [1000])

    calls = 0
    const still500 = await sendWithRetry(async () => { calls += 1; return new Response('', { status: 500 }) }, deps)
    assert.equal(still500.status, 500)
    assert.equal(calls, 2)

    calls = 0
    slept = []
    const afterDrop = await sendWithRetry(async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response('', { status: 200 })
    }, deps)
    assert.equal(afterDrop.status, 200)
    assert.deepEqual(slept, [1000])

    calls = 0
    await assert.rejects(() => sendWithRetry(async () => { calls += 1; throw new TypeError('fetch failed') }, deps), /fetch failed/)
    assert.equal(calls, 2, 'one retry, not forever')

    calls = 0
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    await assert.rejects(() => sendWithRetry(async () => { calls += 1; throw timeout }, deps), /timed out/)
    assert.equal(calls, 1)
  })
})

describe('a retry lets go of the answer it won\'t read', () => {
  for (const status of [429, 503]) {
    it(`after a ${status}`, async () => {
      const first = new Response('some body', { status })
      let sends = 0
      const res = await silenceWarnings(() => sendWithRetry(async () => (sends++ === 0 ? first : new Response('', { status: 200 })), { sleep: async () => {} }))
      assert.equal(res.status, 200)
      assert.equal((await first.body?.getReader().read())?.done, true, 'the first answer\'s body was cancelled')
    })
  }
})

describe('long text', () => {
  const sentence = (i: number) => `Sentence number ${i} goes on about the record for a good while, and then it stops.`

  it('text that fits is one chunk, untouched', () => {
    assert.deepEqual(splitForDialogue('Short. Text.'), ['Short. Text.'])
  })

  it('splits on sentence ends, every chunk within the limit, nothing lost, in order', () => {
    const text = Array.from({ length: 50 }, (_, i) => sentence(i)).join(' ')
    assert.ok(text.length > MAX_DIALOGUE_CHARS && text.length <= 4300)
    const chunks = splitForDialogue(text)
    assert.ok(chunks.length >= 2)
    for (const chunk of chunks) {
      assert.ok(chunk.length <= MAX_DIALOGUE_CHARS, `chunk of ${chunk.length}`)
      assert.match(chunk, /\.$/, 'ends on a sentence end')
      assert.match(chunk, /^Sentence number/, 'starts on a sentence start')
    }
    assert.equal(chunks.join(' '), text)
  })

  it('a stage direction after a sentence end stays with the sentence it directs', () => {
    const chunks = splitForDialogue(`${'a '.repeat(14)}end. [sighs] And then the rest.`, 40)
    assert.deepEqual(chunks, [`${'a '.repeat(14)}end.`, '[sighs] And then the rest.'])
  })

  it('an abbreviation is not a sentence end', () => {
    const chunks = splitForDialogue('He loves Dr. Dre so much that he said it twice. Then he left.', 30)
    for (const chunk of chunks) assert.ok(!/Dr\.$/.test(chunk), `cut after an abbreviation: ${chunk}`)
  })

  it('one sentence too long to fit falls back to a clause, then to a word, never mid-word', () => {
    const clause = splitForDialogue('first part of it goes here, second part of it goes here', 30)
    assert.equal(clause[0], 'first part of it goes here,')
    const words = splitForDialogue('word '.repeat(20).trim(), 12)
    for (const chunk of words) {
      assert.ok(chunk.length <= 12)
      assert.match(chunk, /^(word ?)+$/)
    }
  })

  it('every chunk becomes one call, carrying the words either side of it', async () => {
    const text = Array.from({ length: 50 }, (_, i) => sentence(i)).join(' ')
    const deps = fakeDeps([() => takeResponse()])
    await silenceWarnings(() => speakText(text, MM, deps))
    const chunks = splitForDialogue(text)
    assert.equal(deps.sent.length, chunks.length)
    deps.sent.forEach((s, i) => {
      assert.equal(s.url, DIALOGUE_URL)
      assert.equal(s.body.inputs[0].text, chunks[i])
      assert.ok(s.body.inputs[0].text.length <= MAX_DIALOGUE_CHARS)
      assert.equal(s.body.previous_text, i > 0 ? chunks[i - 1].slice(-100) : undefined)
      assert.equal(s.body.future_text, i < chunks.length - 1 ? chunks[i + 1].slice(0, 100) : undefined)
    })
  })

  it('text in one chunk sends no context fields', async () => {
    const deps = fakeDeps([() => takeResponse()])
    await silenceWarnings(() => speakText('One short line.', MM, deps))
    assert.ok(!('previous_text' in deps.sent[0].body))
    assert.ok(!('future_text' in deps.sent[0].body))
  })

  it('a lost later chunk still speaks the part before it; a lost first chunk fails', async () => {
    const text = Array.from({ length: 50 }, (_, i) => sentence(i)).join(' ')
    const pieces = (n: number) => () => takeResponse([], Buffer.from(`piece-${n}`))
    const lastDead = () => new Response('{}', { status: 400 })

    const deps = fakeDeps([pieces(1), lastDead])
    const audio = await silenceWarnings(() => speakText(text, MM, deps))
    assert.equal(audio.toString(), 'piece-1', 'ffmpeg failed here too, so the raw first piece comes back')

    const dead = fakeDeps([lastDead])
    await silenceWarnings(() => assert.rejects(() => speakText(text, MM, dead), /elevenlabs 400/))
  })
})

describe('trims', () => {
  it('both hosts have a trim; a voice nobody measured gets 0 dB', () => {
    assert.equal(typeof VOICE_TRIM_DB[MM], 'number')
    assert.equal(typeof VOICE_TRIM_DB[LARRY_VOICE_ID], 'number')
    assert.equal(voiceTrimDb('NOBODY'), 0)
  })

  it('a new step only where the trim changes, the first at zero, in time order', () => {
    const quiet = 'QUIET'
    const loud = 'LOUD'
    VOICE_TRIM_DB[quiet] = 6
    VOICE_TRIM_DB[loud] = -2
    try {
      assert.deepEqual(gainTimeline([
        { startSec: 9, voiceId: loud },
        { startSec: 0.2, voiceId: quiet },
        { startSec: 4, voiceId: loud },
        { startSec: 7, voiceId: loud },
        { startSec: 12, voiceId: quiet },
      ]), [
        { atSec: 0, db: 6 },
        { atSec: 4, db: -2 },
        { atSec: 12, db: 6 },
      ])
    } finally {
      delete VOICE_TRIM_DB[quiet]
      delete VOICE_TRIM_DB[loud]
    }
  })

  it('no spans means no change at all', () => {
    assert.deepEqual(gainTimeline([]), [{ atSec: 0, db: 0 }])
  })

  it('the filter is gain by time range, then the limiter, with no EQ and no pitch', () => {
    const steps = [{ atSec: 0, db: 6 }, { atSec: 4, db: 0 }]
    const af = finishFilter(steps)
    assert.ok(af.indexOf('volume=') < af.indexOf('alimiter='), 'gain before the ceiling')
    assert.match(af, /alimiter=[^,]*level=0/, 'alimiter must not normalize on its own')
    assert.match(af, /alimiter=[^,]*latency=1/, 'alimiter must not shift the audio off the captions')
    assert.doesNotMatch(af, /equalizer|highshelf|lowshelf|highpass|lowpass|asetrate|atempo|loudnorm/)
    assert.match(gainExpression(steps), /^1\.99526\+\(-0\.99526\)\*clip\(\(t-3\.990\)\/0\.02,0,1\)$/)
    assert.match(finishFilter([{ atSec: 0, db: 0 }]), /^volume=1\.00000,alimiter=/)
  })

  it('a gain change moves into the gap between speakers, even when the boundary is in a word', () => {
    const rate = 1000
    const samples = new Float32Array(4000).fill(0.2)
    samples.fill(0, 1500, 1700) // silence from 1.5 to 1.7 s
    const inGap = (t: number): boolean => t >= 1.51 && t <= 1.69 // room for the 20 ms ramp
    assert.ok(inGap(snapToQuiet(samples, rate, 1.75)), 'the next speaker\'s first sound led the boundary')
    assert.ok(inGap(snapToQuiet(samples, rate, 1.45)), 'the gap is just ahead of the boundary')
    assert.ok(inGap(snapToQuiet(samples, rate, 1.6)), 'the boundary is already in the gap')
  })

  it('the nearest gap wins, and with no gap the boundary stands', () => {
    const rate = 1000
    const samples = new Float32Array(4000).fill(0.2)
    samples.fill(0, 900, 950)
    samples.fill(0, 1050, 1100)
    assert.ok(Math.abs(snapToQuiet(samples, rate, 1.06) - 1.075) < 0.011)
    assert.ok(Math.abs(snapToQuiet(samples, rate, 0.96) - 0.925) < 0.011)
    const solid = new Float32Array(4000).fill(0.2)
    assert.equal(snapToQuiet(solid, rate, 2), 2)
    const blip = new Float32Array(4000).fill(0.2)
    blip.fill(0, 2000, 2010) // 10 ms: shorter than the ramp
    assert.equal(snapToQuiet(blip, rate, 2), 2)
  })
})

describe('a gain change lands in the gap, and only a real gap', () => {
  const rate = 1000 // one sample a millisecond, so the times read straight off
  const fromDb = (db: number): number => 10 ** (db / 20)

  /** Sound at `db` everywhere, with the given stretches (seconds) silent or at their own level. */
  function take(db: number, seconds: number, stretches: Array<[number, number, number?]>): Float32Array {
    const samples = new Float32Array(seconds * rate).fill(fromDb(db))
    for (const [from, to, level] of stretches) samples.fill(level === undefined ? 0 : fromDb(level), from * rate, to * rate)
    return samples
  }

  it('a word whose tail runs well past the boundary: the switch waits for the quiet', () => {
    // A real take, "[interrupts] No, no, no." into "[whispers] Don't tell anyone.": at
    // the boundary, 5.520, the tail is at -27 dB, and it reaches -60 dB 180 ms later. A
    // switch at the boundary lifted that tail 4.5 dB as it faded.
    const samples = take(-20, 8, [[5.52, 5.58, -30], [5.58, 5.64, -40], [5.64, 5.7, -50], [5.7, 6]])
    const at = snapToQuiet(samples, rate, 5.52)
    assert.ok(at >= 5.71 && at <= 5.99, `landed at ${at}`)
  })

  it('a first sound that leads the boundary: the switch goes back to the quiet before it', () => {
    const samples = take(-20, 8, [[3, 3.2]]) // the next speaker starts at 3.2, the boundary says 3.4
    const at = snapToQuiet(samples, rate, 3.4)
    assert.ok(at >= 3.01 && at <= 3.19, `landed at ${at}`)
  })

  it('a gap too far from the boundary belongs to someone else\'s line', () => {
    assert.equal(snapToQuiet(take(-20, 8, [[3.28, 3.6]]), rate, 3), 3, 'ahead of it')
    assert.equal(snapToQuiet(take(-20, 8, [[2.4, 2.72]]), rate, 3), 3, 'behind it')
  })

  it('soft speech is not a gap: speech at -25 dBFS or a breath at -50, however long', () => {
    assert.equal(snapToQuiet(take(-20, 8, [[2.8, 3.1, -25]]), rate, 3), 3)
    assert.equal(snapToQuiet(take(-20, 8, [[2.8, 3.1, -50]]), rate, 3), 3)
  })

  it('room tone is a gap: -65 dBFS and below', () => {
    const at = snapToQuiet(take(-20, 8, [[2.8, 2.95, -65]]), rate, 3)
    assert.ok(at >= 2.81 && at <= 2.94, `landed at ${at}`)
  })
})

describe('the numbers that decide the sound', () => {
  it('each voice keeps the trim it was measured for', () => {
    // Change one on purpose, by measuring takes: a wrong trim sounds like a different
    // room, and nothing else would notice.
    assert.deepEqual(VOICE_TRIM_DB, {
      [MM]: 4,
      [LARRY_VOICE_ID]: -0.5,
      ApBE43wHy5MiZGz9ihqB: 1, // Stephen
      UOB3uZCEf2cjGpZaGOXq: 1, // Giovanni
      miqykcv8BCUvQnRlIGUV: 1, // Rajiv
      BlgEcC0TfWpBak7FmvHW: 4, // Kristina
      YrAYvOVjAFiqVwBgB4qI: 3, // Devin
      Ib97zM6uFBc71OWgj75I: 7, // Mike
      c8v8wiyiDwyuduufV6kB: 13, // Zoe
    })
  })

  it('one voice: its gain, then the ceiling, the limiter\'s attack and release, and nothing else', () => {
    assert.equal(finishFilter([{ atSec: 0, db: 4 }]), 'volume=1.58489,alimiter=limit=0.89:attack=5:release=50:level=0:latency=1')
  })

  it('two voices: the gain re-read every 256 samples, a 20 ms ramp, the same ceiling', () => {
    assert.equal(
      finishFilter([{ atSec: 0, db: 4 }, { atSec: 5, db: -0.5 }]),
      "asetnsamples=n=256:p=0,volume=volume='1.58489+(-0.64083)*clip((t-4.990)/0.02,0,1)':eval=frame,alimiter=limit=0.89:attack=5:release=50:level=0:latency=1",
    )
  })
})

describe('the doors reach the finishing step', () => {
  /** Fake ffmpeg: records the filter it was asked for, hands back fake audio. */
  function recording(answers: Array<() => Response>) {
    const filters: string[] = []
    const deps = fakeDeps(answers, {
      ffmpeg: async (args) => {
        const at = args.findIndex((a) => a === '-af' || a === '-filter_complex')
        if (at < 0) return Buffer.alloc(4410 * 4) // the decode for snapping: silence
        filters.push(args[at + 1])
        writeFileSync(args[args.length - 1], 'finished')
        return Buffer.alloc(0)
      },
    })
    return { deps, filters }
  }

  it('one voice gets its trim', async () => {
    const { deps, filters } = recording([() => takeResponse()])
    const audio = await speakText('Hello there.', MM, deps)
    assert.equal(audio.toString(), 'finished')
    assert.match(filters[0], new RegExp(`^volume=${(10 ** (voiceTrimDb(MM) / 20)).toFixed(5)},alimiter=`))
  })

  it('a take gets each voice its trim by time range, and answers with who speaks when', async () => {
    const { deps, filters } = recording([() => takeResponse([
      { voice_id: LARRY_VOICE_ID, start_time_seconds: 2.5, end_time_seconds: 4, dialogue_input_index: 1 },
      { voice_id: MM, start_time_seconds: 0, end_time_seconds: 2.5, dialogue_input_index: 0 },
    ])])
    const take = await speakTake([{ text: 'One.', voiceId: MM }, { text: 'Two.', voiceId: LARRY_VOICE_ID }], deps)
    assert.equal(take.audio.toString(), 'finished')
    assert.match(filters[0], /clip\(\(t-/, 'gain by time range')
    assert.deepEqual(take.segments, [
      { input: 0, startSec: 0, endSec: 2.5 },
      { input: 1, startSec: 2.5, endSec: 4 },
    ])
  })
})

describe('finishTake moves each gain change to the quiet', () => {
  it('the ramp sits in the gap the decoded audio shows, not on the boundary', async () => {
    const rate = 22_050 // what finishTake decodes at
    const pcm = new Float32Array(rate * 4).fill(0.1)
    pcm.fill(0, rate * 2, Math.round(rate * 2.1)) // silence from 2.0 to 2.1 s
    const filters: string[] = []
    const deps = fakeDeps([], {
      ffmpeg: async (args) => {
        const at = args.findIndex((a) => a === '-af' || a === '-filter_complex')
        if (at < 0) return Buffer.from(pcm.buffer)
        filters.push(args[at + 1])
        writeFileSync(args[args.length - 1], 'finished')
        return Buffer.alloc(0)
      },
    })
    await finishTake([Buffer.from('raw')], [{ startSec: 0, voiceId: MM }, { startSec: 2.18, voiceId: LARRY_VOICE_ID }], deps)
    const ramp = /clip\(\(t-([\d.]+)\)/.exec(filters[0])
    assert.ok(ramp, filters[0])
    const startsAt = Number(ramp[1])
    assert.ok(startsAt >= 2 && startsAt + 0.02 <= 2.1, `the ramp starts at ${startsAt}`)
  })
})

describe('finishTake leaves nothing behind', () => {
  it('its temp folder is gone, when ffmpeg works and when it fails', async () => {
    const dirs: string[] = []
    const works = fakeDeps([], {
      ffmpeg: async (args) => {
        const out = args[args.length - 1]
        dirs.push(dirname(out))
        writeFileSync(out, 'finished')
        return Buffer.alloc(0)
      },
    })
    assert.equal((await finishTake([Buffer.from('raw')], [{ startSec: 0, voiceId: MM }], works)).toString(), 'finished')
    const fails = fakeDeps([], {
      ffmpeg: async (args) => {
        dirs.push(dirname(args[args.length - 1]))
        throw new Error('ffmpeg exploded')
      },
    })
    assert.equal((await silenceWarnings(() => finishTake([Buffer.from('raw')], [{ startSec: 0, voiceId: MM }], fails))).toString(), 'raw')
    assert.equal(dirs.length, 2)
    for (const dir of dirs) assert.equal(existsSync(dir), false, dir)
  })
})

describe('finishing real audio', { skip: !hasFfmpeg }, () => {
  /** An mp3 of a steady tone peaking at `amp`, `seconds` long. (lavfi's sine is 1/8 of full scale.) */
  function tone(dir: string, name: string, amp: number, seconds: number): Buffer {
    const path = join(dir, name)
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
      '-af', `volume=${amp * 8}`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', path])
    return readFileSync(path)
  }

  /** Decoded samples of an mp3, between two times if given. */
  function pcm(mp3: Buffer, dir: string, range: string[] = []): Float32Array {
    const path = join(dir, `decode-${Math.random()}.mp3`)
    writeFileSync(path, mp3)
    const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', ...range, '-i', path, '-ac', '1', '-f', 'f32le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 })
    return new Float32Array(new Uint8Array(raw).buffer, 0, Math.floor(raw.length / 4))
  }

  function rmsDb(mp3: Buffer, dir: string, fromSec: number, toSec: number): number {
    const s = pcm(mp3, dir, ['-ss', String(fromSec), '-to', String(toSec)])
    let sum = 0
    for (const v of s) sum += v * v
    return 10 * Math.log10(sum / s.length)
  }

  function peak(mp3: Buffer, dir: string): number {
    let max = 0
    for (const v of pcm(mp3, dir)) max = Math.max(max, Math.abs(v))
    return max
  }

  it('applies each voice its own trim in its own time range, and the limiter holds the ceiling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-speech-test-'))
    VOICE_TRIM_DB.QUIET = 6
    VOICE_TRIM_DB.LOUD = -3
    try {
      const source = tone(dir, 'tone.mp3', 0.25, 6)
      const out = await finishTake([source], [
        { startSec: 0, voiceId: 'QUIET' },
        { startSec: 2, voiceId: 'LOUD' },
        { startSec: 4, voiceId: 'QUIET' },
      ])
      const before = rmsDb(source, dir, 0.5, 1.5)
      assert.ok(Math.abs(rmsDb(out, dir, 0.5, 1.5) - before - 6) < 0.5, 'first range +6 dB')
      assert.ok(Math.abs(rmsDb(out, dir, 2.5, 3.5) - before + 3) < 0.5, 'second range -3 dB')
      assert.ok(Math.abs(rmsDb(out, dir, 4.5, 5.5) - before - 6) < 0.5, 'third range +6 dB')

      const hot = tone(dir, 'hot.mp3', 0.8, 2)
      const limited = await finishTake([hot], [{ startSec: 0, voiceId: 'QUIET' }])
      assert.ok(peak(limited, dir) <= 0.95, `peak ${peak(limited, dir)} after +6 dB on a hot tone`)
    } finally {
      delete VOICE_TRIM_DB.QUIET
      delete VOICE_TRIM_DB.LOUD
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sound either side of a boundary keeps its own speaker\'s gain, up to the gap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-speech-test-'))
    VOICE_TRIM_DB.QUIET = 6
    VOICE_TRIM_DB.LOUD = -3
    try {
      // Tone, a gap from 2.0 to 2.4 s, tone.
      const path = join(dir, 'gap.mp3')
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5',
        '-af', "volume='if(between(t,2.0,2.4),0,2)':eval=frame", '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', path])
      const source = readFileSync(path)
      const change = (from: number, to: number, out: Buffer): number => rmsDb(out, dir, from, to) - rmsDb(source, dir, from, to)

      // The encoded tone rings on to about 2.03 s. A boundary at 1.85 is 180 ms before
      // the quiet, like the real take: all of that is still the first speaker's tail.
      const tail = await finishTake([source], [{ startSec: 0, voiceId: 'QUIET' }, { startSec: 1.85, voiceId: 'LOUD' }])
      assert.ok(Math.abs(change(1.88, 1.98, tail) - 6) < 0.5, `the tail changed ${change(1.88, 1.98, tail)} dB`)
      assert.ok(Math.abs(change(2.5, 3, tail) + 3) < 0.5, 'the next speaker has their own')

      // The boundary is 200 ms after the gap: that's already the next speaker's first sound.
      const lead = await finishTake([source], [{ startSec: 0, voiceId: 'QUIET' }, { startSec: 2.6, voiceId: 'LOUD' }])
      assert.ok(Math.abs(change(2.45, 2.55, lead) + 3) < 0.5, `the first sound changed ${change(2.45, 2.55, lead)} dB`)
      assert.ok(Math.abs(change(1.5, 1.9, lead) - 6) < 0.5, 'the first speaker has their own')
    } finally {
      delete VOICE_TRIM_DB.QUIET
      delete VOICE_TRIM_DB.LOUD
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the limiter leaves a hot voice right at its ceiling, not under it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-speech-test-'))
    VOICE_TRIM_DB.QUIET = 6
    try {
      const limited = await finishTake([tone(dir, 'hot.mp3', 0.8, 2)], [{ startSec: 0, voiceId: 'QUIET' }])
      const top = peak(limited, dir)
      assert.ok(top >= 0.8 && top <= 0.95, `peak ${top}`)
    } finally {
      delete VOICE_TRIM_DB.QUIET
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('joins the chunks of a long text in order, one trim across all of them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-speech-test-'))
    VOICE_TRIM_DB.ONE = -6
    try {
      const out = await finishTake([tone(dir, 'a.mp3', 0.1, 1), tone(dir, 'b.mp3', 0.4, 1)], [{ startSec: 0, voiceId: 'ONE' }])
      const quietFirst = rmsDb(out, dir, 0.2, 0.8)
      const loudSecond = rmsDb(out, dir, 1.3, 1.8)
      assert.ok(Math.abs(loudSecond - quietFirst - 12) < 1, 'the second chunk (12 dB hotter) comes second')
      assert.ok(Math.abs(quietFirst - (20 * Math.log10(0.1) - 3 - 6)) < 1, 'and the trim reached it')
    } finally {
      delete VOICE_TRIM_DB.ONE
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not move the audio: a click stays where it was, so captions stay on time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-speech-test-'))
    try {
      const path = join(dir, 'click.mp3')
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=0.05',
        '-filter_complex', '[1:a]volume=0.5,adelay=2000|2000[c];[0:a][c]amix=inputs=2:normalize=0', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', path])
      const source = readFileSync(path)
      const out = await finishTake([source], [{ startSec: 0, voiceId: 'NOBODY' }])
      const onset = (mp3: Buffer): number => pcm(mp3, dir).findIndex((v) => Math.abs(v) > 0.05) / 44100
      assert.ok(Math.abs(onset(out) - onset(source)) < 0.01, `moved ${onset(out) - onset(source)} s`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('if ffmpeg fails the listener gets the untrimmed audio, never silence', async () => {
    const raw = Buffer.from('untrimmed-take')
    const broken = fakeDeps([], { ffmpeg: async () => { throw new Error('ffmpeg exploded') } })
    VOICE_TRIM_DB.MOVES = 3
    try {
      const single = await silenceWarnings(() => finishTake([raw], [{ startSec: 0, voiceId: 'NOBODY' }], broken))
      assert.deepEqual(single, raw)
      const twoVoices = await silenceWarnings(() => finishTake([raw], [{ startSec: 0, voiceId: 'NOBODY' }, { startSec: 1, voiceId: 'MOVES' }], broken))
      assert.deepEqual(twoVoices, raw)
      const pieces = await silenceWarnings(() => finishTake([Buffer.from('a'), Buffer.from('b')], [{ startSec: 0, voiceId: 'NOBODY' }], broken))
      assert.equal(pieces.toString(), 'ab')
    } finally {
      delete VOICE_TRIM_DB.MOVES
    }
  })

  it('an ffmpeg that writes an empty file counts as failed', async () => {
    const raw = Buffer.from('untrimmed-take')
    const empty = fakeDeps([], {
      ffmpeg: async (args) => {
        writeFileSync(args[args.length - 1], '')
        return Buffer.alloc(0)
      },
    })
    assert.deepEqual(await silenceWarnings(() => finishTake([raw], [{ startSec: 0, voiceId: 'NOBODY' }], empty)), raw)
  })
})
