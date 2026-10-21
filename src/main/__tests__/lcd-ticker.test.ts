/**
 * Names never clip on the toolbar LCD — the phone's TickerText numbers
 * (common/lcd-ticker.ts) and the wiring that applies them to the pill.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planLcdFit, LCD_TICKER } from '../../common/lcd-ticker.ts'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const src = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')

describe('planLcdFit — the phone ticker decision', () => {
  it('a name that fits stays as it is', () => {
    assert.deepEqual(planLcdFit(180, 200), { kind: 'static' })
    assert.deepEqual(planLcdFit(200, 200), { kind: 'static' })
    assert.deepEqual(planLcdFit(500, 0), { kind: 'static' }, 'unmeasured container: leave it alone')
  })

  it('up to 20% too long shrinks just enough, never below 83%', () => {
    const p = planLcdFit(220, 200)
    assert.equal(p.kind, 'shrink')
    if (p.kind === 'shrink') {
      assert.ok(p.scale * 220 <= 200, 'shrunk name fits')
      assert.ok(p.scale >= LCD_TICKER.minScale)
    }
    const edge = planLcdFit(240, 200)
    assert.equal(edge.kind, 'shrink')
    if (edge.kind === 'shrink') assert.ok(edge.scale * 240 <= 200)
  })

  it('more than 20% too long scrolls at 24 px/s with the phone pauses', () => {
    const p = planLcdFit(400, 200)
    assert.equal(p.kind, 'ticker')
    if (p.kind !== 'ticker') return
    assert.equal(p.distance, 400 - 200 + 16)
    const scroll = p.distance / 24
    assert.equal(p.durationMs, Math.round((1.5 + scroll + 0.8 + 0.4) * 1000))
    const xs = p.keyframes.map((k) => k.x)
    assert.deepEqual(xs, [0, 0, -216, -216, 0, 0], 'hold, slide, hold, snap back, rest')
    const offs = p.keyframes.map((k) => k.offset)
    assert.deepEqual([...offs].sort((a, b) => a - b), offs, 'offsets never go backwards')
    assert.equal(offs[3], offs[4], 'the snap back is a cut, not a slide')
  })

  it('a barely-scrolling name still moves a readable distance, for at least 2 s', () => {
    const p = planLcdFit(241, 200)
    assert.equal(p.kind, 'ticker')
    if (p.kind === 'ticker') {
      assert.ok(p.distance >= LCD_TICKER.minScrollDistance)
      assert.ok(p.durationMs >= (1.5 + 2 + 0.8 + 0.4) * 1000)
    }
  })
})

describe('the toolbar pill wears the ticker', () => {
  const css = src('styles', 'toolbar.css')
  const toolbar = src('components', 'playback', 'Toolbar.tsx')
  const nowPlaying = src('components', 'playback', 'NowPlaying.tsx')
  const hook = src('components', 'playback', 'lcdTicker.ts')

  it('no "…" on the song / artist / album lines', () => {
    for (const cls of ['primary', 'secondary', 'tertiary']) {
      const rule = new RegExp(`\\.now-playing-line-${cls} \\{[^}]*\\}`).exec(css)?.[0] ?? ''
      assert.ok(rule, `.now-playing-line-${cls} rule exists`)
      assert.doesNotMatch(rule, /ellipsis|line-clamp/)
    }
  })

  it('the hook reads the lines NowPlaying renders', () => {
    for (const cls of ['now-playing-line-primary', 'now-playing-line-secondary', 'now-playing-line-tertiary']) {
      assert.match(nowPlaying, new RegExp(`className="${cls}"`))
      assert.match(hook, new RegExp(`\\.${cls}`))
    }
  })

  it('Toolbar attaches it to its own root', () => {
    assert.match(toolbar, /useLcdTicker\(toolbarRef\)/)
    assert.match(toolbar, /<div className="toolbar" ref=\{toolbarRef\}>/)
  })
})
