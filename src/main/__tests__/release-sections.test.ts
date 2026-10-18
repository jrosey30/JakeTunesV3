/**
 * The artist page's release sections (Jake 2026-10-18): albums → EPs →
 * singles → live → compilations, from the shared rulebook. The grouping is
 * pure (src/common/release-sections.ts) and shared with the resolver, so the
 * page's fallback is what main stores when MusicBrainz has no answer.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectAlbumFacts, groupByReleaseKind, releaseKindForRows, albumKeyOf, type AlbumRow } from '../../common/release-sections.ts'
import { nameKey } from '../../common/fold-text.ts'
import type { ReleaseKindsFile } from '../../common/release-kind.ts'

function rows(artist: string, album: string, n: number, trackCount = n, durationMs = 200_000, albumArtist = ''): AlbumRow[] {
  return Array.from({ length: n }, () => ({ album, artist, albumArtist, trackCount, duration: durationMs }))
}

describe('album facts', () => {
  test('facts: keyed by albumArtist || artist, declared count = the max, every duration kept', () => {
    const f = collectAlbumFacts([
      { album: 'Now 99', artist: 'Geese', albumArtist: 'Various Artists', trackCount: 20, duration: 1 },
      { album: 'Now 99', artist: 'Someone', albumArtist: 'Various Artists', trackCount: 21, duration: 2 },
      { album: '', artist: 'Geese', trackCount: 1, duration: 1 },
    ], nameKey)
    assert.deepEqual([...f.keys()], ['various artists|now 99'])
    const now99 = f.get('various artists|now 99')!
    assert.equal(now99.declaredTrackCount, 21)
    assert.deepEqual(now99.ownedDurationsMs, [1, 2])
    assert.equal(now99.albumArtist, 'Various Artists')
  })
})

describe('artist page grouping', () => {
  test('sections in rulebook order, labelled, empty ones dropped, input order kept inside', () => {
    const items = [
      { n: 'b-live', k: 'live' }, { n: 'a1', k: 'album' }, { n: 'single1', k: 'single' },
      { n: 'a2', k: 'album' }, { n: 'comp', k: 'compilation' },
    ] as const
    const s = groupByReleaseKind(items, (i) => i.k)
    assert.deepEqual(s.map((x) => x.label), ['Albums', 'Singles', 'Live', 'Compilations'])
    assert.deepEqual(s[0].items.map((i) => i.n), ['a1', 'a2'])
    assert.deepEqual(groupByReleaseKind([], () => 'album'), [])
  })

  test('a stored answer wins; otherwise title/shape on the WHOLE library facts', () => {
    const library = [...rows('Geese', '4D Country', 5, 5), ...rows('Geese', 'Alive & In Person', 7, 7)]
    const facts = collectAlbumFacts(library, nameKey)
    const fourD = library.slice(0, 2)   // this persona only shows 2 of its 5 rows
    assert.equal(releaseKindForRows(fourD, {}, facts, nameKey), 'ep')
    const alive = library.slice(5)
    assert.equal(releaseKindForRows(alive, {}, facts, nameKey), 'album')
    const stored: ReleaseKindsFile['albums'] = { [albumKeyOf(alive[0], nameKey)!]: { kind: 'live', source: 'musicbrainz', mbid: 'x' } }
    assert.equal(releaseKindForRows(alive, stored, facts, nameKey), 'live')
    // Rows the facts index hasn't seen yet still classify from themselves
    assert.equal(releaseKindForRows(rows('New', 'Fresh - Single', 1), {}, facts, nameKey), 'single')
  })
})

describe('WIRING — the artist page groups through the shared helpers', () => {
  test('ArtistDetailView uses groupByReleaseKind + releaseKindForRows and has no rulebook of its own', () => {
    const view = readFileSync(join(import.meta.dirname, '../../renderer/views/ArtistDetailView.tsx'), 'utf-8')
    assert.match(view, /groupByReleaseKind\(/)
    assert.match(view, /releaseKindForRows\(/)
    assert.match(view, /RELEASE_KIND_LABEL\[/)
    assert.equal(/function releaseType\(/.test(view), false, 'a second, drifting rulebook is back in the artist page')
  })
})
