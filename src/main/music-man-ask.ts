/**
 * Jake asks, the Music Man answers. The mic button and the chat beside it.
 *
 * 2026-11-13, Jake: "music man cant suck at knowing the twisted teens. he also
 * should only give his opinion if i ask. make it work off of the mic button.
 * if he sees im on the artist page, he should know about the artist, if album
 * know about the album … more conversational … get larry more involved".
 *
 * One ask:
 *   1. gather what JakeTunes knows about the thing on screen (music-man-gather.ts)
 *      and lay it out as facts (common/music-man-packet.ts);
 *   2. thin? look harder first (homemini's artist profile, the press search);
 *   3. ask the host, with the last few turns of this session;
 *   4. a reply that says he doesn't know it (common/non-answer.ts) is never
 *      returned: one more try with more to go on, then the facts and the sound
 *      in plain words. One retry, never more. This holds for things in Jake's
 *      library. A typed question about something else is answered about that:
 *      a record or artist he owns gets its own facts; anything else may
 *      honestly get "never heard of them";
 *   5. Larry may add one line, when he has one and hasn't just had one.
 *
 * Nothing here is kept on disk: a take is said when asked, not stored.
 *
 * Everything it touches is injected, so the whole flow runs under node --test
 * (__tests__/music-man-ask.test.ts) and in the evaluation
 * (scripts/music-man-eval.ts) with the same code the app runs.
 */
import {
  buildPacket, factsOnlyAnswer, subjectKey, subjectLabel, subjectNames,
  type AskHost, type AskLine, type AskResult, type AskSubject, type PacketInput,
} from '../common/music-man-packet.ts'
import { asksAboutOther, judgeReply } from '../common/non-answer.ts'
import {
  askLine, CONVERSATIONAL_REGISTER, GROUNDING_RULES, LARRY_CHIME_IN, NO_HEDGE_RETRY, OFF_PAGE_NOTE, larryPassed,
} from '../common/music-man-ask-prompt.ts'
import { stripStageDirections } from '../common/stage-directions.ts'
import { cleanAiProse } from '../common/clean-ai-prose.ts'
import { wholeSentences } from '../common/sentences.ts'

export type { AskHost, AskLine, AskResult }
export type AskMessage = { role: 'user' | 'assistant'; content: string }

export interface AskModelCall {
  /** Whose persona answers. */
  host: AskHost
  /** What this call adds to the persona. */
  instructions: string
  messages: AskMessage[]
  maxTokens: number
  callKey: string
}

export interface AskDeps {
  /** What the app knows about the subject. Null: nothing of it is in the library. */
  gather: (subject: AskSubject, nowPlayingId?: number | null) => Promise<PacketInput | null>
  /** A second, slower look for a thin subject. Returns what it has now. */
  lookHarder?: (subject: AskSubject, input: PacketInput) => Promise<PacketInput>
  model: (call: AskModelCall) => Promise<{ text: string; cut: boolean }>
  /**
   * Something else in the library that a typed question names (an artist or a record that is
   * not the page). The ask is then about that, with its own facts.
   */
  findAsked?: (question: string, page: AskSubject) => Promise<AskSubject | null>
  /**
   * One yes/no to the small model, only when the rule can't tell whether a reply says he
   * doesn't know the subject. Absent, or failing: the reply is taken as an answer.
   */
  judge?: (reply: string, what: string) => Promise<boolean>
  activeHost: () => AskHost
  /** Settings → AI → "Larry chimes in". */
  larryMayChimeIn: () => boolean | Promise<boolean>
  now?: () => number
  /** 0..1; tests pin it. */
  random?: () => number
  /** Each line said, for the persona's short memory. */
  note?: (host: AskHost, text: string) => void
  log?: (msg: string) => void
}

export interface AskRequest {
  subject: AskSubject
  /** Typed, when he typed. Absent: he pressed the mic. */
  question?: string
  nowPlayingId?: number | null
}

/** A session ends after this long with no ask. */
export const SESSION_IDLE_MS = 30 * 60_000
/** Turns of the session that ride along (user + assistant lines). */
export const THREAD_MAX = 8
/** Larry's line is rare: this long since his last, and this many asks. */
export const LARRY_MIN_GAP_MS = 4 * 60_000
export const LARRY_MIN_ASKS_BETWEEN = 2
/** Even when he may, he's only asked this often. */
export const LARRY_CHANCE = 0.6

const SPOKEN = `This is SPOKEN aloud: two sentences, three at the most. Performance tags like [laughs] or [sighs] are fine where they change a beat; they are never shown.`

/** The voice keeps its directions ("[sighs]"); the screen never sees them. Markdown goes from both. */
function show(raw: string): AskLine {
  const textRaw = (raw || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
    // A whole line handed back inside quotation marks is the line.
    .replace(/^["“]([^"“”]*(?:"[^"“”]*"[^"“”]*)*)["”]$/, (whole, inner: string) => ((inner.match(/"/g)?.length ?? 0) % 2 === 0 ? inner : whole))
    .trim()
  const text = cleanAiProse(stripStageDirections(textRaw))
    .replace(/[ \t]+/g, ' ')
    // A direction removed between a closing quote and the next sentence leaves them touching.
    .replace(/([.!?]["”])(?=\p{Lu})/gu, '$1 ')
    .trim()
  return { textRaw, text }
}

/** The mode block for an ask, by host. Larry's own core already says how he talks. */
export function askInstructions(host: AskHost): string {
  return host === 'larry'
    ? `Jake asked YOU. Short spoken turns, to him; pick up what was said a minute ago.\n\n${GROUNDING_RULES}\n\n${SPOKEN}`
    : `${CONVERSATIONAL_REGISTER}\n\n${GROUNDING_RULES}\n\n${SPOKEN}`
}

export interface MusicManAsk {
  ask(req: AskRequest): Promise<AskResult>
  /** The session's turns, oldest first (the chat reads them so a typed follow-up continues the mic). */
  thread(): AskMessage[]
  forget(): void
}

export function createMusicManAsk(deps: AskDeps): MusicManAsk {
  const now = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const log = deps.log ?? (() => {})

  let turns: AskMessage[] = []
  let lastAt = 0
  let lastKey = ''
  let larryAt = -Infinity
  let asksSinceLarry = LARRY_MIN_ASKS_BETWEEN
  /** Larry's last line, told to the host on the next ask so he can answer it. */
  let larrySaid = ''

  const freshSession = (): void => {
    if (now() - lastAt > SESSION_IDLE_MS) { turns = []; lastKey = ''; larrySaid = '' }
  }

  async function hostReply(host: AskHost, messages: AskMessage[]): Promise<{ line: AskLine; cut: boolean }> {
    const r = await deps.model({ host, instructions: askInstructions(host), messages, maxTokens: 260, callKey: 'musicman-ask' })
    const line = show(r.cut ? wholeSentences(r.text) : r.text)
    return { line, cut: r.cut }
  }

  /** Does this reply say he doesn't know the subject? The rule first; the small model only when the rule can't tell. */
  async function saysHeDoesntKnow(text: string, names: readonly string[], what: string): Promise<boolean> {
    if (!text) return true
    const verdict = judgeReply(text, names)
    if (verdict === 'non-answer') return true
    if (verdict !== 'unsure' || !deps.judge) return false
    try {
      return await deps.judge(text, what)
    } catch (err) {
      log(`[musicman-ask] the judge did not answer: ${(err as Error).message}`)
      return false
    }
  }

  async function larryLine(packetText: string, said: string, asked: boolean, names: readonly string[]): Promise<AskLine | undefined> {
    const instructions = asked
      ? `Jake asked what YOU think, right after the Funk Man answered. One or two short spoken sentences, to both of them.\n\n${GROUNDING_RULES}`
      : LARRY_CHIME_IN
    try {
      const r = await deps.model({
        host: 'larry', instructions, maxTokens: 140, callKey: 'musicman-ask-larry',
        messages: [{ role: 'user', content: `${packetText}\n\nThe Funk Man just said: "${said}"` }],
      })
      if (r.cut || larryPassed(r.text)) return undefined
      const line = show(r.text)
      // The same rule as the Music Man's: a line that says he doesn't know it is not a line.
      if (!line.text || judgeReply(line.text, names) === 'non-answer') return undefined
      return line
    } catch (err) {
      log(`[musicman-ask] Larry had nothing: ${(err as Error).message}`)
      return undefined
    }
  }

  return {
    async ask(req) {
      freshSession()
      const host = deps.activeHost()
      // A typed question may be about something else. If it names a record or an artist Jake owns,
      // the ask is about that. If it names something else entirely, the page is only where he is.
      const question = (req.question ?? '').trim()
      let subject = req.subject
      let offPage = false
      if (question) {
        const asked = deps.findAsked ? await deps.findAsked(question, req.subject).catch(() => null) : null
        if (asked) subject = asked
      }
      let input = await deps.gather(subject, req.nowPlayingId)
      if (!input || (input.songs.length === 0 && !input.artist)) {
        return { ok: false, error: 'not-in-library' }
      }
      let packet = buildPacket(input)
      let looked = false
      if (packet.thin && deps.lookHarder) {
        input = await deps.lookHarder(subject, input)
        packet = buildPacket(input)
        looked = true
      }

      const names = subjectNames(input)
      if (question && subject === req.subject) offPage = asksAboutOther(question, names)
      const key = subjectKey(subject)
      const what = subjectLabel(subject, input.songs)
      const cutIn = larrySaid ? `(After your last line, Larry cut in: "${larrySaid}")\n` : ''
      larrySaid = ''
      const larryOn = host === 'mm' && await deps.larryMayChimeIn()
      const forLarry = larryOn && /\blarry\b/i.test(req.question ?? '')
      const line = `${cutIn}${askLine(what, { question: req.question, again: !req.question && key === lastKey })}${forLarry ? '\n(Larry answers for himself right after you. Hand it to him in one short line; don\'t speak for him.)' : ''}${offPage ? `\n${OFF_PAGE_NOTE}` : ''}`
      const messages: AskMessage[] = [...turns, { role: 'user', content: `${packet.text}\n\n${line}` }]

      let how: 'model' | 'second-try' | 'facts' = 'model'
      let reply = await hostReply(host, messages)
      // Off the page, "never heard of them" is an honest answer and stands. On it, it never does.
      if (!offPage && await saysHeDoesntKnow(reply.line.text, names, what)) {
        log(`[musicman-ask] first reply on ${key} said he didn't know it; asking again`)
        if (!looked && deps.lookHarder) {
          input = await deps.lookHarder(subject, input)
          packet = buildPacket(input)
        }
        how = 'second-try'
        reply = await hostReply(host, [...turns, { role: 'user', content: `${packet.text}\n\n${line}\n\n${NO_HEDGE_RETRY}` }])
        if (await saysHeDoesntKnow(reply.line.text, names, what)) {
          const facts = factsOnlyAnswer(input)
          if (!facts) return { ok: false, error: 'nothing-to-say' }
          log(`[musicman-ask] second reply on ${key} still didn't know it; answering from the facts`)
          how = 'facts'
          reply = { line: { text: facts, textRaw: facts }, cut: false }
        }
      }

      turns = [...turns, { role: 'user' as const, content: line }, { role: 'assistant' as const, content: reply.line.textRaw }].slice(-THREAD_MAX)
      lastAt = now()
      lastKey = key
      deps.note?.(host, reply.line.text)

      let larry: AskLine | undefined
      if (!reply.line.text) return { ok: false, error: 'nothing-to-say' }
      if (larryOn && how !== 'facts' && !offPage) {
        const asked = forLarry
        const due = now() - larryAt >= LARRY_MIN_GAP_MS && asksSinceLarry >= LARRY_MIN_ASKS_BETWEEN && random() < LARRY_CHANCE
        if (asked || due) {
          larry = await larryLine(packet.text, reply.line.text, asked, names)
          if (larry) {
            larryAt = now()
            asksSinceLarry = 0
            larrySaid = larry.text
            deps.note?.('larry', larry.text)
          }
        }
        if (!larry) asksSinceLarry++
      }

      return { ok: true, speaker: host, how, ...reply.line, ...(larry ? { larry } : {}) }
    },
    thread() {
      freshSession()
      return [...turns]
    },
    forget() {
      turns = []
      lastKey = ''
      larrySaid = ''
    },
  }
}
