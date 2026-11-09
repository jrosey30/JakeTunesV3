/**
 * The Record Shop's For You page, reorganized (2026-11-09; Jake approved
 * ~/concert-repair/record-shop-organization.md as proposed).
 *
 * Pinned here: the crates file by Jake's own rules in a fixed order, with no
 * "Misc"; every pick gets a genre first; every record its own card (no fold,
 * Jake the same afternoon: "dont like the fold in") with at most three cards
 * per artist on the page, never side by side; nothing else capped or hidden;
 * no record twice on the page; the bands in order; and the labels that used
 * to mislead.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CRATES, OTHER_SECTIONS, fileGenre, genreForPick, knownFiling, type PickGenreSources } from '../../common/record-shop-bins.ts'
import {
  buildShopPage, laneChip, sectionLabel, shelfLabel, shopCountLine, spreadArtists, LANE_CHIPS, PER_ARTIST_ON_PAGE, SHOP_PAGE_SECTIONS, SHOP_SECTION_TITLES,
  type PageCard,
} from '../../common/record-shop-page.ts'
import { CRITIC_LANE } from '../../common/critic-picks.ts'
import { stampBins, shopGenreSources } from '../discover-feed.ts'

const SRC = join(import.meta.dirname, '../..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

const card = (over: Partial<PageCard> & { artist: string; title: string }): PageCard => ({ lane: 'fresh-albums', type: 'album', ...over })
const lane = (id: string, cards: PageCard[]) => ({ id, cards })
const allCards = <C>(p: ReturnType<typeof buildShopPage<C & PageCard>>): Array<C & PageCard> => [
  ...p.ipods.flatMap((r) => r.cards.map((s) => s.card)),
  ...p.outThisYear.map((s) => s.card),
  ...p.crates.flatMap((c) => c.cards.map((s) => s.card)),
]
const artists = (cards: Array<{ card: PageCard }>): string[] => cards.map((s) => s.card.artist)

describe("Jake's filing (rescued from Step Inside's shopPlan.ts)", () => {
  it('the crates, in his order', () => {
    assert.deepEqual(CRATES.map((c) => c.label), [
      'Punk', 'Grunge', 'Rock', 'Alternative / Indie', 'Rap / Hip-Hop', 'Electronic / Dance', 'Soul / Funk / R&B', 'Pop / New Wave', 'Jazz · World · Metal · Country',
    ])
  })
  it('rock shares, alt/indie share, punk and grunge each their own', () => {
    assert.equal(fileGenre('Classic Rock').bin, 'rock')
    assert.equal(fileGenre('Alternative').bin, 'alt')
    assert.equal(fileGenre('Indie Pop').bin, 'alt')
    assert.equal(fileGenre('Punk').bin, 'punk')
    assert.equal(fileGenre('Grunge').bin, 'grunge')
    assert.equal(fileGenre('Post-Punk').bin, 'punk')
  })
  it('the order of the rules decides the ambiguous ones', () => {
    assert.equal(fileGenre('Funk Rock').bin, 'rock')
    assert.equal(fileGenre('Funk/Soul').bin, 'soul')
    assert.equal(fileGenre('Alternative Hip-Hop').bin, 'rap')
    assert.equal(fileGenre('Latin House').bin, 'electronic')
    assert.equal(fileGenre('UK Garage').bin, 'electronic')
    assert.equal(fileGenre('Garage Rock').bin, 'rock')
    assert.deepEqual(fileGenre('Funk Metal'), { bin: 'other', section: 'METAL' })
  })
  it('the small sections share one crate under a real label', () => {
    assert.deepEqual(fileGenre('Jazz'), { bin: 'other', section: 'JAZZ' })
    assert.deepEqual(fileGenre('Bossa Nova'), { bin: 'other', section: 'BRAZIL & LATIN' })
    assert.deepEqual(fileGenre('Reggae'), { bin: 'other', section: 'REGGAE' })
    assert.equal(sectionLabel('BRAZIL & LATIN'), 'Brazil & Latin')
    assert.equal(sectionLabel('JAZZ'), 'Jazz')
  })
  it('there is no Misc crate, and nothing files outside the crates', () => {
    assert.ok(!CRATES.some((c) => /misc|more finds/i.test(c.label)))
    const ids = new Set(CRATES.map((c) => c.id))
    for (const g of ['', undefined, 'Video Game', 'Spoken Word', 'Rap', 'Nu Disco', 'Synth-Pop', 'Dancehall', 'Ska-Punk', 'Trip Hop']) {
      const f = fileGenre(g)
      assert.ok(ids.has(f.bin), `${g} -> ${f.bin}`)
      if (f.section) assert.ok((OTHER_SECTIONS as readonly string[]).includes(f.section))
    }
  })
})

describe('every pick gets a genre before it is filed', () => {
  const src: PickGenreSources = {
    libraryGenre: (a) => ({ sublime: 'Ska-Punk', heavenly: 'Indie Pop', 'neutral milk hotel': 'Indie Folk' } as Record<string, string>)[a.toLowerCase()],
    tags: (a) => ({ nofx: ['skate punk', 'punk rock'], 'the apples in stereo': ['elephant 6', 'indie pop'], bonobo: ['downtempo', 'trip hop'] } as Record<string, string[]>)[a.toLowerCase()],
  }
  it("the card's own genre first", () => {
    assert.equal(genreForPick({ artist: 'TLC', genre: 'R&B' }, src), 'R&B')
  })
  it('then the artist in the library (his own words)', () => {
    assert.equal(genreForPick({ artist: 'Heavenly' }, src), 'Indie Pop')
  })
  it("then the artist's MusicBrainz tags, the first one his rules know", () => {
    assert.equal(genreForPick({ artist: 'NOFX' }, src), 'skate punk')
    assert.equal(genreForPick({ artist: 'The Apples in Stereo' }, src), 'indie pop', '"elephant 6" files nowhere, so the next tag')
  })
  it('then the library artist the pick came from', () => {
    assert.equal(genreForPick({ artist: 'Jeff Mangum', because: 'Neutral Milk Hotel' }, src), 'Indie Folk')
    assert.equal(fileGenre(genreForPick({ artist: 'Ballyhoo!', because: 'Sublime' }, src)).bin, 'punk')
  })
  it("then the card's sound line; nobody saying anything is the only null", () => {
    assert.equal(fileGenre(genreForPick({ artist: 'untitled (halo)', desc: 'Indie pop with trip-hop shading' }, src)).bin, 'alt')
    assert.equal(genreForPick({ artist: 'Nobody' }, src), null)
  })
  it('stampBins gives every served card a genre and a crate id', async () => {
    const cards = [
      { lane: 'fresh-albums', type: 'album' as const, artist: 'Mad Caddies', title: 'Duck and Cover', why: '', because: 'Sublime' },
      { lane: 'fresh-songs', type: 'song' as const, artist: 'Heavenly', title: 'C Is the Heavenly Option', why: '' },
      { lane: CRITIC_LANE, type: 'album' as const, artist: 'TLC', title: 'CrazySexyCool', why: '', genre: 'R&B' },
    ]
    const sources = await shopGenreSources([
      { artist: 'Sublime', genre: 'Ska-Punk' }, { artist: 'Sublime', genre: 'Ska-Punk' }, { artist: 'Sublime', genre: 'Reggae' },
      { artist: 'Heavenly', albumArtist: 'Heavenly', genre: 'Indie Pop' },
    ], join(SRC, 'does-not-exist', 'artist-tags.json'))
    stampBins(cards, sources)
    assert.deepEqual(cards.map((c) => [c.genre, c.bin]), [['Ska-Punk', 'punk'], ['Indie Pop', 'alt'], ['R&B', 'soul']])
    assert.ok(cards.every((c) => CRATES.some((cr) => cr.id === c.bin)))
    stampBins(cards, sources)
    assert.deepEqual(cards.map((c) => c.bin), ['punk', 'alt', 'soul'], 'idempotent')
  })
})

describe('The Crates', () => {
  it('fixed order, whatever order the cards arrive in; no empty crate drawn', () => {
    const page = buildShopPage({
      lanes: [lane('fresh-albums', [
        card({ artist: 'Gucci Mane', title: 'Trap House', genre: 'Hip Hop' }),
        card({ artist: 'Silver Jews', title: 'American Water', genre: 'Indie Rock' }),
        card({ artist: 'NOFX', title: 'Punk in Drublic', genre: 'Punk' }),
        card({ artist: 'Thin Lizzy', title: 'Jailbreak', genre: 'Rock' }),
      ])],
      wanted: [], year: '2026',
    })
    assert.deepEqual(page.crates.map((c) => c.id), ['punk', 'rock', 'alt', 'rap'])
  })
  it('albums first, then the best match', () => {
    const page = buildShopPage({
      lanes: [lane('fresh-songs', [
        card({ lane: 'fresh-songs', type: 'song', artist: 'A', title: 'Song', genre: 'Punk', brainPct: 99 }),
      ]), lane('fresh-albums', [
        card({ artist: 'B', title: 'LP', genre: 'Punk', brainPct: 60 }),
        card({ artist: 'C', title: 'LP', genre: 'Punk', brainPct: 80 }),
      ])],
      wanted: [], year: '2026',
    })
    assert.deepEqual(artists(page.crates[0].cards), ['C', 'B', 'A'])
  })
  it('every record is its own card: no fold, no "+2 more by"', () => {
    const page = buildShopPage({
      lanes: [lane('fresh-albums', [
        card({ artist: 'NOFX', title: 'So Long and Thanks for All the Shoes', genre: 'Punk', brainPct: 70 }),
        card({ artist: 'NOFX', title: 'Punk in Drublic', genre: 'Punk', brainPct: 75 }),
      ]), lane('fresh-songs', [
        card({ lane: 'fresh-songs', type: 'song', artist: 'NOFX', title: 'Linoleum', genre: 'Punk', brainPct: 90 }),
      ])],
      wanted: [], year: '2026',
    })
    const crate = page.crates.find((c) => c.id === 'punk')!
    assert.deepEqual(crate.cards.map((s) => s.card.title), ['Punk in Drublic', 'So Long and Thanks for All the Shoes', 'Linoleum'])
    const view = src('renderer/views/NewForYouView.tsx')
    assert.doesNotMatch(view, /moreLabel|openFolds|store-fold|more by/)
    assert.doesNotMatch(src('common/record-shop-page.ts'), /export const moreLabel/)
  })
  it(`one artist gets at most ${PER_ARTIST_ON_PAGE} cards on the whole page, their best ones`, () => {
    const page = buildShopPage({
      wanted: [{ listId: 'sleaze', listName: 'Indie Sleeze', title: 'Wanted for Indie Sleeze', cards: [{ lane: 'ipod-wanted', type: 'album', artist: 'NOFX', title: 'White Trash' }] }],
      lanes: [lane('fresh-albums', Array.from({ length: 6 }, (_, i) => card({ artist: 'NOFX', title: `LP ${i}`, genre: 'Punk', brainPct: 50 + i }))),
        lane('brand-new', [card({ lane: 'brand-new', artist: 'NOFX', title: 'Half Album', year: '2026', brainPct: 40 })])],
      year: '2026',
    })
    const nofx = allCards(page).filter((c) => c.artist === 'NOFX')
    assert.equal(nofx.length, PER_ARTIST_ON_PAGE)
    assert.deepEqual(nofx.map((c) => c.title), ['White Trash', 'LP 5', 'LP 4'], 'the iPod row first, then the best two')
  })
  it('two cards by one artist are never side by side when another card can go between', () => {
    const page = buildShopPage({
      lanes: [lane('fresh-albums', [
        card({ artist: 'MxPx', title: 'A', genre: 'Punk', brainPct: 90 }),
        card({ artist: 'MxPx', title: 'B', genre: 'Punk', brainPct: 89 }),
        card({ artist: 'MxPx', title: 'C', genre: 'Punk', brainPct: 88 }),
        card({ artist: 'Mest', title: 'D', genre: 'Punk', brainPct: 80 }),
        card({ artist: 'Mest', title: 'E', genre: 'Punk', brainPct: 79 }),
      ])],
      wanted: [], year: '2026',
    })
    const order = artists(page.crates[0].cards)
    assert.deepEqual(order, ['MxPx', 'Mest', 'MxPx', 'Mest', 'MxPx'])
    assert.deepEqual(spreadArtists(['a', 'a', 'a'], (x) => x), ['a', 'a', 'a'], 'nothing to put between: order kept')
  })
  it('an artist may be in two crates (each record files by its own genre)', () => {
    const page = buildShopPage({
      lanes: [lane('x', [
        card({ artist: 'Faith No More', title: 'Angel Dust', genre: 'Alternative' }),
        card({ artist: 'Faith No More', title: 'Epic', type: 'song', genre: 'Funk Metal' }),
      ])],
      wanted: [], year: '2026',
    })
    assert.deepEqual(page.crates.map((c) => c.id), ['alt', 'other'])
  })
  it('nothing is capped or hidden: a crate of 40 shows 40, a crate of 1 shows 1', () => {
    const many = Array.from({ length: 40 }, (_, i) => card({ artist: `Band ${i}`, title: `LP ${i}`, genre: 'Rock', brainPct: i }))
    const page = buildShopPage({ lanes: [lane('fresh-albums', [...many, card({ artist: 'Lone', title: 'Jazz LP', genre: 'Jazz' })])], wanted: [], year: '2026' })
    assert.equal(page.crates.find((c) => c.id === 'rock')!.cards.length, 40)
    assert.equal(page.crates.find((c) => c.id === 'other')!.cards.length, 1)
    assert.equal(page.crates.find((c) => c.id === 'other')!.cards[0].label, 'Jazz')
    assert.equal(allCards(page).length, 41)
    assert.equal(page.counts.total, 41)
  })
  it('a genre none of his rules know shows its own name in the mixed crate, never "Oddities"', () => {
    assert.equal(shelfLabel({ genre: 'spoken word' }, 'ODDITIES'), 'Spoken Word')
    assert.equal(shelfLabel({}, 'ODDITIES'), 'Other')
    assert.equal(shelfLabel({ genre: 'Reggae' }, 'REGGAE'), 'Reggae')
    assert.equal(shelfLabel({ genre: 'Rock' }), undefined)
  })
})

describe('no card appears twice on the page', () => {
  const ipodCard = (artist: string, title: string): PageCard => ({ lane: 'ipod-wanted', type: 'album', artist, title })
  it('iPods claim first, then Out This Year, then the crates', () => {
    const page = buildShopPage({
      wanted: [
        { listId: 'y2k', listName: 'Y2K Revival', title: 'Wanted for Y2K Revival', cards: [ipodCard('The Strokes', 'Is This It')] },
        { listId: 'sleaze', listName: 'Indie Sleeze', title: 'Wanted for Indie Sleeze', cards: [ipodCard('The Strokes', 'Is This It'), ipodCard('Uffie', 'Sex Dreams and Denim Jeans')] },
      ],
      lanes: [
        lane('brand-new', [card({ lane: 'brand-new', artist: 'Bonobo', title: 'Distance in Static', year: '2026' })]),
        lane('fresh-albums', [
          card({ artist: 'The Strokes', title: 'Is This It', genre: 'Rock' }),
          card({ artist: 'Bonobo', title: 'Distance In Static', year: '2026' }),
          card({ artist: 'Silver Jews', title: 'American Water', genre: 'Indie Rock', year: '1998' }),
        ]),
      ],
      year: '2026',
    })
    assert.deepEqual(page.ipods.map((r) => artists(r.cards)), [['The Strokes'], ['Uffie']])
    assert.deepEqual(artists(page.outThisYear), ['Bonobo'])
    assert.deepEqual(page.crates.flatMap((c) => artists(c.cards)), ['Silver Jews'])
    const keys = allCards(page).map((c) => `${c.artist}|${c.title}`.toLowerCase())
    assert.equal(new Set(keys).size, keys.length)
  })
  it("the same record from two lanes is one card, and the critic's copy wins", () => {
    const page = buildShopPage({
      lanes: [
        lane('fresh-albums', [card({ artist: 'Thin Lizzy', title: 'Jailbreak', genre: 'Rock' })]),
        lane(CRITIC_LANE, [card({ lane: CRITIC_LANE, artist: 'Thin Lizzy', title: 'Jailbreak', genre: 'Rock' })]),
      ],
      wanted: [], year: '2026',
    })
    assert.equal(allCards(page).length, 1)
    assert.equal(page.crates[0].cards[0].card.lane, CRITIC_LANE)
  })
})

describe("an artist's records each go where they belong", () => {
  it("this year's record goes to Out This Year, the older ones to their crate", () => {
    const page = buildShopPage({
      lanes: [lane('fresh-albums', [
        card({ artist: 'Ballyhoo!', title: 'SELF EMPLOYED', year: '2019', genre: 'Ska-Punk', brainPct: 90 }),
        card({ artist: 'Ballyhoo!', title: 'Bad Summer', year: '2026', genre: 'Ska-Punk', brainPct: 81 }),
      ]), lane('fresh-songs', [card({ lane: 'fresh-songs', type: 'song', artist: 'Ballyhoo!', title: 'Walk Away', genre: 'Ska-Punk' })])],
      wanted: [], year: '2026',
    })
    assert.deepEqual(page.outThisYear.map((s) => s.card.title), ['Bad Summer'])
    assert.deepEqual(page.crates.find((c) => c.id === 'punk')!.cards.map((s) => s.card.title), ['SELF EMPLOYED', 'Walk Away'])
  })
  it('an artist an iPod list wants can still have a daily pick in a crate', () => {
    const page = buildShopPage({
      wanted: [{ listId: 'sleaze', listName: 'Indie Sleeze', title: 'Wanted for Indie Sleeze', cards: [{ lane: 'ipod-wanted', type: 'album', artist: 'Uffie', title: 'Sex Dreams and Denim Jeans' }] }],
      lanes: [lane('fresh-songs', [card({ lane: 'fresh-songs', type: 'song', artist: 'Uffie', title: 'Pop the Glock', genre: 'Electro' })])],
      year: '2026',
    })
    assert.deepEqual(page.ipods[0].cards.map((s) => s.card.title), ['Sex Dreams and Denim Jeans'])
    assert.deepEqual(page.crates.find((c) => c.id === 'electronic')!.cards.map((s) => s.card.title), ['Pop the Glock'])
  })
})

describe('Out This Year', () => {
  it("this year's releases only, from any lane, albums first then best match; no cap", () => {
    const page = buildShopPage({
      lanes: [
        lane('brand-new', [
          card({ lane: 'brand-new', artist: 'Old News', title: 'Last Year', year: '2025', genre: 'Rock' }),
          card({ lane: 'brand-new', artist: 'Dawn Richard', title: 'New LP', year: '2026', brainPct: 56 }),
        ]),
        lane('fresh-albums', [card({ artist: 'Ballyhoo!', title: 'Bad Summer', year: '2026', brainPct: 81 })]),
        lane('fresh-songs', [card({ lane: 'fresh-songs', type: 'song', artist: 'Single Act', title: 'Single', year: '2026', brainPct: 99 })]),
      ],
      wanted: [], year: '2026',
    })
    assert.deepEqual(artists(page.outThisYear), ['Ballyhoo!', 'Dawn Richard', 'Single Act'])
    assert.ok(page.crates.some((c) => c.cards.some((s) => s.card.artist === 'Old News')), 'a 2025 "brand new" card goes to the crates')
    assert.equal(page.counts.outThisYear, 3)
  })
})

describe('labels', () => {
  it('the bands are named for what they are', () => {
    assert.equal(SHOP_SECTION_TITLES['for-your-ipods'].title, 'For Your iPods')
    assert.equal(SHOP_SECTION_TITLES['out-this-year'].title, 'Out This Year')
    assert.equal(SHOP_SECTION_TITLES.crates.title, 'The Crates')
    assert.match(SHOP_SECTION_TITLES['hosts-picks'].sub, /already in your library/i)
    assert.match(SHOP_SECTION_TITLES['behind-the-counter'].sub, /already in your library/i)
  })
  it('only a record from this year says "New"', () => {
    assert.equal(laneChip({ lane: 'fresh-albums', year: '2012' }, '2026'), 'Daily')
    assert.equal(laneChip({ lane: 'fresh-albums', year: '2026' }, '2026'), 'New release')
    assert.equal(laneChip({ lane: CRITIC_LANE, year: '1994' }, '2026'), 'Critic')
    for (const [lane, chip] of Object.entries(LANE_CHIPS)) assert.doesNotMatch(chip, /\bnew\b/i, lane)
  })
  it('the count line says what is on the page, in plain words', () => {
    assert.equal(shopCountLine({ records: 60, songs: 60, critic: 5, other: 8, outThisYear: 3, ipods: 0, total: 133 }), 'Today: 60 records · 60 songs · 5 critic picks · 8 other picks')
    assert.equal(shopCountLine({ records: 1, songs: 0, critic: 0, other: 1, outThisYear: 0, ipods: 0, total: 2 }), 'Today: 1 record · 1 other pick')
    assert.doesNotMatch(shopCountLine({ records: 1, songs: 1, critic: 1, other: 8, outThisYear: 3, ipods: 0, total: 11 }), /\d more\b|out this year/)
  })
  it('the counts are what the page shows, not what the lanes held', () => {
    const page = buildShopPage({
      lanes: [lane('fresh-albums', Array.from({ length: 5 }, (_, i) => card({ artist: 'Same', title: `LP ${i}`, genre: 'Rock' })))],
      wanted: [], year: '2026',
    })
    assert.equal(page.counts.records, PER_ARTIST_ON_PAGE)
  })
  it('the old misleading words are gone from the page', () => {
    // Code only: the comments are allowed to remember what the page used to say.
    const view = src('renderer/views/NewForYouView.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(view, /Today's 25 New|More Finds|Misc|Step Inside|recordstore/)
    assert.match(view, /already in your library/)
  })
})

describe('the page, top to bottom', () => {
  it('iPods, this year, the crates, then what you already own, then the report', () => {
    assert.deepEqual([...SHOP_PAGE_SECTIONS], ['for-your-ipods', 'out-this-year', 'crates', 'hosts-picks', 'behind-the-counter', 'what-ive-learned'])
  })
  it('the view draws the bands in that order and nowhere else', () => {
    const view = src('renderer/views/NewForYouView.tsx')
    assert.match(view, /\{SHOP_PAGE_SECTIONS\.map\(\(id\) => bands\[id\]\)\}/)
    assert.match(view, /buildShopPage\(\{ lanes, wanted: wantedShelves, year \}\)/)
    assert.doesNotMatch(view, /applyBinQuotas|binForGenre/)
  })
  it('the tabs are For You, Browse and Listen List; Rock DNA has its own page, linked from the strip', () => {
    const dv = src('renderer/views/DiscoveryView.tsx')
    assert.doesNotMatch(dv, /RockDnaView|>Rock DNA</)
    assert.match(src('renderer/components/MainContent.tsx'), /case 'rock-dna': viewElement = <RockDnaView \/>/)
    assert.match(src('renderer/views/NewForYouView.tsx'), /dispatch\(\{ type: 'SET_VIEW', view: 'rock-dna' \}\)/)
  })
})

describe('Step Inside is gone (tag archive/step-inside-2026-11-09)', () => {
  it('no room, no route, no three.js', () => {
    assert.equal(existsSync(join(SRC, 'renderer/views/RecordStore')), false)
    assert.equal(existsSync(join(SRC, 'main/record-store')), false)
    assert.doesNotMatch(src('renderer/types.ts'), /'recordstore'/)
    assert.doesNotMatch(src('preload/index.ts'), /record-store:/)
    const pkg = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf-8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    assert.equal(pkg.dependencies.three, undefined)
    assert.equal(pkg.devDependencies['@types/three'], undefined)
  })
  it('an old session saved in the room still reopens on Songs', () => {
    assert.match(src('renderer/nav-history.ts'), /saved === 'recordstore' \? 'songs'/)
  })
  it('knownFiling is the one rule the crates and the genre picker share', () => {
    assert.equal(knownFiling('elephant 6'), null)
    assert.deepEqual(knownFiling('indie pop'), { bin: 'alt' })
  })
})
