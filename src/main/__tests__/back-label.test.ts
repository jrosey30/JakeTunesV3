// Jake, 2026-10-20: "if i am on an artist page, the back arrow says back to
// albums, but it takes me back to artists??? what the hell????" The artist
// and album pages' back buttons navigated by history (like the titlebar ‹
// and ⌘[) but took their LABEL from a separately stored return view that
// goes stale. The label now comes from the same history step the click uses.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { backLabelForLocation, albumDetailBackLabel } from '../../renderer/utils/albumBackLabel.ts'

const loc = (view: string, artist: string | null = null) => ({ view, playlistId: null, smartPlaylistId: null, artist, albumKey: null })

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

describe('wiring: label and click share one source', () => {
  for (const f of ['ArtistDetailView.tsx', 'AlbumDetailView.tsx']) {
    it(f, () => {
      const src = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'views', f), 'utf-8')
      assert.match(src, /const backLabel = \(canGoBack && backLabelForLocation\(backTo, backToSearch\)\) \|\|/)
      assert.match(src, /if \(canGoBack\) navBack\(\)/)
    })
  }
  it('the navigation context exposes where back lands', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'context', 'NavigationContext.tsx'), 'utf-8')
    assert.match(src, /backTo: navRef\.current\.index > 0 \? navRef\.current\.history\[navRef\.current\.index - 1\] : null/)
  })
})
