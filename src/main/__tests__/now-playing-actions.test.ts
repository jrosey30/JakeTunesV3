/**
 * Act on what's playing (parity audit #7) — the phone's Now Playing taps and
 * cover menu, on the desktop pill and now-playing cover:
 *   - click the artist / album line → its page;
 *   - right-click the song lines or the cover → the library's song menu.
 * NowPlaying.tsx is Do-Not-Touch, so the pill is wrapped (event delegation);
 * these locks keep the class names the wrapper reads in step with it.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withSongMenuExtras } from '../../renderer/utils/songMenuExtras.ts'
import type { MenuEntry } from '../../renderer/components/ContextMenu.tsx'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

describe('withSongMenuExtras', () => {
  const del = (): void => {}
  const menu: MenuEntry[] = [
    { label: 'Play "x"', onClick: () => {} },
    { separator: true },
    { label: 'Cynthia!!', onClick: () => {} },
    { separator: true },
    { label: 'Delete Song', onClick: del },
  ]
  it('leaves the menu alone with no extras', () => {
    assert.equal(withSongMenuExtras(menu, del), menu)
  })
  it('omitDelete drops the entry wired to the delete action and its separator', () => {
    const out = withSongMenuExtras(menu, del, { omitDelete: true })
    assert.deepEqual(out.map((m) => (m.separator ? '—' : m.label)), ['Play "x"', '—', 'Cynthia!!'])
  })
  it('finds Delete by identity, not by its label', () => {
    const renamed: MenuEntry[] = [{ label: 'Delete Song', onClick: () => {} }, { separator: true }, { label: 'Remove', onClick: del }]
    const out = withSongMenuExtras(renamed, del, { omitDelete: true })
    assert.deepEqual(out.map((m) => (m.separator ? '—' : m.label)), ['Delete Song'])
  })
  it('extra entries go last, after a separator', () => {
    const out = withSongMenuExtras(menu, del, { extra: [{ label: 'Remove Artwork', onClick: () => {} }] })
    assert.deepEqual(out.slice(-2).map((m) => (m.separator ? '—' : m.label)), ['—', 'Remove Artwork'])
  })
})

describe('the toolbar pill acts on what is playing', () => {
  const nowPlaying = src('components', 'playback', 'NowPlaying.tsx')
  const actions = src('components', 'playback', 'NowPlayingActions.tsx')
  const toolbar = src('components', 'playback', 'Toolbar.tsx')
  const css = src('styles', 'toolbar.css')
  const menus = src('utils', 'libraryMenus.ts')

  it('Toolbar wraps the pill', () => {
    assert.match(toolbar, /<NowPlayingActions><NowPlaying \/><\/NowPlayingActions>/)
    assert.match(css, /\.np-actions \{ display: contents; \}/)
  })

  it('the classes the wrapper reads are the ones NowPlaying renders', () => {
    for (const cls of ['now-playing-artist', 'now-playing-album']) {
      assert.match(nowPlaying, new RegExp(`className="${cls}"`))
      assert.match(actions, new RegExp(`'\\.${cls}'`))
    }
    assert.match(nowPlaying, /className="now-playing-info now-playing-info--stacked"/)
    assert.match(nowPlaying, /'now-playing-pill--activity'/)
    assert.match(actions, /closest<HTMLElement>\('\.now-playing-info--stacked'\)/)
    assert.match(actions, /classList\.contains\('now-playing-pill--activity'\)/)
  })

  it('artist → the artist page and album → the album page, the song menu\'s own targets', () => {
    assert.match(menus, /VIEW_ARTIST_DETAIL', artistName: canonicalArtist\(track\.albumArtist \|\| track\.artist \|\| ''\)/)
    assert.match(actions, /canonicalArtist\(track\.albumArtist \|\| track\.artist \|\| ''\)/)
    assert.match(actions, /type: 'VIEW_ARTIST_DETAIL', artistName/)
    assert.match(actions, /type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyOf\(track\)/)
  })

  it('no click-through over a preview or a concert; right-click opens the library song menu', () => {
    assert.match(actions, /if \(previewPlaying\(\)\) return null/)
    assert.match(actions, /if \(!track \|\| isConcert \|\| !songLinesAt\(e\.target\)\) return/)
    assert.match(actions, /api\.openSongMenu\(e, song,[^)]*\)[^\n]*omitDelete: isConcert/)
  })

  it('the menu acts on the library copy, so Star / Unstar reads the song as it is now', () => {
    assert.match(actions, /const song = lib\.tracks\.find\(\(t\) => t\.id === track\.id\) \?\? track/)
    assert.match(src('components', 'sidebar', 'AlbumArtPanel.tsx'), /const track = libState\.tracks\.find\(\(t\) => t\.id === playing\.id\) \?\? playing/)
  })
})

describe('the now-playing cover opens the song menu', () => {
  const panel = src('components', 'sidebar', 'AlbumArtPanel.tsx')
  it('right-click → the library song menu, with Remove Artwork kept', () => {
    assert.match(panel, /songMenus\.openSongMenu\(e, track,/)
    assert.match(panel, /label: 'Remove Artwork', onClick: \(\) => \{ void handleRemoveArtwork\(\) \}/)
    assert.match(panel, /onContextMenu=\{handleContextMenu\}/)
  })
  it('Add / Fetch artwork still exist — in the song menu, same calls', () => {
    const menus = src('utils', 'libraryMenus.ts')
    assert.match(menus, /label: 'Add Artwork…'/)
    assert.match(menus, /label: 'Fetch Artwork from Internet'/)
    assert.match(menus, /fetchAlbumArt\(artist, album, true\)/)
  })
})
