/**
 * Synced lyrics on the desktop (parity audit #6) — the phone's rules
 * (common/lyrics-rules.ts, twin of JakeTunesMobile backend lyricsRules.ts /
 * lyrics.ts and Lyrics.swift) and the wiring that puts the sheet in the
 * right-hand panel slot.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseLRC, stripLRC, trackLyricsFrom, currentLyricIndex, LYRICS_FOLLOW_MS, LYRICS_HAND_SCROLL_HOLD_MS } from '../../common/lyrics-rules.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

describe('parseLRC / stripLRC — same fixtures as the phone backend', () => {
  it('stamps become sorted ms lines, multi-stamp lines expand', () => {
    const lines = parseLRC('[00:06.33] second\n[00:00.51] first\n[00:10.1][00:20.10] chorus\n\n[00:30.5]')
    assert.deepEqual(lines, [
      { t: 510, text: 'first' },
      { t: 6330, text: 'second' },
      { t: 10100, text: 'chorus' },
      { t: 20100, text: 'chorus' },
      { t: 30500, text: '' },
    ])
  })
  it('three-digit fractions and colon fractions read as ms', () => {
    assert.deepEqual(parseLRC('[01:02.345] a\n[00:03:5] b'), [{ t: 3500, text: 'b' }, { t: 62345, text: 'a' }])
  })
  it('lines without a stamp are not lyric lines', () => {
    assert.deepEqual(parseLRC('[ar: someone]\nno stamp\n[00:01.00] one'), [{ t: 1000, text: 'one' }])
  })
  it('stripLRC drops stamps and collapses runs of blank lines', () => {
    assert.equal(stripLRC('[00:00.51] a\n[00:01.00]\n[00:02.00]\n[00:03.00] b'), 'a\n\nb')
  })
})

describe('trackLyricsFrom — the phone backend lyricsFor shaping', () => {
  it('nothing, a miss, or an empty record is "no lyrics"', () => {
    assert.equal(trackLyricsFrom(null), null)
    assert.equal(trackLyricsFrom(undefined), null)
    assert.equal(trackLyricsFrom({ miss: true, plain: 'x' }), null)
    assert.equal(trackLyricsFrom({}), null)
    assert.equal(trackLyricsFrom({ plain: '   ' }), null)
  })
  it('instrumental is a sheet that says so, with no text', () => {
    assert.deepEqual(trackLyricsFrom({ instrumental: true, plain: 'x' }), { lines: [], plain: '', instrumental: true })
  })
  it('plain only → no lines, the trimmed plain sheet', () => {
    assert.deepEqual(trackLyricsFrom({ plain: '  a\nb  ' }), { lines: [], plain: 'a\nb', instrumental: false })
  })
  it('synced → lines, and the plain sheet falls back to the stamps cut off', () => {
    const out = trackLyricsFrom({ synced: '[00:01.00] a\n[00:02.00] b' })
    assert.deepEqual(out, { lines: [{ t: 1000, text: 'a' }, { t: 2000, text: 'b' }], plain: 'a\nb', instrumental: false })
  })
})

describe('currentLyricIndex — the last line whose stamp has passed', () => {
  const lines = [{ t: 1000, text: 'a' }, { t: 2000, text: '' }, { t: 3000, text: 'c' }]
  it('−1 before the first line', () => {
    assert.equal(currentLyricIndex(lines, 0), -1)
    assert.equal(currentLyricIndex(lines, 999), -1)
    assert.equal(currentLyricIndex([], 5000), -1)
  })
  it('on and between stamps', () => {
    assert.equal(currentLyricIndex(lines, 1000), 0)
    assert.equal(currentLyricIndex(lines, 1999), 0)
    assert.equal(currentLyricIndex(lines, 2000), 1)
    assert.equal(currentLyricIndex(lines, 3000), 2)
    assert.equal(currentLyricIndex(lines, 999_999), 2)
  })
  it("the phone's timings", () => {
    assert.equal(LYRICS_HAND_SCROLL_HOLD_MS, 4000)
    assert.equal(LYRICS_FOLLOW_MS, 350)
  })
})

describe('the Lyrics panel is wired like Up Next', () => {
  const app = src('App.tsx')
  const toolbar = src('components', 'playback', 'Toolbar.tsx')
  const toggle = src('components', 'playback', 'LyricsToggle.tsx')
  const panel = src('components', 'playback', 'LyricsPanel.tsx')
  const store = src('lyricsStore.ts')
  const menu = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')

  it('the toolbar panel group carries the Lyrics button', () => {
    assert.match(toolbar, /<LyricsToggle open=\{showLyrics\} onToggle=\{onToggleLyrics\} \/>/)
    assert.match(app, /onToggleLyrics=\{toggleLyrics\}/)
    assert.match(app, /\{showLyrics && <LyricsPanel ref=\{lyricsRef\} onClose=\{\(\) => setShowLyrics\(false\)\} \/>\}/)
  })

  it('View → Lyrics (⇧⌘L) reaches the same toggle', () => {
    assert.match(menu, /label: 'Lyrics', accelerator: 'Shift\+CmdOrCtrl\+L', click: \(\) => sendMenuAction\('toggle-lyrics'\)/)
    assert.match(app, /case 'toggle-lyrics': toggleLyricsRef\.current\(\); break/)
    assert.match(toggle, /title="Lyrics \(⇧⌘L\)"/)
    // ⌘L (Go to Current Song) stands aside for ⇧⌘L — one press, one action.
    assert.match(app, /\(e\.metaKey \|\| e\.ctrlKey\) && !e\.shiftKey && e\.key === 'l'/)
  })

  it('one right-hand drawer at a time: every other opener closes Lyrics', () => {
    const opens = app.match(/setShow(?:Queue|MusicMan|Downloads)\(true\)/g) ?? []
    const closes = app.match(/lyricsRef\.current\?\.requestClose\(\);[^\n]*setShow(?:Queue|MusicMan|Downloads)\(true\)/g) ?? []
    assert.ok(opens.length >= 5)
    assert.equal(closes.length, opens.length, 'an opener that leaves Lyrics open stacks two drawers')
  })

  it("opens only on a song with a sheet (the phone's guard)", () => {
    assert.match(app, /if \(lyricsFor\(pbState\.nowPlaying\?\.id\) == null\) return/)
    assert.match(toggle, /const usable = open \|\| hasLyrics/)
  })

  it("the phone's wording", () => {
    assert.match(panel, />No lyrics for this song</)
    assert.match(panel, />Instrumental</)
    assert.match(panel, /className="queue-title">Lyrics</)
  })

  it('smooth: the line list re-renders on a line change, not per tick', () => {
    assert.match(panel, /const SyncedLines = memo\(/)
    assert.match(panel, /<SyncedLines lines=\{lines\} idx=\{idx\} onPick=\{pick\} \/>/)
    assert.match(panel, /prefers-reduced-motion: reduce/)
  })

  it('the store keeps the phone states and bound', () => {
    assert.match(store, /if \(cache\.size > 48\) cache\.clear\(\)/)
    assert.match(store, /trackLyricsFrom\(/)
  })

  it('NowPlaying.tsx (Do-Not-Touch) is not where the lyrics live', () => {
    assert.doesNotMatch(src('components', 'playback', 'NowPlaying.tsx'), /lyric/i)
  })
})
