/**
 * The real musicman-speak, radio-dialogue and radio-get-cast handlers (ai-ipc.ts),
 * through a fake registrar with a fake network: which voice a call goes to, the
 * Settings switch, the shape of the answer, the limits, and what a failure says.
 *
 * The audio here isn't real, so ffmpeg (or no ffmpeg) fails on it and the handler
 * answers with the bytes as they came. That path is the point of finishTake's
 * "never silence", and it leaves these bytes checkable.
 */
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LARRY_VOICE_ID } from '../../common/cohost.ts'
import { MAX_DIALOGUE_CHARS } from '../../common/speech.ts'
import { FAST_MODEL, SPEECH_MODEL } from '../eleven-speech.ts'

const userData = mkdtempSync(join(tmpdir(), 'jt-speech-ipc-'))
process.env.JT_USER_DATA = userData
after(() => rmSync(userData, { recursive: true, force: true }))
register('./speech-test-hooks.mjs', import.meta.url)

const MM_VOICE = 'REAL-MM-VOICE'
const TAKE_AUDIO = Buffer.from('take-bytes-\xff\x00')

interface Sent { url: string; body: Record<string, any> }
let sent: Sent[] = []
let answer: (url: string, body: Record<string, any>) => Response = () => dialogueAnswer()
const realFetch = globalThis.fetch
const realWarn = console.warn
const savedVoice = process.env.ELEVENLABS_VOICE_ID

function dialogueAnswer(): Response {
  return new Response(JSON.stringify({
    audio_base64: TAKE_AUDIO.toString('base64'),
    voice_segments: [
      { voice_id: MM_VOICE, start_time_seconds: 0, end_time_seconds: 2.5, dialogue_input_index: 0 },
      { voice_id: LARRY_VOICE_ID, start_time_seconds: 2.5, end_time_seconds: 4, dialogue_input_index: 1 },
    ],
  }), { status: 200 })
}

beforeEach(() => {
  sent = []
  answer = () => dialogueAnswer()
  process.env.ELEVENLABS_VOICE_ID = MM_VOICE
  console.warn = () => {}
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, any>
    sent.push({ url: String(url), body })
    return answer(String(url), body)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  console.warn = realWarn
  if (savedVoice === undefined) delete process.env.ELEVENLABS_VOICE_ID
  else process.env.ELEVENLABS_VOICE_ID = savedVoice
})

let loads = 0

/** A fresh copy of ai-ipc.ts for each test: its rate-limit bucket lives at module scope. */
async function handlers(state: { host?: 'mm' | 'larry'; settings?: Record<string, unknown> | null } = {}) {
  const { registerAiIpc } = await import(`../ipc/ai-ipc.ts?test=${++loads}`)
  const table = new Map<string, { fn: (event: unknown, ...args: unknown[]) => Promise<any>; options: Record<string, unknown> }>()
  registerAiIpc({ handle: (channel: string, fn: never, options: never) => { table.set(channel, { fn, options }) } }, {
    readAppSettings: async () => (state.settings === undefined ? { ai: { musicManVoiceEnabled: true } } : state.settings),
    readActiveHost: () => state.host ?? 'mm',
    getMainWindow: () => null,
  })
  return {
    invoke: (channel: string, ...args: unknown[]) => {
      const entry = table.get(channel)
      assert.ok(entry, `no handler for ${channel}`)
      return entry.fn({}, ...args)
    },
    options: (channel: string) => table.get(channel)?.options,
  }
}

const voicesSent = (): string[] => sent.flatMap((s) => s.body.inputs.map((i: { voice_id: string }) => i.voice_id))
const charsSent = (): number => sent.reduce((sum, s) => sum + s.body.inputs.reduce((n: number, i: { text: string }) => n + i.text.length, 0), 0)

describe('radio-get-cast', () => {
  for (const host of ['mm', 'larry'] as const) {
    it(`sends the Music Man's real voice with ${host} at the mic`, async () => {
      const { invoke } = await handlers({ host })
      const { ok, cast } = await invoke('radio-get-cast')
      assert.equal(ok, true)
      assert.equal(cast.find((m: { id: string }) => m.id === 'mm').voiceId, MM_VOICE)
      assert.equal(cast.find((m: { id: string }) => m.id === 'larry').voiceId, LARRY_VOICE_ID)
    })
  }

  it('radio lines from that cast reach the Music Man\'s voice even with Larry at the mic', async () => {
    const { invoke } = await handlers({ host: 'larry' })
    const { cast } = await invoke('radio-get-cast')
    await invoke('musicman-speak', 'A radio line.', false, cast.find((m: { id: string }) => m.id === 'mm').voiceId)
    assert.deepEqual(voicesSent(), [MM_VOICE])
  })
})

describe('musicman-speak', () => {
  it('speaks on eleven_v4 and answers with the bytes in base64', async () => {
    const { invoke } = await handlers()
    const res = await invoke('musicman-speak', 'Hello there.')
    assert.deepEqual(res, { ok: true, audio: TAKE_AUDIO.toString('base64') })
    assert.equal(sent[0].body.model_id, SPEECH_MODEL)
    assert.deepEqual(sent[0].body.inputs, [{ text: 'Hello there.', voice_id: MM_VOICE }])
  })

  it('with no voice passed it uses the host at the mic', async () => {
    await (await handlers({ host: 'mm' })).invoke('musicman-speak', 'Hello.')
    await (await handlers({ host: 'larry' })).invoke('musicman-speak', 'Hello.')
    assert.deepEqual(voicesSent(), [MM_VOICE, LARRY_VOICE_ID])
  })

  it('a voice passed in wins over the host at the mic', async () => {
    const { invoke } = await handlers({ host: 'larry' })
    await invoke('musicman-speak', 'Hello.', false, 'SOMEONE')
    assert.deepEqual(voicesSent(), ['SOMEONE'])
  })

  it('the fast flag alone takes the Scotus path', async () => {
    answer = () => new Response(Buffer.from('flash-bytes'), { status: 200 })
    const { invoke } = await handlers()
    const res = await invoke('musicman-speak', 'May it please the court.', true, 'SCOTUS')
    assert.deepEqual(res, { ok: true, audio: Buffer.from('flash-bytes').toString('base64') })
    assert.equal(sent[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/SCOTUS')
    assert.equal(sent[0].body.model_id, FAST_MODEL)
  })

  it('takes 4,000 characters and no more, split to fit the endpoint', async () => {
    const { invoke } = await handlers()
    const words = 'Some words about the record, and then a stop. '.repeat(120)
    assert.ok(words.length > 5000)
    await invoke('musicman-speak', words)
    assert.ok(sent.length >= 3, `${sent.length} calls`)
    assert.ok(sent.every((s) => s.body.inputs[0].text.length <= MAX_DIALOGUE_CHARS))
    assert.ok(charsSent() <= 4000, `${charsSent()} characters sent`)
    assert.ok(charsSent() > 3900, `${charsSent()} characters sent`)
  })

  it('nothing to say is a quiet yes, with no call', async () => {
    const { invoke } = await handlers()
    assert.deepEqual(await invoke('musicman-speak', '   '), { ok: true, audio: '' })
    assert.deepEqual(await invoke('musicman-speak', 42), { ok: true, audio: '' })
    assert.deepEqual(await invoke('musicman-speak', '   ', true, 'SCOTUS'), { ok: true, audio: '' })
    assert.deepEqual(sent, [])
  })

  it('a failure says so without the API\'s words', async () => {
    answer = () => new Response('{"detail":{"status":"voice_not_found","message":"secret detail"}}', { status: 404 })
    const { invoke } = await handlers()
    assert.deepEqual(await invoke('musicman-speak', 'Hello.', false, 'DEAD'), { ok: false, error: 'api-failed' })
  })
})

describe('radio-dialogue', () => {
  const inputs = [{ text: 'One.', voiceId: MM_VOICE }, { text: 'Two.', voiceId: LARRY_VOICE_ID }]

  it('answers with the take in base64 and who speaks when, on the wire in the renderer\'s shape', async () => {
    const { invoke } = await handlers()
    const res = await invoke('radio-dialogue', inputs)
    assert.deepEqual(res, {
      ok: true,
      audio: TAKE_AUDIO.toString('base64'),
      segments: [{ input: 0, startSec: 0, endSec: 2.5 }, { input: 1, startSec: 2.5, endSec: 4 }],
    })
    assert.deepEqual(sent[0].body.inputs, [{ text: 'One.', voice_id: MM_VOICE }, { text: 'Two.', voice_id: LARRY_VOICE_ID }])
  })

  for (const [what, bad] of [
    ['nothing', []],
    ['not a list', 'nope'],
    ['no list', undefined],
    ['a blank line', [{ text: '   ', voiceId: MM_VOICE }]],
    ['text that is not text', [{ text: 7, voiceId: MM_VOICE }]],
    ['no voice', [{ text: 'One.', voiceId: '' }]],
    ['a line that is not a line', [null]],
    ['one good line and one bad', [{ text: 'One.', voiceId: MM_VOICE }, { text: 'Two.' }]],
    ['too many characters', [{ text: 'x'.repeat(MAX_DIALOGUE_CHARS), voiceId: MM_VOICE }, { text: 'y', voiceId: LARRY_VOICE_ID }]],
  ] as Array<[string, unknown]>) {
    it(`refuses ${what}, with no call`, async () => {
      const { invoke } = await handlers()
      assert.deepEqual(await invoke('radio-dialogue', bad), { ok: false, error: 'invalid-input' })
      assert.deepEqual(sent, [])
    })
  }

  it('takes exactly the limit', async () => {
    const { invoke } = await handlers()
    const res = await invoke('radio-dialogue', [{ text: 'x'.repeat(MAX_DIALOGUE_CHARS), voiceId: MM_VOICE }])
    assert.equal(res.ok, true)
    assert.equal(sent.length, 1)
  })

  it('a dead voice fails the call plainly, so the renderer falls back', async () => {
    answer = () => new Response('{"detail":{"status":"voice_not_found","message":"secret detail"}}', { status: 404 })
    const { invoke } = await handlers()
    assert.deepEqual(await invoke('radio-dialogue', inputs), { ok: false, error: 'api-failed' })
    assert.equal(sent.length, 1)
  })
})

describe('the Settings switch', () => {
  const line = [{ text: 'One.', voiceId: MM_VOICE }]

  it('off: both doors give a quiet yes with no call', async () => {
    const { invoke } = await handlers({ settings: { ai: { musicManVoiceEnabled: false } } })
    assert.deepEqual(await invoke('musicman-speak', 'Hello.'), { ok: true, audio: '' })
    assert.deepEqual(await invoke('radio-dialogue', line), { ok: true, audio: '' })
    assert.deepEqual(sent, [])
  })

  for (const [what, settings] of [
    ['on', { ai: { musicManVoiceEnabled: true } }],
    ['never set', { ai: {} }],
    ['no AI settings', {}],
    ['no settings file', null],
  ] as Array<[string, Record<string, unknown> | null]>) {
    it(`${what}: both doors speak`, async () => {
      const { invoke } = await handlers({ settings })
      assert.equal((await invoke('musicman-speak', 'Hello.')).audio, TAKE_AUDIO.toString('base64'))
      assert.equal((await invoke('radio-dialogue', line)).audio, TAKE_AUDIO.toString('base64'))
      assert.equal(sent.length, 2)
    })
  }
})

describe('the rate limit', () => {
  const refused = { ok: false, error: 'TTS rate limit — try again in a moment.' }

  it('both doors share 60 calls a minute', async () => {
    const { invoke } = await handlers()
    // These answer without a network call, and still spend a token.
    for (let i = 0; i < 30; i++) assert.deepEqual(await invoke('musicman-speak', ''), { ok: true, audio: '' })
    for (let i = 0; i < 30; i++) assert.deepEqual(await invoke('radio-dialogue', []), { ok: false, error: 'invalid-input' })
    assert.deepEqual(await invoke('musicman-speak', 'Hello.'), refused)
    assert.deepEqual(await invoke('radio-dialogue', [{ text: 'One.', voiceId: MM_VOICE }]), refused)
    assert.deepEqual(sent, [])
  })
})

describe('who may call', () => {
  it('both speech doors refuse a sender that is not the main window; the cast is public', async () => {
    const { options } = await handlers()
    assert.deepEqual(options('musicman-speak')?.refuse, { ok: false, error: 'refused-sender' })
    assert.deepEqual(options('radio-dialogue')?.refuse, { ok: false, error: 'refused-sender' })
    assert.equal(options('radio-get-cast')?.public, true)
  })
})
