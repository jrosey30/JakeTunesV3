/**
 * The ask (main/music-man-ask.ts): Jake presses the mic, the Music Man answers
 * about the page he is on, from the facts, and never with "I don't know them".
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMusicManAsk, askInstructions, LARRY_MIN_GAP_MS, SESSION_IDLE_MS, THREAD_MAX,
  type AskDeps, type AskModelCall,
} from '../music-man-ask.ts'
import type { AskSubject, PacketInput } from '../../common/music-man-packet.ts'
import { isNonAnswer } from '../../common/non-answer.ts'
import { LARRY_CHIME_IN } from '../../common/music-man-ask-prompt.ts'

const TIGERS: AskSubject = { kind: 'album', artist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: '2026' }
const SAW = 'I don\'t know Twisted Teens or "The Holy Cross Tigers," and I\'d rather say that than invent a take on a record I can\'t place in their run. If you give me a sense of the sound, I\'ll tell you honestly whether it fits.'
const GOOD = '[laughs] Two people out of New Orleans making that much noise. You starred all thirteen, so you already know. Play "Stalks" again.'

const input = (over: Partial<PacketInput> = {}): PacketInput => ({
  subject: TIGERS,
  songs: [{ id: 12970, title: 'Stalks', artist: 'Twisted Teens', album: 'The Holy Cross Tigers', plays: 2, starred: true, bpm: 138, durationMs: 168_000, genre: 'Garage Punk' }],
  artist: { name: 'Twisted Teens', oneLiner: 'American rock duo.', place: 'New Orleans, Louisiana', facts: [{ label: 'Labels', value: 'Sub Pop' }] },
  today: '2026-11-13', ...over,
})

function rig(replies: Array<string | { text: string; cut: boolean }>, over: Partial<AskDeps> = {}) {
  const calls: AskModelCall[] = []
  const said: Array<[string, string]> = []
  let clock = 1_000_000
  const queue = [...replies]
  const deps: AskDeps = {
    gather: async () => input(),
    model: async (call) => {
      calls.push(call)
      const next = queue.shift()
      if (next === undefined) throw new Error('no more replies')
      return typeof next === 'string' ? { text: next, cut: false } : next
    },
    activeHost: () => 'mm',
    larryMayChimeIn: () => false,
    now: () => clock,
    random: () => 0,
    note: (host, text) => { said.push([host, text]) },
    ...over,
  }
  return { ask: createMusicManAsk(deps), calls, said, tick: (ms: number) => { clock += ms } }
}

describe('an ask', () => {
  test('hands him the facts for the page and returns what he said, tags only in the voice copy', async () => {
    const r = rig([GOOD])
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok)
    assert.equal(out.speaker, 'mm')
    assert.equal(out.how, 'model')
    assert.match(out.textRaw, /^\[laughs\] Two people/)
    assert.doesNotMatch(out.text, /\[laughs\]/)
    const sent = r.calls[0]!.messages.at(-1)!.content
    assert.match(sent, /WHAT JAKE IS LOOKING AT: the album "The Holy Cross Tigers" by Twisted Teens/)
    assert.match(sent, /Labels: Sub Pop/)
    assert.match(sent, /Jake pressed the mic on the album "The Holy Cross Tigers"/)
    assert.match(r.calls[0]!.instructions, /NEVER say you don't know the artist or the record/)
    assert.deepEqual(r.said, [['mm', out.text]])
  })

  test('nothing of it in the library: no model call, a plain refusal', async () => {
    const r = rig([], { gather: async () => null })
    assert.deepEqual(await r.ask.ask({ subject: TIGERS }), { ok: false, error: 'not-in-library' })
    assert.equal(r.calls.length, 0)
  })

  test('a typed question is asked as his words', async () => {
    const r = rig([GOOD])
    await r.ask.ask({ subject: TIGERS, question: 'is the back half any good?' })
    assert.match(r.calls[0]!.messages.at(-1)!.content, /Jake asks, about the album "The Holy Cross Tigers" by Twisted Teens \(2026\): "is the back half any good\?"/)
  })
})

describe("he never says he doesn't know something in Jake's library", () => {
  test('the reply Jake saw is not returned: he is asked again, with more to go on', async () => {
    let harder = 0
    const r = rig([SAW, GOOD], { lookHarder: async (_s, i) => { harder++; return { ...i, press: 'Twisted Teens are a duo on Sub Pop.' } } })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok)
    assert.equal(out.how, 'second-try')
    assert.equal(isNonAnswer(out.text), false)
    assert.equal(harder, 1)
    assert.equal(r.calls.length, 2)
    const second = r.calls[1]!.messages.at(-1)!.content
    assert.match(second, /Your last reply said you didn't know it/)
    assert.match(second, /PRESS AND REFERENCE/)
    // Only the good line is remembered.
    assert.deepEqual(r.said.map(([, t]) => isNonAnswer(t)), [false])
    assert.ok(r.ask.thread().every((m) => !isNonAnswer(m.content)))
  })

  test('twice: the facts and the sound, in plain words', async () => {
    const r = rig([SAW, SAW])
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok)
    assert.equal(out.how, 'facts')
    assert.match(out.text, /^Twisted Teens: American rock duo, out of New Orleans, Louisiana, on Sub Pop\./)
    assert.match(out.text, /"Stalks" is the one you play most/)
    assert.equal(isNonAnswer(out.text), false)
  })

  test('an empty reply is treated the same way', async () => {
    const r = rig(['', GOOD])
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.how === 'second-try')
  })

  test('a thin packet is looked into before the first ask, once', async () => {
    let harder = 0
    const r = rig([SAW, GOOD], {
      gather: async () => input({ artist: null }),
      lookHarder: async (_s, i) => { harder++; return { ...i, artist: { name: 'Twisted Teens', oneLiner: 'American rock duo.' } } },
    })
    await r.ask.ask({ subject: TIGERS })
    assert.equal(harder, 1)
    assert.match(r.calls[0]!.messages.at(-1)!.content, /American rock duo\./)
  })

  test('a reply cut off by max_tokens is trimmed to whole sentences', async () => {
    const r = rig([{ text: 'Loud, fast, done in half an hour. The best part is the third so', cut: true }])
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok)
    assert.equal(out.text, 'Loud, fast, done in half an hour.')
  })

  test('a legitimate "I don\'t love this record" is his opinion and is returned', async () => {
    const r = rig(["I don't love this record. You do, and you're wrong, and I respect it."])
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.how === 'model')
    assert.equal(r.calls.length, 1)
  })
})

describe('a real back-and-forth', () => {
  test('the session rides along: his last line is in the next ask, the packet is not repeated', async () => {
    const r = rig([GOOD, 'The fourth one. "Blue Rose". Slower, and it earns it.'])
    await r.ask.ask({ subject: TIGERS })
    await r.ask.ask({ subject: TIGERS, question: 'ok which one next?' })
    const msgs = r.calls[1]!.messages
    assert.equal(msgs.length, 3)
    assert.equal(msgs[0]!.role, 'user')
    assert.doesNotMatch(msgs[0]!.content, /WHAT JAKE IS LOOKING AT/)
    assert.equal(msgs[1]!.role, 'assistant')
    assert.match(msgs[1]!.content, /Two people out of New Orleans/)
    assert.match(msgs[2]!.content, /WHAT JAKE IS LOOKING AT/)
  })

  test('the mic again on the same page asks for something new', async () => {
    const r = rig([GOOD, 'Different song.'])
    await r.ask.ask({ subject: TIGERS })
    await r.ask.ask({ subject: TIGERS })
    assert.match(r.calls[1]!.messages.at(-1)!.content, /pressed the mic again .* Go somewhere new/)
  })

  test('the thread is bounded and starts with Jake', async () => {
    const r = rig(Array.from({ length: 10 }, (_, i) => `Line ${i}.`))
    for (let i = 0; i < 10; i++) await r.ask.ask({ subject: { kind: 'song', trackId: i } })
    const t = r.ask.thread()
    assert.equal(t.length, THREAD_MAX)
    assert.equal(t[0]!.role, 'user')
  })

  test('half an hour of quiet is a new conversation', async () => {
    const r = rig([GOOD, 'Fresh.'])
    await r.ask.ask({ subject: TIGERS })
    r.tick(SESSION_IDLE_MS + 1)
    await r.ask.ask({ subject: TIGERS })
    assert.equal(r.calls[1]!.messages.length, 1)
    assert.doesNotMatch(r.calls[1]!.messages[0]!.content, /pressed the mic again/)
  })
})

describe('Larry', () => {
  const LARRY = 'He said "noise" like it\'s a compliment. [sighs] It is. Fine.'

  test('off in Settings: never asked', async () => {
    const r = rig([GOOD], { larryMayChimeIn: () => false })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && !out.larry)
    assert.equal(r.calls.length, 1)
  })

  test('on: one line after the Music Man, from the same facts, tags only for the voice', async () => {
    const r = rig([GOOD, LARRY], { larryMayChimeIn: () => true })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.larry)
    assert.equal(out.larry.text, 'He said "noise" like it\'s a compliment. It is. Fine.')
    assert.match(out.larry.textRaw, /\[sighs\]/)
    const call = r.calls[1]!
    assert.equal(call.host, 'larry')
    assert.equal(call.instructions, LARRY_CHIME_IN)
    assert.match(call.messages[0]!.content, /Labels: Sub Pop/)
    assert.match(call.messages[0]!.content, /The Funk Man just said: "Two people out of New Orleans/)
  })

  test('he passes when he has nothing: no line, and no error', async () => {
    const r = rig([GOOD, 'PASS'], { larryMayChimeIn: () => true })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && !out.larry)
  })

  test("a Larry line that says he doesn't know the band is dropped", async () => {
    const r = rig([GOOD, "I've never heard of these people."], { larryMayChimeIn: () => true })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && !out.larry)
  })

  test('never every time: after a line he sits out the next asks, and the clock', async () => {
    const r = rig([GOOD, LARRY, 'Two.', 'Three.', 'Four.', LARRY], { larryMayChimeIn: () => true })
    assert.ok((await r.ask.ask({ subject: TIGERS }) as { larry?: unknown }).larry)
    // The very next ask: too soon by count and by clock.
    let out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && !out.larry)
    r.tick(LARRY_MIN_GAP_MS + 1)
    // The clock has passed, the count has not.
    out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && !out.larry)
    // Both have.
    out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.larry)
    assert.equal(r.calls.filter((c) => c.host === 'larry').length, 2)
  })

  test('even when he may, chance keeps him out some of the time', async () => {
    const r = rig([GOOD], { larryMayChimeIn: () => true, random: () => 0.99 })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && !out.larry)
    assert.equal(r.calls.length, 1)
  })

  test('"what does Larry think?" is always put to him', async () => {
    const r = rig([GOOD, LARRY], { larryMayChimeIn: () => true, random: () => 0.99 })
    const out = await r.ask.ask({ subject: TIGERS, question: 'what does Larry think?' })
    assert.ok(out.ok && out.larry)
    assert.match(r.calls[1]!.instructions, /Jake asked what YOU think/)
  })

  test('a line handed back in quotation marks is the line; a direction between two sentences leaves a space', async () => {
    const r = rig([GOOD, '"Hangs together." [pauses] Three singers. That\'s a group chat, Marty.'], { larryMayChimeIn: () => true })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.larry)
    assert.equal(out.larry.text, '"Hangs together." Three singers. That\'s a group chat, Marty.')
    const q = rig([GOOD, '"Third one this year. Who has that much to be sad about?"'], { larryMayChimeIn: () => true })
    const quoted = await q.ask.ask({ subject: TIGERS })
    assert.ok(quoted.ok && quoted.larry)
    assert.equal(quoted.larry.text, 'Third one this year. Who has that much to be sad about?')
  })

  test('asked about Larry, the Music Man hands it over instead of speaking for him', async () => {
    const r = rig([GOOD, LARRY], { larryMayChimeIn: () => true })
    await r.ask.ask({ subject: TIGERS, question: 'what does Larry think?' })
    assert.match(r.calls[0]!.messages.at(-1)!.content, /Larry answers for himself right after you/)
  })

  test('his line is told to the Music Man on the next ask', async () => {
    const r = rig([GOOD, LARRY, 'Larry wouldn\'t know noise if it sat on him.'], { larryMayChimeIn: () => true })
    await r.ask.ask({ subject: TIGERS })
    await r.ask.ask({ subject: TIGERS })
    assert.match(r.calls[2]!.messages.at(-1)!.content, /Larry cut in: "He said "noise" like it's a compliment\. It is\. Fine\."/)
  })

  test('with Larry as the chosen host he answers himself and nobody cuts in', async () => {
    const r = rig(['It\'s thirty-three minutes. I checked. Good.'], { activeHost: () => 'larry', larryMayChimeIn: () => true })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.speaker === 'larry' && !out.larry)
    assert.equal(r.calls.length, 1)
    assert.equal(r.calls[0]!.host, 'larry')
    assert.match(askInstructions('larry'), /Jake asked YOU/)
  })

  test("Larry failing never costs Jake the Music Man's answer", async () => {
    const r = rig([GOOD], { larryMayChimeIn: () => true })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && !out.larry)
  })
})

describe('a question about something that is not the page', () => {
  const HONEST = "Glorp Division? Never heard of them, and I'm not going to make something up."

  test('an honest "never heard of them" about another band stands: no retry, no facts forced on it', async () => {
    const r = rig([HONEST])
    const out = await r.ask.ask({ subject: TIGERS, question: 'do you know Glorp Division?' })
    assert.ok(out.ok)
    assert.equal(out.how, 'model')
    assert.equal(out.text, HONEST)
    assert.equal(r.calls.length, 1)
    const sent = r.calls[0]!.messages.at(-1)!.content
    assert.match(sent, /This question is about something other than the page he has open/)
    assert.doesNotMatch(sent, /Your last reply said you didn't know it/)
    assert.match(r.calls[0]!.instructions, /If he asks about something ELSE .* answer THAT/)
  })

  test('the same words about the page itself are still thrown away', async () => {
    const r = rig(['Never heard of them.', GOOD])
    const out = await r.ask.ask({ subject: TIGERS, question: 'who are they?' })
    assert.ok(out.ok && out.how === 'second-try')
  })

  test('on the page, a reply that says he doesn\'t know some other band is not a failure', async () => {
    const r = rig(["It's a breakup record with steel guitar, and it's great. I've never heard of Glorp Division, though."])
    const out = await r.ask.ask({ subject: TIGERS, question: 'is it good?' })
    assert.ok(out.ok && out.how === 'model')
    assert.equal(r.calls.length, 1)
  })

  test('a question that names another record Jake owns is answered from that record\'s facts', async () => {
    const gathered: string[] = []
    const television = { kind: 'artist', name: 'Television' } as const
    const r = rig(['Marquee Moon. Ten minutes and not one wasted.'], {
      findAsked: async (q) => (/television/i.test(q) ? television : null),
      gather: async (subject) => {
        gathered.push(subject.kind === 'artist' ? subject.name : 'page')
        return subject.kind === 'artist'
          ? input({ subject, songs: [{ id: 7, title: 'Marquee Moon', artist: 'Television', album: 'Marquee Moon', plays: 40 }], artist: { name: 'Television', oneLiner: 'American rock band.' } })
          : input()
      },
    })
    const out = await r.ask.ask({ subject: TIGERS, question: 'what about Television?' })
    assert.ok(out.ok)
    assert.deepEqual(gathered, ['Television'])
    const sent = r.calls[0]!.messages.at(-1)!.content
    assert.match(sent, /WHAT JAKE IS LOOKING AT: the artist Television/)
    assert.match(sent, /Jake asks, about the artist Television: "what about Television\?"/)
    assert.doesNotMatch(sent, /something other than the page/)
  })

  test('and there, in his library, "I don\'t know them" is a failure again', async () => {
    const r = rig(["I don't know Television.", 'Marquee Moon. Ten minutes and not one wasted.'], {
      findAsked: async () => ({ kind: 'artist', name: 'Television' }),
      gather: async (subject) => input({ subject, songs: [{ id: 7, title: 'Marquee Moon', artist: 'Television', album: 'Marquee Moon' }], artist: { name: 'Television', oneLiner: 'American rock band.' } }),
    })
    const out = await r.ask.ask({ subject: TIGERS, question: 'what about Television?' })
    assert.ok(out.ok && out.how === 'second-try')
  })

  test('the mic itself (no typed question) is always about the page', async () => {
    let asked = 0
    const r = rig([GOOD], { findAsked: async () => { asked++; return null } })
    await r.ask.ask({ subject: TIGERS })
    assert.equal(asked, 0)
    assert.doesNotMatch(r.calls[0]!.messages.at(-1)!.content, /something other than the page/)
  })
})

describe("when the rule can't tell", () => {
  const UNCLEAR = "This album hasn't exactly been living rent-free with me, I can't comment."

  test('the small model is asked once, yes or no; yes means try again', async () => {
    const judged: string[] = []
    const r = rig([UNCLEAR, GOOD], { judge: async (reply, what) => { judged.push(`${what} :: ${reply}`); return reply === UNCLEAR } })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.how === 'second-try')
    assert.deepEqual(judged, [`the album "The Holy Cross Tigers" by Twisted Teens (2026) :: ${UNCLEAR}`])
  })

  test('no means the reply stands', async () => {
    const r = rig([UNCLEAR], { judge: async () => false })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.how === 'model')
    assert.equal(r.calls.length, 1)
  })

  test('a clear answer and a clear non-answer never reach the judge', async () => {
    let judged = 0
    const judge = async (): Promise<boolean> => { judged++; return true }
    await rig([GOOD], { judge }).ask.ask({ subject: TIGERS })
    await rig([SAW, GOOD], { judge }).ask.ask({ subject: TIGERS })
    assert.equal(judged, 0)
  })

  test('a judge that fails or is absent leaves the reply as it is', async () => {
    const failing = rig([UNCLEAR], { judge: async () => { throw new Error('model down') } })
    const a = await failing.ask.ask({ subject: TIGERS })
    assert.ok(a.ok && a.how === 'model')
    const none = rig([UNCLEAR])
    const b = await none.ask.ask({ subject: TIGERS })
    assert.ok(b.ok && b.how === 'model')
  })

  test('the retry is bounded at one: two host calls at most, whatever comes back', async () => {
    const r = rig([SAW, UNCLEAR, 'never used'], { judge: async () => true })
    const out = await r.ask.ask({ subject: TIGERS })
    assert.ok(out.ok && out.how === 'facts')
    assert.equal(r.calls.length, 2)
  })

  test("the reviewer's opinions go straight through", async () => {
    for (const opinion of ["I've never heard a band commit this hard.", "I didn't know Twisted Teens could sound this mean.", 'Send me a song that hits harder.']) {
      const r = rig([opinion], { judge: async () => { throw new Error('must not be asked') } })
      const out = await r.ask.ask({ subject: TIGERS })
      assert.ok(out.ok && out.how === 'model', opinion)
      assert.equal(r.calls.length, 1, opinion)
    }
  })
})
