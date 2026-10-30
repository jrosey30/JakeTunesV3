// common/weak-blurb.ts: an answer that says it has nothing is shown as nothing and never kept.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWeakBlurb } from '../../common/weak-blurb.ts'

test('isWeakBlurb: the Music Man\'s "nothing" phrases, nothing else', () => {
  assert.equal(isWeakBlurb("I'm drawing a blank on this one."), true)
  assert.equal(isWeakBlurb("Honestly it didn't stick with me."), true)
  assert.equal(isWeakBlurb('Perfecth is the ninth studio album by Queens of the Stone Age.'), false)
  assert.equal(isWeakBlurb(''), false)
})
