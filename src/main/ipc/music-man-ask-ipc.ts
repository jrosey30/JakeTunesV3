/**
 * 'musicman-ask': the mic button's door, and the grounding the chat beside it
 * shares (2026-11-13). The flow is main/music-man-ask.ts; what he is handed is
 * main/music-man-gather.ts. This file only checks what the renderer sent and
 * wires the app's own Claude call, settings and library in.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { MODEL_FAST, MODEL_SMART } from '../../common/ai-models.ts'
import { LARRY_CORE, buildMusicManPrompt } from '../personas.ts'
import { buildPacket, factsOnlyAnswer, subjectLabel, subjectNames, type AskSubject, type PacketInput } from '../../common/music-man-packet.ts'
import { CONVERSATIONAL_REGISTER, GROUNDING_RULES, NO_HEDGE_RETRY, judgePrompt, judgedYes } from '../../common/music-man-ask-prompt.ts'
import { asksAboutOther, judgeReply } from '../../common/non-answer.ts'
import { createMusicManAsk, type AskHost, type AskResult, type MusicManAsk } from '../music-man-ask.ts'
import { createMusicManGather, type GatherTrack, type MusicManGather } from '../music-man-gather.ts'

export interface MusicManAskHost {
  tracks: () => Promise<GatherTrack[]>
  userDataDir: () => string
  hubUrl: string
  withAuth: (init?: RequestInit) => RequestInit | undefined
  press: (artist: string, album?: string) => Promise<string>
  claudeCall: (callKey: string, params: Anthropic.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Messages.Message>
  readActiveHost: () => AskHost
  readAppSettings: () => Promise<Record<string, unknown> | null>
  /** The persona's short memory and the mic log. */
  said: (host: AskHost, text: string, subject: AskSubject) => void
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Only a well-formed subject gets through; anything else is no subject. */
export function parseAskSubject(raw: unknown): AskSubject | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'album') {
    const artist = text(r.artist, 300), album = text(r.album, 300)
    return album ? { kind: 'album', artist, album, year: text(r.year, 10) || undefined } : null
  }
  if (r.kind === 'artist') {
    const name = text(r.name, 300)
    return name ? { kind: 'artist', name } : null
  }
  if (r.kind === 'song') {
    return typeof r.trackId === 'number' && Number.isInteger(r.trackId) ? { kind: 'song', trackId: r.trackId } : null
  }
  if (r.kind === 'list') {
    const name = text(r.name, 200)
    const ids = Array.isArray(r.trackIds) ? r.trackIds.filter((i): i is number => typeof i === 'number' && Number.isInteger(i)).slice(0, 6000) : []
    const what = r.what === 'ipod' || r.what === 'smart' ? r.what : 'playlist'
    return name && ids.length ? { kind: 'list', what, name, trackIds: ids, purpose: text(r.purpose, 200) || undefined } : null
  }
  return null
}

/** Settings → AI → "Larry chimes in". On unless Jake turned it off. */
export function larryChimesIn(settings: Record<string, unknown> | null): boolean {
  return (settings?.ai as { larryChimesIn?: boolean } | undefined)?.larryChimesIn !== false
}

export interface MusicManGrounding {
  /**
   * What to add to the chat's system prompt. The facts are for the page, unless the question
   * names another artist or record Jake owns: then they are for that. `offPage`: the question is
   * about something that is neither, so "never heard of them" is an honest reply and stands.
   */
  chatBlock(subject: unknown, nowPlayingId?: unknown, question?: string): Promise<{ block: string; input: PacketInput; offPage: boolean } | null>
  /** A chat reply that said he didn't know it: one more try, then the facts. */
  rescueChat(input: PacketInput, reply: string, again: (extra: string) => Promise<string>): Promise<string>
}

export function registerMusicManAskIpc(ipc: IpcRegistrar, host: MusicManAskHost): MusicManGrounding {
  let gatherer: MusicManGather | null = null
  const gather = (): MusicManGather => (gatherer ??= createMusicManGather({
    tracks: host.tracks,
    userDataDir: host.userDataDir(),
    hubUrl: host.hubUrl.replace(/\/+$/, ''),
    withAuth: host.withAuth,
    press: host.press,
    warn: (m) => console.warn(m),
  }))

  /** The rule couldn't tell: one yes/no to the small model. A failed call counts as "no". */
  const judge = async (reply: string, what: string): Promise<boolean> => {
    const p = judgePrompt(what, reply)
    const r = await host.claudeCall('musicman-ask-judge', { model: MODEL_FAST, max_tokens: 5, system: p.system, messages: [{ role: 'user', content: p.user }] })
    return judgedYes(r.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map((b) => b.text).join(' '))
  }

  let subjectNow: AskSubject | null = null
  const asker: MusicManAsk = createMusicManAsk({
    gather: (subject, nowPlayingId) => gather().gather(subject, nowPlayingId),
    lookHarder: (subject, input) => gather().lookHarder(subject, input),
    findAsked: (question, page) => gather().findAsked(question, page),
    judge,
    activeHost: host.readActiveHost,
    larryMayChimeIn: async () => larryChimesIn(await host.readAppSettings()),
    note: (who, said) => { if (subjectNow) host.said(who, said, subjectNow) },
    log: (m) => console.log(m),
    model: async (call) => {
      // The active host's prompt carries the library digest, the taste profile and what he said lately.
      // Larry cutting in on the Music Man's turn is Larry's core alone.
      const system: TextBlockParam[] = call.host === host.readActiveHost()
        ? buildMusicManPrompt(call.instructions)
        : [{ type: 'text', text: LARRY_CORE, cache_control: { type: 'ephemeral' } }, { type: 'text', text: call.instructions }]
      const reply = await host.claudeCall(call.callKey, { model: MODEL_SMART, max_tokens: call.maxTokens, system, messages: call.messages })
      const said = reply.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text').map((b) => b.text).join(' ').trim()
      return { text: said, cut: reply.stop_reason === 'max_tokens' }
    },
  })

  ipc.handle('musicman-ask', async (_e, rawSubject: unknown, question?: unknown, nowPlayingId?: unknown): Promise<AskResult> => {
    const subject = parseAskSubject(rawSubject)
    if (!subject) return { ok: false, error: 'invalid-input' }
    subjectNow = subject
    try {
      return await asker.ask({
        subject,
        question: text(question, 600) || undefined,
        nowPlayingId: typeof nowPlayingId === 'number' ? nowPlayingId : null,
      })
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  return {
    async chatBlock(rawSubject, nowPlayingId, question) {
      const page = parseAskSubject(rawSubject)
      if (!page) return null
      const q = (question ?? '').trim()
      const asked = q ? await gather().findAsked(q, page).catch(() => null) : null
      const subject = asked ?? page
      const input = await gather().gather(subject, typeof nowPlayingId === 'number' ? nowPlayingId : null).catch(() => null)
      if (!input || (input.songs.length === 0 && !input.artist)) return null
      const offPage = !asked && !!q && asksAboutOther(q, subjectNames(input))
      return {
        input,
        offPage,
        block: `\n\n${CONVERSATIONAL_REGISTER}\n\n${GROUNDING_RULES}\n\nFACTS (${asked ? 'what Jake just asked about' : 'what Jake is on right now; a question about "this" means this'}):\n${buildPacket(input).text}`,
      }
    },
    async rescueChat(input, reply, again) {
      // Only when it is this subject he says he doesn't know. The rule first; the small model when it can't tell.
      const names = subjectNames(input)
      const what = subjectLabel(input.subject, input.songs)
      const doesntKnow = async (text: string): Promise<boolean> => {
        const v = judgeReply(text, names)
        return v === 'non-answer' || (v === 'unsure' && await judge(text, what).catch(() => false))
      }
      if (!(await doesntKnow(reply))) return reply
      const second = await again(NO_HEDGE_RETRY).catch(() => '')
      if (second && !(await doesntKnow(second))) return second
      return factsOnlyAnswer(input) || reply
    },
  }
}
