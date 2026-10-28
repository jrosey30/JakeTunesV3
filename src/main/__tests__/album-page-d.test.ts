// Album page direction D (Jake 2026-10-27: "build D") — source locks.
// Record-sleeve header on brushed metal over a classic iTunes table. These
// pin the behaviours the redesign had to keep and the rules it had to meet,
// so a later restyle can't quietly drop one.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', 'renderer')
const view = readFileSync(join(root, 'views', 'AlbumDetailView.tsx'), 'utf-8')
const css = readFileSync(join(root, 'styles', 'album-page.css'), 'utf-8')
const dCss = css.slice(css.indexOf('Direction D'))

describe('album page D — kept behaviours', () => {
  it('rows still play on double-click, open the song menu, drag to the queue', () => {
    assert.match(view, /onDoubleClick=\{\(\) => handleDoubleClick\(idx\)\}/)
    assert.match(view, /onContextMenu=\{\(e\) => handleContextMenu\(e, track, idx\)\}/)
    assert.match(view, /onDragStart=\{\(e\) => handleRowDragStart\(track, e\)\}/)
    assert.match(view, /application\/jaketunes-tracks/)
  })
  it('the Star column toggles the same rating write as the Songs list', () => {
    assert.match(view, /handleRatingChange\(track\.id, starred \? 0 : 5\)/)
  })
  it('missing-audio badge, now-playing speaker and Cmd+I survive', () => {
    assert.match(view, /songs-cell-missing-badge/)
    assert.match(view, /isPlaying \? <SpeakerPlayingIcon \/>/)
    assert.match(view, /'jaketunes-get-info'/)
  })
  it('keyboard: ↑/↓ move the selection, Return plays, without nudging the volume', () => {
    assert.match(view, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/)
    assert.match(view, /e\.stopPropagation\(\)/)
    assert.match(view, /window\.addEventListener\('keydown', onKey, true\)/)
  })
  it('the Artist column appears only on multi-artist albums', () => {
    assert.match(view, /const multiArtist = new Set\(tracks\.map/)
    assert.match(view, /\{multiArtist && <div className="apd-th" role="columnheader">Artist<\/div>\}/)
  })
  it("the Music Man's take is fetched with the page, not behind a click", () => {
    assert.match(view, /const takeCall = window\.electronAPI\.getAlbumTake\?\./)
    assert.doesNotMatch(view, /handleToggleTake/)
  })
  it('the history is shown in full (no clamp on the bio)', () => {
    const bio = dCss.slice(dCss.indexOf('.apd-bio {'), dCss.indexOf('}', dCss.indexOf('.apd-bio {')))
    assert.doesNotMatch(bio, /line-clamp/)
  })
  it('the disc handoff still finds the cover box', () => {
    assert.match(view, /className="album-page-cover apd-cover"/)
  })
  it('pager reads "1 of N" under "More by <Artist>"', () => {
    assert.match(view, /More by \{albumArtist\}/)
    assert.match(view, /\{curIdx \+ 1\} of \{siblingAlbums\.length\}/)
  })
})

describe('album page D — standing rules', () => {
  it('names never ellipsize in the D styles', () => {
    assert.doesNotMatch(dCss, /text-overflow:\s*ellipsis/)
  })
  it('small orange text uses the text-safe orange token', () => {
    const vars = readFileSync(join(root, 'styles', 'variables.css'), 'utf-8')
    assert.match(vars, /--accent-text:\s*#C14201;/)
    for (const sel of ['.apd-artist {', '.apd-take-more {']) {
      const block = dCss.slice(dCss.indexOf(sel), dCss.indexOf('}', dCss.indexOf(sel)))
      assert.match(block, /color: var\(--accent-text\)/, sel)
    }
  })
  it('no emoji glyphs in the view', () => {
    assert.doesNotMatch(view, /[\u{1F300}-\u{1FAFF}]/u)
  })
})
