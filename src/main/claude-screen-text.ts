/**
 * The Music Man's persona teaches the voice's stage directions ("[softer]", "[laughs]"),
 * so any call that uses it can come back with them, and most replies are read, not spoken:
 * Listen List notes, rediscovery pitches, tape commentary and record store blurbs all
 * printed them. claudeCall passes every reply through here.
 *
 * Only these go to a voice and keep them. Radio and DJ captions strip their own, and the
 * chat keeps a clean `text` beside the tagged `textRaw` (index.ts).
 */
import { stripStageDirections } from '../common/stage-directions.ts'

const FOR_A_VOICE: ReadonlySet<string> = new Set([
  'musicman-chat',
  'musicman-dj',
  'musicman-dj-set',
  'musicman-radio',
  'musicman-radio-plan',
])

interface ReplyLike {
  content: ReadonlyArray<{ type: string; text?: string }>
}

export function forTheScreen<R extends ReplyLike>(callKey: string, reply: R): R {
  if (FOR_A_VOICE.has(callKey)) return reply
  return {
    ...reply,
    content: reply.content.map((b) => (b.type === 'text' && typeof b.text === 'string' ? { ...b, text: stripStageDirections(b.text) } : b)),
  }
}
