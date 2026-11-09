/**
 * The Record Shop's For You page, reorganized (2026-11-09; Jake approved
 * ~/concert-repair/record-shop-organization.md as proposed).
 *
 * Pinned here: the crates file by Jake's own rules in a fixed order, with no
 * "Misc"; every pick gets a genre first; one card per artist (the rest
 * folded behind it); nothing capped or hidden; no card twice on the page;
 * the bands in order; and the labels that used to mislead.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CRATES, OTHER_SECTIONS, fileGenre, genreForPick, knownFiling, type PickGenreSources } from '../../common/record-shop-bins.ts'
import {
  buildShopPage, laneChip, moreLabel, sectionLabel, shopCountLine, LANE_CHIPS, SHOP_PAGE_SECTIONS, SHOP_SECTION_TITLES,
  type PageCard,
} from '../../common/record-shop-page.ts'
import { CRITIC_LANE } from '../../common/critic-picks.ts'
import { stampBins, shopGenreSources } from '../discover-feed.ts'

const SRC = join(import.meta.dirname, '../..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

const card = (over: Partial<PageCard> & { artist: string; title: string }): PageCard => ({ lane: 'fresh-albums', type: 'album', ...over })
const lane = (id: string, cards: PageCard[]) => ({ id, cards })
const allCards = <C>(p: ReturnType<typeof buildShopPage<C & PageCard>>): Array<C & PageCard> => [
  ...p.ipods.flatMap((r) => r.entries.flatMap((e) => [e.lead, ...e.more])),
  ...p.outThisYear.flatMap((e) => [e.lead, ...e.more]),
  ...p.crates.flatMap((c) => c.entries.flatMap((e) => [e.lead, ...e.more])),
]

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
    assert.equal(sectionLabel('ODDITIES'), 'Oddities')
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
    assert.deepEqual(page.crates[0].entries.map((e) => e.lead.artist), ['C', 'B', 'A'])
  })
  it("one card per artist; the rest fold behind it, the artist's best leading", () => {
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
    assert.equal(crate.entries.length, 1)
    assert.equal(crate.entries[0].lead.title, 'Punk in Drublic')
    assert.deepEqual(crate.entries[0].more.map((c) => c.title), ['So Long and Thanks for All the Shoes', 'Linoleum'])
    assert.equal(moreLabel(crate.entries[0]), '+2 more by NOFX')
    assert.equal(crate.count, 3)
  })
  it('one card per artist across the crates: an artist is never in two crates', () => {
    const page = buildShopPage({
      lanes: [lane('x', [
        card({ artist: 'Faith No More', title: 'Angel Dust', genre: 'Alternative' }),
        card({ artist: 'Faith No More', title: 'Epic', type: 'song', genre: 'Funk Metal' }),
      ])],
      wanted: [], year: '2026',
    })
    assert.equal(page.crates.length, 1)
    assert.equal(page.crates[0].id, 'alt')
  })
  it('nothing is capped or hidden: a crate of 40 shows 40, a crate of 1 shows 1', () => {
    const many = Array.from({ length: 40 }, (_, i) => card({ artist: `Band ${i}`, title: `LP ${i}`, genre: 'Rock', brainPct: i }))
    const page = buildShopPage({ lanes: [lane('fresh-albums', [...many, card({ artist: 'Lone', title: 'Jazz LP', genre: 'Jazz' })])], wanted: [], year: '2026' })
    assert.equal(page.crates.find((c) => c.id === 'rock')!.entries.length, 40)
    assert.equal(page.crates.find((c) => c.id === 'other')!.entries.length, 1)
    assert.equal(page.crates.find((c) => c.id === 'other')!.entries[0].section, 'JAZZ')
    assert.equal(allCards(page).length, 41)
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
    assert.deepEqual(page.ipods.map((r) => r.entries.map((e) => e.lead.artist)), [['The Strokes'], ['Uffie']])
    assert.deepEqual(page.outThisYear.map((e) => [e.lead.artist, e.more.length]), [['Bonobo', 0]])
    assert.deepEqual(page.crates.flatMap((c) => c.entries.map((e) => e.lead.artist)), ['Silver Jews'])
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
    assert.equal(page.crates[0].entries[0].lead.lane, CRITIC_LANE)
  })
})

describe('one card per artist on the whole page', () => {
  it("an artist with a release this year leads Out This Year; their older picks fold behind it, not into a crate", () => {
    const page = buildShopPage({
      lanes: [lane('fresh-albums', [
        card({ artist: 'Ballyhoo!', title: 'SELF EMPLOYED', year: '2019', genre: 'Ska-Punk', brainPct: 90 }),
        card({ artist: 'Ballyhoo!', title: 'Bad Summer', year: '2026', genre: 'Ska-Punk', brainPct: 81 }),
      ]), lane('fresh-songs', [card({ lane: 'fresh-songs', type: 'song', artist: 'Ballyhoo!', title: 'Walk Away', genre: 'Ska-Punk' })])],
      wanted: [], year: '2026',
    })
    assert.deepEqual(page.outThisYear.map((e) => [e.lead.title, e.more.map((c) => c.title)]), [['Bad Summer', ['SELF EMPLOYED', 'Walk Away']]])
    assert.equal(page.crates.length, 0)
  })
  it("an artist an iPod list wants keeps their other picks folded in that row", () => {
    const page = buildShopPage({
      wanted: [{ listId: 'sleaze', listName: 'Indie Sleeze', title: 'Wanted for Indie Sleeze', cards: [{ lane: 'ipod-wanted', type: 'album', artist: 'Uffie', title: 'Sex Dreams and Denim Jeans' }] }],
      lanes: [lane('fresh-songs', [card({ lane: 'fresh-songs', type: 'song', artist: 'Uffie', title: 'Pop the Glock', genre: 'Electro' })])],
      year: '2026',
    })
    assert.deepEqual(page.ipods[0].entries.map((e) => [e.lead.title, e.more.map((c) => c.title)]), [['Sex Dreams and Denim Jeans', ['Pop the Glock']]])
    assert.equal(page.crates.length, 0)
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
    assert.deepEqual(page.outThisYear.map((e) => e.lead.artist), ['Ballyhoo!', 'Dawn Richard', 'Single Act'])
    assert.ok(page.crates.some((c) => c.entries.some((e) => e.lead.artist === 'Old News')), 'a 2025 "brand new" card goes to the crates')
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
  it('the count line says what is in the crates, today', () => {
    assert.equal(shopCountLine({ records: 25, songs: 25, critic: 5, other: 8, outThisYear: 3, ipods: 0 }), 'Today: 25 records · 25 songs · 5 critic picks · 8 more · 3 out this year')
    assert.equal(shopCountLine({ records: 1, songs: 0, critic: 0, other: 0, outThisYear: 0, ipods: 0 }), 'Today: 1 record')
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
