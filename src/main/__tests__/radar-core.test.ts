import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCandidates, rankCandidates, listenListPredicate, stripEditionWords } from '../radar-core.ts'
import { computeTasteFingerprint, getTasteAnchors } from '../taste-model.ts'
import { nameKey } from '../../common/fold-text.ts'
import { recoNorm } from '../reco-match.ts'
import { recoKind } from '../../renderer/listen-to-the-list/ltlDownload.ts'
import type { Recommendation } from '../../renderer/types.ts'

const rec = (over: Partial<Recommendation>): Recommendation => ({ id: 'r1', createdAt: '2026-10-11T00:00:00Z', ...over })

const rep = (n: number, t: Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ ...t, title: `t${i}` }))
const fp = computeTasteFingerprint([
  ...rep(10, { artist: 'Daft Punk', genre: 'House', year: 2013, playCount: 8 }),
  ...rep(12, { artist: 'Nirvana', genre: 'Grunge', year: 1991, playCount: 3 }),
])

describe('radar-core — parseCandidates', () => {
  it('parses a code-fenced JSON array', () => {
    const out = parseCandidates('```json\n[{"artist":"X","title":"Y"}]\n```')
    assert.equal(out.length, 1)
    assert.equal(out[0].artist, 'X')
  })
  it('parses a bare array embedded in prose', () => {
    assert.equal(parseCandidates('Sure! [{"artist":"A","title":"B"}] enjoy').length, 1)
  })
  it('returns [] on garbage or empty', () => {
    assert.deepEqual(parseCandidates('no json here'), [])
    assert.deepEqual(parseCandidates(''), [])
  })
})

describe('radar-core — rankCandidates', () => {
  it('drops owned artists (discovery only)', () => {
    const out = rankCandidates(fp, [
      { artist: 'Daft Punk', title: 'Something New', genre: 'House', year: 2024 }, // owned
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 }, // new
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].artist, 'Overmono')
  })

  it('dedupes by artist+title and drops entries missing fields', () => {
    const out = rankCandidates(fp, [
      { artist: 'A', title: 'Song', genre: 'Electronic', year: 2024 },
      { artist: 'A', title: 'Song', genre: 'Electronic', year: 2024 }, // dupe
      { artist: '', title: 'No Artist' },                              // invalid
      { artist: 'B' },                                                 // no title
    ])
    assert.equal(out.length, 1)
  })

  it('sorts by score desc and respects the limit', () => {
    const out = rankCandidates(fp, [
      { artist: 'P', title: '1', genre: 'Polka', year: 1955 },     // off-taste
      { artist: 'R', title: '2', genre: 'Grunge', year: 2024 },    // rock match
      { artist: 'E', title: '3', genre: 'Electronic', year: 2024 }, // electronic match
    ], 2)
    assert.equal(out.length, 2)
    assert.ok(out[0].score >= out[1].score)
    assert.ok(out.every((c) => c.genre !== 'Polka'), 'weakest dropped by the limit')
  })

  it('drops candidates already on the list via isOnList (no re-suggesting jots)', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const onList = new Set(['overmono|goodlies'])
    const isOnList = (a: string, t: string) => onList.has(`${norm(a)}|${norm(t)}`)
    const out = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 }, // on list → drop
      { artist: 'Jamie xx', title: 'Gosh', genre: 'Electronic', year: 2024 },      // new → keep
    ], 12, isOnList)
    assert.equal(out.length, 1)
    assert.equal(out[0].artist, 'Jamie xx')
  })

  it('boosts candidates with a taste anchor', () => {
    const anchors = getTasteAnchors([
      ...rep(10, { artist: 'Daft Punk', genre: 'House', playCount: 8 }),
    ])
    const withAnchor = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023, anchor: 'Daft Punk', why: 'Same dancefloor energy as Daft Punk' },
    ], 12, undefined, anchors)
    const noAnchor = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 },
    ], 12, undefined, anchors)
    assert.ok(withAnchor[0].score > noAnchor[0].score)
    assert.ok(withAnchor[0].reasons.some((r) => /daft punk/i.test(r)))
  })
})

// The real Listen List guard (2026-10-11): index.ts looked the radar's
// (artist, title) up under a song|artist key, so it never matched and the
// radar kept re-suggesting songs already on the list.
describe('radar-core — listenListPredicate (the real Listen List key)', () => {
  const list = [
    { song: 'Good Lies', artist: 'Overmono' },
    { matchedTitle: 'Chamber of Reflection', matchedArtist: 'Mac DeMarco' }, // iTunes-matched only
  ]

  it('drops a radar candidate whose artist + title is already on the list', () => {
    const out = rankCandidates(fp, [
      { artist: 'Overmono', title: 'Good Lies', genre: 'Electronic', year: 2023 }, // on list → drop
      { artist: 'Jamie xx', title: 'Gosh', genre: 'Electronic', year: 2024 },      // new → keep
    ], 12, listenListPredicate(list))
    assert.deepEqual(out.map((c) => c.artist), ['Jamie xx'])
  })

  it('matches through case, punctuation, and the iTunes-matched fields', () => {
    const isOnList = listenListPredicate(list)
    assert.equal(isOnList('OVERMONO', 'good lies!'), true)
    assert.equal(isOnList('Mac DeMarco', 'Chamber of Reflection'), true)
  })

  it('keys song first — the swapped pair is a different song', () => {
    assert.equal(listenListPredicate(list)('Good Lies', 'Overmono'), false)
    // The old lookup matched exactly this backwards row and nothing else.
    assert.equal(listenListPredicate([{ song: 'Overmono', artist: 'Good Lies' }])('Overmono', 'Good Lies'), false)
  })

  it('drops nothing when the list is empty or a row is missing a side', () => {
    assert.equal(listenListPredicate([])('Overmono', 'Good Lies'), false)
    assert.equal(listenListPredicate([{ song: 'Good Lies' }, { artist: 'Overmono' }])('Overmono', 'Good Lies'), false)
  })

  // The radar's "title" is a release — an album on the list is on the list.
  it('drops a radar release already on the list as an album', () => {
    const albums = [
      rec({ artist: 'Wednesday', album: 'Rat Saw God', kind: 'album' }),
      rec({ artist: 'Fontaines D.C.', album: 'Romance' }),                    // songless → an album row
      rec({ artist: 'pratt', album: 'pitch',                                  // a loose jot, iTunes-matched
        matchedArtist: 'Jessica Pratt', matchedAlbum: 'Here in the Pitch' }),
    ]
    const out = rankCandidates(fp, [
      { artist: 'Wednesday', title: 'Rat Saw God', genre: 'Indie Rock', year: 2023 },
      { artist: 'Fontaines D.C.', title: 'Romance', genre: 'Post-Punk', year: 2024 },
      { artist: 'Jessica Pratt', title: 'Here in the Pitch', genre: 'Folk', year: 2024 },
      { artist: 'Jamie xx', title: 'In Waves', genre: 'Electronic', year: 2024 },
    ], 12, listenListPredicate(albums))
    assert.deepEqual(out.map((c) => c.artist), ['Jamie xx'])
  })

  it('a song row that names its album does not hide the album', () => {
    const isOnList = listenListPredicate([rec({ song: 'Bull Believer', artist: 'Wednesday', album: 'Rat Saw God' })])
    assert.equal(isOnList('Wednesday', 'Rat Saw God'), false)
    assert.equal(isOnList('Wednesday', 'Bull Believer'), true)
  })

  it('an album needs its artist — same title by another band stays', () => {
    const isOnList = listenListPredicate([rec({ artist: 'Fontaines D.C.', album: 'Romance' }), rec({ album: 'Romance' })])
    assert.equal(isOnList('Camila Cabello', 'Romance'), false)
  })

  it('matches albums without their edition words, either side', () => {
    const isOnList = listenListPredicate([
      rec({ artist: 'Wednesday', album: 'Rat Saw God (Deluxe Edition)', kind: 'album' }),
      rec({ artist: 'Talking Heads', album: 'Remain in Light (2005 Remaster)' }),
      rec({ artist: 'pratt', album: 'pitch', matchedArtist: 'Jessica Pratt', matchedAlbum: 'Here in the Pitch - EP' }),
      rec({ artist: 'Overmono', album: 'Good Lies', kind: 'album' }),
    ])
    assert.equal(isOnList('Wednesday', 'Rat Saw God'), true)
    assert.equal(isOnList('Wednesday', 'Rat Saw God (Expanded Edition)'), true)
    assert.equal(isOnList('Talking Heads', 'Remain in Light'), true)
    assert.equal(isOnList('Jessica Pratt', 'Here in the Pitch'), true)
    assert.equal(isOnList('Overmono', 'Good Lies (Deluxe)'), true)
  })

  it('keeps a live album, and a different deluxe record, apart', () => {
    const isOnList = listenListPredicate([
      rec({ artist: 'Wednesday', album: 'Rat Saw God', kind: 'album' }),
      rec({ artist: 'Talking Heads', album: 'Little Creatures (Deluxe Version)', kind: 'album' }),
    ])
    assert.equal(isOnList('Wednesday', 'Rat Saw God (Live)'), false)
    assert.equal(isOnList('Talking Heads', 'Remain in Light (Deluxe Version)'), false)
  })

  // Names in other alphabets: recoNorm's [^a-z0-9] erased them, so a Hebrew
  // or Cyrillic song on the list had no key at all and came right back.
  const otherScripts = [
    rec({ song: 'שירת הסטיקר', artist: 'הדג נחש' }),
    rec({ album: 'Этажи', artist: 'Молчат Дома', kind: 'album' }),
    rec({ song: 'Кукушка', artist: 'Кино' }),
  ]

  it('hides songs and albums titled in other alphabets', () => {
    const isOnList = listenListPredicate(otherScripts)
    assert.equal(isOnList('הדג נחש', 'שירת הסטיקר'), true)
    assert.equal(isOnList('Молчат Дома', 'Этажи'), true)
    assert.equal(isOnList('КИНО', 'кукушка'), true)
  })

  it('keeps other-alphabet songs, albums and artists apart', () => {
    const isOnList = listenListPredicate(otherScripts)
    assert.equal(isOnList('ברי סחרוף', 'שירת הסטיקר'), false)   // same title, another band
    assert.equal(isOnList('Молчат Дома', 'Монумент'), false)     // another album
    assert.equal(isOnList('Кино', 'Группа крови'), false)         // another song
  })

  it('matches albums without their edition words in other languages too', () => {
    const isOnList = listenListPredicate([
      rec({ album: 'Этажи (Делюкс)', artist: 'Молчат Дома', kind: 'album' }),
      rec({ album: 'Acabou Chorare', artist: 'Novos Baianos', kind: 'album' }),
      rec({ album: 'POP VIRUS【初回限定盤】', artist: '星野源', kind: 'album' }),
      rec({ album: 'אלבום (מהדורת דלוקס)', artist: 'הדג נחש', kind: 'album' }),
    ])
    assert.equal(isOnList('Молчат Дома', 'Этажи'), true)
    assert.equal(isOnList('Novos Baianos', 'Acabou Chorare (Edição Comemorativa)'), true)
    assert.equal(isOnList('星野源', 'POP VIRUS (デラックス・エディション)'), true)
    assert.equal(isOnList('הדג נחש', 'אלבום'), true)
    assert.equal(isOnList('Novos Baianos', 'Acabou Chorare (Ao Vivo)'), false)   // a live album stays
  })

  it('folds accents instead of dropping the letter', () => {
    const isOnList = listenListPredicate([rec({ artist: 'Sigur Rós', album: 'Ágætis byrjun', kind: 'album' })])
    assert.equal(isOnList('Sigur Ros', 'Agaetis Byrjun'), true)
  })

  it('keys A-Z names exactly as recoNorm did', () => {
    for (const s of ['Good Lies', 'Fontaines D.C.', "Rock 'n' Roll", 'AC/DC', '1999', 'Rat  Saw--God!']) {
      assert.equal(nameKey(s, ''), recoNorm(s))
    }
  })

  it('hides exactly the rows the list files under Albums (recoKind twin)', () => {
    const rows = [
      rec({ artist: 'Wednesday', album: 'Rat Saw God', kind: 'album' }),
      rec({ artist: 'Wednesday', album: 'Rat Saw God', kind: 'concert' }),
      rec({ artist: 'Wednesday', album: 'Rat Saw God' }),
      rec({ matchedArtist: 'Wednesday', matchedAlbum: 'Rat Saw God' }),
      rec({ artist: 'Wednesday', album: 'Rat Saw God', song: 'Bull Believer' }),
      rec({ artist: 'Wednesday', album: 'Rat Saw God', matchedTitle: 'Bull Believer', kind: 'track' }),
      rec({ artist: 'Wednesday' }),
    ]
    for (const r of rows) {
      const filed = recoKind(r)
      assert.equal(listenListPredicate([r])('Wednesday', 'Rat Saw God'), filed === 'album' || filed === 'concert',
        `${JSON.stringify(r)} is filed as ${filed}`)
    }
  })

  it('is what the radar IPC in index.ts hands rankCandidates (checked at the source)', () => {
    const index = readFileSync(join(import.meta.dirname, '../index.ts'), 'utf-8')
    assert.match(index, /isOnList = listenListPredicate\(await readRecommendationsFile\(\)\)/)
    assert.match(index, /rankCandidates\(fp, parseCandidates\(text\), 24, isOnList, anchors\)/)
    assert.doesNotMatch(index, /recoIdentityKey\(/)
  })
})

describe('radar-core — stripEditionWords (any language, radar only)', () => {
  it('drops edition groups in brackets or after " - "', () => {
    const cases: Array<[string, string]> = [
      ['Этажи - Делюкс-издание', 'Этажи'],
      ['Группа крови (Юбилейное издание)', 'Группа крови'],
      ['Romance (Edición 25º Aniversario)', 'Romance'],
      ['Mi Plan (Versión Remasterizada)', 'Mi Plan'],
      ['Histoire de Melody Nelson (Édition Deluxe)', 'Histoire de Melody Nelson'],
      ['La voce del padrone (Edizione Rimasterizzata)', 'La voce del padrone'],
      ['Mensch (Jubiläumsausgabe)', 'Mensch'],
      ['אלבום (מהדורה מורחבת)', 'אלבום'],
      ['Album (豪华版)', 'Album'],
      ["Album (Collector's Edition) [Remastered]", 'Album'],
    ]
    for (const [title, want] of cases) assert.equal(stripEditionWords(title), want, title)
  })
  // Real labels from the 2026-10-11 iTunes-catalog harvest (27 storefronts):
  // an edition noun strips the group whatever else it says, compounds too.
  it('drops the edition labels real catalogs use', () => {
    const cases: Array<[string, string]> = [
      ['México en la Piel (Edición Diamante)', 'México en la Piel'],
      ['Inercia (Edición de Lujo)', 'Inercia'],
      ['Sinfônico 40 Anos (Edição Luxo) [Ao Vivo]', 'Sinfônico 40 Anos [Ao Vivo]'],
      ['Lumières & Trahisons (Remasterisé en 2017)', 'Lumières & Trahisons'],
      ['Ciche dni (Edycja Specjalna)', 'Ciche dni'],
      ['Pokazde - Zlatá edice', 'Pokazde'],
      ['Luister (Kersteditie)', 'Luister'],
      ['Shu-bi-dua 7 (Deluxe udgave)', 'Shu-bi-dua 7'],
      ['Jag kommer hem igen till jul - Jubileumsutgåva', 'Jag kommer hem igen till jul'],
      ['Az Utca Másik Oldalán (Felújított Kiadás)', 'Az Utca Másik Oldalán'],
      ['Люди (Дополненное издание)', 'Люди'],
      ['WE GO【初回限定盤B】', 'WE GO'],
      ['BAND WAGON (リマスター2017)', 'BAND WAGON'],
      ['时光幻游指南 (十周年纪念版)', '时光幻游指南'],
    ]
    for (const [title, want] of cases) assert.equal(stripEditionWords(title), want, title)
  })
  it('keeps groups that name another recording, and filler words alone', () => {
    for (const title of [
      'Acabou Chorare (Ao Vivo)', 'Mi Plan (En Vivo)', 'אלבום (הופעה חיה)', 'Album (Live Edition)',
      'Album (Special)', 'Album (Limited)', 'The Edition - Live', '(Deluxe)',
      'Lo Niego Todo (En Directo)', 'Wat is dan liefde (Radio editie)', '纪念日 (现场版)',
      'Album (Remezclado y Remasterizado 2019)', 'Album (Remixé et remasterisé)', 'Album (Expedition)',
    ]) assert.equal(stripEditionWords(title), title, title)
  })
  it('keeps a group that names a volume — volume 17 is not volume 10', () => {
    assert.equal(stripEditionWords('Очи Чёрные (Коллекционное издание, том 10)'), 'Очи Чёрные (Коллекционное издание, том 10)')
    assert.equal(stripEditionWords('Album (Deluxe Edition, Pt. 2)'), 'Album (Deluxe Edition, Pt. 2)')
    assert.equal(stripEditionWords('Candomblé (Edição Bahia) (Vol.2)'), 'Candomblé (Vol.2)')
  })
})

it('pseudo-artists can never become taste anchors', () => {
  const tracks = [
    ...Array.from({ length: 60 }, (_, i) => ({ artist: `A${i}`, albumArtist: 'Various Artists', playCount: 9, genre: 'Rock' })),
    ...Array.from({ length: 8 }, () => ({ artist: 'Sublime', albumArtist: 'Sublime', playCount: 5, genre: 'Ska' })),
    { artist: 'X', albumArtist: 'Original Motion Picture Soundtrack', playCount: 40, genre: 'Score' },
  ]
  const anchors = getTasteAnchors(tracks, 8)
  const names = anchors.map((a) => a.artist.toLowerCase())
  assert.ok(names.includes('sublime'))
  assert.ok(!names.some((n) => n.includes('various') || n.includes('soundtrack')))
})
