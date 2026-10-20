// Which Wikipedia page is an artist's bio (2026-10-20) — the desktop twin of the
// phone's Brief 200 fix. The fixtures below are JakeTunesMobile's
// backend/src/util/__tests__/wikipedia.test.ts, VERBATIM (twin lock: the same
// pages must pass and fail on both). Desktop additions follow: Nirvana (the
// Buddhist concept was the desktop's bio), the lookup order, and the lock that
// index.ts keeps no unvalidated Wikipedia path.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assessSummary, searchTitleEligible, bioTitleCandidates } from '../../common/wiki-artist-bio.ts'

const gooseBird = {
  type: 'standard',
  title: 'Goose',
  description: 'Common name for a group of waterfowl',
  extract:
    'A goose is a bird of any of several waterfowl species in the family Anatidae. This group comprises the genera Anser and Branta.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Goose' } },
}

const geeseBand = {
  type: 'standard',
  title: 'Geese (band)',
  description: 'American rock band',
  extract: 'Geese is an American rock band from New York City that formed in 2016.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Geese_(band)' } },
}

const gooseBand = {
  type: 'standard',
  title: 'Goose (band)',
  description: 'American rock band',
  extract: 'Goose is an American rock band from Connecticut.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Goose_(band)' } },
}

const grizzlyAnimal = {
  type: 'standard',
  title: 'Grizzly bear',
  description: 'Subspecies of brown bear',
  extract: 'The grizzly bear is a North American subspecies of the brown bear.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Grizzly_bear' } },
}

const grizzlyBand = {
  type: 'standard',
  title: 'Grizzly Bear (band)',
  description: 'American rock band',
  extract: 'Grizzly Bear is an American rock band from Brooklyn, New York.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Grizzly_Bear_(band)' } },
}

const turnstileGate = {
  type: 'standard',
  title: 'Turnstile',
  description: 'Form of gate',
  extract: 'A turnstile is a form of gate which allows one person to pass at a time.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Turnstile' } },
}

const daftPunk = {
  type: 'standard',
  title: 'Daft Punk',
  description: 'French electronic music duo',
  extract: 'Daft Punk were a French electronic music duo formed in Paris in 1993.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Daft_Punk' } },
}

const daftPunkAlbum = {
  type: 'standard',
  title: 'Random Access Memories',
  description: '2013 studio album by Daft Punk',
  extract:
    'Random Access Memories is the fourth studio album by the French electronic music duo Daft Punk.',
  content_urls: {
    desktop: { page: 'https://en.wikipedia.org/wiki/Random_Access_Memories' },
  },
}

const beachHouse = {
  type: 'standard',
  title: 'Beach House',
  description: 'American dream pop band',
  extract: 'Beach House is an American dream pop band formed in Baltimore.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Beach_House' } },
}

const vocalGroup = {
  type: 'standard',
  title: 'The Mamas & the Papas',
  description: 'American folk rock vocal group',
  extract: 'The Mamas & the Papas was an American folk rock vocal group formed in Los Angeles.',
  content_urls: {
    desktop: { page: 'https://en.wikipedia.org/wiki/The_Mamas_%26_the_Papas' },
  },
}

describe('assessSummary (Brief 200 wrong-entity guards)', () => {
  it('rejects the bird article redirected from "Geese"', () => {
    assert.equal(assessSummary('Geese', 'Geese', gooseBird), null)
  })

  it('serves Geese (band)', () => {
    const bio = assessSummary('Geese', 'Geese (band)', geeseBand)
    assert.equal(bio?.title, 'Geese (band)')
    assert.equal(bio?.url, 'https://en.wikipedia.org/wiki/Geese_(band)')
  })

  it('rejects the bird article for the artist "Goose" too', () => {
    assert.equal(assessSummary('Goose', 'Goose', gooseBird), null)
    assert.notEqual(assessSummary('Goose', 'Goose (band)', gooseBand), null)
  })

  it('rejects the animal article whose title differs only by case', () => {
    assert.equal(assessSummary('Grizzly Bear', 'Grizzly Bear', grizzlyAnimal), null)
    assert.notEqual(assessSummary('Grizzly Bear', 'Grizzly Bear (band)', grizzlyBand), null)
  })

  it('still rejects the Turnstile gate', () => {
    assert.equal(assessSummary('Turnstile', 'Turnstile', turnstileGate), null)
  })

  it('still serves a direct-title artist (Daft Punk)', () => {
    assert.notEqual(assessSummary('Daft Punk', 'Daft Punk', daftPunk), null)
  })

  it('rejects an album page even when its extract names the artist', () => {
    assert.equal(assessSummary('Daft Punk', 'Random Access Memories', daftPunkAlbum), null)
  })

  it('serves Beach House, whose (band) query resolves to the bare title', () => {
    assert.notEqual(assessSummary('Beach House', 'Beach House (band)', beachHouse), null)
  })

  it('accepts a qualified generic ("folk rock vocal group")', () => {
    assert.notEqual(assessSummary('The Mamas & the Papas', 'The Mamas & the Papas', vocalGroup), null)
  })

  it('search gate: only name-titled pages are eligible (Dan Gilroy regression)', () => {
    // Live regression, Oct 16 2026: "Goose musician band" search ranked
    // Dan Gilroy (musician) — musical, but not Goose — and he was served.
    assert.equal(searchTitleEligible('Dan Gilroy (musician)', 'Goose'), false)
    assert.equal(searchTitleEligible('Goose (American band)', 'Goose'), true)
    assert.equal(searchTitleEligible('Goose (Belgian band)', 'Goose'), true)
    assert.equal(searchTitleEligible('Goose', 'Goose'), true)
    assert.equal(searchTitleEligible('Mother Goose (band)', 'Goose'), false)
    assert.equal(searchTitleEligible('The Goose', 'Goose'), false)
    assert.equal(searchTitleEligible('Geese (band)', 'Geese'), true)
  })

  it('search gate: only name-titled pages are eligible (Dan Gilroy regression)', () => {
    // Live regression, Oct 16 2026: the "Goose musician band" search
    // ranked Dan Gilroy (musician) — musical, but not Goose — and his
    // page was served as the Goose bio.
    assert.equal(searchTitleEligible('Dan Gilroy (musician)', 'Goose'), false)
    assert.equal(searchTitleEligible('Goose (American band)', 'Goose'), true)
    assert.equal(searchTitleEligible('Goose (Belgian band)', 'Goose'), true)
    assert.equal(searchTitleEligible('Goose', 'Goose'), true)
    assert.equal(searchTitleEligible('Mother Goose (band)', 'Goose'), false)
    assert.equal(searchTitleEligible('The Goose', 'Goose'), false)
    assert.equal(searchTitleEligible('Geese (band)', 'Geese'), true)
  })

  it('rejects disambiguation pages and empty extracts', () => {
    assert.equal(
      assessSummary('Geese', 'Geese', { ...geeseBand, type: 'disambiguation' }),
      null,
    )
    assert.equal(assessSummary('Geese', 'Geese (band)', { ...geeseBand, extract: '  ' }), null)
  })
})

const nirvanaConcept = {
  type: 'standard',
  title: 'Nirvana',
  description: 'Concept in Indian religions',
  extract: "Nirvana, in the Indian religions, is the concept of an individual's passions being extinguished.",
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Nirvana' } },
}
const nirvanaBand = {
  type: 'standard',
  title: 'Nirvana (band)',
  description: 'American rock band',
  extract: 'Nirvana was an American rock band formed in Aberdeen, Washington, in 1987.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Nirvana_(band)' } },
}

describe('desktop additions (10/20)', () => {
  it('rejects the religious concept for Nirvana; serves Nirvana (band)', () => {
    assert.equal(assessSummary('Nirvana', 'Nirvana', nirvanaConcept), null)
    assert.equal(assessSummary('Nirvana', 'Nirvana (band)', nirvanaBand)?.url, 'https://en.wikipedia.org/wiki/Nirvana_(band)')
  })

  it('tries the parentheticals before the bare name; MusicBrainz\'s link first', () => {
    assert.deepEqual(bioTitleCandidates('Geese', null), ['Geese (band)', 'Geese (musician)', 'Geese'])
    const c = bioTitleCandidates('Drake', { wikiTitle: 'Drake (musician)', type: 'Person', tags: ['hip hop', 'rap'] })
    assert.equal(c[0], 'Drake (musician)')
    assert.ok(c.indexOf('Drake (rapper)') < c.indexOf('Drake'))
    assert.equal(c[c.length - 1], 'Drake')
    assert.equal(new Set(c.map((t) => t.toLowerCase())).size, c.length, 'no duplicates')
  })

  it('index.ts keeps no unvalidated Wikipedia lookup', () => {
    const index = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    assert.ok(!/rest_v1\/page\/summary|list=search&srsearch/.test(index), 'Wikipedia fetches live in artist-wiki.ts, behind assessSummary')
    const wiki = readFileSync(join(import.meta.dirname, '..', 'artist-wiki.ts'), 'utf-8')
    assert.match(wiki, /return assessSummary\(artist, title,/)
    assert.match(wiki, /searchTitleEligible\(hit\.title, artist\)/)
  })
})
