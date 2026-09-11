import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BINS, fileGenre, filingLetter, letterSections, groupSections, OTHER_SECTIONS,
} from '../../renderer/views/RecordStore/stepinside/shopPlan.ts'

describe('shop plan — filing', () => {
  it("files the way Jake said: rock shares, alt/indie share, punk and grunge each their own", () => {
    assert.equal(fileGenre('Classic Rock').bin, 'rock')
    assert.equal(fileGenre('Rock').bin, 'rock')
    assert.equal(fileGenre('Alternative').bin, 'alt')
    assert.equal(fileGenre('Indie Rock').bin, 'alt')
    assert.equal(fileGenre('Indie Pop').bin, 'alt')
    assert.equal(fileGenre('Punk').bin, 'punk')
    assert.equal(fileGenre('Grunge').bin, 'grunge')
    assert.equal(fileGenre('Hardcore').bin, 'punk')
    assert.equal(fileGenre('Post-Punk').bin, 'punk')
  })

  it('order of rules decides the ambiguous ones', () => {
    assert.equal(fileGenre('Funk Rock').bin, 'rock')
    assert.equal(fileGenre('Funk/Soul').bin, 'soul')
    assert.equal(fileGenre('Alternative Hip-Hop').bin, 'rap')
    assert.equal(fileGenre('Alternative R&B').bin, 'soul')
    assert.equal(fileGenre('Latin House').bin, 'electronic')
    assert.equal(fileGenre('Latin Rock').bin, 'rock')
    assert.equal(fileGenre('Garage Rock').bin, 'rock')
    assert.equal(fileGenre('UK Garage').bin, 'electronic')
    assert.equal(fileGenre('Electronic Jazz').bin, 'electronic')
    assert.equal(fileGenre('Rock, Pop').bin, 'rock')
    assert.deepEqual(fileGenre('Surf Country'), { bin: 'other', section: 'COUNTRY' })
    assert.deepEqual(fileGenre('Funk Metal'), { bin: 'other', section: 'METAL' })
  })

  it('small sections file in the mixed bin under a real card', () => {
    assert.deepEqual(fileGenre('Jazz'), { bin: 'other', section: 'JAZZ' })
    assert.deepEqual(fileGenre('Bossa Nova'), { bin: 'other', section: 'BRAZIL & LATIN' })
    assert.deepEqual(fileGenre('MPB'), { bin: 'other', section: 'BRAZIL & LATIN' })
    assert.deepEqual(fileGenre('Reggae'), { bin: 'other', section: 'REGGAE' })
    assert.deepEqual(fileGenre('World'), { bin: 'other', section: 'WORLD' })
    assert.deepEqual(fileGenre('Metal'), { bin: 'other', section: 'METAL' })
    assert.deepEqual(fileGenre('Country'), { bin: 'other', section: 'COUNTRY' })
  })

  it('nothing is lost: unknown and empty genres land on the oddities card', () => {
    assert.deepEqual(fileGenre('Video Game'), { bin: 'other', section: 'ODDITIES' })
    assert.deepEqual(fileGenre(''), { bin: 'other', section: 'ODDITIES' })
    assert.deepEqual(fileGenre(undefined), { bin: 'other', section: 'ODDITIES' })
  })

  it('every filing names a real bin and a real section', () => {
    const ids = new Set(BINS.map((b) => b.id))
    for (const g of ['Rap', 'Electroclash', 'Nu Disco', 'New Wave', 'Synth-Pop', 'Dark Wave', 'Trip Hop', 'Dancehall', 'Comedy', 'Kids', 'Israeli Hip-Hop', 'Afro-Rock']) {
      const f = fileGenre(g)
      assert.ok(ids.has(f.bin), `${g} -> ${f.bin}`)
      if (f.section) assert.ok((OTHER_SECTIONS as readonly string[]).includes(f.section), `${g} -> ${f.section}`)
    }
  })

  it('there is no dollar bin', () => {
    assert.equal(BINS.some((b) => /dollar|bargain/i.test(b.label)), false)
  })
})

describe('shop plan — cards', () => {
  it('filing letters drop "The", fold accents, keep other scripts, bucket digits', () => {
    assert.equal(filingLetter('The Beatles'), 'B')
    assert.equal(filingLetter('Édith Piaf'), 'E')
    assert.equal(filingLetter('הדג נחש'), 'ה')
    assert.equal(filingLetter('2Pac'), '#')
  })

  it('no bin leads with a card: the first record faces you', () => {
    assert.equal(letterSections(['A', 'B', 'C', 'D'], 2)[0]?.at, 2)
    assert.equal(groupSections(['JAZZ', 'WORLD'])[0]?.at, 1)
  })

  it('letter cards read the real range of each section', () => {
    const artists = ['AC/DC', 'Bala Desejo', 'The Beatles', 'Dire Straits', 'Eels', 'Turnstile']
    assert.deepEqual(letterSections(artists, 3), [{ at: 3, label: 'D–T' }])
    assert.deepEqual(letterSections(['Air', 'Aphex Twin'], 12), [])
    assert.deepEqual(letterSections([], 12), [])
  })

  it('group cards stand at each change of section', () => {
    assert.deepEqual(groupSections(['JAZZ', 'JAZZ', 'WORLD', 'METAL', 'METAL']), [
      { at: 2, label: 'WORLD' }, { at: 3, label: 'METAL' },
    ])
  })
})
