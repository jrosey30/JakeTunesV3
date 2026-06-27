/**
 * 4.5 Radio rebuild (radioV2) — the structured Show data model.
 *
 * The whole point of the rebuild: a radio show is DATA, not tagged text we parse
 * with fragile regexes. Generation returns these objects directly (validated at
 * the source), the engine sequences them, the pill renders them. Nothing here
 * imports node/electron/DOM — pure types, safe to share across processes.
 *
 * Lives behind the `radioV2` flag; V1 (the current Toolbar path) is untouched.
 * See project_radio_mode memory for the full rebuild roadmap.
 */

/** Every voice in the WJLR cast — hosts, the announcer, the 9-caller rolodex,
 *  and the guest DJ. The single source of truth for the actual entries +
 *  metadata is the cast registry (src/main/cast.ts → RADIO_CAST); this union is
 *  the compile-time guard so a typo can't invent a speaker. */
export type SpeakerId =
  | 'mm'
  | 'megan'
  | 'announcer'
  | 'stephen'
  | 'giovanni'
  | 'rajiv'
  | 'bernard'
  | 'lashonte'
  | 'kristina'
  | 'devin'
  | 'maya'
  | 'mike'
  | 'zoe'

/** One spoken line — the atomic unit of a show. `text` is the words; the pill
 *  caption is `text` minus inline audio tags (e.g. "[laughs]"). `overlap` is the
 *  rebuild's fix for stiff pacing: a true interrupt starts BEFORE the previous
 *  line finishes instead of waiting for dead air. `audio`/`durationMs` are filled
 *  by the TTS pass. */
export interface RadioLine {
  speaker: SpeakerId
  text: string
  overlap?: boolean
  audio?: string        // base64 mp3
  durationMs?: number   // measured when audio metadata loads
}

/** One generated talk break — the show open, a between-songs banter, a caller
 *  call-in, a station ID. Carries the structural context (slot/archetype/angle)
 *  so memory + the hour-clock keep working. */
export interface RadioSegment {
  id: string
  slot: number              // 0..11 hour-clock position
  archetypeId?: string      // structural shape used (see archetypes.ts)
  angle?: string            // topic angle used
  speakers: SpeakerId[]     // everyone who appears (for memory/callbacks)
  lines: RadioLine[]
  prevTrack?: string        // "Title — Artist" that just played
  nextTrack?: string        // "Title — Artist" coming up
}

/** The planned arc of a show: theme + throughline + track order. Generated once
 *  at start and — the key coherence fix — injected into EVERY segment so the
 *  hosts know where they are ("track 7 of 13, soul-roots phase"). V1 generates
 *  this then throws it away; V2 uses it. */
export interface RadioShowPlan {
  theme: string
  throughline: string
  trackIds: number[]
}

/** A live show session. */
export interface RadioShow {
  id: string
  plan?: RadioShowPlan
  startedAt: number
  capMs: number             // hard cap (90 min) — non-negotiable for token budget
}

/** Status surfaced to the UI — mirrors the existing activity.ts `radio` store
 *  shape so the pill renders identically regardless of V1/V2. */
export interface RadioStatus {
  active: boolean
  elapsedMs: number
  capMs: number
}
