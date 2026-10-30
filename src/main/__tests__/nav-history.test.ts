import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  recordLocation, canGoBack, canGoForward, sameLoc, locationOf, restoreActionFor, savedLocation,
} from '../../renderer/nav-history.ts'
import type { NavLocation, NavHistory, NavigableState, RestoreAction } from '../../renderer/nav-history.ts'

const L = (view: string, extra: Partial<NavLocation> = {}): NavLocation => ({
  view, playlistId: null, smartPlaylistId: null, artist: null, albumKey: null, ...extra,
})
const start = (loc: NavLocation): NavHistory => ({ history: [loc], index: 0 })
const src = (...p: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', 'renderer', ...p), 'utf-8')

// ---------------------------------------------------------------------------
// A model of the app's navigation, built from the SAME pure pieces the app
// uses, so a whole click sequence can be walked headlessly:
//   reduce  — the five reducer cases NavigationContext relies on, on the
//             navigable fields only (LibraryContext.tsx is do-not-touch; the
//             exact lines are locked by a test below so this twin can't drift)
//   observe — NavigationContext's effect: record where the state now is
//   back / forward — move the index, replay the entry with restoreActionFor,
//             observe (a correct landing records nothing)
// ---------------------------------------------------------------------------
const BOOT: NavigableState = { currentView: 'songs', activePlaylistId: null, activeSmartPlaylist: null, activeArtist: null, pendingAlbumKey: null }
function reduce(s: NavigableState, a: RestoreAction): NavigableState {
  switch (a.type) {
    case 'SET_VIEW': return { ...s, currentView: a.view }
    case 'VIEW_PLAYLIST': return { ...s, currentView: 'playlist', activePlaylistId: a.id, activeSmartPlaylist: null }
    case 'VIEW_SMART_PLAYLIST': return { ...s, currentView: 'smart-playlist', activeSmartPlaylist: a.id, activePlaylistId: null }
    case 'VIEW_ARTIST_DETAIL': return { ...s, currentView: 'artist-detail', activeArtist: a.artistName }
    case 'VIEW_ALBUM_DETAIL': return { ...s, currentView: 'album-detail', pendingAlbumKey: a.albumKey }
  }
}
class NavModel {
  state: NavigableState = BOOT
  nav: NavHistory = { history: [locationOf(BOOT)], index: 0 }
  get loc(): NavLocation { return locationOf(this.state) }
  /** Where the titlebar ‹ (and the album page's own back button) would land. */
  get backTo(): NavLocation | null { return this.nav.index > 0 ? this.nav.history[this.nav.index - 1] : null }
  dispatch(a: RestoreAction): void { this.state = reduce(this.state, a); this.nav = recordLocation(this.nav, this.loc) }
  back(): void { if (!canGoBack(this.nav)) return; this.nav = { ...this.nav, index: this.nav.index - 1 }; this.dispatch(restoreActionFor(this.nav.history[this.nav.index])) }
  forward(): void { if (!canGoForward(this.nav)) return; this.nav = { ...this.nav, index: this.nav.index + 1 }; this.dispatch(restoreActionFor(this.nav.history[this.nav.index])) }
}
const PERFECTH = 'queens of the stone age|||perfecth'

describe('nav-history — recordLocation', () => {
  it('pushes a new location and advances the index', () => {
    let s = start(L('songs'))
    s = recordLocation(s, L('albums'))
    assert.deepEqual(s.history.map((l) => l.view), ['songs', 'albums'])
    assert.equal(s.index, 1)
  })

  it('returns the SAME state object on a repeat of the current location (landing/no-op)', () => {
    const s = start(L('albums'))
    assert.equal(recordLocation(s, L('albums')), s) // identity — no push
  })

  it('distinguishes album-detail entries by albumKey', () => {
    let s = start(L('albums'))
    s = recordLocation(s, L('album-detail', { albumKey: 'a|||x' }))
    s = recordLocation(s, L('album-detail', { albumKey: 'a|||y' }))
    assert.equal(s.history.length, 3)
    assert.equal(s.index, 2)
  })

  it('truncates forward entries when navigating after a back', () => {
    let s = start(L('songs'))
    s = recordLocation(s, L('albums'))
    s = recordLocation(s, L('album-detail', { albumKey: 'k1' }))
    s = { history: s.history, index: 1 } // simulate goBack to albums
    s = recordLocation(s, L('album-detail', { albumKey: 'k2' })) // new nav
    assert.deepEqual(s.history.map((l) => l.albumKey), [null, null, 'k2'])
    assert.equal(s.index, 2) // k1 forward entry dropped
    assert.equal(canGoForward(s), false)
  })

  it('caps the stack length, keeping the newest', () => {
    let s = start(L('v0'))
    for (let i = 1; i < 150; i++) s = recordLocation(s, L('v' + i), 100)
    assert.equal(s.history.length, 100)
    assert.equal(s.history[s.history.length - 1].view, 'v149')
    assert.equal(s.index, 99)
  })
})

describe('nav-history — canGoBack / canGoForward', () => {
  it('reflect index position in the stack', () => {
    const s: NavHistory = { history: [L('a'), L('b'), L('c')], index: 1 }
    assert.equal(canGoBack(s), true)
    assert.equal(canGoForward(s), true)
    assert.equal(canGoBack({ ...s, index: 0 }), false)
    assert.equal(canGoForward({ ...s, index: 2 }), false)
  })
})

describe('nav-history — sameLoc', () => {
  it('compares all fields and handles undefined', () => {
    assert.equal(sameLoc(L('a'), L('a')), true)
    assert.equal(sameLoc(L('a'), L('b')), false)
    assert.equal(sameLoc(L('a', { albumKey: 'x' }), L('a', { albumKey: 'y' })), false)
    assert.equal(sameLoc(undefined, L('a')), false)
  })
})

describe('nav-history — locationOf reads a subject only while its view is showing', () => {
  it('a lingering playlist id does not belong to the album page you are on', () => {
    const onAlbum: NavigableState = { ...BOOT, currentView: 'album-detail', pendingAlbumKey: PERFECTH, activePlaylistId: 'pl-1', activeArtist: 'Geese' }
    assert.deepEqual(locationOf(onAlbum), L('album-detail', { albumKey: PERFECTH }))
  })
  it('two visits to Albums are the same place whatever lingers', () => {
    const a = locationOf({ ...BOOT, currentView: 'albums', pendingAlbumKey: PERFECTH })
    const b = locationOf({ ...BOOT, currentView: 'albums', activePlaylistId: 'pl-9' })
    assert.equal(sameLoc(a, b), true)
  })
})

describe('nav-history — restoreActionFor re-enters a page with the existing actions', () => {
  it('each page with a subject comes back as itself', () => {
    assert.deepEqual(restoreActionFor(L('album-detail', { albumKey: PERFECTH })), { type: 'VIEW_ALBUM_DETAIL', albumKey: PERFECTH })
    assert.deepEqual(restoreActionFor(L('artist-detail', { artist: 'Geese' })), { type: 'VIEW_ARTIST_DETAIL', artistName: 'Geese' })
    assert.deepEqual(restoreActionFor(L('playlist', { playlistId: 'pl-1' })), { type: 'VIEW_PLAYLIST', id: 'pl-1' })
    assert.deepEqual(restoreActionFor(L('smart-playlist', { smartPlaylistId: 'recently-added' })), { type: 'VIEW_SMART_PLAYLIST', id: 'recently-added' })
    assert.deepEqual(restoreActionFor(L('home')), { type: 'SET_VIEW', view: 'home' })
  })
  it('a page whose subject is missing falls back to its browse root, never a blank page', () => {
    assert.deepEqual(restoreActionFor(L('album-detail')), { type: 'SET_VIEW', view: 'albums' })
    assert.deepEqual(restoreActionFor(L('artist-detail')), { type: 'SET_VIEW', view: 'artists' })
    assert.deepEqual(restoreActionFor(L('playlist')), { type: 'SET_VIEW', view: 'songs' })
    assert.deepEqual(restoreActionFor(L('smart-playlist')), { type: 'SET_VIEW', view: 'songs' })
  })
})

// Jake, 2026-10-30: "page memory sucks ass... i flip from perfecth to a playlist
// page, and i dont have any way of going back to the perfecth page, it should
// not have to be that i have to go to the beginning of the albums page again
// to find perfecth then re-enter it".
describe('Jake\'s flow — Albums → Perfecth → a sidebar playlist → Back', () => {
  const openPerfecthThenPlaylist = (): NavModel => {
    const app = new NavModel()
    app.dispatch({ type: 'SET_VIEW', view: 'home' })
    app.dispatch({ type: 'SET_VIEW', view: 'albums' })                     // sidebar: Albums
    app.dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: PERFECTH })       // click the Perfecth card
    app.dispatch({ type: 'VIEW_PLAYLIST', id: 'pl-1' })                   // sidebar: a playlist
    return app
  }

  it('the sidebar click goes on the one history: Back is enabled and names the album page', () => {
    const app = openPerfecthThenPlaylist()
    assert.deepEqual(app.nav.history.map((l) => l.view), ['songs', 'home', 'albums', 'album-detail', 'playlist'])
    assert.equal(canGoBack(app.nav), true)
    assert.deepEqual(app.backTo, L('album-detail', { albumKey: PERFECTH }))
  })

  it('Back = the Perfecth page, Back again = Albums, Forward = the Perfecth page', () => {
    const app = openPerfecthThenPlaylist()
    const depth = app.nav.history.length
    app.back()
    assert.deepEqual(app.loc, L('album-detail', { albumKey: PERFECTH }), 'first back re-enters the album page')
    assert.equal(app.nav.history.length, depth, 'a landing records nothing new')
    assert.equal(canGoForward(app.nav), true)
    app.back()
    assert.deepEqual(app.loc, L('albums'), 'second back is the Albums grid')
    app.forward()
    assert.deepEqual(app.loc, L('album-detail', { albumKey: PERFECTH }), 'forward re-enters the album page')
    app.forward()
    assert.deepEqual(app.loc, L('playlist', { playlistId: 'pl-1' }), 'forward again is the playlist')
    assert.equal(canGoForward(app.nav), false)
  })

  it('an album entry with no album under it is the one thing Back cannot re-enter — it can only reach Albums, and Forward is lost', () => {
    // What the startup restore recorded before the fix: SET_VIEW 'album-detail'
    // by name (no key), then VIEW_PLAYLIST for the lingering id.
    const app = new NavModel()
    app.dispatch({ type: 'SET_VIEW', view: 'album-detail' })
    app.dispatch({ type: 'VIEW_PLAYLIST', id: 'mobile:74989a9a' })
    assert.deepEqual(app.nav.history.map((l) => l.view), ['songs', 'album-detail', 'playlist'])
    assert.equal(app.nav.history[1].albumKey, null)
    app.back()
    assert.deepEqual(app.loc, L('albums'), 'back lands on the Albums grid, not the album page')
    assert.equal(canGoForward(app.nav), false, 'and the playlist is gone from the forward side')
  })
})

describe('savedLocation — reopening the window lands on the page you were on', () => {
  // Jake's actual ui-state.json on 2026-10-30: on an album page, with the id of
  // a phone playlist he had visited earlier still saved beside it.
  const jakesFile = { currentView: 'album-detail', activePlaylistId: 'mobile:74989a9a-2623-42fc-a41c-db5754479693', activeSmartPlaylist: null, sidebarWidth: 291 }

  it('the album page comes back as that album — the lingering playlist id does not hijack it', () => {
    const loc = savedLocation({ ...jakesFile, pendingAlbumKey: PERFECTH })
    assert.deepEqual(loc, L('album-detail', { albumKey: PERFECTH }))
    assert.deepEqual(restoreActionFor(loc), { type: 'VIEW_ALBUM_DETAIL', albumKey: PERFECTH })
  })
  it('a ui-state written by an older build (no album key saved) reopens on Albums — not the playlist, not a blank album page', () => {
    assert.deepEqual(restoreActionFor(savedLocation(jakesFile)), { type: 'SET_VIEW', view: 'albums' })
  })
  it('and the reopened album page is then on the history like any other: sidebar playlist → Back = the album', () => {
    const app = new NavModel()
    app.dispatch(restoreActionFor(savedLocation({ ...jakesFile, pendingAlbumKey: PERFECTH })))
    app.dispatch({ type: 'VIEW_PLAYLIST', id: 'mobile:74989a9a-2623-42fc-a41c-db5754479693' })
    app.back()
    assert.deepEqual(app.loc, L('album-detail', { albumKey: PERFECTH }))
  })
  it('a playlist that WAS the page reopens as that playlist; a smart playlist likewise', () => {
    assert.deepEqual(restoreActionFor(savedLocation({ currentView: 'playlist', activePlaylistId: 'pl-1' })), { type: 'VIEW_PLAYLIST', id: 'pl-1' })
    assert.deepEqual(restoreActionFor(savedLocation({ currentView: 'smart-playlist', activeSmartPlaylist: 'top-25', activePlaylistId: null })), { type: 'VIEW_SMART_PLAYLIST', id: 'top-25' })
  })
  it('any other saved page ignores the lingering ids (Home stays Home)', () => {
    assert.deepEqual(restoreActionFor(savedLocation({ currentView: 'home', activePlaylistId: 'pl-1', pendingAlbumKey: PERFECTH, activeArtist: 'Geese' })), { type: 'SET_VIEW', view: 'home' })
  })
  it('an artist page comes back as that artist, or as Artists without one', () => {
    assert.deepEqual(restoreActionFor(savedLocation({ currentView: 'artist-detail', activeArtist: 'Geese' })), { type: 'VIEW_ARTIST_DETAIL', artistName: 'Geese' })
    assert.deepEqual(restoreActionFor(savedLocation({ currentView: 'artist-detail' })), { type: 'SET_VIEW', view: 'artists' })
  })
  it('first open → Home; the hidden Record Store placeholder → Songs; garbage is ignored', () => {
    assert.deepEqual(savedLocation(null), L('home'))
    assert.deepEqual(savedLocation({}), L('home'))
    assert.deepEqual(savedLocation({ currentView: 'recordstore' }), L('songs'))
    assert.deepEqual(savedLocation({ currentView: 42, activePlaylistId: ['x'] }), L('home'))
  })
})

describe('wiring: one rule for re-entering a page, used by Back/Forward AND the startup restore', () => {
  it('NavigationContext reads its location and replays entries through nav-history', () => {
    const ctx = src('context', 'NavigationContext.tsx')
    assert.match(ctx, /const loc: NavLocation = locationOf\(lib\)/)
    assert.match(ctx, /dispatch\(restoreActionFor\(t\)\)/)
  })
  it('App reopens the saved page with the same step, and no longer replays a lingering playlist id', () => {
    const app = src('App.tsx')
    assert.match(app, /restoreActionFor\(savedLocation\(ui\)\)/)
    assert.doesNotMatch(app, /VIEW_PLAYLIST', id: ui\.activePlaylistId/)
    assert.doesNotMatch(app, /VIEW_SMART_PLAYLIST', id: ui\.activeSmartPlaylist/)
  })
  it('App saves the subjects savedLocation reads', () => {
    const app = src('App.tsx')
    assert.match(app, /pendingAlbumKey: libState\.pendingAlbumKey,/)
    assert.match(app, /activeArtist: libState\.activeArtist,/)
  })
  it('the reducer twin in this file matches the real reducer (LibraryContext.tsx is do-not-touch)', () => {
    const lib = src('context', 'LibraryContext.tsx')
    assert.match(lib, /case 'SET_VIEW':\s*\n\s*return \{ \.\.\.state, currentView: action\.view, searchQuery: '' \}/)
    assert.match(lib, /case 'VIEW_PLAYLIST':\s*\n\s*return \{ \.\.\.state, currentView: 'playlist', activePlaylistId: action\.id, activeSmartPlaylist: null \}/)
    assert.match(lib, /case 'VIEW_SMART_PLAYLIST':\s*\n\s*return \{ \.\.\.state, currentView: 'smart-playlist', activeSmartPlaylist: action\.id, activePlaylistId: null \}/)
    assert.match(lib, /currentView: 'artist-detail',\s*\n\s*activeArtist: action\.artistName,/)
    assert.match(lib, /currentView: 'album-detail',\s*\n\s*pendingAlbumKey: action\.albumKey,/)
    assert.match(lib, /case 'CLEAR_PENDING_ALBUM_KEY':\s*\n\s*return \{ \.\.\.state, pendingAlbumKey: null \}/)
  })
})
