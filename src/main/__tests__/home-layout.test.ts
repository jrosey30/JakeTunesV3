/**
 * The V7 desktop Home (Jake's approved design, 2026-11-24): hero, three
 * shelves, Shows; Year in Review in December only; everything else moved off
 * the Home to a page you can reach, never deleted (common/home-layout.ts).
 *
 * Mutation-checked: each rule below was broken on purpose and its test failed
 * (see the PR for the list).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  homeSections, yearInReviewOnHome, nyMonth, heroShowLine, heroByline, shortDay, MOVED_OFF_HOME,
} from '../../common/home-layout.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

// Noon in New York on the given day (no daylight-time edge to trip on).
const ny = (ymd: string): Date => new Date(`${ymd}T12:00:00-05:00`)

describe('which sections the Home draws', () => {
  it('a normal day: the hero, the shelves, the shows — in that order, nothing else', () => {
    assert.deepEqual(homeSections({ now: ny('2026-11-24'), libraryEmpty: false, shows: 3 }), ['hero', 'shelves', 'shows'])
  })
  it('no shows: no Shows band', () => {
    assert.deepEqual(homeSections({ now: ny('2026-11-24'), libraryEmpty: false, shows: 0 }), ['hero', 'shelves'])
  })
  it('an empty library: only the welcome', () => {
    assert.deepEqual(homeSections({ now: ny('2026-12-10'), libraryEmpty: true, shows: 5 }), ['welcome'])
  })
  it('December: Year in Review joins, right under the hero', () => {
    assert.deepEqual(homeSections({ now: ny('2026-12-01'), libraryEmpty: false, shows: 2 }), ['hero', 'year-in-review', 'shelves', 'shows'])
    assert.deepEqual(homeSections({ now: ny('2026-12-31'), libraryEmpty: false, shows: 0 }), ['hero', 'year-in-review', 'shelves'])
  })
  it('every other month: no Year in Review on the Home', () => {
    for (let m = 1; m <= 11; m++) {
      const d = ny(`2026-${String(m).padStart(2, '0')}-15`)
      assert.equal(yearInReviewOnHome(d), false, `month ${m}`)
      assert.ok(!homeSections({ now: d, libraryEmpty: false, shows: 1 }).includes('year-in-review'), `month ${m}`)
    }
    assert.equal(yearInReviewOnHome(ny('2026-12-15')), true)
  })
  it('December is New York\'s December, not the machine\'s or UTC\'s', () => {
    // 2026-12-01 03:00 UTC is still Nov 30 in New York.
    assert.equal(nyMonth(new Date('2026-12-01T03:00:00Z')), 11)
    assert.equal(yearInReviewOnHome(new Date('2026-12-01T03:00:00Z')), false)
    // 2027-01-01 03:00 UTC is still Dec 31 in New York.
    assert.equal(yearInReviewOnHome(new Date('2027-01-01T03:00:00Z')), true)
  })
})

describe('the hero', () => {
  const shows = [
    { date: '2026-12-20', venue: 'Webster Hall', artists: ['Geese'] },
    { date: '2026-12-05', venue: 'Brooklyn Paramount', artists: ['Geese', 'Opener'] },
    { date: '2026-11-01', venue: 'Past Room', artists: ['Geese'] },
    { date: '2026-12-01', venue: 'Elsewhere', artists: ['Someone Else'] },
  ]
  it('ties the album to the soonest upcoming show by its artist', () => {
    assert.equal(heroShowLine('Geese', shows, '2026-11-24'), 'Live at Brooklyn Paramount, Dec 5')
  })
  it('a show today still counts; a past one never does', () => {
    assert.equal(heroShowLine('Geese', shows, '2026-12-05'), 'Live at Brooklyn Paramount, Dec 5')
    assert.equal(heroShowLine('Geese', shows, '2026-12-06'), 'Live at Webster Hall, Dec 20')
    assert.equal(heroShowLine('Geese', shows, '2026-12-21'), null)
  })
  it('names compare folded (case, accents), and a headliner counts', () => {
    assert.equal(heroShowLine('GEESE', shows, '2026-11-24'), 'Live at Brooklyn Paramount, Dec 5')
    assert.equal(heroShowLine('Beyoncé', [{ date: '2026-12-02', venue: 'MSG', artists: [], headliners: ['Beyonce'] }], '2026-11-24'), 'Live at MSG, Dec 2')
  })
  it('no show by the artist: no line (nothing invented)', () => {
    assert.equal(heroShowLine('Pavement', shows, '2026-11-24'), null)
    assert.equal(heroShowLine('', shows, '2026-11-24'), null)
  })
  it('the byline: artist · year, or the artist alone', () => {
    assert.equal(heroByline('Geese', '2025'), 'Geese · 2025')
    assert.equal(heroByline('Geese', 2025), 'Geese · 2025')
    assert.equal(heroByline('Geese', ''), 'Geese')
    assert.equal(heroByline('Geese', 0), 'Geese')
    assert.equal(heroByline('Geese', 'unknown'), 'Geese')
  })
  it('a calendar day is never read as UTC (Dec 5 stays Dec 5)', () => {
    assert.equal(shortDay('2026-12-05'), 'Dec 5')
    assert.equal(shortDay('2027-01-01'), 'Jan 1')
  })
})

describe('the Home draws only what homeSections allows', () => {
  const home = src('views', 'HomeView.tsx')
  it('asks homeSections, and gates every band on it', () => {
    assert.match(home, /const sections = homeSections\(\{/)
    for (const s of ['welcome', 'hero', 'year-in-review', 'shelves', 'shows']) {
      assert.match(home, new RegExp(`sections\\.includes\\('${s}'\\)`), s)
    }
  })
  it('the Year in Review card is mounted only behind its December gate', () => {
    assert.match(home, /\{sections\.includes\('year-in-review'\) && <YirHomeCard \/>\}/)
    assert.equal(home.match(/<YirHomeCard/g)?.length, 1)
  })
  it('none of what moved is drawn on the Home', () => {
    for (const gone of ['<MadeForYou', '<TonightOnJakeTunes', 'getRediscovery', 'getListeningMemory', 'getMusicNews',
      'getNotableReleases', 'getUpcomingReleasesPersonal', 'New This Week', 'On the Horizon', 'Music News', 'Today\'s pick', 'Rediscover']) {
      assert.ok(!home.includes(gone), `HomeView still has ${gone}`)
    }
  })
  it('the hero has ▶ Play and Shuffle, and the Music Man line only for the album he wrote it about', () => {
    const hero = src('components', 'HomeHero.tsx')
    assert.match(hero, /TONIGHT ON JAKETUNES/)
    assert.match(hero, /<span>Play<\/span>/)
    assert.match(hero, />Shuffle<\/button>/)
    assert.match(hero, /const mmLine = isLiving \? spot\.doc\?\.musicMan\?\.line \?\? null : null/)
    assert.match(hero, /heroShowLine\(album\.artist, shows, nyDate\(Date\.now\(\)\)\)/)
  })
})

describe('everything that left the Home is reachable', () => {
  const sidebar = src('components', 'sidebar', 'Sidebar.tsx')
  const main = src('components', 'MainContent.tsx')
  const mfy = src('views', 'MadeForYouView.tsx')
  const shop = src('views', 'DiscoveryView.tsx')
  const news = src('views', 'NewsView.tsx')
  it('Made for You has a sidebar row and a page', () => {
    assert.match(sidebar, /\{ label: 'Made for You', view: 'made-for-you' \}/)
    assert.match(main, /case 'made-for-you': viewElement = <MadeForYouView \/>/)
  })
  it('the Record Shop has a News tab that draws the News page', () => {
    assert.match(readFileSync(join(R, 'views', 'discoveryTab.ts'), 'utf8'), /\{ id: 'news', label: SHOP_TAB_LABELS\[4\] \}/)
    assert.match(shop, /SHOP_TABS\.map\(/)
    assert.match(shop, /tab === 'news' \? <NewsView \/>/)
  })
  const drawnOn: Record<string, string> = {
    'island-albums': '<TonightOnJakeTunes',
    'now-digging': '<TonightOnJakeTunes',
    'daily-mixes': '<MadeForYou />',
    'listening-quote': '— the Music Man',
    rediscover: '>Rediscover<',
    'year-in-review': '<YirHomeCard />',
    'new-this-week': '>New This Week<',
    'on-the-horizon': '>On the Horizon<',
    'music-news': '>Music News<',
    'todays-pick': 'todaysPick(albums)',
  }
  it('each moved feature is drawn where MOVED_OFF_HOME says', () => {
    const pages: Record<string, string> = { 'made-for-you': mfy, discovery: news, home: src('components', 'HomeHero.tsx') }
    assert.deepEqual(Object.keys(drawnOn).sort(), Object.keys(MOVED_OFF_HOME).sort(), 'every moved feature is checked')
    for (const [feature, where] of Object.entries(MOVED_OFF_HOME)) {
      const page = pages[where.to]
      assert.ok(page, `${feature}: no page for ${where.to}`)
      assert.ok(page.includes(drawnOn[feature]!), `${feature} is not on ${where.to}`)
    }
  })
  it('the island Cover Flow\'s disc handoff follows it to Made for You', () => {
    const jc = readFileSync(join(import.meta.dirname, '..', '..', 'common', 'jewel-case.ts'), 'utf8')
    assert.match(jc, /export const DISC_HANDOFF_PAGE = 'made-for-you'/)
  })
})
