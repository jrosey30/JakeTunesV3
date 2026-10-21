/**
 * A concert starts at the top (Jake, 2026-08-08: "why am i able to select a
 * track in live concert mode....it should start from track 1 thats it").
 *
 * The phone made the setlist a map long ago (LiveConcertsView startShow);
 * the desktop's concert page and the album page's setlist still seeked to
 * the clicked song. This locks the desktop to the phone's rule:
 *   - the pure plan (common/concert-start.ts),
 *   - both desktop setlists route every click through it and never seek.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planConcertStart } from '../../common/concert-start.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

describe('planConcertStart', () => {
  it('a show that is not playing starts from the top', () => {
    assert.deepEqual(planConcertStart({ showIsCurrent: false, repeat: 'off' }), { action: 'play-from-top', clearRepeatOne: false })
    assert.deepEqual(planConcertStart({ showIsCurrent: false, repeat: 'all' }), { action: 'play-from-top', clearRepeatOne: false })
  })
  it('a stale repeat-one is switched off so it cannot loop the whole set', () => {
    assert.deepEqual(planConcertStart({ showIsCurrent: false, repeat: 'one' }), { action: 'play-from-top', clearRepeatOne: true })
  })
  it('a click while the show is already the current track does nothing', () => {
    assert.deepEqual(planConcertStart({ showIsCurrent: true, repeat: 'off' }), { action: 'none' })
    assert.deepEqual(planConcertStart({ showIsCurrent: true, repeat: 'one' }), { action: 'none' })
  })
})

describe('the desktop setlists are a map, not a menu', () => {
  for (const [name, file] of [
    ['concert page', src('views', 'ConcertDetailView.tsx')],
    ['album page setlist', src('views', 'AlbumDetailView.tsx')],
  ] as const) {
    it(`${name}: every click runs the one start rule`, () => {
      assert.match(file, /planConcertStart\(\{ showIsCurrent: setPlaying, repeat: pb\.repeat \}\)/)
    })
    it(`${name}: no seek into the show from a song click`, () => {
      assert.doesNotMatch(file, /\bseek\(/)
      assert.doesNotMatch(file, /const \{[^}]*\bseek\b[^}]*\} = useAudio\(\)/)
      assert.doesNotMatch(file, /Jump to "/)
    })
  }
})
