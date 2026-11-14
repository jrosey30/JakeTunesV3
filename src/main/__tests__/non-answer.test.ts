/**
 * "music man cant suck at knowing the twisted teens" (Jake, 2026-11-13).
 *
 * A labelled set: replies that say the speaker doesn't know the subject, in
 * varied wording, and opinions that use the same words innocently ("never",
 * "didn't know", "heard", "send me"). The first detector matched phrases and a
 * review showed it wrong both ways (it flagged 21 of 32 opinions and missed 17
 * of 22 plain non-answers). The bar here is 95% on each side, by the rule
 * alone, with nothing called a non-answer that is an opinion.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { asksAboutOther, isNonAnswer, judgeReply } from '../../common/non-answer.ts'

const NAMES = ['Twisted Teens', 'The Holy Cross Tigers']

const NON_ANSWERS = [
  // The ones found in the two caches on 2026-11-13.
  'I don\'t know Twisted Teens or "The Holy Cross Tigers," and I\'d rather say that than invent a take on a record I can\'t place in their run. If you give me a sense of the sound, I\'ll tell you honestly whether it fits.',
  'I haven\'t got a reliable read on "The Holy Cross Tigers" as a 2026 record, so I won\'t pretend to have dissected its tracks.',
  'I don\'t have anything reliable on a 2026 Twisted Teens album called "The Holy Cross Tigers," so I won\'t pretend to know its sound or where it sits in their run.',
  'I don\'t have a reliable read on "The Holy Cross Tigers" by Twisted Teens from 2026, and I won\'t bluff a take on a record I can\'t place in their catalog.',
  'I don\'t have a reliable read on Twisted Teens or a 2026 album called "The Holy Cross Tigers," so I\'d be inventing a take on sound and career position I can\'t back up. Send me a track or two from it.',
  'I don\'t have a solid handle on "The Holy Cross Tigers" by Twisted Teens, so I won\'t pretend to know where it sits in their run or what the record actually sounds like.',
  'I don\'t know "The Holy Cross Tigers" well enough to call it, and I\'d rather admit that than invent a verdict.',
  'I don\'t have a solid handle on this record, so I\'m not going to pretend I\'ve absorbed it well enough to hand you a verdict.',
  'I don\'t have a solid enough handle on this specific 2026 record to give you a real take without guessing, and the Music Man doesn\'t bluff.',
  'I don\'t have solid enough knowledge of Twisted Teens\'s 2026 album "The Holy Cross Tigers" to give a real take without making things up.',
  'I don\'t have solid enough recall of "The Holy Cross Tigers" to give you a real take on its sound.',
  // The reviewer's.
  'Never heard of them.',
  "They're new to me.",
  "I don't recognize the name.",
  // Plain, in varied wording.
  "I've never heard of Twisted Teens.",
  'Honestly, never heard of them.',
  'Twisted Teens? Never heard of them, Jake.',
  "I don't know them.",
  "I don't know this record.",
  "Don't know it. Sorry.",
  "I'm not familiar with Twisted Teens.",
  "I'm unfamiliar with this one.",
  'Not familiar with them at all.',
  "The name doesn't ring a bell.",
  "Twisted Teens doesn't ring a bell.",
  'That name means nothing to me.',
  'This one is new to me.',
  'Twisted Teens are a new one on me.',
  "I've got nothing on them.",
  "I haven't heard it.",
  "I haven't listened to this record yet.",
  "I've never heard this album.",
  "I can't place them.",
  "I'm drawing a blank on Twisted Teens.",
  'I have no idea who they are.',
  "I couldn't tell you who Twisted Teens are.",
  "They're not a band I know.",
  "This isn't one I know.",
  'That record slipped past me.',
  "They're not on my radar.",
  "I can't speak to this record.",
  "I can't tell you much about them, honestly.",
  'I know nothing about Twisted Teens.',
  "I don't know much about them, to be honest.",
  "I don't know who they are.",
  "I haven't come across them.",
  "Tell me what it sounds like and I'll place it.",
  "Send me a track and I'll give you a real answer.",
  "If you tell me a little about them, I can tell you whether it's for you.",
  'Who are they?',
  'I don’t know this record, honestly.',
  'I’m not familiar with them.',
  "Look, I'd be guessing.",
  "I have no read on this one.",
  "I won't pretend to know them.",
]

const OPINIONS = [
  // The reviewer's.
  "I've never heard a band commit this hard.",
  "I didn't know The Clash could sound this mean.",
  'Send me a song that hits harder.',
  // Opinions that use the same words.
  "I don't love this record. The singles were the bait and the back half never shows up.",
  "I don't know why people skip this one. Big mistake.",
  "I won't pretend it's their best. It's their third best, and that's still better than most bands' first.",
  "You've never heard of them, which is the whole point. New Orleans, two people, a lot of noise.",
  "I can't place a single bad song on it.",
  "I don't know what else you want from a garage record: it's fast, it's loud, it's over in thirty-three minutes.",
  'Fine record. Fine. Not the best thing they did and you know it.',
  "That's a fucking great record. I don't know why that's a problem for people.",
  'Give me the B-side any day. The A-side is for people who read the sticker.',
  "I don't know that it's better than the debut, but it's braver.",
  'Listen, I know this band. Duo out of New Orleans, on Sub Pop, and you starred every song on it.',
  "Nobody knows this record and I can't forgive that.",
  "I'd never heard of them before you put this on, and now I can't stop.",
  "I never heard a steel guitar used like that on a punk record.",
  "I haven't heard anything this raw since the first Gun Club record.",
  "I didn't know I needed a breakup record with steel guitar. I did.",
  "I didn't know they had a slow one in them. \"Blue Rose\" proves it.",
  "Most people have never heard of Twisted Teens. That's their loss.",
  "If you don't know this record yet, start with \"Stalks.\"",
  'Never heard a duo make this much noise.',
  "I don't know how two people make that much racket.",
  "I don't know anyone else doing this right now.",
  "You don't know them yet. You will.",
  "Tell me that riff isn't pure Sub Pop.",
  "Tell me I'm wrong about the closer.",
  'Play me a better opener from this year. You can\'t.',
  "I can't say enough about the steel guitar.",
  "I'm not sure the second half holds up, but the first six are murder.",
  "New to me is the steel guitar. The rest is garage punk done right.",
  "They don't know when to stop, and I mean that as praise.",
  "No idea why this isn't on every year-end list.",
  "I've never been this happy to be wrong about a band.",
  "Critics never heard of them until Sub Pop called.",
  "I don't know a better two minutes this year than \"When We First Met.\"",
  'It rings every bell I have: Gun Club, Cramps, a little Gram Parsons.',
  "I won't pretend the back half is as strong.",
  "Who are they? A duo out of New Orleans, on Sub Pop since this year.",
  "Third record this year, and a breakup record at that. Steel guitar dragged through garage punk should be a gimmick and somehow isn't.",
  '',
]

/** About some other band: honest, and allowed. */
const OTHER = [
  "I've never heard of Glorp Division.",
  'I don\'t know "Moon Shed" at all.',
  "Honestly, I'm not familiar with Glorp Division.",
]

/**
 * Two more batches, written after the rules and before looking at how they did. The first
 * taught the rules its misses; the second is kept as it scored, hard idioms and all: where the
 * rule can't tell it must say 'unsure' (one yes/no to the small model), never 'answer'.
 */
const BATCHES: Array<{ names: string[]; non: string[]; ok: string[] }> = [
  { names: ['Westside Cowboy', 'It Goes On'], non: [
 "Westside Cowboy? Don't know 'em.",
 "Can't say I know them.",
 "I've not heard of this band.",
 "This band is unknown to me.",
 "I have never come across Westside Cowboy.",
 "Sorry, Jake, I'm coming up empty on this one.",
 "No idea who these guys are.",
 "I haven't heard this one, so I can't judge it.",
 "I don't have enough on Westside Cowboy to say anything real.",
 "That's not a record I know.",
 "It Goes On isn't an album I'm familiar with.",
 "I'm not sure who Westside Cowboy are.",
 "I can't give you an honest take on it. I haven't heard it.",
 "They've slipped under my radar.",
 "I wish I could tell you something about them, but I can't.",
 "I'd be making it up if I told you anything about this record.",
 "Never listened to it.",
 "Haven't heard of them, to be honest.",
 "I don't recognize this album.",
 "I know very little about Westside Cowboy.",
 "The band's name doesn't ring any bells.",
 "I don't have any information about this album.",
 "Describe it to me and I'll tell you what I think.",
 "What does it sound like? I haven't heard it.",
 "It's not one I've heard.",
 "I can't claim to know this record.",
 "Westside Cowboy is a mystery to me.",
 "I've got no file on them.",
 "This one got past me.",
 "I'm not the guy to ask about Westside Cowboy; I don't know them.",
  ], ok: [
 "I never get tired of this record.",
 "I didn't know a band could still sound this hungry.",
 "Never heard a rhythm section lock in like this.",
 "I don't know who told them to slow down on side two, but they were right.",
 "You haven't heard this record until you've heard it loud.",
 "Nobody had heard of Westside Cowboy a year ago. Now look.",
 "I haven't heard a debut this sure of itself in years.",
 "I can't place the influence exactly, somewhere between Pavement and the Band.",
 "I don't know about you, but the title track wrecks me.",
 "I'm not familiar with restraint, and neither are they.",
 "No idea how they got that guitar tone, and I don't want to know.",
 "Tell me the last time a British band did country this well.",
 "Send me to the back of the line if I'm wrong, but track three is the one.",
 "Who knew Manchester had this in it?",
 "I had never heard of them until the EP, and the EP was enough.",
 "It's new to me every time I play it.",
 "I don't recognize the band that made the EP in this record, and that's growth.",
 "They don't know how good they are yet.",
 "If you've never heard them live, fix that.",
 "I don't know, Jake, I think the single is the weakest thing here.",
 "It Goes On does exactly what the title says, and I never want it to stop.",
 "I've heard it forty times and I still don't know how the bridge works.",
 "I can't tell you how much I love the drums on this.",
 "You'd be guessing if you tried to date this record. It sounds like 1974 and next year.",
 "Never mind the hype. It's good.",
 "I've got nothing on this record except praise.",
 "The first time I heard them I didn't know what to do with my hands.",
 "Don't pretend you weren't waiting for this one.",
 "Not a band I'd bet against.",
 "I couldn't tell you which song is best. That's the compliment.",
  ] },
  { names: ['Star Moles', 'Highway to Hell', 'Born Again'], non: [
 "Star Moles is not a name I know.",
 "I'll be honest, I don't know Star Moles.",
 "Never heard a note of it.",
 "I haven't had the pleasure.",
 "This album hasn't crossed my desk.",
 "Not ringing any bells, I'm afraid.",
 "I can't say I've heard of Star Moles.",
 "I don't have any history with this band.",
 "I've no knowledge of this record.",
 "You've got me there. Who is Star Moles?",
 "I'm blanking on Star Moles.",
 "Star Moles? Beats me.",
 "My memory has nothing on \"Highway to Hell\" by Star Moles.",
 "I don't know enough about Star Moles to say.",
 "I'm not going to pretend I know this one.",
 "Couldn't tell you a thing about them.",
 "I lack any real information on this album.",
 "That one's outside my wheelhouse.",
 "I'm in the dark on this one.",
 "Honestly? I've never even heard the name.",
 "I can't comment on a record I haven't heard.",
 "No clue, Jake.",
 "I only know the AC/DC record by that name, not this one.",
 "Is this a new band? I don't know them.",
 "I don't have a take, because I don't know the record.",
  ], ok: [
 "I never thought a piano record called Highway to Hell would work. It does.",
 "Didn't know Emily Moales had this in her.",
 "Heard it once and I was done for.",
 "You could send me a hundred bedroom records and I'd pick this one.",
 "Never has a ninth album sounded so much like a first.",
 "I don't know another songwriter this prolific who's this good.",
 "I have no idea how she writes this fast.",
 "Nobody's heard of her, and everybody should.",
 "I can't pretend the medieval records were easy. This one is.",
 "Don't tell me you skipped \"Born Again.\"",
 "It isn't the AC/DC record, and thank God.",
 "I didn't recognize her voice at first without the reverb.",
 "The first time through I didn't know where it was going. Second time I didn't care.",
 "I haven't heard her this relaxed before.",
 "I'm not sure anyone else could get away with that title.",
 "You don't know Star Moles until you've heard the piano ones.",
 "I've never been a piano-record guy, and here we are.",
 "Blank is the last word I'd use for it. Every song has a face.",
 "Give me \"Control Freak\" over the single every time.",
 "Tell me the last ninth album you wanted to hear twice.",
 "Not familiar territory for her, and that's why it works.",
 "I know this record cold. It's the piano that gets me.",
 "She doesn't know how to write a dull song.",
 "I've got no complaints about this record.",
 "New ground for Star Moles, and she owns it.",
  ] },
]

describe('judgeReply on the labelled set', () => {
  test(`non-answers: at least 95% of ${NON_ANSWERS.length} caught by the rule`, () => {
    const missed = NON_ANSWERS.filter((t) => judgeReply(t, NAMES) !== 'non-answer')
    assert.ok(NON_ANSWERS.length >= 30)
    assert.ok(missed.length / NON_ANSWERS.length <= 0.05, `missed ${missed.length}:\n${missed.map((m) => `  [${judgeReply(m, NAMES)}] ${m}`).join('\n')}`)
  })
  test(`opinions: at least 95% of ${OPINIONS.length} read as answers by the rule, and none called a non-answer`, () => {
    const wrong = OPINIONS.filter((t) => judgeReply(t, NAMES) !== 'answer')
    assert.ok(OPINIONS.length >= 30)
    assert.ok(wrong.length / OPINIONS.length <= 0.05, `not read as answers ${wrong.length}:\n${wrong.map((m) => `  [${judgeReply(m, NAMES)}] ${m}`).join('\n')}`)
    assert.deepEqual(OPINIONS.filter((t) => isNonAnswer(t, NAMES)), [])
  })
  test("not knowing some OTHER band is 'other', never a failure", () => {
    for (const t of OTHER) assert.equal(judgeReply(t, NAMES), 'other', t)
    for (const t of OTHER) assert.equal(isNonAnswer(t, NAMES), false, t)
  })
  test('the three sentences the review named, each way', () => {
    assert.equal(judgeReply("I've never heard a band commit this hard.", NAMES), 'answer')
    assert.equal(judgeReply("I didn't know The Clash could sound this mean.", ['The Clash', 'London Calling']), 'answer')
    assert.equal(judgeReply('Send me a song that hits harder.', NAMES), 'answer')
    assert.equal(judgeReply('Never heard of them.', NAMES), 'non-answer')
    assert.equal(judgeReply("They're new to me.", NAMES), 'non-answer')
    assert.equal(judgeReply("I don't recognize the name.", NAMES), 'non-answer')
  })
  test('with no names to go by (an old saved take), any named thing is taken to be the subject', () => {
    assert.equal(isNonAnswer('I don\'t know Twisted Teens or "The Holy Cross Tigers," and I\'d rather say that than invent a take.'), true)
    assert.equal(isNonAnswer("I've never heard a band commit this hard."), false)
  })
})

describe('judgeReply on the two later batches', () => {
  const non = BATCHES.flatMap((b) => b.non.map((t) => ({ t, v: judgeReply(t, b.names) })))
  const ok = BATCHES.flatMap((b) => b.ok.map((t) => ({ t, v: judgeReply(t, b.names) })))
  const show = (rows: Array<{ t: string; v: string }>): string => rows.map((r) => `  [${r.v}] ${r.t}`).join('\n')
  test(`no opinion is called a non-answer (${ok.length} opinions)`, () => {
    assert.equal(show(ok.filter((r) => r.v === 'non-answer')), '')
  })
  test('at least 90% of the opinions are settled by the rule alone; the rest go to the judge', () => {
    const not = ok.filter((r) => r.v !== 'answer')
    assert.ok(not.length / ok.length <= 0.10, `${not.length} of ${ok.length}:\n${show(not)}`)
    assert.ok(not.every((r) => r.v === 'unsure'))
  })
  test(`at least 90% of the non-answers are caught by the rule alone (${non.length})`, () => {
    const not = non.filter((r) => r.v !== 'non-answer')
    assert.ok(not.length / non.length <= 0.10, `${not.length} of ${non.length}:\n${show(not)}`)
  })
  test('at most 5% of the non-answers get past both the rule and the judge (read as plain answers)', () => {
    const past = non.filter((r) => r.v === 'answer' || r.v === 'other')
    assert.ok(past.length / non.length <= 0.05, `${past.length} of ${non.length}:\n${show(past)}`)
  })
})

describe('is the question about something other than the page?', () => {
  const yes = ['do you know Glorp Division?', 'what do you think of "Moon Shed"?', 'have you heard of glorp division?', 'how about Television?', 'is it better than Marquee Moon?']
  const no = ['is this any good?', 'who are they?', 'what do you think of it?', 'where do I start?', 'what about the back half?', 'what does Larry think?', 'do you know them?',
    'tell me about Twisted Teens', 'is The Holy Cross Tigers their best?', 'what do you think of the closer?', 'ok which one next?', '']
  for (const q of yes) test(`yes: ${q}`, () => assert.equal(asksAboutOther(q, NAMES), true))
  for (const q of no) test(`no: ${q || '(empty)'}`, () => assert.equal(asksAboutOther(q, NAMES), false))
})
