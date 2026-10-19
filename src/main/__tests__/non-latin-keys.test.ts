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
import { recordIdentityKeys, recoDedupeKey, recoIdNorm, recoNorm, isTombstonedRecord, RECO_IDENTITY_PREFIX } from '../reco-match.ts'
import { maskedTitleMatches } from '../streamrip-match.ts'
import { buildRequestedRecording, verifyCandidate, textNamesArtist } from '../exact-recording.ts'
import { getTasteAnchors, computeTasteFingerprint, scoreCandidate } from '../taste-model.ts'
import { rankCandidates } from '../radar-core.ts'
import { buildRequestedAlbum } from '../album-identity.ts'
import { judgeAlbumTracks, bandcampAlbumHit } from '../near-edition.ts'
import { planMatchingTrackGets } from '../../common/near-edition-actions.ts'
import type { CompareEditionsResult, TrackRow } from '../../common/near-edition-types.ts'
import { explicitMapKey, resolveExplicitEdition, pickItunesAlbumRow } from '../download-search.ts'
import { normForOwnership } from '../owned-album-key.ts'
import { recoTitleMatches, recoArtistMatches, recoFold, shouldRejectRecoArtistCorrection, evaluateMusicManVerification } from '../reco-match.ts'
import { rankStreamripCandidates, pickBestSoundcloudMatch, rankSoundcloudCandidates } from '../streamrip-match.ts'
import { verifyAlbumCandidate, matchLibraryOwnership } from '../album-identity.ts'
import { acceptableHit } from '../discover-feed.ts'
import { pickItunesCollection } from '../download-search.ts'
import { dedupeSuggestions } from '../../renderer/listen-to-the-list/store.ts'
import { foldAccents } from '../../common/fold-text.ts'
import type { Recommendation } from '../../renderer/types.ts'

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
    // 10/18: the cache moved from the IPC wiring into fillOrigins (planOrigins) — same key.
    assert.match(read('main/genre-filer.ts'), /const key = originCacheKey\(name\)/)
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

// ── Second sweep (2026-10-11) ─────────────────────────────────────────────

describe('recommendation identity (reco-match — PERSISTED: tombstones, dedupe)', () => {
  const heb = { song: 'למה הים כחול?', artist: HADAG }
  const heb2 = { song: 'שיר', artist: BERRY }
  const cyr = { song: 'Группа крови', artist: KINO }
  it('an all-Hebrew or all-Cyrillic jot has identity keys, and they are its own', () => {
    for (const r of [heb, heb2, cyr]) assert.equal(recordIdentityKeys(r).length, 1, r.song)
    assert.notEqual(recoDedupeKey(heb), recoDedupeKey(heb2))
    assert.notEqual(recoDedupeKey(cyr), recoDedupeKey({ song: 'Судно', artist: MOLCHAT }))
  })
  it('deleting one Hebrew song by a Latin-named artist does not hide the others', () => {
    // Was ['artist:rockfour'] for both — a delete tombstoned every songless
    // Rockfour row and every other Hebrew-titled Rockfour song.
    const a = { song: 'שיר', artist: 'Rockfour' }, b = { song: 'למה', artist: 'Rockfour' }
    const tombs = new Set(recordIdentityKeys(a).map((k) => RECO_IDENTITY_PREFIX + k))
    assert.ok(isTombstonedRecord(tombs, a))
    assert.ok(!isTombstonedRecord(tombs, b))
    assert.ok(!isTombstonedRecord(tombs, { artist: 'Rockfour' }))
  })
  it('a deleted Hebrew jot stays deleted when it comes back under a fresh id', () => {
    const tombs = new Set(['id-1', ...recordIdentityKeys(heb).map((k) => RECO_IDENTITY_PREFIX + k)])
    assert.ok(isTombstonedRecord(tombs, { ...heb, id: 'id-2' }))
    assert.ok(!isTombstonedRecord(tombs, { ...heb2, id: 'id-3' }))
  })
  it('every Latin name keeps its stored key byte for byte', () => {
    for (const n of ['Sigur Rós', 'Björk', "Can't Stop Playing", 'JAŸ-Z', 'µ-Ziq', '!!!', 'Motörhead']) assert.equal(recoIdNorm(n), recoNorm(n), n)
  })
  it("recommendations-ipc's add-path fallback key is this one, and it keeps no copy of the pair key", () => {
    const src = read('main/ipc/recommendations-ipc.ts')
    assert.match(src, /function recoMatchKey\([^)]*\): string \{\n\s+const norm = recoIdNorm\b/)
    // Its only pair-key wrapper, recoIdentityKey, fed the radar's on-list
    // guard; that guard now keys in radar-core (listenListPredicate, PR #81).
    assert.doesNotMatch(src, /function recoIdentityKey\(|function recoRecordIdentityKey\(/)
  })
})

describe('Music Man suggest filter (recommendations-ipc)', () => {
  it('folds in any script, so one owned Hebrew artist no longer marks every Hebrew pick owned', () => {
    const src = read('main/ipc/recommendations-ipc.ts')
    const at = src.indexOf('const ownedArtists = new Set<string>() // normalized')
    assert.match(src.slice(at - 400, at), /const norm = \(s: string\) => nameKey\(s, ''\)/)
    assert.notEqual(nameKey(BERRY, ''), nameKey(HADAG, ''))
    assert.notEqual(`${nameKey(KINO, '')}|${nameKey('Кукушка', '')}`, `${nameKey(MOLCHAT, '')}|${nameKey('Судно', '')}`)
  })
})

describe('Get: the recording guard (maskedTitleMatches, verifyCandidate)', () => {
  it('a Hebrew title no longer reads as every other Hebrew title', () => {
    assert.equal(maskedTitleMatches('שיר', 'למה הים כחול'), false)
    assert.equal(maskedTitleMatches('Группа крови', 'Звезда по имени Солнце'), false)
    assert.equal(maskedTitleMatches('שיר', 'שיר (Live)'), true, 'its own title still reads, decoration and all')
    assert.equal(maskedTitleMatches('N****s in Paris', 'Niggas in Paris'), true, 'masked profanity unchanged')
  })
  it('the wrong Hebrew song by the right artist is refused on its title', () => {
    const req = buildRequestedRecording({ artist: 'Rockfour', title: 'שיר', durationTolSec: 3 })
    const v = verifyCandidate(req, { provider: 'qobuz', title: 'למה הים כחול', artist: 'Rockfour' })
    assert.equal(v.verdict, 'reject')
    assert.equal(v.verdict === 'reject' && v.kind, 'title')
    assert.notEqual(verifyCandidate(req, { provider: 'qobuz', title: 'שיר', artist: 'Rockfour' }).verdict, 'reject')
  })
  it('a SoundCloud upload must actually name the Hebrew or Cyrillic artist', () => {
    const req = buildRequestedRecording({ artist: BERRY, title: 'שיר', durationTolSec: 3 })
    const stranger = verifyCandidate(req, { provider: 'soundcloud', title: 'שיר', artist: 'Some Label' })
    assert.equal(stranger.verdict === 'reject' && stranger.kind, 'artist')
    assert.notEqual(verifyCandidate(req, { provider: 'soundcloud', title: `${BERRY} - שיר`, artist: 'Some Label' }).verdict, 'reject')
    assert.equal(textNamesArtist('Группа крови', KINO), false)
    assert.equal(textNamesArtist('КИНО — Группа крови', KINO), true)
  })
  it('Latin artists now fold accents too; a name with no letters is looked for as written, not matched by everything', () => {
    assert.equal(textNamesArtist('Sigur Ros - Hoppipolla', 'Sigur Rós'), true)
    assert.equal(textNamesArtist('!!! - Heart of Hearts', '!!!'), true)
    assert.equal(textNamesArtist('Heart of Hearts', '!!!'), false)
  })
})

describe('taste model + radar (norm is comparison-only)', () => {
  const tracks = [
    ...Array.from({ length: 6 }, () => ({ artist: BERRY, genre: 'Rock', playCount: 9 })),
    ...Array.from({ length: 4 }, () => ({ artist: KINO, genre: 'Post-Punk', playCount: 5 })),
    ...Array.from({ length: 3 }, () => ({ artist: MOLCHAT, genre: 'Post-Punk', playCount: 2 })),
  ]
  it('each Hebrew and Cyrillic artist is its own taste anchor, with its own plays', () => {
    const anchors = getTasteAnchors(tracks, 10)
    assert.deepEqual(anchors.map((a) => a.artist), [BERRY, KINO, MOLCHAT])
    assert.deepEqual(anchors.map((a) => a.plays), [54, 20, 6])
  })
  it('owning Кино does not mark a Hadag Nahash pick as owned', () => {
    const fp = computeTasteFingerprint([{ artist: KINO, genre: 'Post-Punk', playCount: 3 }])
    assert.equal(scoreCandidate(fp, { artist: HADAG, genre: 'Hip-Hop' }).owned, false)
    assert.equal(scoreCandidate(fp, { artist: 'КИНО', genre: 'Post-Punk' }).owned, true)
  })
  it('the radar keeps every distinct Hebrew and Cyrillic pick', () => {
    const fp = computeTasteFingerprint([{ artist: 'Radiohead', genre: 'Rock', playCount: 3 }])
    const ranked = rankCandidates(fp, [
      { artist: BERRY, title: 'שיר' }, { artist: HADAG, title: 'למה הים כחול' },
      { artist: KINO, title: 'Группа крови' }, { artist: MOLCHAT, title: 'Судно' }, { artist: KINO, title: 'группа крови!' },
    ], 12)
    assert.equal(ranked.length, 4)
  })
})

describe('compare editions (near-edition)', () => {
  const req = buildRequestedAlbum({ artist: 'Rockfour', title: 'Supermarket', trackCount: 1, tracks: [{ title: 'שיר', trackNumber: 1, durationSec: 200 }] })
  const found = [{ title: 'שיר', trackNumber: 1, durationSec: 300 }]
  it('a different Hebrew song you own at the found runtime is not "you own the other version"', () => {
    const [row] = judgeAlbumTracks(req, found, undefined, [{ title: 'למה', artist: 'Rockfour', durationSec: 300 }, { title: 'שיר', artist: HADAG, durationSec: 300 }])
    assert.equal(row.verdict, 'mismatch')
    assert.equal(row.ownedVariantSec, null)
    const [own] = judgeAlbumTracks(req, found, undefined, [{ title: 'שיר', artist: 'Rockfour', durationSec: 300 }])
    assert.equal(own.ownedVariantSec, 300)
  })
  it('Bandcamp: the album that matches, not the first Hebrew or Cyrillic album of any band', () => {
    const rows = [
      { type: 'a', name: 'לאן נעלם', band_name: HADAG, item_url_path: '/hadag' },
      { type: 'a', name: 'Этажи', band_name: MOLCHAT, item_url_path: '/molchat' },
      { type: 'a', name: 'נעלם ונשכח', band_name: BERRY, item_url_path: '/berry' },
    ]
    assert.equal(bandcampAlbumHit(rows, BERRY, 'נעלם ונשכח')?.item_url_path, '/berry')
    assert.equal(bandcampAlbumHit(rows, KINO, 'Группа крови'), undefined)
    assert.equal(bandcampAlbumHit([{ type: 'a', name: 'Homogenic', band_name: 'Björk', item_url_path: '/b' }], 'Bjork', 'Homogenic')?.item_url_path, '/b')
  })
  it('matching-track Gets: each Hebrew track is its own job, under the same id Download gives it', () => {
    const row = (n: number, title: string): TrackRow => ({ n, wantTitle: title, gotTitle: title, wantSec: 200, gotSec: 200, deltaSec: 0, verdict: 'exact', reason: null, owned: false })
    const cmp = { ok: true, picked: { label: 'x', trackCount: 3 }, found: { provider: 'bandcamp', label: 'y', source: 'z', trackCount: 3 }, rows: [row(1, 'שיר'), row(2, 'למה הים כחול?'), row(3, 'Группа крови')], summary: {}, toleranceSec: 20 } as unknown as CompareEditionsResult
    const plan = planMatchingTrackGets(cmp, { parentKey: 'p', artist: HADAG, album: 'א' })
    assert.equal(new Set(plan.jobs.map((j) => j.id)).size, 3)
    for (const j of plan.jobs) assert.equal(j.id, trackQueryId(HADAG, j.title))
    assert.equal(planMatchingTrackGets({ ...cmp, rows: [row(1, 'Halo')] }, { parentKey: 'p', artist: 'Beyoncé', album: 'x' }).jobs[0].id, trackQueryId('Beyoncé', 'Halo'))
  })
})

describe('Download: album rows (explicitMapKey, pickItunesAlbumRow)', () => {
  it('two Hebrew deluxe albums are two explicit editions', () => {
    assert.notEqual(explicitMapKey('שיר (Deluxe)'), explicitMapKey('למה (Deluxe)'))
    const map = new Map([[explicitMapKey('נעלם ונשכח (Deluxe)'), { id: 1, trackCount: 12 }]])
    assert.equal(resolveExplicitEdition('לאן נעלם (Deluxe)', 12, map), undefined)
    assert.deepEqual(resolveExplicitEdition('נעלם ונשכח (Deluxe Version)', 12, map), { id: 1, trackCount: 12 })
    assert.equal(explicitMapKey('Watch the Throne (Deluxe Version)'), 'watchthethronedeluxe', 'Latin keys unchanged')
  })
  it('album info reads the row that IS the album, not the first Hebrew one', () => {
    const rows = [{ collectionName: 'לאן נעלם' }, { collectionName: 'נעלם ונשכח' }]
    assert.equal(pickItunesAlbumRow(rows, 'נעלם ונשכח')?.collectionName, 'נעלם ונשכח')
    assert.equal(pickItunesAlbumRow([{ collectionName: 'Этажи' }, { collectionName: 'Монумент' }], 'Монумент')?.collectionName, 'Монумент')
    assert.equal(pickItunesAlbumRow(rows, 'Something Else')?.collectionName, 'לאן נעלם', "Apple's first row is still the fallback")
  })
})

describe("Music Man album picks: the owned filter (normForOwnership)", () => {
  it('owning one Hebrew album no longer hides every Hebrew pick', () => {
    const owned = `${normForOwnership(BERRY)}|${normForOwnership('נעלם ונשכח')}`
    assert.notEqual(owned, `${normForOwnership(HADAG)}|${normForOwnership('לאן נעלם')}`)
    assert.notEqual(`${normForOwnership(KINO)}|${normForOwnership('Группа крови')}`, `${normForOwnership(MOLCHAT)}|${normForOwnership('Этажи')}`)
    assert.equal(normForOwnership('Группа крови (Remastered)'), normForOwnership('ГРУППА КРОВИ'))
  })
  it('keeps every Latin rule it had', () => {
    assert.equal(normForOwnership('The Beatles'), normForOwnership('Beatles'))
    assert.equal(normForOwnership('Simon & Garfunkel'), normForOwnership('Simon and Garfunkel'))
    assert.equal(normForOwnership('Kill Bill: Vol. 1 [Original Soundtrack]'), 'kill bill volume 1')
    assert.equal(normForOwnership('Beyoncé'), 'beyonce')
    assert.equal(normForOwnership('No. 5'), 'number 5')
  })
  it('index.ts uses it', () => {
    assert.match(read('main/index.ts'), /import \{ normForOwnership \} from '\.\/owned-album-key\.ts'/)
  })
})

// ── The matchers (2026-10-11): recoFold kept only [a-z0-9] ──────────────

describe('recoTitleMatches / recoArtistMatches — every script', () => {
  it('a Hebrew or Cyrillic name matches itself and only itself', () => {
    assert.equal(recoArtistMatches(BERRY, BERRY), true)
    assert.equal(recoArtistMatches(BERRY, HADAG), false)
    assert.equal(recoArtistMatches(KINO, 'КИНО'), true)
    assert.equal(recoArtistMatches(MOLCHAT, KINO), false)
    assert.equal(recoArtistMatches(BERRY, `${BERRY} & Rockfour`), true, 'a joint credit still contains the artist')
    assert.equal(recoTitleMatches('למה הים כחול?', 'למה הים כחול'), true)
    assert.equal(recoTitleMatches('שיר', 'למה הים כחול'), false)
    assert.equal(recoTitleMatches('Группа крови', 'Группа Крови'), true)
    assert.equal(recoTitleMatches('Группа крови', 'Звезда по имени Солнце'), false)
  })
  it('Latin names compare exactly as before', () => {
    const before = (s: string): string => foldAccents(s).replace(/[^a-z0-9]/g, '')
    for (const n of ['JAŸ-Z', 'Sigur Rós', 'Björk', 'Motörhead', "Can't Stop Playing", 'MØ', 'Bonafied Lovin\'', '!!!', 'P!nk', 'Ke$ha', 'AC/DC']) assert.equal(recoFold(n), before(n), n)
    assert.equal(recoArtistMatches('JAŸ-Z', 'Jay-Z'), true)
    assert.equal(recoTitleMatches('Bonafide Lovin', "Bonafied Lovin'"), true)
  })
})

describe('Music Man verification', () => {
  it('a real Hebrew pick verifies on its own credit', () => {
    const v = evaluateMusicManVerification({ mm: { song: 'שיר', artist: BERRY }, strictCredit: { matchedTitle: 'שיר', matchedArtist: BERRY }, canonical: {}, titleOnlyRows: [] })
    assert.deepEqual(v, { ok: true, song: 'שיר', artist: BERRY, mode: 'strict' })
  })
  it('a title a Hebrew and a Latin artist share is ambiguous, so the credit is not "corrected"', () => {
    // Before: the Hebrew artist was invisible, so "Love" looked like Rockfour's
    // alone and Music Man's credit was rewritten to Rockfour.
    const rows = [{ song: 'Love', artist: BERRY }, { song: 'Love', artist: 'Rockfour' }]
    assert.equal(shouldRejectRecoArtistCorrection('Love', HADAG, 'Rockfour', rows), true)
    assert.equal(shouldRejectRecoArtistCorrection('Love', HADAG, 'Rockfour', [rows[1]]), false, 'one artist with the title is still a correction')
  })
})

describe('Get: Qobuz, SoundCloud and the recording guard', () => {
  const q = (id: string, desc: string) => ({ source: 'qobuz', mediaType: 'track', id, desc })
  it('Qobuz: the Hebrew artist ranks, the stranger is out, and only the exact title gets the exact bonus', () => {
    const { ranked } = rankStreamripCandidates('שיר', BERRY, [q('1', `שיר אהבה by ${BERRY}`), q('2', `שיר by ${BERRY}`), q('3', `שיר by ${HADAG}`)])
    assert.deepEqual(ranked.map((r) => r.id), ['2', '1'])
  })
  it('the right Hebrew recording verifies; the same title by another Hebrew artist does not', () => {
    const req = buildRequestedRecording({ artist: BERRY, title: 'שיר', durationTolSec: 3, durationMs: 200_000 })
    assert.equal(verifyCandidate(req, { provider: 'qobuz', title: 'שיר', artist: BERRY, durationSec: 201 }).verdict, 'exact')
    const wrong = verifyCandidate(req, { provider: 'qobuz', title: 'שיר', artist: HADAG, durationSec: 201 })
    assert.equal(wrong.verdict === 'reject' && wrong.kind, 'artist')
  })
  it('SoundCloud: a Hebrew artist must be in the upload; a Hebrew title can be found', () => {
    const sc = (id: string, desc: string) => ({ source: 'soundcloud', mediaType: 'track', id, desc })
    assert.equal(pickBestSoundcloudMatch('Song Title', BERRY, [sc('a', 'Song Title by Random Uploader')]), null, 'the artist gate was skipped for a Hebrew artist')
    assert.equal(pickBestSoundcloudMatch('Song Title', BERRY, [sc('a', 'Song Title by Random Uploader'), sc('b', `${BERRY} - Song Title`)])?.id, 'b')
    assert.deepEqual(rankSoundcloudCandidates('שיר', BERRY, [sc('a', `${HADAG} - שיר`), sc('b', `${BERRY} - שיר`)]).map((r) => r.id), ['b'])
  })
})

describe('albums: identity and ownership', () => {
  const req = buildRequestedAlbum({ artist: BERRY, title: 'נעלם ונשכח', trackCount: 2, tracks: [{ title: 'שיר', trackNumber: 1, durationSec: 200 }, { title: 'למה', trackNumber: 2, durationSec: 180 }] })
  const cand = (artist: string) => ({ provider: 'qobuz' as const, desc: 'x', title: 'נעלם ונשכח', artist, trackCount: 2, tracks: [{ title: 'שיר', trackNumber: 1, durationSec: 201 }, { title: 'למה', trackNumber: 2, durationSec: 180 }] })
  it('a Hebrew album verifies as itself, and not when another artist made it', () => {
    assert.equal(verifyAlbumCandidate(req, cand(BERRY)).verdict, 'exact')
    const v = verifyAlbumCandidate(req, cand(HADAG))
    assert.equal(v.verdict === 'reject' && v.kind, 'artist')
  })
  it("the library owns the Hebrew track it has — not another artist's track of the same title", () => {
    const own = matchLibraryOwnership(req, [{ id: 1, title: 'שיר', artist: BERRY, durationSec: 200 }, { id: 2, title: 'למה', artist: HADAG, durationSec: 180 }])
    assert.deepEqual(own.owned.map((o) => o.index), [0])
    assert.deepEqual(own.missing, [1])
  })
  it('the iTunes collection for a Hebrew album is found by its own name and artist', () => {
    const rows = [{ collectionId: 1, collectionName: 'נעלם ונשכח', artistName: BERRY }, { collectionId: 2, collectionName: 'לאן נעלם', artistName: HADAG }]
    assert.equal(pickItunesCollection(rows, BERRY, 'נעלם ונשכח')?.collectionId, 1)
    assert.equal(pickItunesCollection(rows, KINO, 'נעלם ונשכח'), null)
  })
})

describe('discovery and the Listen List', () => {
  it("a discovery hit is acceptable only when it is the card's own Hebrew or Cyrillic artist", () => {
    assert.equal(acceptableHit({ artist: BERRY }, { artist: BERRY }), true)
    assert.equal(acceptableHit({ artist: BERRY }, { artist: HADAG }), false)
    assert.equal(acceptableHit({ artist: MOLCHAT, title: 'Этажи' }, { artist: MOLCHAT, title: 'Этажи' }), true)
  })
  it('a Music Man suggestion already on the list (under a joint Hebrew credit) is dropped; a different artist is kept', () => {
    const list = [{ id: 'r1', song: 'שיר', artist: BERRY }] as unknown as Recommendation[]
    const out = dedupeSuggestions([{ song: 'שיר', artist: `${BERRY} & Rockfour`, note: '' }, { song: 'שיר', artist: HADAG, note: '' }], list)
    assert.deepEqual(out.map((s) => s.artist), [HADAG])
  })
})

describe('recommendations-ipc: caches and iTunes scoring compare with recoFold', () => {
  const src = read('main/ipc/recommendations-ipc.ts')
  it('the iTunes search cache and the cover-art cache key on recoFold, not one Hebrew key for all', () => {
    assert.match(src, /const cacheKey = `\$\{recoFold\(q\)\}\|\$\{limit\}`/)
    assert.match(src, /const cacheKey = `\$\{recoFold\(artist\)\}\|\$\{recoFold\(title\)\}`/)
    assert.notEqual(recoFold(`${HADAG} למה`), recoFold(`${BERRY} שיר`))
  })
  it("a Hebrew jot earns the exact-artist boost, so a cover never renames it", () => {
    assert.match(src, /const wantSong = recoFold\(input\.song \|\| ''\)\n\s+const wantArtist = recoFold\(input\.artist \|\| ''\)/)
    assert.match(src, /const songN = recoFold\(s\.song\)\n\s+const artistN = recoFold\(s\.artist\)/)
    assert.doesNotMatch(src, /recoNorm\(/, 'recoNorm is identity-only; nothing in this file compares with it')
  })
})
