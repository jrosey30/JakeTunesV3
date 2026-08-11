/**
 * The censored edition must never quietly win a search row.
 *
 * Jake, 2026-08-10, searching Migos and seeing only CLEAN copies of Culture
 * and Culture II: "this is a disaster."
 *
 * Apple lists the censored and uncensored editions of a record under the same
 * artist and title, so both collapse onto one key in the Download page. The
 * first one seen used to keep the row — and with it the collectionId — so when
 * the clean edition happened to arrive first, expanding the album fetched the
 * CLEAN tracklist and every download taken from it was censored. The badge was
 * honest; the row was bound to the wrong record.
 *
 * The distinction that matters and is easy to get wrong: 'notExplicit' is not
 * 'cleaned'. A record with nothing to censor is not a censored record, and it
 * must never lose its row to anything.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { explicitWins } from '../../common/explicit.ts'

describe('explicit edition wins the row', () => {
  test('explicit takes over a cleaned row', () => {
    assert.equal(explicitWins('cleaned', 'explicit'), true)
  })

  test('cleaned never takes over an explicit row', () => {
    assert.equal(explicitWins('explicit', 'cleaned'), false)
  })

  test('notExplicit is not cleaned and never loses its row', () => {
    // A record with nothing to censor. Treating it as "clean" would let a
    // mislabelled duplicate steal the row from the real release.
    assert.equal(explicitWins('notExplicit', 'explicit'), false)
    assert.equal(explicitWins('notExplicit', 'cleaned'), false)
  })

  test('a second explicit result does not churn the row', () => {
    assert.equal(explicitWins('explicit', 'explicit'), false)
  })

  test('unknown values are inert in both directions', () => {
    assert.equal(explicitWins(undefined, 'explicit'), false)
    assert.equal(explicitWins('cleaned', undefined), false)
    assert.equal(explicitWins(undefined, undefined), false)
  })

  test('the Migos case end to end', () => {
    // Both editions of Culture II, as Apple returns them, in the order that
    // produced the bug: clean first.
    const editions = [
      { collectionId: 111, explicitness: 'cleaned' },
      { collectionId: 222, explicitness: 'explicit' },
    ]
    let row = { ...editions[0] }
    for (const e of editions.slice(1)) {
      if (explicitWins(row.explicitness, e.explicitness)) row = { ...e }
    }
    assert.equal(row.explicitness, 'explicit')
    assert.equal(row.collectionId, 222, 'the row must point at the UNCENSORED collection')
  })

  test('and the same when Apple returns them the other way round', () => {
    const editions = [
      { collectionId: 222, explicitness: 'explicit' },
      { collectionId: 111, explicitness: 'cleaned' },
    ]
    let row = { ...editions[0] }
    for (const e of editions.slice(1)) {
      if (explicitWins(row.explicitness, e.explicitness)) row = { ...e }
    }
    assert.equal(row.collectionId, 222, 'order must not decide which edition Jake gets')
  })
})
