// Jake, 2026-10-20: "if i am on an artist page, the back arrow says back to
// albums, but it takes me back to artists??? what the hell????" The artist
// and album pages' back buttons navigated by history (like the titlebar ‹
// and ⌘[) but took their LABEL from a separately stored return view that
// goes stale. The label now comes from the same history step the click uses.
//
// 2026-10-30: "never used those arrows. make going back obvious on every page"
// — one back pill on every page names the page Back lands on, so every page
// has a name here, and the names a history step only holds ids for (the
// album's title, the playlist's name) are resolved in ONE place
// (hooks/useBackLabel.ts) and handed to the same function.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { backLabelForLocation, albumDetailBackLabel } from '../../renderer/utils/albumBackLabel.ts'

const src = (...p: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', 'renderer', ...p), 'utf-8')
const loc = (view: string, artist: string | null = null) => ({ view, playlistId: null, smartPlaylistId: null, artist, albumKey: null })
/** Every member of the ViewName union, read from the type itself. */
const allViews = (): string[] => {
  const m = src('types.ts').match(/export type ViewName = ([^\n]+)/)
  assert.ok(m, 'ViewName union found in types.ts')
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1])
}

describe('backLabelForLocation names where back actually lands', () => {
  it('Jake\'s case: the history step is Artists → "← Artists", whatever the stale return view says', () => {
    assert.equal(backLabelForLocation(loc('artists')), '← Artists')
    assert.equal(albumDetailBackLabel('albums'), '← Albums', 'the stale value the old label used')
  })
  it('an artist page names the artist; an album page says Album', () => {
    assert.equal(backLabelForLocation(loc('artist-detail', 'Geese')), '← Geese')
    assert.equal(backLabelForLocation(loc('album-detail')), '← Album')
  })
  it('a search return says Search; no history → null (caller falls back with its fallback action)', () => {
    assert.equal(backLabelForLocation(loc('artists'), true), '← Search')
    assert.equal(backLabelForLocation(null), null)
  })
  it('known views keep their names; unknown ones say Back, never a wrong place', () => {
    assert.equal(backLabelForLocation(loc('home')), '← Home')
    assert.equal(backLabelForLocation(loc('discovery')), '← Record Shop')
    assert.equal(backLabelForLocation(loc('some-new-view')), '← Back')
  })
})

describe('the back pill names every page you can come from (Jake 10/30: "make going back obvious on every page")', () => {
  it('the browse and sidebar pages, by the names the sidebar gives them', () => {
    const named: Array<[string, string]> = [
      ['home', 'Home'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['genres', 'Genres'],
      ['discovery', 'Record Shop'], ['top1000', 'Top 1000 Quiz'], ['concerts', 'Live Concerts'],
      ['musicman', 'The Music Man'], ['year-in-review', 'Year in Review'], ['activity-pool', 'iPod Pool'],
      ['device', 'iPod'], ['store', 'Bandcamp Store'], ['dj', 'DJ'],
    ]
    for (const [view, name] of named) assert.equal(backLabelForLocation(loc(view)), `← ${name}`)
  })
  it('a playlist, a smart playlist, an album and an artist by THEIR names when the caller resolved them', () => {
    assert.equal(backLabelForLocation(loc('playlist'), false, { playlist: 'Road Trip' }), '← Road Trip')
    assert.equal(backLabelForLocation(loc('smart-playlist'), false, { playlist: 'Recently Added' }), '← Recently Added')
    assert.equal(backLabelForLocation(loc('album-detail'), false, { album: 'Perfecth' }), '← Perfecth')
    assert.equal(backLabelForLocation(loc('artist-detail', 'Geese'), false, {}), '← Geese')
  })
  it('without a resolved name, the kind of page — never a blank', () => {
    assert.equal(backLabelForLocation(loc('playlist')), '← Playlist')
    assert.equal(backLabelForLocation(loc('smart-playlist'), false, { playlist: null }), '← Playlist')
    assert.equal(backLabelForLocation(loc('album-detail'), false, { album: null }), '← Album')
    assert.equal(backLabelForLocation(loc('artist-detail')), '← Artist')
  })
  it('a search return still wins over a resolved name', () => {
    assert.equal(backLabelForLocation(loc('album-detail'), true, { album: 'Perfecth' }), '← Search')
  })
  it('EVERY view in ViewName has a name — "← Back" is only ever for a stranger', () => {
    const views = allViews()
    assert.ok(views.length >= 20, `parsed ${views.length} views`)
    for (const v of views) {
      const label = backLabelForLocation(loc(v))
      assert.ok(label !== null && /^← \S/.test(label) && label !== '← Back', `${v} → ${label}`)
    }
  })
})

describe('wiring: label and click share one source', () => {
  for (const f of ['ArtistDetailView.tsx', 'AlbumDetailView.tsx']) {
    it(f, () => {
      const s = src('views', f)
      assert.match(s, /const navBackLabel = useBackLabel\(\)/)
      assert.match(s, /const backLabel = \(canGoBack && navBackLabel\) \|\|/)
      assert.match(s, /if \(canGoBack\) navBack\(\)/)
    })
  }
  it('ConcertDetailView.tsx — the concert page joined the rule (its back used to be hard-wired to the list)', () => {
    const s = src('views', 'ConcertDetailView.tsx')
    assert.match(s, /const navBackLabel = useBackLabel\(\)/)
    assert.match(s, /const backLabel = \(canGoBack && navBackLabel\) \|\| '← Live Concerts'/)
    assert.match(s, /if \(canGoBack\) navBack\(\)/)
  })
  it('useBackLabel is the one place names are resolved, through backLabelForLocation', () => {
    const s = src('hooks', 'useBackLabel.ts')
    assert.match(s, /backLabelForLocation\(backTo, backToSearch, \{ album, playlist \}\)/)
    assert.match(s, /SMART_PLAYLIST_TITLES\[/)
    // the smart playlist page's heading and the pill read the same map
    assert.match(src('views', 'SmartPlaylistView.tsx'), /SMART_PLAYLIST_TITLES as TITLES/)
    assert.doesNotMatch(src('views', 'SmartPlaylistView.tsx'), /const TITLES: Record/)
  })
  it('the navigation context exposes where back lands', () => {
    const s = src('context', 'NavigationContext.tsx')
    assert.match(s, /backTo: navRef\.current\.index > 0 \? navRef\.current\.history\[navRef\.current\.index - 1\] : null/)
  })
})
