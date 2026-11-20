// Brief 254 — the toolbar search's JakeTunes | This page switch.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hasPageScope, ownsFilterBox, parseSearchScope, resolveSearchScope, pageScopeLabel,
  searchPlaceholder, pageKey, recordShopRowLabel, recordShopPrefill, shorten,
  PAGE_SCOPE_VIEWS, SEARCH_SCOPE_KEY,
} from '../../renderer/utils/searchScope.ts'
import { getPageFilter, setPageFilter, subscribePageFilter } from '../../renderer/utils/pageFilter.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

describe('which pages have a page scope', () => {
  it('Songs, Albums, Artists, a playlist and a smart playlist', () => {
    for (const v of ['songs', 'albums', 'artists', 'playlist', 'smart-playlist']) assert.equal(hasPageScope(v), true, v)
  })
  it('nothing else — Home, detail pages, the Record Shop, Genres (no filter of its own)', () => {
    for (const v of ['home', 'album-detail', 'artist-detail', 'discovery', 'genres', 'musicman', 'concerts', 'top1000', 'ipod-playlist']) {
      assert.equal(hasPageScope(v), false, v)
    }
  })
  it('only Albums and Artists keep their own box', () => {
    assert.deepEqual(PAGE_SCOPE_VIEWS.filter(ownsFilterBox), ['albums', 'artists'])
  })
})

describe('the scope in force', () => {
  it('reads the saved choice defensively', () => {
    assert.equal(parseSearchScope('page'), 'page')
    for (const v of ['jaketunes', undefined, null, 'library', 3, {}]) assert.equal(parseSearchScope(v), 'jaketunes')
    assert.equal(SEARCH_SCOPE_KEY, 'searchScope')
  })
  it('"This page" holds only where the page has one; JakeTunes everywhere', () => {
    assert.equal(resolveSearchScope('page', 'songs'), 'page')
    assert.equal(resolveSearchScope('page', 'playlist'), 'page')
    assert.equal(resolveSearchScope('page', 'home'), 'jaketunes')
    assert.equal(resolveSearchScope('page', 'album-detail'), 'jaketunes')
    assert.equal(resolveSearchScope('jaketunes', 'songs'), 'jaketunes')
  })
  it('the remembered choice comes back on the next page that supports it', () => {
    const pref = 'page' as const
    const walk = ['songs', 'home', 'album-detail', 'albums'].map((v) => resolveSearchScope(pref, v))
    assert.deepEqual(walk, ['page', 'jaketunes', 'jaketunes', 'page'])
  })
})

describe('the page name on the switch', () => {
  it('names the fixed pages', () => {
    assert.equal(pageScopeLabel('songs'), 'Songs')
    assert.equal(pageScopeLabel('albums'), 'Albums')
    assert.equal(pageScopeLabel('artists'), 'Artists')
    assert.equal(pageScopeLabel('home'), null)
    assert.equal(pageScopeLabel('genres'), null)
  })
  it("a playlist's own name, cut short", () => {
    assert.equal(pageScopeLabel('playlist', { playlistName: 'Road Trip' }), 'Road Trip')
    const long = pageScopeLabel('playlist', { playlistName: 'Songs For The Long Drive Home' })!
    assert.equal(long, 'Songs For The L…')
    assert.ok(long.length <= 16)
    assert.equal(pageScopeLabel('smart-playlist', { smartName: 'Recently Added' }), 'Recently Added')
  })
  it('"Playlist" when there is no name', () => {
    assert.equal(pageScopeLabel('playlist', {}), 'Playlist')
    assert.equal(pageScopeLabel('playlist', { playlistName: '   ' }), 'Playlist')
    assert.equal(pageScopeLabel('smart-playlist', { smartName: null }), 'Playlist')
  })
  it('placeholder', () => {
    assert.equal(searchPlaceholder('jaketunes', 'Songs'), 'Search')
    assert.equal(searchPlaceholder('page', 'Songs'), 'Search Songs')
    assert.equal(searchPlaceholder('page', null), 'Search')
  })
  it('shorten collapses spaces and never cuts what fits', () => {
    assert.equal(shorten('  a   b ', 5), 'a b')
    assert.equal(shorten('abcdef', 6), 'abcdef')
    assert.equal(shorten('abcdefg', 6), 'abcde…')
  })
})

describe('a page filter belongs to one page', () => {
  it('two playlists are two pages; Songs is one', () => {
    assert.notEqual(pageKey('playlist', 'a'), pageKey('playlist', 'b'))
    assert.notEqual(pageKey('smart-playlist', null, 'top-25'), pageKey('smart-playlist', null, 'recently-added'))
    assert.equal(pageKey('songs', 'a', 'top-25'), pageKey('songs'))
  })
})

describe('the Record Shop row', () => {
  it('says what it will search', () => {
    assert.equal(recordShopRowLabel('  Fugazi '), 'Search the Record Shop for “Fugazi”')
    assert.equal(recordShopRowLabel(''), null)
    assert.equal(recordShopRowLabel('   '), null)
    const long = recordShopRowLabel('x'.repeat(80))!
    assert.ok(long.endsWith('…”'))
  })
  it("sends the whole words to the shop's Search, as typed", () => {
    assert.deepEqual(recordShopPrefill(' the long words of a really long search query that goes on '), {
      query: 'the long words of a really long search query that goes on', target: 'browse', how: 'typed',
    })
    assert.equal(recordShopPrefill(' '), null)
  })
})

describe('the shared Albums / Artists filter', () => {
  it('one value per page, heard by every listener', () => {
    let heard = 0
    const off = subscribePageFilter(() => { heard++ })
    setPageFilter('albums', 'beat')
    setPageFilter('albums', 'beat')   // no change, no news
    assert.equal(getPageFilter('albums'), 'beat')
    assert.equal(getPageFilter('artists'), '')
    assert.equal(heard, 1)
    off()
    setPageFilter('albums', '')
    assert.equal(heard, 1)
  })
})

describe('wiring', () => {
  const pill = src('components', 'playback', 'SearchPill.tsx')
  const panel = src('components', 'playback', 'SearchPanel.tsx')
  it('the pill resolves its scope, remembers it, and opens the dropdown only in JakeTunes', () => {
    assert.match(pill, /resolveSearchScope\(pref, lib\.currentView\)/)
    assert.match(pill, /saveUiState\(\{ \[SEARCH_SCOPE_KEY\]: next \}\)/)
    assert.match(pill, /const panelOpen = scope === 'jaketunes' && focused && query\.trim\(\)\.length > 0/)
  })
  it('"This page" writes the page filter, and a page change clears lib.searchQuery', () => {
    assert.match(pill, /dispatch\(\{ type: 'SET_SEARCH', query: q \}\)/)
    assert.match(pill, /if \(ownBox\) setPageFilter\(ownBox, q\)/)
    assert.match(pill, /if \(lib\.searchQuery\) dispatch\(\{ type: 'SET_SEARCH', query: '' \}\)/)
  })
  it('the dropdown ends with the Record Shop row, through the existing prefill + openBrowse', () => {
    assert.match(panel, /recordShopRowLabel\(query\)/)
    assert.match(panel, /new CustomEvent\('jaketunes-download-prefill', \{ detail \}\)\)\s*\n\s*openBrowse\(dispatch\)/)
    assert.match(panel, /if \(selectedFlatIdx === shopIdx\) \{ openShop\(\); return \}/)
  })
  it("the shop's Search counts a typed prefill as typed", () => {
    const dl = src('views', 'DownloadStore', 'DownloadView.tsx')
    assert.match(dl, /how\?: ShopSearchHow \}/)
    assert.match(dl, /searchHowRef\.current = d\?\.how === 'typed' \? 'typed' : 'list'/)
  })
  it('Albums and Artists have one filter, shared with the pill', () => {
    for (const [file, view] of [['AlbumsView.tsx', 'albums'], ['ArtistsView.tsx', 'artists']] as const) {
      const v = src('views', file)
      assert.match(v, new RegExp(`useSyncExternalStore\\(subscribePageFilter, \\(\\) => getPageFilter\\('${view}'\\)\\)`), file)
      assert.match(v, new RegExp(`useEffect\\(\\(\\) => \\(\\) => setPageFilter\\('${view}', ''\\), \\[\\]\\)`), file)
      assert.doesNotMatch(v, /lib\.searchQuery/, `${file} no longer reads a second filter`)
    }
  })
  it('the do-not-touch files are untouched by this', () => {
    const lib = src('context', 'LibraryContext.tsx')
    assert.match(lib, /case 'SET_VIEW':\s*\n\s*return \{ \.\.\.state, currentView: action\.view, searchQuery: '' \}/)
    assert.doesNotMatch(src('views', 'GenresView.tsx'), /pageFilter|searchScope/)
  })
})
