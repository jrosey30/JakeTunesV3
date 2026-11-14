/**
 * A reply that says the speaker doesn't know the record or the artist.
 *
 * Jake, 2026-11-13, on an album he owns and loves: "music man cant suck at
 * knowing the twisted teens." The album page showed "I don't know Twisted
 * Teens or "The Holy Cross Tigers," and I'd rather say that than invent a take
 * on a record I can't place in their run. If you give me a sense of the sound,
 * I'll tell you honestly whether it fits." The old filter (isWeakBlurb) knew
 * four phrases and none of them was in it: 9 of the 35 takes kept on the
 * MacBook and 7 of the 41 on homemini were answers like this one.
 *
 * Such a reply about something in Jake's own library is never shown, spoken or
 * kept: the ask tries again with more to go on, then answers from the facts
 * and the sound.
 *
 * What it must NOT catch is an opinion: "I don't love this record", "I don't
 * know why people skip it", "I won't pretend it's their best". Every pattern
 * is about knowing the thing, not about liking it.
 *
 * ⚠️ TWIN: one file, byte for byte, in two repos: JakeTunesV3 src/common/non-answer.ts and
 * JakeTunesMobile backend/src/util/nonAnswer.ts. Each repo's
 * music-man-twins test pins its sha256: change it here, change it there, and
 * update both pins.
 *
 * Pure and import-free.
 */

const THING = '(?:record|album|one|band|artist|act|group|duo|song|track|ep|lp|release|project)'

/** Case matters: a name or a quoted title after "know". */
const KNOWS_A_NAME = /\bI (?:don't|do not|didn't) (?:really |actually )?know ["“'A-Z@]/

const PATTERNS: readonly RegExp[] = [
  // "I don't know this record / them / it / enough about"
  new RegExp(`\\bi (?:don't|do not) (?:really |actually )?know (?:(?:this|that|the|their|his|her) (?:new |latest |specific |particular )?${THING}\\b|them\\b|it\\b(?!'s| is| was| when)|enough\\b|much about|anything about)`, 'i'),
  // "I don't have a solid handle on", "I haven't got a reliable read on", "solid enough knowledge of"
  /\bi (?:don't|do not|haven't|have not) (?:got |have )?(?:a |an |any |enough |solid |reliable |good |real |firm |clear |strong )+(?:enough )?(?:read|handle|knowledge|recall|memory|information|info|grip|line|sense|picture) (?:on|of|about)\b/i,
  /\bi (?:don't|do not|haven't|have not) (?:got |have )?anything (?:reliable|solid|real|useful|concrete|verified) (?:on|about)\b/i,
  // "a record I can't place in their run"
  /\b(?:can't|cannot|can not|couldn't) (?:really |quite |honestly )?place (?:it|this|that|them|in |the (?:record|album|band|artist)|["“])/i,
  /\bi(?:'m| am) (?:not familiar|unfamiliar) with\b/i,
  /\bi(?:'ve| have) never (?:heard|come across)\b/i,
  /\bi (?:haven't|have not) (?:actually |really )?(?:heard|listened to|absorbed|sat with) (?:it|this|that|them|the (?:record|album))\b/i,
  // The Music Man's own older ways of saying it (isWeakBlurb)
  /drawing a blank|didn't stick|pulling a name|land a take worth hearing/i,
  // "I won't pretend to know", "I'd be inventing", "without making things up"
  /\bpretend (?:to(?: know| have| be able)?[.,;!]|to (?:know|have)\b|i (?:know|have)\b|i've\b)/i,
  /\b(?:invent|bluff|fake|fabricate) (?:a |an |my |some )?(?:take|verdict|opinion|read|story|answer|review)\b/i,
  /\bi(?:'d| would) be (?:inventing|guessing|making)\b/i,
  /\bmaking (?:things|stuff|it|something) up\b/i,
  /\bwell enough to (?:call|judge|give|say|hand|rate|rank)\b/i,
  // Asking the listener to do the knowing
  /\b(?:give|tell|send) me (?:a sense of|what you've heard|more about|the artist's|a track|a song|a couple)/i,
  /\btell me what (?:it|they|you've) (?:sounds?|heard)\b/i,
]

/** Curly apostrophes and quotes read as straight ones. */
function straight(text: string): string {
  return (text || '').replace(/[‘’]/g, "'")
}

export function isNonAnswer(text: string): boolean {
  const t = straight(text)
  if (!t.trim()) return false
  if (KNOWS_A_NAME.test(t)) return true
  return PATTERNS.some((p) => p.test(t))
}
