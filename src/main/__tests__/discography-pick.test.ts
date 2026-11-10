// Jake, 2026-10-20, on the workmini Geese page: "why is my workmini have 3d
// country like this what a nightmare!!!" The tracklist was an unofficial
// 3-disc bundle (album + covers + live) concatenated. Fixture: MusicBrainz's
// four real 3D Country releases that day, in MusicBrainz's order.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { heldDiscography, DISCO_SCHEMA_VERSION, DISCO_CACHE_TTL_MS, DISCO_INCOMPLETE_TTL_MS, DISCO_UNAVAILABLE_TTL_MS } from '../artist-discography.ts'
import { pickStandardRelease } from '../../common/discography-pick.ts'
import { isHiddenRelease } from '../../common/release-gate.ts'

const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `t${i}`, position: i + 1 }))
const threeDCountry = [
  { id: 'xw', date: '2023-06-23', status: 'Official', disambiguation: '', media: [{ tracks: tracks(11) }] },
  { id: 'bundle', date: '2023-06-03', status: null, disambiguation: '', media: [{ tracks: tracks(11) }, { tracks: tracks(3) }, { tracks: tracks(9) }] },
  { id: 'hires', date: '2023-06-23', status: 'Official', disambiguation: '24-Bit/44.1 kHz', media: [{ tracks: tracks(11) }] },
  { id: 'cd', date: '2023-06-23', status: 'Official', disambiguation: '', media: [{ tracks: tracks(11) }] },
]

describe('pickStandardRelease', () => {
  it('3D Country: the plain 11-track album, never the 3-disc bundle', () => {
    const r = pickStandardRelease(threeDCountry)
    assert.equal(r?.media?.reduce((n, m) => n + m.tracks.length, 0), 11)
    assert.notEqual(r?.id, 'bundle')
    assert.notEqual(r?.id, 'hires', 'an edition note ("24-Bit") loses a tie to the plain release')
  })
  it('the earliest release is not automatically the album (the bundle was earliest)', () => {
    assert.equal(threeDCountry.reduce((a, b) => (a.date < b.date ? a : b)).id, 'bundle')
  })
  it('deluxe loses to standard among official releases', () => {
    const r = pickStandardRelease([
      { id: 'deluxe', status: 'Official', date: '2020-01-01', media: [{ tracks: tracks(18) }] },
      { id: 'std', status: 'Official', date: '2020-01-01', media: [{ tracks: tracks(12) }] },
    ])
    assert.equal(r?.id, 'std')
  })
  it('a real double album keeps both discs', () => {
    const r = pickStandardRelease([{ id: 'dbl', status: 'Official', media: [{ tracks: tracks(14) }, { tracks: tracks(14) }] }])
    assert.equal(r?.id, 'dbl')
  })
  it('no official release → the smallest one; no tracks anywhere → null', () => {
    assert.equal(pickStandardRelease([{ id: 'a', media: [{ tracks: tracks(9) }] }, { id: 'b', media: [{ tracks: tracks(7) }] }])?.id, 'b')
    assert.equal(pickStandardRelease([{ id: 'e', media: [{ tracks: [] }] }]), null)
    assert.equal(pickStandardRelease(undefined), null)
  })
})

describe('Jake\'s hidden releases', () => {
  it('Bottomless Pink Lagoon is out of Geese ("it isnt anywhere")', () => {
    assert.equal(isHiddenRelease('e0c97a4d-c392-41a9-a374-57af3e3eeab3', 'Bottomless Pink Lagoon'), true)
    assert.equal(isHiddenRelease('e0c97a4d-c392-41a9-a374-57af3e3eeab3', 'bottomless pink lagoon '), true)
    assert.equal(isHiddenRelease('e0c97a4d-c392-41a9-a374-57af3e3eeab3', '3D Country'), false)
    assert.equal(isHiddenRelease('some-other-artist', 'Bottomless Pink Lagoon'), false)
  })
})

describe('wiring', () => {
  const body = (() => {
    const src = readFileSync(join(import.meta.dirname, '..', 'artist-discography.ts'), 'utf-8')
    return src.slice(src.indexOf('async function fetchArtistDiscographyOnce('))
  })()
  it('the discography picks the standard edition and honours hidden releases (through the release gate)', () => {
    assert.match(body, /pickStandardRelease\(relData\.releases\)/)
    assert.doesNotMatch(body, /relData\.releases\?\.\[0\]/)
    assert.match(body, /gateReleaseGroups\(/)
    assert.match(body, /\.filter\(\(v\) => v\.admitted\)/)
  })
  it('a second request for the same artist joins the running fetch', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'artist-discography.ts'), 'utf-8')
    assert.match(src, /const running = inFlight\.get\(key\)\n\s+if \(running\) return running/)
  })
  it('a result the gate could not finish is never kept as a fact (an outage is not a fact): it is held a few hours, then asked again', () => {
    assert.match(body, /let incomplete = !browse\.complete \|\| !gate\.complete/)
    assert.match(body, /\.\.\.\(incomplete \? \{ incomplete: true \} : \{\}\)/, 'the unfinished result says so in the file')
    assert.match(body, /const held = heldDiscography\(JSON\.parse\(await readFile\(cachePath, 'utf-8'\)\), Date\.now\(\)\)/, 'and only heldDiscography decides whether the file still answers')
    assert.match(body, /if \(!gate\.complete\) return unavailable\(/, 'an identity refusal made during an outage is "no answer", never the refusal')
    assert.doesNotMatch(body, /if \(!gate\.complete\) return refuse/)
  })
})

// 2026-11-10 — "More from" ran the whole MusicBrainz lookup on every visit for
// any artist whose lookup had not finished cleanly: 60 "incomplete, not cached"
// lines in one log (Red Hot Chili Peppers 27 times, The Orb 24, Talking Heads
// 19), each popping the list in late under the Discography.
describe('an unfinished or absent discography answer is held for a while, not re-run on every visit', () => {
  const NOW = Date.UTC(2026, 10, 10, 12)
  const H = 3_600_000
  const file = (extra: Record<string, unknown> = {}, ageMs = 0): Record<string, unknown> =>
    ({ artist: 'Talking Heads', albums: [{ title: 'Remain in Light', year: '1980', tracks: [{ title: 'Born Under Punches', position: 1 }] }], fetchedAt: NOW - ageMs, schemaVersion: DISCO_SCHEMA_VERSION, ...extra })

  it('a finished answer stands for 7 days', () => {
    assert.equal(heldDiscography(file({}, 6 * 24 * H), NOW)?.result?.albums.length, 1)
    assert.equal(heldDiscography(file({}, DISCO_CACHE_TTL_MS), NOW), null)
  })
  it('an unfinished one (a source was down) answers the next visits for 6 hours, then the lookup runs again', () => {
    const held = heldDiscography(file({ incomplete: true }, 5 * H), NOW)
    assert.equal(held?.result?.incomplete, true, 'what was found is shown meanwhile')
    assert.equal(heldDiscography(file({ incomplete: true }, DISCO_INCOMPLETE_TTL_MS), NOW), null, 'an outage is not a fact: it is asked again')
    assert.ok(DISCO_INCOMPLETE_TTL_MS < DISCO_CACHE_TTL_MS / 10)
  })
  it('"no answer" (MusicBrainz away) is no answer for an hour — null, exactly what the lookup returned — then asked again', () => {
    const held = heldDiscography(file({ albums: [], unavailable: true }, 59 * 60_000), NOW)
    assert.ok(held, 'held')
    assert.equal(held!.result, null)
    assert.equal(heldDiscography(file({ albums: [], unavailable: true }, DISCO_UNAVAILABLE_TTL_MS), NOW), null)
  })
  it('an identity refusal (a confirmed empty) is a fact and stands the full 7 days', () => {
    assert.deepEqual(heldDiscography(file({ albums: [] }, 3 * 24 * H), NOW)?.result?.albums, [])
  })
  it('another schema, no date, a date in the future, or junk is a miss', () => {
    assert.equal(heldDiscography(file({ schemaVersion: DISCO_SCHEMA_VERSION - 1 }), NOW), null)
    assert.equal(heldDiscography(file({ fetchedAt: undefined }), NOW), null)
    assert.equal(heldDiscography(file({}, -5 * H), NOW), null)
    for (const junk of [null, 'x', 42, []]) assert.equal(heldDiscography(junk, NOW), null)
  })
  it('every way the lookup ends without an answer goes through the short hold; nothing returns a bare null any more', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'artist-discography.ts'), 'utf-8')
    const body = src.slice(src.indexOf('async function fetchArtistDiscographyOnce('))
    assert.equal((body.match(/return unavailable\(/g) ?? []).length, 5)
    assert.doesNotMatch(body.replace(/const unavailable = async[\s\S]*?\n  \}\n/, ''), /return null/)
    assert.match(body, /await writeCache\(cachePath, result\)\n\s+return result/, 'an unfinished result is written too (its file says incomplete)')
  })
  it('the page keeps a real answer for the session, so a revisit paints "More from" on its first frame', () => {
    const view = readFileSync(join(import.meta.dirname, '../../renderer/views/ArtistDetailView.tsx'), 'utf-8')
    assert.match(view, /\(\) => new Map\(personas\.map\(p => \[p\.name, discoMemo\.get\(p\.name\) \?\? \('loading' as const\)\]\)\)\)/)
    assert.match(view, /if \(r\?\.ok\) discoMemo\.set\(p\.name, got\)/, '"unavailable" is not remembered: the next visit asks main, which holds it')
  })
})
