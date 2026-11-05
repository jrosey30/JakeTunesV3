// ⚠️ TWIN: JakeTunesMobile backend/src/util/stageDirections.ts. Byte-identical apart
// from this comment. Change both.
/**
 * Stage directions belong to the voice. The Music Man's persona teaches ElevenLabs tags
 * ("[softer]", "[laughs]"), which is right when he's spoken and wrong when he's read: the
 * take on Ants From Up There said "...more devastating. [softer] It's the record where...",
 * and a record store blurb opened "[leans against counter] Thirty plays is respect".
 *
 * Only a short run of lowercase words in brackets counts, or one of the persona's tags in
 * any case. Everything else in brackets is somebody's words and stays: a title's "[Live]"
 * or "[live]", an editor's "[sic]" or "[the band]", a JSON array.
 *
 * LEAF MODULE: no imports.
 */

/** The persona's list, and what it has been seen to write around it. */
const DELIVERY = /^(?:scoffs?|laugh(?:s|ing)?|chuckl(?:es?|ing)|sigh(?:s|ing)?|exhal(?:es?|ing)|whisper(?:s|ing)?|excited(?:ly)?|sarcastic(?:ally)?|interrupt(?:s|ing)?|curious(?:ly)?|mischievous(?:ly)?|softer|softly)$/i
const LOWERCASE_RUN = /^[a-z][a-z'’-]*(?: [a-z][a-z'’-]*){0,3}$/
/** What a title's bracket says, in whatever case the tag was written. */
const TITLE_WORDS = new Set([
  'live', 'demo', 'remix', 'remixes', 'remaster', 'remastered', 'edit', 'mix', 'version', 'explicit', 'clean',
  'instrumental', 'acoustic', 'reprise', 'untitled', 'mono', 'stereo', 'bonus', 'deluxe', 'single', 'album', 'ep', 'lp',
  'cover', 'intro', 'outro', 'interlude', 'skit', 'bootleg', 'unreleased', 'session', 'sessions', 'dub', 'extended',
  'radio', 'vinyl', 'cd', 'from', 'feat', 'featuring', 'with', 'edition', 'expanded', 'anniversary', 'reissue',
])
/** An editor's insertion or data, not a direction: "[sic]", "[the band]", "[their]", "[null]". */
const NOT_A_DIRECTION = new Set([
  'sic', 'the', 'a', 'an', 'he', 'she', 'they', 'it', 'his', 'her', 'their', 'its', 'this', 'that', 'these', 'those',
  'and', 'or', 'of', 'in', 'on', 'to', 'for', 'is', 'was', 'were', 'are', 'null', 'true', 'false',
])

const BRACKETS = /( *)\[([^[\]\n]{1,40})\]( *)/g
/** Nothing on this side wants a space: a line's edge, a quote, or punctuation. */
const NO_SPACE_BEFORE = /^$|[\n"“‘(]$/
const NO_SPACE_AFTER = /^(?:$|[\n"”’).,;:!?…])/

export function isStageDirection(inside: string): boolean {
  const text = inside.trim()
  if (DELIVERY.test(text)) return true
  if (!LOWERCASE_RUN.test(text)) return false
  const words = text.split(' ')
  if (NOT_A_DIRECTION.has(words[0]!)) return false
  return !words.some((w) => TITLE_WORDS.has(w))
}

/** The same text with its stage directions gone. Text with none comes back untouched. */
export function stripStageDirections(text: string): string {
  const source = String(text ?? '')
  let removed = false
  const out = source.replace(BRACKETS, (whole, before: string, inside: string, after: string, at: number) => {
    if (!isStageDirection(inside)) return whole
    removed = true
    const edge = NO_SPACE_BEFORE.test(source.slice(0, at)) || NO_SPACE_AFTER.test(source.slice(at + whole.length, at + whole.length + 1))
    return edge ? '' : ' '
  })
  if (!removed) return text
  const tidy = out
    // "Listen — [sighs] — fine." and "[sighs] — fine."
    .replace(/([—–]) \1/g, '$1')
    .replace(/^[—–] */gm, '')
    .trim()
  // "[scoff] yeah, sure."
  return source.trimStart().startsWith('[') ? tidy.charAt(0).toUpperCase() + tidy.slice(1) : tidy
}
