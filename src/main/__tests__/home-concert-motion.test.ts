// 2026-11-03 — Jake: "The animation for the concert area is very very cool. Try to mimic that
// throughout the home page wherever it makes the most sense. Like not album art. But other
// things." The concert card's moves (home.css), on the Home's other artist photos: NOW DIGGING's
// posters (TonightOnJakeTunes.tsx, home-tonight.css).
// V7 motion (Jake approved the plan, 2026-11-24): "Cut: the endless backdrop drift, drifting
// posters, the bouncing rank pop". What stays is the equalizer on the act playing now.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const tonight = readFileSync(new URL('../../renderer/components/TonightOnJakeTunes.tsx', import.meta.url), 'utf-8')
const css = readFileSync(new URL('../../renderer/styles/home-tonight.css', import.meta.url), 'utf-8')
const reduce = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))

describe('the concert motion on the Home', () => {
  it('the artist posters hold still (V7 cut the drift)', () => {
    assert.doesNotMatch(css, /tn-poster-drift/)
    assert.doesNotMatch(css, /\.tn-poster img \{[^}]*animation/)
  })

  it('the poster clips without becoming the scroller its photo\'s timeline would follow', () => {
    const poster = css.match(/\n\.tn-poster \{[^}]*\}/)?.[0] ?? ''
    assert.match(poster, /overflow: clip;/)
    assert.doesNotMatch(poster, /overflow: hidden;/)
  })

  it('album art never moves', () => {
    assert.doesNotMatch(css, /\.tn-(flow|art|cover)[\w-]* (img )?\{[^}]*animation:\s*(?!none)/)
  })

  it('the rank is simply there (V7 cut the bouncing pop); the playing act gets the equalizer', () => {
    assert.doesNotMatch(css, /tn-rank-in/)
    assert.doesNotMatch(css, /\.tn-dig-rank \{[^}]*animation/)
    assert.match(tonight, /<span className="tn-dig-rank" style=\{\{ '--i': i \} as CSSProperties\}>\{i \+ 1\}<\/span>\n\s+<DigPlaying artist=\{d\.artist\} \/>/)
    assert.match(tonight, /function DigPlaying\(\{ artist \}: \{ artist: string \}\)[\s\S]*?usePlayback\(\)[\s\S]*?className="home-concert-eq tn-dig-eq"/)
  })

  it('Reduce Motion stills what still moves (the global switch in motion.css does the rest)', () => {
    assert.match(reduce, /\.tn-case-plastic \{ animation: none; \}/)
  })
})
