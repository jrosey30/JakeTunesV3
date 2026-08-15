/**
 * What the personas read from Exa, kept honest.
 *
 * The junk inputs in these tests are not invented — they are lifted from the
 * real exa-cache entries found on 2026-08-15, where `highlights: true` on a
 * Pitchfork review returned "Release Date:", a bare "2017", the page title
 * again, and "..." separators. The Music Man was grounded in that for six
 * weeks. If the filter regresses, he goes back to reviewing boilerplate.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatExaResults,
  MAX_CHARS_PER_RESULT,
  MAX_CHARS_PER_BLOCK,
} from '../exa-format.ts'

const HEADER = '[Exa music journalism]'

describe('summary-first formatting', () => {
  test('a directed summary is used verbatim', () => {
    const out = formatExaResults([{
      title: 'Migos: Culture Album Review | Pitchfork',
      url: 'https://pitchfork.com/reviews/albums/migos-culture/',
      publishedDate: '2017-01-31T00:00:00.000Z',
      summary: 'Pitchfork deems Culture a definitive rebound, praising the triplet flow.',
      highlights: ['Release Date:', '2017'],
    }], HEADER)
    assert.ok(out.includes('definitive rebound'))
    assert.ok(!out.includes('Release Date:'), 'junk highlights must not appear when a summary exists')
    assert.ok(out.startsWith(HEADER))
    assert.ok(out.includes('(2017-01-31)'), 'date is kept — recency claims need it')
  })

  test('the real observed junk lines die in the fallback path too', () => {
    // Exactly what the live cache contained for the Kneecap FENIAN lookup.
    const out = formatExaResults([{
      title: 'Kneecap: FENIAN Album Review | Pitchfork',
      url: 'https://pitchfork.com/reviews/albums/kneecap-fenian/',
      highlights: [
        'Kneecap: FENIAN Album Review | Pitchfork',  // the page title again
        'Release Date:',
        '2026',
        '...',
        'Reviewed April 30, 2026',
        'The trio sharpen their bilingual provocations into their most focused record yet.',
      ],
    }], HEADER)
    assert.ok(out.includes('bilingual provocations'), 'the one real sentence survives')
    assert.ok(!out.includes('Release Date:'))
    assert.ok(!/\n\s*2026\s*\n/.test(out), 'a bare year line is not information')
    assert.ok(!out.includes('Reviewed April 30'), 'review-date crumbs are not criticism')
    // The title line itself is fine — it's the highlighter RE-SERVING the
    // title as content that must go.
    const [, ...contentLines] = out.split('\n')
    const contentText = contentLines.filter(l => !l.trim().startsWith('•') && !l.trim().startsWith('https')).join('\n')
    assert.ok(!contentText.includes('FENIAN Album Review | Pitchfork'), 'title-as-highlight must be filtered')
  })

  test('a result with nothing left after filtering is dropped entirely', () => {
    const out = formatExaResults([
      { title: 'Empty | Pitchfork', url: 'https://x.test', highlights: ['Release Date:', '2019', '...'] },
      { title: 'Real', url: 'https://y.test', summary: 'An actual take.' },
    ], HEADER)
    assert.ok(!out.includes('x.test'), 'a source with no content is not a source')
    assert.ok(out.includes('An actual take.'))
  })

  test('no usable results → empty string, so callers treat it as a miss', () => {
    assert.equal(formatExaResults([], HEADER), '')
    assert.equal(formatExaResults([{ title: 'T', url: 'u', highlights: ['2020'] }], HEADER), '')
  })
})

describe('size discipline', () => {
  test('one runaway summary cannot exceed the per-result cap', () => {
    const out = formatExaResults([{
      title: 'T', url: 'https://u.test', summary: 'x'.repeat(MAX_CHARS_PER_RESULT * 3),
    }], HEADER)
    assert.ok(out.length < MAX_CHARS_PER_RESULT + 200)
  })

  test('the whole block stays under the budget no matter how many results', () => {
    const results = Array.from({ length: 12 }, (_, i) => ({
      title: `Source ${i}`, url: `https://s${i}.test`, summary: 'y'.repeat(1000),
    }))
    const out = formatExaResults(results, HEADER)
    assert.ok(out.length <= MAX_CHARS_PER_BLOCK + HEADER.length + 100,
      `block is ${out.length} chars — the 34KB firehose came back`)
  })
})
