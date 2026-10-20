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
    for (const [name, text] of [['HomeView', home], ['HomeShelves', shelves], ['TonightOnJakeTunes', g], ['MadeForYou', mixes]] as const) {
      assert.doesNotMatch(text, /<ContextMenu\b/, `${name} must go through HomeItemMenus`)
    }
  })
})

describe('the Home\'s items right-click and drag like library items', () => {
  it('shelf songs: the song menu + a track drag; Recently Added: the album menu + an album drag', () => {
    assert.match(shelves, /onContextMenu=\{\(e\) => menus\?\.openSongMenu\(e, c\.track, play, queue, i\)\}/)
    assert.match(shelves, /onDragStart=\{\(e\) => setTrackDragPayload\(e, c\.track\.id\)\}/)
    assert.match(shelves, /onContextMenu=\{\(e\) => menus\?\.openAlbumMenu\(e, card\.tracks\)\}/)
    assert.match(shelves, /onDragStart=\{\(e\) => setAlbumDragPayload\(e, card\.tracks\.map/)
  })
  it('G: the hero and island covers are albums; Now Digging drags as the artist, like an Artists tile', () => {
    assert.equal((g.match(/menus\?\.openAlbumMenu\(/g) ?? []).length, 2)
    assert.equal((g.match(/setAlbumDragPayload\(e, sortAlbumTracks\(/g) ?? []).length, 2)
    assert.match(g, /tracksForArtist\(tracks, d\.artist\)/)
  })
  it("Today's pick is an album; Rediscover an artist; a daily mix drags as its songs in order", () => {
    assert.match(home, /homeMenus\.api\.openAlbumMenu\(e, featuredAlbum\.tracks\)/)
    assert.match(home, /setAlbumDragPayload\(e, sortAlbumTracks\(featuredAlbum\.tracks\)/)
    assert.match(home, /tracksForArtist\(regularTracks, pick\.artist\)/)
    assert.match(mixes, /onDragStart=\{\(e\) => setAlbumDragPayload\(e, m\.tracks\.map/)
  })
  it('the menus and sheets render beside .home-view, outside its stacking context', () => {
    assert.match(home, /<\/div>\n(?:\s*\{\/\*[\s\S]*?\*\/\}\n)?\s*<ScrollTopButton targetRef=\{rootRef\} \/>\n\s*\{homeMenus\.overlays\}\n\s*<\/HomeItemMenusProvider>/)
  })
})
