/**
 * Does a reply say the speaker doesn't know the thing Jake asked about?
 *
 * Jake, 2026-11-13, on an album he owns and loves: "music man cant suck at
 * knowing the twisted teens." The album page showed "I don't know Twisted
 * Teens or "The Holy Cross Tigers," and I'd rather say that than invent a take
 * on a record I can't place in their run. If you give me a sense of the sound,
 * I'll tell you honestly whether it fits."
 *
 * The first version of this file matched phrases, and a review showed it was
 * wrong both ways: it called "I've never heard a band commit this hard" a
 * non-answer and let "Never heard of them" through. This one looks for the
 * actual thing, sentence by sentence:
 *
 *   1. a CLAIM OF NOT KNOWING ("never heard of", "don't know", "new to me",
 *      "doesn't ring a bell", "can't place", "no read on" …)
 *   2. made by the SPEAKER ("I", "we", or nobody: "Never heard of them."),
 *      not about somebody else ("you've never heard of them, which is the point")
 *   3. whose OBJECT is the subject: one of its names, or a word standing for it
 *      ("them", "it", "this record", "the name"). "A band", "anything this
 *      raw", "why people skip it" and "The Clash could sound this mean" are
 *      not the subject: they are opinions that happen to use the same words.
 *
 * A reply about some OTHER named thing ("I've never heard of Glorp Division")
 * is 'other': honest, and allowed. When a sentence has the words but the rule
 * cannot tell, the verdict is 'unsure' and the caller may put one yes/no
 * question to the small model (music-man-ask-prompt.ts judgePrompt).
 *
 * ⚠️ TWIN: one file, byte for byte, in two repos: JakeTunesV3 src/common/non-answer.ts and
 * JakeTunesMobile backend/src/util/nonAnswer.ts. Each repo's
 * music-man-twins test pins its sha256: change it here, change it there, and
 * update both pins.
 *
 * Pure and import-free.
 */

export type ReplyVerdict =
  /** Says something about the subject. */
  | 'answer'
  /** Says the speaker doesn't know the subject. */
  | 'non-answer'
  /** Says the speaker doesn't know some other named thing. */
  | 'other'
  /** Has the words; the rule can't tell. */
  | 'unsure'

const S = 'zzsubjectzz' // a name of the subject
const N = 'zzothernamezz' // some other name or quoted title

const THING = '(?:records?|albums?|one|ones|bands?|artists?|act|group|duo|trio|outfit|songs?|tracks?|ep|lp|release|project|name|title|singer|guy|guys|people|crew|stuff|music|material|catalog|catalogue|discography|work|playlist|list|kids)'
/** Words that stand for the subject. */
const REF = `(?:(?:this|that|the|their|his|her|these|those|its|your) (?:[a-z0-9'-]+ ){0,2}${THING}\\b|${S}|them|'em|it|him|her|this|that|these|those|either)`
/** The same, where the subject comes first: "they're new to me". */
const SUBJ = `(?:(?:this|that|the|their|his|her|these|those) (?:[a-z0-9'-]+ ){0,2}${THING}\\b|${S}|${N}|they|it|he|she|this|that|these|those)`
const BE = "(?: (?:is|are|was|were|isn't|aren't|is not|are not)|'s|'re)"
const OTHER = N
const OBJ = `(?:${REF}|${OTHER})`
const ADV = "(?:really |actually |honestly |even |ever |quite |just |genuinely |truly |personally |simply |exactly |yet |still )*"
/** What follows an object when the claim is "…know X <does something>": a clause, so it is not about knowing X. */
const CLAUSE_NEXT = /^(?:it's|they're|he's|she's|there's|i'm|i\b|we\b|you\b|they\b|could|would|can|will|might|should|had|has|have|was|were|is|are|did|do|does|made|make|makes|to\b|be\b|being|been|sound|play|sing|get|got|go|going|went|come|came|commit|hit|needed|need|want|still|ever|even|ended|turn|pull|keep|kept|put|from a\b|for the\b)/
/** What may follow an object when the sentence simply stops there. */
const END_NEXT = /^(?:$|[.,;:!?…)"]|and\b|but i\b|but\b(?! praise| love| good)|so\b|or\b|nor\b|either\b|yet\b|at all\b|well\b|before\b|myself\b|personally\b|by name\b|to be honest\b|honestly\b|sorry\b|though\b|i'm afraid\b|unfortunately\b|enough\b|as\b|from\b|by\b|right now\b|here\b|to (?:say|give|judge|tell|call|speak|offer|have|know|rate|weigh)\b|because\b|which\b)/

/** The subject of the verb is somebody else. */
const NOT_ME = /\b(?:you|you've|you'd|you'll|nobody|no one|people|folks|they|they've|they'd|he|she|he's|she's|everyone|everybody|anyone|anybody|critics|kids|somebody|someone|who|whoever|most|half|world|radio|america|crowd|label|fans)\b[^,;:]*$/
const ME = /\b(?:i|we|i've|we've|i'm|we're|i'd|we'd|me)\b[^,;:]*$/
const FILLER = /^(?:(?:honestly|frankly|sorry|look|listen|nope|no|yeah|yes|well|truthfully|admittedly|okay|ok|fine|oh|hm+|uh|um|and|but|so|because|jake|man|pal|kid|to be honest|truth is|truth be told|gotta say|i'll be honest|i'll level with you|can't lie|not gonna lie|full disclosure|confession|real talk)[, ]*)*$/

interface Claim {
  re: RegExp
  /** 'ref': the capture is the object and must stand for the subject. 'bare': the phrase alone is the claim. */
  kind: 'ref' | 'bare'
  /** The object must be followed by the end of the thought (not a clause). */
  ends?: boolean
  /** The knower is inside the phrase ("…to me", "…I know") or is nobody: no need to look for who is speaking. */
  self?: boolean
  /** A question put back to Jake ("Who are they?"): a non-answer only when the reply ends on it. */
  ask?: boolean
}

const g = (src: string): RegExp => new RegExp(src, 'g')

const CLAIMS: readonly Claim[] = [
  // never heard OF it
  { kind: 'ref', re: g(`\\b(?:never|[a-z]+n't|not|hardly|barely) ${ADV}(?:heard|hear|know|knew) of (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:never|[a-z]+n't|not) ${ADV}(?:come|came|run|ran|stumbled|bumped) (?:across|into|on|upon) (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:never|[a-z]+n't|not) ${ADV}(?:encountered|met|crossed paths with) (${OBJ})`) },
  // don't know it / know nothing about it
  { kind: 'ref', ends: true, re: g(`\\b(?:don't|do not|didn't|did not|wouldn't|can't say i|cannot say i|can't claim to|couldn't say i) ${ADV}know (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:don't|do not|didn't|did not) ${ADV}know (?:much|anything|a thing|a lot|enough|the first thing|a damn thing|squat|jack|a whole lot) (?:about|of|on) (${OBJ})`) },
  { kind: 'ref', re: g(`\\bknow (?:nothing|next to nothing|almost nothing|zero|very little|little|so little) (?:about|of|on) (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:don't|do not|didn't) ${ADV}know who (${SUBJ}) (?:is|are|was|were)`) },
  { kind: 'ref', re: g(`\\b(?:no idea|no clue|not a clue|not sure|couldn't tell you|can't tell you|cannot tell you|don't know) who (${SUBJ}) (?:is|are|was|were)`) },
  { kind: 'ref', re: g(`\\b(?:no idea|no clue|not a clue|couldn't tell you|can't tell you|cannot tell you) (?:who|what) (${SUBJ}) (?:is|are|sounds?|does|do)\\b`) },
  // never heard it
  { kind: 'ref', ends: true, re: g(`\\b(?:never|haven't|have not|hadn't|not) ${ADV}(?:heard|listened to|played|spun|sat with|absorbed|gotten to|got to|got around to|gotten around to) (${OBJ})`) },
  // not familiar with it, don't recognize it, can't place it
  { kind: 'ref', re: g(`\\b(?:not|[a-z]+n't|un)\\s?${ADV}familiar with (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:don't|do not|didn't|can't|cannot|couldn't) ${ADV}(?:recognize|recognise|place|identify|recall|remember) (${OBJ})`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ})${BE} (?:all |totally |completely |brand |entirely )?(?:a )?(?:new|unfamiliar|unknown|foreign|a mystery|a blank|a stranger|strangers) (?:one )?(?:to|on|for) me`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ}) (?:doesn't|don't|does not|didn't|isn't|aren't) ${ADV}(?:ring a bell|ring any bells?|ringing (?:a|any) bells?|mean anything to me|register|sound familiar)`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ}) (?:means|mean) nothing to me`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ})${BE} (?:not )?(?:one|a band|an artist|a name|a record|an album|a song|an act|a group|ones|something|someone|anything|anyone) i ${ADV}(?:know|recognize|recognise|'ve heard|have heard|'ve come across|can place|can speak to)`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ}) (?:slipped|got|went|flew|sailed|passed) (?:right |clean |completely )?(?:past|by|under) (?:me|my radar)`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ}) (?:passed|has passed|have passed) me by`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ})${BE} (?:not on|off|outside|beyond|out of) my (?:radar|wheelhouse|collection|shelves|memory|knowledge|depth)`) },
  { kind: 'ref', re: g(`\\b(?:i|i've|we|we've)(?: have|'ve)? ${ADV}(?:got |have |had )?(?:nothing|zero|zilch|nada|not much|very little) (?:reliable |solid |useful |real |concrete )?(?:on|about|for) (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:don't|do not|haven't|have not|didn't) ${ADV}(?:got |have |had )?(?:a |an |any |enough |solid |reliable |good |real |firm |clear |strong |much |much of a |the |anything |anything reliable |anything solid )+(?:enough )?(?:read|handle|knowledge|recall|memory|information|info|grip|line|sense|picture|data|context|background|details|facts|file|notes|reliable|solid|useful|concrete)? ?(?:on|of|about|for) (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:have|got|with|having) (?:no|zero) (?:reliable |solid |real |good |clear )?(?:read|handle|knowledge|recall|memory|information|info|grip|line|sense|picture|data|context|background|details|facts|file|record|notes) (?:on|of|about|for) (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:can't|cannot|couldn't|won't|wouldn't) ${ADV}(?:speak to|comment on|weigh in on|vouch for|tell you (?:much|anything|a thing|the first thing) about|say (?:much|anything) about|give you (?:a|an|my) (?:real |honest |proper |fair |straight )?(?:take|read|opinion|verdict|answer) on) (${OBJ})`) },
  { kind: 'ref', re: g(`\\bknow (${OBJ}) well enough to\\b`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ})${BE} (?:not )?(?:one|ones|a band|an artist|a name|a record|an album|a song|an act|a group|something|someone|anything|anyone) (?:that )?i(?:'m| am|'ve| have)? ${ADV}(?:not )?(?:familiar with|heard of|heard|come across|listened to|played)`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ})(?:'ve| have| has|'s)? (?:completely |totally |somehow )?(?:slipped|gotten|got|gone|flown|sailed|passed) (?:right |clean |completely )?(?:past|by|under) (?:me|my radar)`) },
  { kind: 'ref', re: g(`\\bwish i (?:could tell you|knew|could say) (?:something|anything|more|much) (?:about|on) (${OBJ})`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ})${BE} (?:a |an )?(?:complete |total )?(?:mystery|blank|unknown|stranger|strangers|question mark) to me`) },
  { kind: 'ref', re: g(`\\b(?:never|[a-z]+n't|not) ${ADV}heard a (?:note|second|single note|lick|bar) of (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:can't|cannot|couldn't) ${ADV}say (?:that )?i(?:'ve| have)? ${ADV}(?:heard of|heard|come across|listened to|know|recognize) (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:no|zero|any|lack(?:ing)?(?: any| the| all)?|without(?: any)?) (?:real |solid |reliable )?(?:knowledge|information|info|history|experience|familiarity|background|context|data) (?:of|on|about|with) (${OBJ})`) },
  { kind: 'ref', re: g(`\\b(?:blanking|stumped|lost|in the dark|at a loss|clueless|drawing blanks) (?:on|about|with|by|when it comes to) (${OBJ})`) },
  { kind: 'ref', self: true, re: g(`\\b(${SUBJ}) (?:hasn't|haven't|has not|have not|never) ${ADV}(?:crossed|come across|come up on|made it (?:on)?to|reached|landed on|hit) my (?:desk|path|radar|turntable|ears|shelf|shelves)`) },
  { kind: 'ref', re: g(`\\bonly know [^.!?]{2,60}, not (${OBJ})`) },
  // the claim needs no object
  { kind: 'bare', re: g(`\\b(?:haven't|have not|never) had the pleasure\\b`) },
  { kind: 'bare', re: g(`\\b(?:on|about|to|of) (?:a|an) (?:record|album|band|song|artist|act) i (?:haven't|have not|don't|do not|never|'ve never) ${ADV}(?:heard|know|listened to|played)\\b`) },
  { kind: 'bare', self: true, re: g(`\\b(?:beats me|search me|you've got me there|you got me there|you've stumped me|your guess is as good as mine|i'm stumped|i'm at a loss|i got nothing|i've got nothing)(?=$|[.,;:!?…])`) },
  { kind: 'bare', re: g(`(?:^|[.!?] )(?:no clue|no idea|not a clue)(?=$|[.,;:!?…])`) },
  { kind: 'bare', self: true, ask: true, re: g(`\\b(?:who|what) (?:is|are|'s) (?:${S})\\s*\\??$`) },
  { kind: 'bare', re: g(`\\b(?:drawing|draw|drew|coming up|come up|came up) (?:a |an )?(?:complete |total )?(?:blank|empty)\\b`) },
  { kind: 'bare', self: true, re: g(`\\b(?:doesn't|don't|does not|didn't|not|no) ${ADV}(?:ring a bell|ring any bells?|ringing (?:a|any) bells?)|\\brings? no bells?\\b`) },
  { kind: 'bare', re: g(`\\b(?:don't|do not|didn't|can't|cannot|couldn't) ${ADV}(?:recognize|recognise|place) (?:the|that|this) name\\b`) },
  { kind: 'bare', self: true, re: g(`\\b(?:the|that|this) name (?:means nothing|doesn't mean anything|isn't one i know|is new to me|doesn't register)`) },
  { kind: 'bare', re: g(`\\b(?:not|[a-z]+n't|never) ${ADV}(?:going to |gonna |about to )?(?:pretend|claim) (?:to(?: know| have| be able| be familiar)?|i know|i've|i have|otherwise)(?=$|[.,;:!?…]| know| have| be| heard| i | otherwise)(?! (?:it's|this is|that it|they're|he's|she's))`) },
  { kind: 'bare', re: g(`\\b(?:invent|bluff|fake|fabricate|make up|wing|improvise) (?:a |an |my |some |you a )?(?:take|verdict|opinion|read|story|answer|review|facts|history|biography|bio)\\b`) },
  { kind: 'bare', re: g(`\\b(?:i|we)(?:'d| would) (?:just |only )?be (?:inventing|guessing|making|bluffing|lying|winging|faking)\\b`) },
  { kind: 'bare', re: g(`\\bmaking (?:things|stuff|it|something|facts) up\\b`) },
  { kind: 'bare', re: g(`\\bwell enough to (?:call|judge|give|say|hand|rate|rank|speak|tell)\\b`) },
  { kind: 'bare', re: g(`\\b(?:give|tell|send|play|show|point|feed|hand|get|describe|hum|sing) (?:me|it|them|that|this)\\b(?! to the)(?:[^.!?]{0,60}?)(?:,? (?:and|so|then|and then)) (?:i'll|i can|we'll|i could|we can|i will|i'd)\\b`) },
  { kind: 'bare', re: g(`\\b(?:tell|give|show) me (?:what (?:it|they|this|that) sounds? like|what (?:it|they) (?:is|are) like|a sense of|more about|who (?:they|he|she|these guys) (?:are|is)|something about|a little about|about (?:them|it|him|her))\\b`) },
  { kind: 'bare', re: g(`\\bif you (?:can )?(?:give|tell|send|play|show|point|describe)(?: me| it)?\\b[^.!?]{0,60}\\b(?:i'll|i can|i could|i'd)\\b`) },
  { kind: 'bare', re: g(`\\b(?:fill me in|clue me in|enlighten me|help me out here|you'll have to tell me)\\b`) },
  { kind: 'bare', re: g(`\\b(?:don't|do not|haven't|have not) ${ADV}(?:got |have )?(?:a |an |any |enough |solid |reliable |good |real |firm |clear |strong |much |the )+(?:enough )?(?:read|handle|knowledge|recall|memory|information|info|grip|line|sense|picture|data|context|background|details|facts) (?:on|of|about|for|to)\\b`) },
  { kind: 'bare', self: true, re: g(`\\b(?:not|isn't|aren't) (?:one|a band|an artist|a name|a record|an album|a song|an act|a group|something|someone) i ${ADV}(?:know|recognize|recognise|'ve heard|have heard|'ve come across|can place)\\b`) },
  { kind: 'bare', re: g(`\\b(?:i|we) (?:honestly |really |truly |simply |just )?(?:have no idea|haven't a clue|have no clue|haven't the faintest|haven't the foggiest|couldn't tell you|couldn't say|can't help you (?:there|here|with that))(?=$|[.,;:!?…])`) },
  { kind: 'bare', self: true, ask: true, re: g(`\\b(?:who are (?:they|these guys|these people)|who is (?:this|that|he|she)|what is (?:this|that)|who\\?)\\s*\\??$`) },
]

/** Words that might be a not-knowing claim the rules above did not settle. */
const CUE = /\b(?:had the pleasure|crossed my|beats me|got me there|blanking|in the dark|no knowledge|lack(?:ing)? (?:any|the|all)|no history|a note of|only know|can't comment|cannot comment|stumped|at a loss|your guess|search me|(?:don't|do not) have a take|no take on|sit this one out|ask me another|is this a new|never (?:heard|listened|come across|encountered)|haven't (?:heard|listened)|not heard|heard of|familiar with|my radar|wish i (?:could|knew)|describe (?:it|them)|not (?:one|a band|a record|an album|a name) i|mystery to me|got (?:past|by) me|no (?:file|read|handle|info|information) on|nothing on|(?:don't|do not|didn't|did not) (?:really |actually |honestly )?know\b|(?:not|un)\s?familiar|new to me|no idea|no clue|ring(?:s|ing)? (?:a|any|no) bell|can't place|cannot place|can't say i|couldn't tell you|can't tell you|pretend|not sure (?:who|what)|don't recogni[sz]e|drawing a blank|off my radar|send me|tell me (?:what|more|about)|who are they)\b/

function straight(text: string): string {
  return (text || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The subject's names, longest first, as they would be written. */
function nameList(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names ?? []) {
    const n = straight(String(raw ?? '')).replace(/\s+/g, ' ').trim()
    if (n.length < 2 || seen.has(n.toLowerCase())) continue
    seen.add(n.toLowerCase())
    out.push(n)
    // "The Holy Cross Tigers" is also said without its article.
    const bare = n.replace(/^(?:the|a|an)\s+/i, '')
    if (bare.length >= 4 && bare !== n && !seen.has(bare.toLowerCase())) { seen.add(bare.toLowerCase()); out.push(bare) }
  }
  return out.sort((a, b) => b.length - a.length)
}

/** The sentence with the subject's names and every other name replaced by a token, lowercased. */
function tokenize(sentence: string, names: readonly string[], namesKnown: boolean): string {
  let t = sentence
  for (const n of names) {
    t = t.replace(new RegExp(`(^|[^\\p{L}\\p{N}])["']?${escapeRe(n)}["']?(?![\\p{L}\\p{N}])`, 'giu'), `$1${S}`)
  }
  // With no names to go by, any quoted title or proper name is taken to be the subject.
  const other = namesKnown ? N : S
  t = t.replace(/"[^"]{2,80}"/g, other)
  // A run of capitalised words that does not start the sentence is somebody's name.
  t = t.replace(/(?<=[\p{L}\p{N},;:'")] )(?!I\b|I'[a-z]+\b)(?:[\p{Lu}][\p{L}\p{N}'&./-]*|\d+[\p{L}]*)(?: (?:(?:of|the|and|&|de|la|von|van|for|in|a|to) )?[\p{Lu}\d][\p{L}\p{N}'&./-]*)*/gu, (m) => (/^(?:I|I'm|I've|I'd|I'll|Jake|Larry|Marty|Funkhouser|Funk Man|Music Man|God|OK|Okay|Yes|No|Not|Never|Honestly|Sorry|But|And|So|Then|Now|Well|Look|Listen|Fine|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(m) ? m : other))
  return t.toLowerCase().replace(new RegExp(`(${escapeRe(S)}|${escapeRe(N)})(?:'s)?(?:[ ,]+(?:or|and|nor|&) (?:${escapeRe(S)}|${escapeRe(N)})(?:'s)?)+`, 'g'), (m) => (m.includes(S) ? S : N))
}

/** Who is doing the not-knowing: true = the speaker, false = somebody else, null = can't tell. */
function speaker(before: string): boolean | null {
  // The clause the verb sits in: back to the last comma, dash or joining word.
  const clause = before.split(/[,;:—()]| - | and | but | so | because | although | though | while | which | that /).pop() ?? ''
  const c = clause.trim()
  if (c === '' || FILLER.test(c)) return true
  const me = ME.exec(c)
  const notMe = NOT_ME.exec(c)
  if (me && notMe) return me.index > notMe.index
  if (me) return true
  if (notMe) return false
  // "If", "when", "unless": a condition, not a confession.
  if (/\b(?:if|when|unless|until|once|whether|imagine|suppose)\b/.test(c)) return false
  return c.split(/\s+/).length <= 2 ? true : null
}

/** One sentence. */
function judgeSentence(raw: string, names: readonly string[], namesKnown: boolean): ReplyVerdict | 'ask' {
  const t = tokenize(raw, names, namesKnown).replace(/\s+/g, ' ').trim()
  if (!t) return 'answer'
  let unsure = false
  let other = false
  let ask = false
  /** A claim's words were here and were plainly not a confession: the sentence needs no second look. */
  let dismissed = false
  for (const claim of CLAIMS) {
    claim.re.lastIndex = 0
    for (let m = claim.re.exec(t); m; m = claim.re.exec(t)) {
      const before = t.slice(0, m.index)
      const after = t.slice(m.index + m[0].length).trim()
      // A rhetorical question is not a confession ("Never heard of them? You will.").
      if (/^\?/.test(after) && !/who|what/.test(m[0])) { unsure = true; continue }
      // "I'd never heard of them before tonight": he has now.
      if (/\b(?:i'd|i had|we'd|we had|hadn't)\b[^,;:]*$/.test(before + m[0].replace(/\S+$/, '')) && /^(?:before|until|till)\b./.test(after)) { dismissed = true; continue }
      const who = claim.self ? true : speaker(before)
      if (who === false) { dismissed = true; continue }
      if (claim.ask) { ask = true; continue }
      if (claim.kind === 'ref') {
        const obj = m[1] ?? ''
        // The thought must stop at its object. "…know them to miss", "…new to me every time" go on: not a confession.
        if (claim.ends && CLAUSE_NEXT.test(after)) { dismissed = true; continue }
        if (!END_NEXT.test(after)) { if (/^(?:that|who|which|except|every|each|when|whenever|until|till)\b/.test(after)) dismissed = true; else unsure = true; continue }
        if (obj === N) { if (who) other = true; else unsure = true; continue }
      }
      if (who === null) { unsure = true; continue }
      return 'non-answer'
    }
  }
  if (other) return 'other'
  if (unsure) return 'unsure'
  if (ask) return 'ask'
  if (dismissed || !CUE.test(t)) return 'answer'
  // The words are there and no claim above settled it. It is a doubt only when what follows stands
  // for the subject, or the thought stops there ("…, I don't know."). "A band", "the influence",
  // "restraint", "why people skip it", "about you": opinions that happen to use the same words.
  const cue = CUE.exec(t)
  const before = t.slice(0, cue?.index ?? 0)
  const after = t.slice((cue?.index ?? 0) + (cue?.[0].length ?? 0)).trim().replace(/^(?:of|about|on|with) /, '')
  if (speaker(before) === false) return 'answer'
  if (/^(?:send|tell) me\b/.test(cue?.[0] ?? '') || /^pretend/.test(cue?.[0] ?? '')) {
    return new RegExp(`^(?:${REF}\\b|what (?:it|they)|more|about (?:it|them)|to know|to have|i know|i've)`).test(after) || after === '' ? 'unsure' : 'answer'
  }
  if (new RegExp(`^(?:${REF}|${S})(?:$|[ .,;:!?])`).test(after)) {
    const rest = after.replace(new RegExp(`^(?:${REF}|${S})[ ]?`), '')
    return CLAUSE_NEXT.test(rest) || /^(?:that|who|which|except|every|each|when)\b/.test(rest) ? 'answer' : 'unsure'
  }
  if (after === '' || /^[.,;:!?…]/.test(after)) return /^[,] (?:[a-z]+, )?(?:i think|i'd say|but|maybe|it's|they're|the )/.test(after) ? 'answer' : 'unsure'
  return 'answer'
}

/**
 * What a reply says about knowing the subject. `names` are the subject's own
 * names (artist, record, song). With none, any name counts as the subject.
 */
export function judgeReply(text: string, names?: readonly string[]): ReplyVerdict {
  const t = straight(text)
  if (!t.trim()) return 'answer'
  const list = nameList(names)
  const sentences = t.split(/(?<=[.!?…])["')\]]*\s+|\n+/).map((s) => s.trim()).filter(Boolean)
  let unsure = false
  let other = false
  for (const [i, s] of sentences.entries()) {
    const v = judgeSentence(s, list, list.length > 0)
    // "Who are they?" is a non-answer only when the reply ends on it; before his own answer it is a flourish.
    if (v === 'ask') { if (i === sentences.length - 1) return 'non-answer'; continue }
    if (v === 'non-answer') return 'non-answer'
    if (v === 'unsure') unsure = true
    if (v === 'other') other = true
  }
  return unsure ? 'unsure' : other ? 'other' : 'answer'
}

/** The plain rule: the reply says the speaker doesn't know the subject. */
export function isNonAnswer(text: string, names?: readonly string[]): boolean {
  return judgeReply(text, names) === 'non-answer'
}

/**
 * Is Jake's question about something other than the page he has open? Then
 * the page's facts are not the answer, and "I don't know that one" may be.
 * A quoted title or a proper name that is not the subject's counts; so does a
 * lowercase name after "know / heard of / think of / about" that is not a
 * word for the page ("do you know glorp division?").
 */
export function asksAboutOther(question: string, names?: readonly string[]): boolean {
  const q = straight(question)
  if (!q.trim()) return false
  const t = tokenize(q, nameList(names), true)
  if (t.includes(S)) return false
  if (t.includes(N)) return true
  const m = /\b(?:know|heard of|think of|make of|into|thoughts on|opinion (?:of|on)|take on|familiar with|tell me about|what about|how about|compared? to|better than|worse than|like)\s+([a-z0-9][a-z0-9 &'./-]{2,40}?)\s*(?:[?.!,]|$)/.exec(t)
  if (!m) return false
  return !/^(?:the|a|an|my|your|its|their|his|her|this|that|these|those|it|them|him|what|how|why|where|when|which|who|me|you|us|here|there|all|any|some|more|less|one|ones|side|track|song|songs|album|record|back|front|first|last|second|third|next|other|others|rest|best|worst|start|end|opener|closer|single|singles|lyrics|drums|guitar|guitars|bass|vocals|production|sound|cover|art|artwork|label|larry|marty|him too|about)\b/.test(m[1] ?? '')
}
