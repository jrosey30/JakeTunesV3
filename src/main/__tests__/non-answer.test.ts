/**
 * "music man cant suck at knowing the twisted teens" (Jake, 2026-11-13).
 * The replies below are the real ones found in album-notes.json on the MacBook
 * and album-page-notes.json on homemini that day, plus the opinions the
 * detector must leave alone.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isNonAnswer } from '../../common/non-answer.ts'
import { isWeakBlurb } from '../../common/weak-blurb.ts'

const NON_ANSWERS = [
  // The one Jake saw.
  'I don\'t know Twisted Teens or "The Holy Cross Tigers," and I\'d rather say that than invent a take on a record I can\'t place in their run. If you give me a sense of the sound, I\'ll tell you honestly whether it fits.',
  'I haven\'t got a reliable read on "Perfecth" as a 2026 record, so I won\'t pretend to have dissected its tracks. What I can say is that Queens have spent their whole career refusing to repeat themselves.',
  'I don\'t have anything reliable on a 2026 Tinashe album called "Popstar," so I won\'t pretend to know its sound or where it sits in her run.',
  'I don\'t have a reliable read on "Cannonball" by Man/Woman/Chainsaw from 2026, and I won\'t bluff a take on a record I can\'t place in their catalog.',
  'I don\'t have a reliable read on "N.Y. Baby" from Blu DeTiger, so I won\'t pretend to. Blu DeTiger\'s earlier work leaned into bright, sample-happy house.',
  'I don\'t have a reliable read on Star Moles or a 2026 album called "Highway to Hell," so I\'d be inventing a take on sound and career position I can\'t back up. Send me a track or two from it.',
  'I don\'t have a solid handle on "How To Perform Magic" by Sofy, so I won\'t pretend to know where it sits in their run or what the record actually sounds like.',
  'I don\'t know "Autosmile" well enough to call it, and I\'d rather admit that than invent a verdict. Give me the artist\'s previous record and I\'ll tell you if this one is a step forward.',
  'I don\'t have a solid handle on "It Goes On" by Westside Cowboy, so I\'m not going to pretend I\'ve absorbed the record well enough to hand you a verdict.',
  'I don\'t have a solid enough handle on this specific 2025 record to give you a real take without guessing, and the Music Man doesn\'t bluff.',
  'I don\'t have solid enough knowledge of Man/Woman/Chainsaw\'s 2026 album "Cannonball" to give a real take without making things up, and I won\'t fake a verdict on it.',
  'I don\'t have solid enough recall of "Holo Boy" to give you a real take on its sound or where it sits in This is Lorelei\'s catalog.',
  // Curly quotes, as a model writes them.
  'I don’t know this record, honestly.',
  'I’m not familiar with them.',
  "I've never heard of this band.",
  "I'm drawing a blank on this specific cut.",
  "Tell me what it sounds like and I'll place it.",
]

const OPINIONS = [
  "I don't love this record. The singles were the bait and the back half never shows up.",
  "I don't know why people skip this one. Big mistake.",
  "I won't pretend it's their best. It's their third best, and that's still better than most bands' first.",
  "You've never heard of them, which is the whole point. New Orleans, two people, a lot of noise.",
  "I can't place a single bad song on it.",
  "I don't know what else you want from a garage record: it's fast, it's loud, it's over in thirty-eight minutes.",
  'Fine record. Fine. Not the best thing they did and you know it.',
  "That's a fucking great record. I don't know why that's a problem for people.",
  "Give me the B-side any day. The A-side is for people who read the sticker.",
  "I don't know that it's better than the debut, but it's braver.",
  "Listen — I know this band. Duo out of New Orleans, on Sub Pop, and you starred every song on it.",
  "Nobody knows this record and I can't forgive that.",
  '',
]

describe('isNonAnswer', () => {
  for (const text of NON_ANSWERS) {
    test(`a reply that says he doesn't know it: ${text.slice(0, 60)}`, () => {
      assert.equal(isNonAnswer(text), true)
    })
  }
  for (const text of OPINIONS) {
    test(`an opinion is left alone: ${text.slice(0, 60) || '(empty)'}`, () => {
      assert.equal(isNonAnswer(text), false)
    })
  }
  test('the old filter missed the one Jake saw; it is still caught by the new one', () => {
    assert.equal(isWeakBlurb(NON_ANSWERS[0]!), false)
    assert.equal(isNonAnswer(NON_ANSWERS[0]!), true)
  })
  test("everything the old filter caught is still caught", () => {
    for (const phrase of ["I'm drawing a blank here.", "That one didn't stick.", "I'm pulling a name out of the air.", "Can't land a take worth hearing."]) {
      assert.equal(isWeakBlurb(phrase), true)
      assert.equal(isNonAnswer(phrase), true)
    }
  })
})
