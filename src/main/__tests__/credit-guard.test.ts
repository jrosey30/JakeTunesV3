/**
 * Music Man credit guard (src/main/ai/credit-guard.ts): the two 10/13 eval
 * mistakes get fixed; any credit that could be deliberate is left alone.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { guardCredits } from '../ai/credit-guard.ts'

const shown = [
  { title: 'No More Hangovers', artist: 'Mean Street', album: 'No More Hangovers - EP' },
  { title: 'Celebrity', artist: 'My First Time', album: 'My First Time' },
  { title: 'Hurt', artist: 'Nine Inch Nails', album: 'The Downward Spiral' },
  { title: 'Bad Company', artist: 'Bad Company', album: 'Bad Company' },
]

describe('fixes the garbles the eval caught', () => {
  it('a song credited to its own title becomes the real artist', () => {
    const r = guardCredits('Try "No More Hangovers" by No More Hangovers, it rips.', shown)
    assert.equal(r.text, 'Try "No More Hangovers" by Mean Street, it rips.')
    assert.equal(r.fixes[0].why, 'title-as-artist')
  })
  it('a song credited to its album (release suffix and all) becomes the real artist', () => {
    const r = guardCredits('"No More Hangovers" — No More Hangovers - EP is short and loud', shown)
    assert.match(r.text, /^"No More Hangovers" — Mean Street/)
  })
  it('a band and song swapped get put the right way round', () => {
    const r = guardCredits('Spin “My First Time” by Celebrity next.', shown)
    assert.equal(r.text, 'Spin “Celebrity” by My First Time next.')
    assert.equal(r.fixes[0].why, 'swapped')
  })
})

describe('never "corrects" a credit that could be on purpose', () => {
  it('the right credit is untouched, even mid-sentence', () => {
    const t = '"Celebrity" by My First Time is the one. "No More Hangovers" by Mean Street too.'
    assert.deepEqual(guardCredits(t, shown), { text: t, fixes: [] })
  })
  it('a cover by another artist stays (Johnny Cash\'s "Hurt" is real)', () => {
    const t = 'You own NIN, but hear "Hurt" by Johnny Cash.'
    assert.equal(guardCredits(t, shown).text, t)
  })
  it('a self-titled song by its own band stays', () => {
    const t = '"Bad Company" by Bad Company is the blueprint.'
    assert.equal(guardCredits(t, shown).text, t)
  })
  it('songs outside the list and unquoted prose are left alone', () => {
    const t = '"Some Other Song" by Some Other Song. Celebrity by Celebrity.'
    assert.equal(guardCredits(t, shown).text, t)
  })
})
