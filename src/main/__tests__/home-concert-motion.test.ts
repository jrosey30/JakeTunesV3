// 2026-11-03 — Jake: "The animation for the concert area is very very cool. Try to mimic that
// throughout the home page wherever it makes the most sense. Like not album art. But other
// things." The concert card's moves (home.css), on the Home's other artist photos: NOW DIGGING's
// posters (TonightOnJakeTunes.tsx, home-tonight.css).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const tonight = readFileSync(new URL('../../renderer/components/TonightOnJakeTunes.tsx', import.meta.url), 'utf-8')
const css = readFileSync(new URL('../../renderer/styles/home-tonight.css', import.meta.url), 'utf-8')
const reduce = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))

describe('the concert motion on the Home', () => {
  it('the artist posters drift with the scroll, scroll-driven, as the concert photos drift with their rail', () => {
    assert.match(css, /@supports \(animation-timeline: view\(\)\) \{\n  \.tn-poster img \{\n    height: calc\(100% \+ 28px\);\n    margin-top: -14px;\n    animation: tn-poster-drift linear both;\n    animation-timeline: view\(\);/)
    assert.match(css, /@keyframes tn-poster-drift \{\n  from \{ transform: translateY\(14px\); \}\n  to \{ transform: translateY\(-14px\); \}/)
  })

  it('the poster clips without becoming the scroller its photo\'s timeline would follow', () => {
    const poster = css.match(/\n\.tn-poster \{[^}]*\}/)?.[0] ?? ''
    assert.match(poster, /overflow: clip;/)
    assert.doesNotMatch(poster, /overflow: hidden;/)
  })

  it('album art never moves: the drift is on the posters\' artist photos only', () => {
    const drifting = [...css.matchAll(/([^{}]+)\{[^{}]*animation: tn-poster-drift/g)].map((m) => m[1]!.trim())
    assert.deepEqual(drifting, ['.tn-poster img'])
    assert.ok(!/tn-flow|tn-art|tn-cover/.test(drifting.join(' ')))
  })

  it('the ranks flip down like the date stubs, one poster after another; the playing act gets the equalizer', () => {
    assert.match(css, /\.tn-dig-rank \{\n  transform-origin: top center;\n  animation: tn-rank-in 420ms cubic-bezier\(0\.3, 1\.5, 0\.5, 1\) both;\n  animation-delay: calc\(80ms \+ var\(--i, 0\) \* 70ms\);/)
    assert.match(tonight, /<span className="tn-dig-rank" style=\{\{ '--i': i \} as CSSProperties\}>\{i \+ 1\}<\/span>\n\s+<DigPlaying artist=\{d\.artist\} \/>/)
    assert.match(tonight, /function DigPlaying\(\{ artist \}: \{ artist: string \}\)[\s\S]*?usePlayback\(\)[\s\S]*?className="home-concert-eq tn-dig-eq"/)
  })

  it('Reduce Motion stills all of it', () => {
    assert.match(reduce, /\.tn-poster img \{ animation: none; height: 100%; margin-top: 0; \}/)
    assert.match(reduce, /\.tn-dig-rank \{ animation: none; \}/)
  })
})
