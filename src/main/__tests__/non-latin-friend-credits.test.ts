/**
 * Friend credits in other alphabets (2026-10-11) — the pattern of
 * non-latin-keys.test.ts, for the friend ledger.
 *
 * The credit keys folded with recoNorm ([a-z0-9]), which erased every Hebrew
 * and Cyrillic title and artist. Every path skips an empty key, so a friend's
 * Hebrew or Cyrillic send was never recorded, never credited, and never on the
 * standings. These keys are STORED (friend-credits.json keys/albumKey, and
 * inside attribution credit ids), so they go through recoIdNorm: a Latin name
 * keeps its key byte for byte, which the pins below prove.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pairKeys, computeImportCredits, attributionKey, attributionRecoId, computeAttributionCredits, friendOfNote,
} from '../friend-imports-core.ts'
import {
  albumKeyOfStrings, buildLibraryIndex, evaluateCredit, computeAlbumCredits, computeStandings, type CreditRecord,
} from '../friend-standings-core.ts'

const BERRY = 'ברי סחרוף'          // Berry Sakharof
const HADAG = 'הדג נחש'            // Hadag Nahash
const MOLCHAT = 'Молчат Дома'      // Molchat Doma
const KINO = 'Кино'

const SENT = '2026-10-01T12:00:00.000Z'
const BEFORE = '2026-09-01T12:00:00.000Z'
const AFTER = '2026-10-02T12:00:00.000Z'
const note = (friend: string) => `from ${friend}`

describe('song credits (friend-imports-core)', () => {
  it('a Hebrew or Cyrillic send has pair keys, and two songs have two', () => {
    assert.deepEqual(pairKeys({ id: '1', song: 'שיר', artist: BERRY }), ['שיר|ברי סחרוף'])
    assert.deepEqual(pairKeys({ id: '2', song: 'Группа крови', artist: KINO }), ['группа крови|кино'])
    assert.notDeepEqual(pairKeys({ id: '1', song: 'שיר', artist: BERRY }), pairKeys({ id: '3', song: 'למה הים כחול?', artist: HADAG }))
  })
  it('a Latin send keys exactly as it always has (stored credits stay valid)', () => {
    assert.deepEqual(pairKeys({ id: '1', song: 'Hoppípolla', artist: 'Sigur Rós' }), ['hopppolla|sigurrs'])
    assert.deepEqual(pairKeys({ id: '1', song: 'Til the Right One Comes', artist: 'John Mayer', matchedTitle: 'Til the Right One Comes', matchedArtist: 'John Mayer' }), ['tiltherightonecomes|johnmayer'])
  })
  it('importing the Hebrew song Lorin sent earns Lorin the credit; a different Hebrew song does not', () => {
    const recos = [{ id: 'r1', song: 'שיר', artist: BERRY, note: note('Lorin'), createdAt: SENT }]
    assert.deepEqual(computeImportCredits(recos, [{ title: 'שיר', artist: BERRY, dateAdded: AFTER }], new Set()), [{ recoId: 'r1', friend: 'Lorin' }])
    assert.deepEqual(computeImportCredits(recos, [{ title: 'למה הים כחול?', artist: HADAG, dateAdded: AFTER }], new Set()), [])
    assert.deepEqual(computeImportCredits(recos, [{ title: 'שיר', artist: HADAG, dateAdded: AFTER }], new Set()), [], 'same title, other artist')
  })
  it('a Hebrew song already owned before the send still earns nothing', () => {
    const recos = [{ id: 'r1', song: 'שיר', artist: BERRY, note: note('Lorin'), createdAt: SENT }]
    assert.deepEqual(computeImportCredits(recos, [{ title: 'שיר', artist: BERRY, dateAdded: BEFORE }], new Set()), [])
  })
})

describe('attribution credits (sends the list no longer remembers)', () => {
  it('a Cyrillic send is recordable — noteAttribution drops a send with no key', () => {
    assert.equal(attributionKey({ song: 'Судно', artist: MOLCHAT }), 'судно|молчат дома')
    assert.equal(attributionRecoId({ song: 'Судно', artist: MOLCHAT, friend: 'Ben', at: SENT }), 'attr:судно|молчат дома:ben')
    assert.notEqual(attributionKey({ song: 'Судно', artist: MOLCHAT }), attributionKey({ song: 'Группа крови', artist: KINO }))
  })
  it('a Latin attribution keeps its credit id byte for byte (no second credit for an old one)', () => {
    assert.equal(attributionRecoId({ song: 'Til the Right One Comes', artist: 'John Mayer', friend: 'Lorin', at: SENT }), 'attr:tiltherightonecomes|johnmayer:lorin')
  })
  it('the import earns the credit once, and only for the song that was sent', () => {
    const attrs = [{ song: 'Судно', artist: MOLCHAT, friend: 'Ben', at: SENT }]
    const hits = computeAttributionCredits(attrs, [{ title: 'Судно', artist: MOLCHAT, dateAdded: AFTER }, { title: 'Группа крови', artist: KINO, dateAdded: AFTER }], new Set(), new Set())
    assert.deepEqual(hits.map((h) => [h.recoId, h.key]), [['attr:судно|молчат дома:ben', 'судно|молчат дома']])
    assert.deepEqual(computeAttributionCredits(attrs, [{ title: 'Группа крови', artist: KINO, dateAdded: AFTER }], new Set(), new Set()), [])
    assert.deepEqual(computeAttributionCredits(attrs, [{ title: 'Судно', artist: MOLCHAT, dateAdded: AFTER }], new Set([hits[0].recoId]), new Set()), [], 'already credited')
  })
})

describe('standings (friend-standings-core)', () => {
  const credit = (o: Partial<CreditRecord>): CreditRecord => ({ recoId: 'r1', friend: 'Lorin', kind: 'song', label: 'x', creditedAt: AFTER, ...o })
  it('a kept Hebrew song is +1, deleting it is −1, and another Hebrew song never keeps it alive', () => {
    const rec = credit({ keys: pairKeys({ id: 'r1', song: 'שיר', artist: BERRY }) })
    assert.equal(evaluateCredit(rec, buildLibraryIndex([{ title: 'שיר', artist: BERRY }])).points, 1)
    assert.equal(evaluateCredit(rec, buildLibraryIndex([{ title: 'למה הים כחול?', artist: HADAG }])).points, -1)
    assert.equal(evaluateCredit(rec, buildLibraryIndex([])).points, -1)
  })
  it('a credit stored before this change still reads as kept', () => {
    const rec = credit({ keys: ['hopppolla|sigurrs'] })
    assert.equal(evaluateCredit(rec, buildLibraryIndex([{ title: 'Hoppípolla', artist: 'Sigur Rós' }])).status, 'kept')
    assert.equal(albumKeyOfStrings('( )', 'Sigur Rós'), null, 'a name that folds to nothing still has no key')
    assert.equal(albumKeyOfStrings('Ágætis byrjun', 'Sigur Rós'), 'gtisbyrjun|sigurrs')
  })
  it('a Hebrew album sent and imported earns the album credit, scored on its own tracks', () => {
    const recos = [{ id: 'a1', kind: 'album', album: 'נעלם ונשכח', artist: BERRY, note: note('Ben'), createdAt: SENT }]
    const tracks = [
      { title: 'שיר', album: 'נעלם ונשכח', artist: BERRY, dateAdded: AFTER },
      { title: 'למה', album: 'נעלם ונשכח', artist: BERRY, dateAdded: AFTER },
      { title: 'Этажи', album: 'Этажи', artist: MOLCHAT, dateAdded: AFTER },
    ]
    const [hit] = computeAlbumCredits(recos, tracks, new Set(), friendOfNote)
    assert.deepEqual([hit.albumKey, hit.n0], ['נעלם ונשכח|ברי סחרוף', 2])
    const rec = credit({ recoId: 'a1', friend: 'Ben', kind: 'album', albumKey: hit.albumKey, n0: hit.n0 })
    assert.equal(evaluateCredit(rec, buildLibraryIndex(tracks)).points, 5)
    assert.equal(evaluateCredit(rec, buildLibraryIndex(tracks.slice(1))).points, 1, 'one track deleted counts as a song')
    assert.equal(evaluateCredit(rec, buildLibraryIndex(tracks.slice(2))).points, -1, 'another album never keeps it alive')
    assert.notEqual(albumKeyOfStrings('נעלם ונשכח', BERRY), albumKeyOfStrings('לאן נעלם', HADAG))
  })
  it('the friend appears on the board with the Hebrew import', () => {
    const rec = credit({ friend: 'Lorin', keys: pairKeys({ id: 'r1', song: 'שיר', artist: BERRY }) })
    const rows = computeStandings([rec], { lorin: { name: 'Lorin', adds: 1 } }, [{ title: 'שיר', artist: BERRY }])
    assert.deepEqual(rows.map((r) => [r.name, r.points]), [['Lorin', 1]])
  })
})

describe('one fold for every friend key', () => {
  it('both cores key through recoIdNorm and nothing else', () => {
    for (const f of ['friend-imports-core.ts', 'friend-standings-core.ts']) {
      const src = readFileSync(join(import.meta.dirname, '..', f), 'utf-8')
      assert.match(src, /import \{ recoIdNorm \} from '\.\/reco-match\.ts'/, f)
      assert.doesNotMatch(src, /recoNorm\(|a-z0-9/, f)
    }
  })
})
