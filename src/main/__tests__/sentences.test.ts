// Sentence boundaries (common/sentences.ts): the album page's history and the
// Music Man's take never show or store a cut-off sentence (Jake 2026-10-30).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sentenceEnds, sentencePreview, wholeSentences } from '../../common/sentences.ts'

const CUT_OFF = 'Perfecth is the ninth studio album by Queens of the Stone Age, released in 2026 on Matador. '
  + 'It follows In Times New Roman… (2023), and the music press framed it as a clear stylistic shift. '
  + 'Coverage describes the record as recorded piecemeal in studios around the world. '
  + 'Tracks singled out include "It\'s Only Love," "Insignificant Other," "Where'

test('wholeSentences: a reply that ran out of tokens keeps only its finished sentences', () => {
  assert.equal(
    wholeSentences(CUT_OFF),
    'Perfecth is the ninth studio album by Queens of the Stone Age, released in 2026 on Matador. '
      + 'It follows In Times New Roman… (2023), and the music press framed it as a clear stylistic shift. '
      + 'Coverage describes the record as recorded piecemeal in studios around the world.',
  )
  assert.equal(wholeSentences('Not even one finished'), '')
  assert.equal(wholeSentences('Done.'), 'Done.')
  assert.equal(wholeSentences('He asked "why?" Then he left'), 'He asked "why?"')
  assert.equal(wholeSentences('  Trailing space. '), 'Trailing space.')
})

test('sentenceEnds: an ellipsis or a period mid-sentence is not an end; abbreviations are stepped over', () => {
  assert.deepEqual(sentenceEnds('Mr. Smith left. He did.'), [15, 23])
  assert.deepEqual(sentenceEnds('It follows In Times New Roman… (2023), and more. Next.'), [48, 54])
  assert.deepEqual(sentenceEnds('With J. Dilla on the beat. Then (feat. Common) too.'), [26, 51])
  assert.deepEqual(sentenceEnds('Wait... what? Nothing.'), [13, 22])
})

test('sentencePreview: the opening whole sentences that fit, never a cut one', () => {
  const text = 'One is here. Two follows it. Three ends it all.'
  assert.equal(sentencePreview(text, 20), 'One is here.')
  assert.equal(sentencePreview(text, 30), 'One is here. Two follows it.')
  assert.equal(sentencePreview(text, 100), text)
  // The first sentence alone is longer than the budget: still the whole first sentence.
  assert.equal(sentencePreview('A very long opening sentence that runs past the budget. Short.', 10), 'A very long opening sentence that runs past the budget.')
  // No sentence ends at all: the whole text (nothing to cut on).
  assert.equal(sentencePreview('no punctuation here at all but long enough to pass the budget', 10), 'no punctuation here at all but long enough to pass the budget')
})
