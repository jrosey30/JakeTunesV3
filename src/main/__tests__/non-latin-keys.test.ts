/**
 * Names in other alphabets keep their own keys (2026-10-11).
 *
 * Every identity/matching key below folded with [^a-z0-9], which deletes every
 * Hebrew, Cyrillic, Greek, Arabic and CJK letter — so all those names became
 * the SAME key ('' or '|'). PR #76 fixed the genre filer; this sweep fixes the
 * rest, all through one helper (fold-text nameKey). Each block pins one site
 * with Hebrew and Cyrillic names, and the persisted keys prove a Latin name
 * still keys exactly as it did (nothing stored is orphaned).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nameKey, hasOtherScript, storedNameKey } from '../../common/fold-text.ts'
import { normName } from '../taste-profile.ts'
import { songKey, summarize, attachTrackIds, mergeHistories, type Listen } from '../../common/listening-history.ts'
import {
  cardKey, normKey, filterFeed, ownedPairKeys, trimGapLane, buildGapCards, deezerVerify, deezerTrack, type FeedCard,
} from '../discover-feed.ts'
import { discoverVerdicts, type LedgerRow } from '../discovery-learned.ts'
import { originCacheKey } from '../genre-filer.ts'
import { scanLibraryConsistency } from '../cynthia-library-scan.ts'
import type { CynthiaScanTrack } from '../cynthia-scan.ts'
import { resolveOrbitSeedIds } from '../ai/orbit-quality.ts'
import { routeArtistKey, queryNamesArtist } from '../ai/rag-route.ts'
import { rankSuggestions } from '../download-search.ts'
import { normalizedArtworkKey, buildNormalizedArtworkIndex, lookupArtwork } from '../../renderer/utils/artworkLookup.ts'
import { normTitle } from '../../renderer/utils/normTitle.ts'
import { norm as dlNorm, normQ } from '../../renderer/views/DownloadStore/downloadKeys.ts'
import { trackQueryId, albumQueryId } from '../../renderer/views/DownloadStore/downloadQueue.ts'
import { normalize as searchNormalize, buildIndex, search } from '../../renderer/utils/searchIndex.ts'
import type { Track } from '../../renderer/types.ts'

const SRC = join(import.meta.dirname, '../..')
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

// Real artists, two scripts.
const BERRY = 'ברי סחרוף'          // Berry Sakharof
const HADAG = 'הדג נחש'            // Hadag Nahash
const MOLCHAT = 'Молчат Дома'      // Molchat Doma
const KINO = 'Кино'

describe('nameKey — the one fold', () => {
  it('gives every Hebrew and Cyrillic name its own key, never the empty one', () => {
    const keys = [BERRY, HADAG, MOLCHAT, KINO].map((n) => nameKey(n))
    assert.deepEqual(keys, ['ברי סחרוף', 'הדג נחש', 'молчат дома', 'кино'])
    assert.equal(new Set(keys).size, 4)
  })
  it('still folds accents and punctuation the way the Latin keys always did', () => {
    assert.equal(nameKey('Björk'), 'bjork')
    assert.equal(nameKey('JAŸ-Z'), 'jay z')
    assert.equal(nameKey('MØ'), 'mo')
    assert.equal(nameKey('Sigur Rós', ''), 'sigurros')
    assert.equal(nameKey('!!!'), '')
  })
  it('is what the genre filer (normName) uses — no second variant', () => {
    for (const n of [BERRY, MOLCHAT, 'Björk', 'MØ']) assert.equal(normName(n), nameKey(n))
  })
  it('knows which names the ASCII fold erased', () => {
    for (const n of [BERRY, MOLCHAT, 'Σωκράτης', 'くるり']) assert.equal(hasOtherScript(n), true, n)
    for (const n of ['Sigur Rós', 'µ-Ziq', 'JAŸ-Z', '!!!', '']) assert.equal(hasOtherScript(n), false, n)
  })
  it('storedNameKey keeps a Latin key byte for byte and gives other scripts a real one', () => {
    const legacy = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
    assert.equal(storedNameKey('Björk', legacy), 'bjo rk', 'the legacy key, warts and all')
    assert.equal(storedNameKey(BERRY, legacy), 'ברי סחרוף')
    assert.equal(storedNameKey(MOLCHAT, legacy), 'молчат дома')
  })
})

describe('listening history (songKey) — Year in Review counts', () => {
  const L = (artist: string, title: string, sec = 0, extra: Partial<Listen> = {}): Listen =>
    ({ ts: new Date(Date.UTC(2026, 5, 1, 12, 0, sec)).toISOString(), device: 'laptop', kind: 'play', pct: 100, artist, title, album: '', genre: '', ...extra })

  it('two Hebrew songs are two songs', () => {
    assert.notEqual(songKey(BERRY, 'שיר'), songKey(HADAG, 'למה הים כחול?'))
    assert.notEqual(songKey(MOLCHAT, 'Судно'), songKey(KINO, 'Группа крови'))
    assert.notEqual(songKey(BERRY, 'שיר'), '|')
    assert.equal(songKey('Beyoncé', 'Halo!'), songKey('beyonce', 'halo'))
  })
  it('summarize counts each song and each artist on its own', () => {
    const s = summarize([L(BERRY, 'שיר', 1), L(BERRY, 'שיר', 2), L(HADAG, 'למה הים כחול?', 3), L(MOLCHAT, 'Судно', 4), L(KINO, 'Группа крови', 5)], 2026, () => undefined)
    assert.equal(s.topSongs.length, 4)
    assert.deepEqual(s.topSongs[0], { artist: BERRY, title: 'שיר', plays: 2 })
    assert.deepEqual(s.topArtists.map((a) => a.artist).sort(), [BERRY, HADAG, MOLCHAT, KINO].sort(), 'non-Latin artists are no longer dropped')
  })
  it('a listen attaches to its own track, not the only Hebrew track with plays', () => {
    const lib = [
      { id: 1, artist: BERRY, title: 'שיר', playCount: 9 },
      { id: 2, artist: HADAG, title: 'למה הים כחול?', playCount: 0 },
      { id: 3, artist: KINO, title: 'Группа крови', playCount: 0 },
    ]
    const [h, c] = attachTrackIds([L(HADAG, 'למה הים כחול?'), L(KINO, 'Группа крови')], lib)
    assert.equal(h.trackId, 2)
    assert.equal(c.trackId, 3)
  })
  it('two different songs at the same instant are both kept', () => {
    assert.equal(mergeHistories([[L(BERRY, 'שיר', 7)], [L(HADAG, 'למה הים כחול?', 7)]]).length, 2)
  })
})

describe('discover feed — ledger keys and lanes', () => {
  const C = (artist: string, title: string, type: FeedCard['type'] = 'album'): FeedCard => ({ lane: 'time-machine', type, artist, title, why: 'x' })
  const opts = { ownedArtists: new Set<string>(), ownedAlbumKeys: new Set<string>(), notForMe: {}, served: {}, now: 1e12 }

  it('cardKey: Hebrew and Cyrillic cards are different cards; Latin ledger keys are unchanged', () => {
    assert.equal(cardKey(C(BERRY, 'שיר')), 'ברי סחרוף|שיר')
    assert.notEqual(cardKey(C(BERRY, 'שיר')), cardKey(C(HADAG, 'למה הים כחול?')))
    assert.equal(cardKey(C(MOLCHAT, 'Этажи')), 'молчат дома|этажи')
    // Persisted served/notForMe keys: a Latin name must key exactly as before.
    assert.equal(cardKey(C('Björk', 'Homogenic')), 'bjo rk|homogenic')
    assert.equal(normKey('Sigur Rós'), 'sigur ro s')
  })
  it('filterFeed shows more than one non-Latin card, and resting one rests only it', () => {
    const cards = [C(BERRY, 'שיר'), C(HADAG, 'למה הים כחול?'), C(MOLCHAT, 'Этажи'), C(KINO, 'Группа крови')]
    assert.equal(filterFeed(cards, opts).length, 4)
    const served = { [cardKey(cards[0])]: { views: 9, last: 1e12 } }
    assert.deepEqual(filterFeed(cards, { ...opts, served }).map((c) => c.artist), [HADAG, MOLCHAT, KINO])
  })
  it('owning one Hebrew album does not mark another as owned; owning it does', () => {
    const owned = new Set(ownedPairKeys([{ artist: BERRY, album: 'נעלם ונשכח', title: 'שיר' }, { artist: KINO, album: 'Группа крови', title: 'Кукушка' }]))
    assert.ok(owned.has('ברי סחרוף|נעלם ונשכח'))
    assert.ok(owned.has('кино|группа крови'))
    const kept = filterFeed([C(BERRY, 'נעלם ונשכח'), C(HADAG, 'למה הים כחול?'), C(KINO, 'Группа крови'), C(MOLCHAT, 'Этажи')], { ...opts, ownedAlbumKeys: owned })
    assert.deepEqual(kept.map((c) => c.artist), [HADAG, MOLCHAT])
  })
  it('the gap lane keeps one record per artist — per artist, not per alphabet', () => {
    assert.equal(trimGapLane([C(BERRY, 'א'), C(HADAG, 'ב'), C(MOLCHAT, 'Этажи'), C(KINO, 'Звезда')]).length, 4)
    const gap = buildGapCards([
      { artist: HADAG, tracks: 3, albums: [{ title: 'לאן נעלם', year: 2004 }] },
      { artist: MOLCHAT, tracks: 5, albums: [{ title: 'Этажи', year: 2018 }, { title: 'Монумент', year: 2020 }] },
    ], new Set(ownedPairKeys([{ artist: MOLCHAT, album: 'Этажи' }])))
    assert.deepEqual(gap.map((c) => c.title), ['לאן נעלם', 'Монумент'])
  })

  const fakeFetch = (rows: unknown[]) => (async () => ({ ok: true, json: async () => ({ data: rows }) })) as unknown as typeof fetch
  it('deezerVerify no longer waves a Hebrew pick through against any row', async () => {
    const wrong = [{ artist: { name: 'Someone Else' }, title: 'Other Record', record_type: 'album', cover_big: 'x' }]
    assert.equal(await deezerVerify(HADAG, 'למה הים כחול?', fakeFetch(wrong)), null)
    const right = [...wrong, { artist: { name: HADAG }, title: 'למה הים כחול?', record_type: 'album', cover_big: 'y' }]
    assert.equal((await deezerVerify(HADAG, 'למה הים כחול?', fakeFetch(right)))?.artUrl, 'y')
    assert.equal(await deezerVerify(MOLCHAT, 'Этажи', fakeFetch(wrong)), null)
  })
  it('deezerTrack matches the Cyrillic artist and title, not the first row', async () => {
    const rows = [{ artist: { name: 'Kino Tribute' }, title: 'Song', preview: 'p0' }, { artist: { name: KINO }, title: 'Группа крови', preview: 'p1' }]
    assert.equal((await deezerTrack(KINO, 'Группа крови', fakeFetch(rows)))?.previewUrl, 'p1')
    assert.equal(await deezerTrack(BERRY, 'שיר', fakeFetch(rows)), null)
  })
})

describe('discovery verdicts — one per card', () => {
  it('keeps an accept and a reject on two different Hebrew cards', () => {
    const rows: LedgerRow[] = [
      { surface: 'discover', verdict: 'accept', key: { artist: BERRY, title: 'שיר' } },
      { surface: 'discover', verdict: 'reject', key: { artist: HADAG, title: 'למה הים כחול?' } },
      { surface: 'discover', verdict: 'reject', key: { artist: KINO, title: 'Группа крови' } },
    ]
    const v = discoverVerdicts(rows)
    assert.deepEqual(v.accepts.map((x) => x.artist), [BERRY])
    assert.deepEqual(v.rejects.map((x) => x.artist), [HADAG, KINO])
  })
})

describe('origin cache key (origin-lookups.json)', () => {
  it('keys mixed-script names apart, and a name that folds to nothing as itself', () => {
    assert.notEqual(originCacheKey(`${BERRY} & Rockfour`), originCacheKey(`${MOLCHAT} & Rockfour`))
    assert.equal(originCacheKey(KINO), 'кино')
    assert.equal(originCacheKey('!!!'), '!!!')
    assert.match(read('main/ipc/genre-filer-ipc.ts'), /const k = originCacheKey\(artist\)/)
  })
})

describe('Cynthia clusters', () => {
  let id = 1
  const mk = (artist: string): CynthiaScanTrack => ({
    id: id++, title: 'Song', artist, album: 'Album', albumArtist: '', trackNumber: 1, trackCount: 10,
    discNumber: 1, discCount: 1, year: 2000, genre: '', duration: 200000,
  } as CynthiaScanTrack)
  it('never proposes renaming one Hebrew artist to another', () => {
    const f = scanLibraryConsistency([mk(`${BERRY} feat. Rockfour`), mk(`${BERRY} feat. Rockfour`), mk('אביב גפן feat. Rockfour')])
    assert.deepEqual(f.filter((x) => x.field === 'artist'), [])
  })
  it('does see a Cyrillic case variant, as it would a Latin one', () => {
    const f = scanLibraryConsistency([mk(MOLCHAT), mk(MOLCHAT), mk(MOLCHAT), mk('МОЛЧАТ ДОМА')]).filter((x) => x.field === 'artist')
    assert.equal(f.length, 1)
    assert.equal(f[0].newValue, MOLCHAT)
    assert.equal(f[0].provable, false, 'a case change stays a judgment call')
  })
})

describe('orbit seeds', () => {
  const lib = [
    { id: 1, title: 'Ginga', artist: 'Robson Jorge & Lincoln Olivetti' },
    { id: 2, title: 'שיר', artist: BERRY },
    { id: 3, title: 'Группа крови', artist: KINO },
  ]
  it('a Latin title seed no longer pulls in every Hebrew and Cyrillic song', () => {
    assert.deepEqual(resolveOrbitSeedIds({ kind: 'title', query: 'Ginga' }, lib), [1])
  })
  it('Hebrew and Cyrillic seeds find their own songs', () => {
    assert.deepEqual(resolveOrbitSeedIds({ kind: 'title', query: 'Группа крови' }, lib), [3])
    assert.deepEqual(resolveOrbitSeedIds({ kind: 'artist', query: BERRY }, lib), [2])
  })
})

describe('RAG routing', () => {
  it('a question naming a Hebrew or Cyrillic library artist routes to the main index', () => {
    const set = new Set([BERRY, MOLCHAT, 'Radiohead'].map(routeArtistKey).filter((k): k is string => !!k))
    assert.ok(queryNamesArtist(`play something like ${BERRY}`, set))
    assert.ok(queryNamesArtist('songs like Молчат Дома please', set))
    assert.ok(!queryNamesArtist('sad songs for a rainy day', set))
    assert.equal(routeArtistKey('House'), null, 'genre words still never route')
  })
})

describe('Download — ranking, ownership, queue ids', () => {
  it('the Hebrew song you typed ranks first', () => {
    const ranked = rankSuggestions([
      { song: 'שיר אחר לגמרי', artist: HADAG, album: 'א' },
      { song: 'למה הים כחול', artist: HADAG, album: 'ב' },
    ], `${HADAG} למה הים כחול`)
    assert.equal(ranked[0].song, 'למה הים כחול')
  })
  it('two Hebrew songs are two library keys and two queue ids', () => {
    assert.notEqual(dlNorm('שיר') + '|' + dlNorm(BERRY), dlNorm('למה הים כחול?') + '|' + dlNorm(HADAG))
    assert.notEqual(trackQueryId(BERRY, 'שיר'), trackQueryId(HADAG, 'למה הים כחול?'))
    assert.notEqual(albumQueryId(MOLCHAT, 'Этажи'), albumQueryId(KINO, 'Группа крови'))
    assert.equal(trackQueryId('JAŸ-Z', '99 Problems'), trackQueryId('jay z', '99 problems'))
  })
  it('normQ keeps the words, in any script', () => {
    assert.equal(normQ(`${MOLCHAT} — Судно (Борис Рыжий)`), 'молчат дома судно борис рыжии')
  })
})

describe('universal search (searchIndex.normalize — normQ twin)', () => {
  const tracks = [
    { id: 1, title: 'שיר', artist: BERRY, album: 'נעלם ונשכח' },
    { id: 2, title: 'Группа крови', artist: KINO, album: 'Группа крови' },
    { id: 3, title: 'Halo', artist: 'Beyoncé', album: 'I Am... Sasha Fierce' },
  ] as unknown as Track[]
  it('normalizes Hebrew and Cyrillic instead of erasing them', () => {
    assert.equal(searchNormalize(BERRY), 'ברי סחרוף')
    assert.equal(searchNormalize("Don't Stop"), 'dont stop')
  })
  it('finds a Hebrew artist and a Cyrillic song', () => {
    const idx = buildIndex(tracks, [])
    assert.deepEqual(search(idx, 'סחרוף').tracks.map((r) => (r.row as { id: number }).id), [1])
    assert.deepEqual(search(idx, 'группа').tracks.map((r) => (r.row as { id: number }).id), [2])
    assert.deepEqual(search(idx, 'beyonce').tracks.map((r) => (r.row as { id: number }).id), [3])
  })
})

describe('artwork lookup (renderer + main twins)', () => {
  it('two Hebrew albums have two artwork keys', () => {
    assert.notEqual(normalizedArtworkKey(BERRY, 'נעלם ונשכח'), normalizedArtworkKey(HADAG, 'לאן נעלם'))
    assert.notEqual(normalizedArtworkKey(MOLCHAT, 'Этажи'), normalizedArtworkKey(KINO, 'Звезда по имени Солнце'))
    assert.equal(normalizedArtworkKey('Beyoncé', 'Lemonade (Deluxe)'), normalizedArtworkKey('beyonce', 'lemonade'))
  })
  it("one Hebrew album's cover is never served for another", () => {
    const map = { [`${BERRY}|||נעלם ונשכח`.toLowerCase()]: 'hashA' }
    const idx = buildNormalizedArtworkIndex(map)
    assert.equal(lookupArtwork(map, idx, BERRY, 'נעלם ונשכח (Remastered)'), 'hashA')
    assert.equal(lookupArtwork(map, idx, HADAG, 'לאן נעלם'), undefined)
  })
  it('the main-process twin folds exactly like the renderer', () => {
    const body = (src: string, name: string): string => {
      const at = src.indexOf(`function ${name}(`)
      return src.slice(src.indexOf('return nameKey(', at), src.indexOf('\n}', at)).replace(/\s+\/\/[^\n]*/g, '')   // code only
    }
    assert.equal(body(read('main/artwork-engine.ts'), 'normalizeArtworkPartServer'), body(read('renderer/utils/artworkLookup.ts'), 'normalizeArtworkPart'))
  })
})

describe("Artist page owned titles (normTitle)", () => {
  it('two Hebrew titles are two titles; the old expansions still hold', () => {
    assert.notEqual(normTitle('שיר'), normTitle('למה הים כחול?'))
    assert.notEqual(normTitle('Группа крови'), normTitle('Кукушка'))
    assert.equal(normTitle('Группа крови (Remastered)'), normTitle('ГРУППА КРОВИ'))
    assert.equal(normTitle('Dr. Robert'), normTitle('Doctor Robert'))
  })
})

describe('index.ts keys (main process — checked at the source)', () => {
  const index = read('main/index.ts')
  it("normArtistKey is discover-feed's normKey: same legacy fold, other scripts through nameKey", () => {
    const legacyOf = (src: string, from: string): string => src.slice(src.indexOf(from)).match(/toLowerCase\(\)\.normalize\('NFKD'\)\.replace\(\/\[\^a-z0-9\]\+\/g, ' '\)\.trim\(\)/)![0]
    assert.equal(legacyOf(index, 'function normArtistKey('), legacyOf(read('main/discover-feed.ts'), 'const legacyNormKey'))
    assert.match(index, /function normArtistKey\(sname: string\): string \{\n\s+return storedNameKey\(sname,/)
    assert.match(index, /const nk = \(x: string\): string => normArtistKey\(x\)/)
    for (const n of [BERRY, MOLCHAT]) assert.equal(normKey(n), nameKey(n))
  })
  it('the discography cache gives each Hebrew artist its own file', () => {
    assert.match(index, /const safe = Array\.from\(nameKey\(artist, '_'\)\)\.slice\(0, 80\)\.join\(''\) \|\|/)
    assert.equal(nameKey(BERRY, '_'), 'ברי_סחרוף')
    assert.notEqual(nameKey(BERRY, '_'), nameKey(HADAG, '_'))
  })
})
