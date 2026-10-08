import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSubgenre, expandSubgenreQuery, isSubgenreAnchor, SUBGENRE_LEXICON } from '../../common/subgenre-lexicon.ts'

describe('subgenre lexicon', () => {
  const yacht = SUBGENRE_LEXICON.find((e) => e.key === 'yacht rock')!

  test('matches aliases word-bounded, case/accent folded', () => {
    assert.equal(matchSubgenre('make me a Yacht Rock mix')?.key, 'yacht rock')
    assert.equal(matchSubgenre('yacht-rock for the boat')?.key, 'yacht rock')
    assert.equal(matchSubgenre('heavy crushing guitars'), null)
    // "yachting" is not "yacht" — no bare-substring hit
    assert.equal(matchSubgenre('yachting documentary soundtrack'), null)
  })

  test('expansion appends sonic words, keeps the query', () => {
    const x = expandSubgenreQuery('yacht rock', yacht)
    assert.ok(x.startsWith('yacht rock.'))
    assert.match(x, /soft rock/)
  })

  test('anchors honour per-artist and entry era windows; unknown year trusts the artist', () => {
    assert.equal(isSubgenreAnchor(yacht, 'Steely Dan', 1972), true)     // per-artist window
    assert.equal(isSubgenreAnchor(yacht, 'Steely Dan', 2000), false)
    assert.equal(isSubgenreAnchor(yacht, 'Chicago', 1970), false)       // not an anchor at all
    assert.equal(isSubgenreAnchor(yacht, 'Toto', 1978), true)
    assert.equal(isSubgenreAnchor(yacht, 'Toto', 1999), false)          // entry window
    assert.equal(isSubgenreAnchor(yacht, 'Toto', undefined), true)
    assert.equal(isSubgenreAnchor(yacht, 'Led Zeppelin', 1979), false)
  })
})
