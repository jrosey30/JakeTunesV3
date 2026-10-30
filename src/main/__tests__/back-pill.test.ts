// Jake, 2026-10-30: "never used those arrows. make going back obvious on every
// page." One back pill (components/chrome/BackButton.tsx) in a strip above every
// view that has no back control of its own; the album, artist and concert pages
// keep theirs where they sit — never two pills on one page, none when there is
// nothing to go back to.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { showsSharedBack, viewHasOwnBack, VIEWS_WITH_OWN_BACK } from '../../renderer/backPill.ts'

const src = (...p: string[]): string => readFileSync(join(import.meta.dirname, '..', '..', 'renderer', ...p), 'utf-8')
const allViews = (): string[] => {
  const m = src('types.ts').match(/export type ViewName = ([^\n]+)/)
  assert.ok(m, 'ViewName union found in types.ts')
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1])
}

describe('backPill — which pages the shell puts the pill on', () => {
  it('every page without a back control of its own, when there is somewhere to go back to', () => {
    const views = allViews()
    assert.ok(views.length >= 20)
    for (const v of views) assert.equal(showsSharedBack(v, true), !viewHasOwnBack(v), v)
    for (const v of ['songs', 'albums', 'artists', 'genres', 'playlist', 'smart-playlist', 'concerts', 'top1000', 'discovery', 'musicman']) {
      assert.equal(showsSharedBack(v, true), true, v)
    }
  })
  it('never on Home, the album, artist or concert page — they carry their own; no double back', () => {
    assert.deepEqual([...VIEWS_WITH_OWN_BACK], ['home', 'album-detail', 'artist-detail', 'concert-detail'])
    for (const v of VIEWS_WITH_OWN_BACK) assert.equal(showsSharedBack(v, true), false, v)
  })
  it('hidden everywhere when the history is empty (fresh launch)', () => {
    for (const v of allViews()) assert.equal(showsSharedBack(v, false), false, v)
  })
})

describe('wiring — one pill, one look', () => {
  it('the shell renders BackButton in its strip, gated by showsSharedBack, as a flex sibling above the view box', () => {
    const s = src('components', 'MainContent.tsx')
    assert.match(s, /const backStrip = showsSharedBack\(view, canGoBack\) && backLabel !== null/)
    assert.match(s, /\{backStrip && \(\s*<div className="view-back-strip">\s*<BackButton label=\{backLabel\} onClick=\{goBack\} \/>/)
    assert.equal(s.match(/<BackButton /g)?.length, 1, 'exactly one shared pill in the shell')
    assert.ok(s.indexOf('view-back-strip') < s.indexOf('<div className="main-content-shell-view">'), 'strip comes before the view box')
  })
  it('Home, the album, artist and concert pages render the same component — no raw back buttons remain', () => {
    for (const f of ['HomeView.tsx', 'AlbumDetailView.tsx', 'ArtistDetailView.tsx', 'ConcertDetailView.tsx']) {
      const s = src('views', f)
      assert.match(s, /<BackButton label=\{/, f)
      assert.doesNotMatch(s, /<button[^>]*className="(album-page-back|artist-detail-back|concert-back|home-back)/, f)
    }
    // Home's pill sits where the strip puts it everywhere else, over the hero,
    // and takes the strip's height when there is no hero to sit over.
    const home = src('styles', 'home.css')
    assert.match(home, /\.home-back \.back-pill \{\s*position: absolute;\s*top: 6px;\s*left: 16px;\s*\}/)
    assert.match(home, /\.home-view:not\(:has\(\.tn\)\) \.home-back \{ height: 36px; \}/)
    assert.match(src('views', 'HomeView.tsx'), /\{canNavBack && navBackLabel !== null && \(/)
    // the chevron is drawn once, in the component
    assert.doesNotMatch(src('views', 'AlbumDetailView.tsx'), /const ICON_BACK/)
    assert.match(src('components', 'chrome', 'BackButton.tsx'), /<svg width="9" height="10" viewBox="0 0 9 10"/)
  })
  it('the pill is one stylesheet: wraps long names (never ellipsizes), shows keyboard focus; the old skins are gone', () => {
    const css = src('styles', 'back-pill.css')
    assert.match(css, /\.back-pill\s*\{/)
    assert.match(css, /min-height: 24px/)
    assert.doesNotMatch(css, /text-overflow: ellipsis|white-space: nowrap/)
    assert.match(css, /\.back-pill:focus-visible/)
    assert.doesNotMatch(src('styles', 'album-page.css'), /\.album-page-back(\.apd-back)?\s*\{/)
    assert.doesNotMatch(src('styles', 'artist-detail.css'), /\.artist-detail-back:hover|backdrop-filter: blur\(8px\)/)
    assert.doesNotMatch(src('styles', 'concert-stage.css'), /\.concert-back/)
    assert.doesNotMatch(src('styles', 'concert-detail.css'), /\.concert-back:hover/)
  })
  it('the strip: 36px tall, 16px side padding, transparent, flex: none above a flex: 1 1 auto / min-height: 0 view box', () => {
    const css = src('styles', 'main-content.css')
    assert.match(css, /\.view-back-strip\s*\{[^}]*flex: none;[^}]*min-height: 36px;[^}]*padding: 6px 16px;/)
    assert.doesNotMatch(css, /\.view-back-strip\s*\{[^}]*background/)
    assert.match(css, /\.main-content-shell\s*\{[^}]*display: flex;[^}]*flex-direction: column;[^}]*height: 100%;/)
    assert.match(css, /\.main-content-shell-view\s*\{[^}]*position: relative;[^}]*flex: 1 1 auto;[^}]*min-height: 0;/)
  })
  it('history begins when the UI is up — no Back (and no pill) to the splash-covered first render', () => {
    assert.match(src('App.tsx'), /useEffect\(\(\) => \{ if \(uiReady\) beginHistory\(\) \}, \[uiReady, beginHistory\]\)/)
    const ctx = src('context', 'NavigationContext.tsx')
    assert.match(ctx, /beginHistory: \(\) => void/)
    assert.match(ctx, /navRef\.current = \{ history: \[locRef\.current\], index: 0 \}/)
  })
})
