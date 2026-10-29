/**
 * The Year in Review story's test fixture (yir-story.test.ts), kept apart so the phone's twin
 * test (JakeTunesMobile YirStoryTests.swift) can be regenerated from the same facts.
 */
import { buildYearInReview, type Top1000Review } from '../../common/year-in-review.ts'
import type { Listen } from '../../common/listening-history.ts'

export const L = (ts: string, artist: string, title: string, extra: Partial<Listen> = {}): Listen =>
  ({ ts, device: 'laptop', kind: 'play', pct: 100, artist, title, album: `${title} LP`, genre: 'Rock', ...extra })

export const listens: Listen[] = [
  ...['06-01', '06-02', '06-03', '07-20', '07-21', '07-22', '07-23'].map((d) => L(`2026-${d}T16:00:00Z`, 'TV Girl', 'Pantyhose', { genre: 'Indie Pop' })),
  ...['06-04', '06-05', '06-06'].map((d) => L(`2026-${d}T16:00:00Z`, 'Geese', 'Taxes', { genre: 'Garage Punk', device: 'workmini' })),
  L('2026-06-07T16:00:00Z', 'Drake', 'Hotline Bling', { genre: 'Hip-Hop', device: 'ipod' }),
]
/** The Top 1000 chapter as homemini serves it (JakeTunesMobile util/top1000Review.ts). */
export const T1K: Top1000Review = {
  builtAt: '2026-10-29T12:00:00.000Z',
  sure: 0.918,
  proof: {
    pool: 11760, answers: 10611, decisions: 10249, songsJudged: 6122, heats: 1772, duels: 6987,
    calls: { n: 9517, called: 5832 }, headToHead: { n: 6214, called: 3941 }, sureCalls: { n: 1526, called: 1335 },
    heatCalls: { n: 1772, called: 703, chance: 0.196 }, tasteAlone: { n: 6214, called: 3468 }, overruled: 3685,
    rechecks: { n: 490, same: 368 }, firstAnswer: '2026-10-23T16:44:48.283Z', lastAnswer: '2026-10-29T00:58:11.914Z',
  },
  variety: {
    seats: 1000, artists: 462,
    topArtists: [{ name: 'The Beatles', seats: 56 }, { name: 'Red Hot Chili Peppers', seats: 35 }, { name: 'TV Girl', seats: 16 }],
    brackets: 72, bracketsTotal: 77, genres: 100,
    decades: [{ decade: '1960s', seats: 86 }, { decade: '2020s', seats: 127 }],
    oldest: { title: "Surfin' Safari", artist: 'The Beach Boys', year: 1962 },
    newest: { title: 'Fabienk', artist: 'Angine de Poitrine', year: 2026 },
    numberOne: { title: "Take What's Given", artist: 'BADBADNOTGOOD' },
    wall: [{ title: "Take What's Given", artist: 'BADBADNOTGOOD' }, { title: 'Au Pays du Cocaine', artist: 'Geese' }, { title: 'Jane', artist: 'Jefferson Starship' }],
    // Ten seats: Beatles, Beatles, RHCP, TV Girl, anyone, Beatles, TV Girl, RHCP, anyone, Beatles.
    seatArtists: [0, 0, 1, 2, -1, 0, 2, 1, -1, 0],
    bracketChampions: [
      { bracket: 'Classic Rock', seats: 143, title: 'Jane', artist: 'Jefferson Starship', rank: 17 },
      { bracket: 'Rock', seats: 70, title: 'Au Pays du Cocaine', artist: 'Geese', rank: 3 },
    ],
  },
}
/** Shows he went to (Mobile #648's attended list): one last year (left out), two this year. */
export const attended = [
  { artist: 'Geese', venue: 'Forest Hills Stadium', borough: 'Queens', date: '2026-10-03', setlist: { songs: [{ name: 'Taxes' }, { name: 'Cobra' }, { name: 'Au Pays du Cocaine' }, { name: 'Trinidad' }] } },
  { artist: 'TV Girl', venue: 'Brooklyn Paramount', date: '2026-06-12', setlist: null },
  { artist: 'Old Band', venue: 'Somewhere', date: '2025-12-30' },
]
export const y = { ...buildYearInReview({ year: 2026, listens, library: [], attended }), top1000: T1K }
export const concerts = [
  { albumKey: 'geese|||forest hills', band: 'Geese', show: 'Forest Hills', venue: 'Forest Hills Stadium', date: 'October 3, 2026', notes: 'I was there.' },
  { albumKey: 'grateful dead|||nassau', band: 'Grateful Dead', show: 'Nassau', venue: 'Nassau Coliseum', date: 'May 15-16, 1980' },
]
