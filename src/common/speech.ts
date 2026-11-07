/**
 * What main and the renderer share about a spoken take (2026-11-06): the radio
 * asks for a run of lines as one dialogue call, and captions follow the speaker
 * from the times ElevenLabs sends back. Types and one limit, so the two sides
 * can't drift on either. No imports: node --test and both tsconfigs load it.
 */

/** ElevenLabs' dialogue docs: keep the total text of one request at or under
 *  2,000 characters "for reliable generation". Tags count: they are billed. */
export const MAX_DIALOGUE_CHARS = 2000

export interface DialogueInput {
  text: string
  voiceId: string
}

/** One entry of the API's voice_segments: when `input` (an index into the
 *  inputs sent) is speaking, in seconds into the take. */
export interface DialogueSegment {
  input: number
  startSec: number
  endSec: number
}

export interface DialogueResult {
  ok: boolean
  /** base64 mp3. '' with ok:true means the voice is switched off in Settings. */
  audio?: string
  segments?: DialogueSegment[]
  error?: string
}
