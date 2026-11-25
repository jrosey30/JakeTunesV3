/**
 * Right-click + drag on the Home (Jake, 2026-10-20: "i should also be able to
 * right click the songs/albums/whatever on the home page and also drag to the
 * queue, like it is a regular song in the library").
 *
 * The rule this locks: the Home offers the LIBRARY's menus and the LIBRARY's
 * drag payload — never a parallel copy. The song menu and the album menu are
 * built once (renderer/utils/libraryMenus.ts) and called by both the library
 * views and the Home; the Home's cards put utils/trackDrag.ts's payload on a
 * drag, the one every drop target reads.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

const menus = src('utils', 'libraryMenus.ts')
const songs = src('views', 'SongsView.tsx')
const albums = src('views', 'AlbumsView.tsx')
const host = src('components', 'HomeItemMenus.tsx')
const home = src('views', 'HomeView.tsx')
const shelves = src('components', 'HomeShelves.tsx')
const g = src('components', 'TonightOnJakeTunes.tsx')
const mixes = src('components', 'MadeForYou.tsx')
const hero = src('components', 'HomeHero.tsx')
const mfy = src('views', 'MadeForYouView.tsx')

describe('one song menu, one album menu', () => {
  it('libraryMenus builds both', () => {
    assert.match(menus, /export function songMenuEntries\(/)
    assert.match(menus, /export function albumMenuEntries\(/)
  })
  it('the Songs view and the Albums view build theirs with it — no inline copy left behind', () => {
    assert.match(songs, /songMenuEntries\(\{/)
    assert.doesNotMatch(songs, /'Fetch Artwork from Internet'|label: count > 1 \? `Delete \$\{count\} Songs`/)
    assert.match(albums, /albumMenuEntries\(\{/)
    assert.doesNotMatch(albums, /'Declare Live Concert Mode'/)
  })
  it('the Home opens the same two, with the Songs view\'s Get Info and delete confirmation', () => {
    assert.match(host, /songMenuEntries\(\{/)
    assert.match(host, /albumMenuEntries\(\{/)
    assert.match(host, /<GetInfoModal/)
    assert.match(host, /<DeleteSongsDialog/)
    assert.match(songs, /<DeleteSongsDialog/)
    assert.match(songs, /useGetInfoHandlers\(\)/)
    assert.match(host, /useGetInfoHandlers\(\)/)
  })
  it('no Home component draws a ContextMenu of its own', () => {
    for (const [name, text] of [['HomeView', home], ['HomeShelves', shelves], ['TonightOnJakeTunes', g], ['MadeForYou', mixes], ['HomeHero', hero], ['MadeForYouView', mfy]] as const) {
      assert.doesNotMatch(text, /<ContextMenu\b/, `${name} must go through HomeItemMenus`)
    }
  })
})

describe('the Home\'s items right-click and drag like library items', () => {
  it('every shelf row (Recently Added too, now songs) gets the song menu + a track drag', () => {
    assert.match(shelves, /onContextMenu=\{\(e\) => menus\?\.openSongMenu\(e, c\.track, play, queue, i\)\}/)
    assert.match(shelves, /onDragStart=\{\(e\) => setTrackDragPayload\(e, c\.track\.id\)\}/)
    assert.match(shelves, /title="Recently Added" scrollKey="home-row-recent"/)
  })
  it('the hero cover is an album; the island covers are albums; Now Digging drags as the artist, like an Artists tile', () => {
    // V7: the hero is HomeHero; the island Cover Flow + Now Digging moved to Made for You.
    assert.match(hero, /menus\?\.openAlbumMenu\(e, album\.tracks\)/)
    assert.match(hero, /setAlbumDragPayload\(e, ordered\.map/)
    assert.equal((g.match(/menus\?\.openAlbumMenu\(/g) ?? []).length, 1)
    assert.equal((g.match(/setAlbumDragPayload\(e, sortAlbumTracks\(/g) ?? []).length, 1)
    assert.match(g, /tracksForArtist\(tracks, d\.artist\)/)
  })
  it("a daily mix drags as its songs in order (Rediscover and Today's pick were cut in V7)", () => {
    assert.match(mixes, /onDragStart=\{\(e\) => setAlbumDragPayload\(e, m\.tracks\.map/)
  })
  it('Made for You is its own menu host, like the Home', () => {
    assert.match(mfy, /<HomeItemMenusProvider value=\{menus\.api\}>/)
    assert.match(mfy, /\{menus\.overlays\}/)
  })
  it('the menus and sheets render beside .home-view, outside its stacking context', () => {
    assert.match(home, /<\/div>\n(?:\s*\{\/\*[\s\S]*?\*\/\}\n)?\s*<ScrollTopButton targetRef=\{rootRef\} \/>\n\s*\{homeMenus\.overlays\}\n\s*<\/HomeItemMenusProvider>/)
  })
})
