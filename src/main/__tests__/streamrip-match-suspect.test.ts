/** The TopKnot case (2026-08-29): SoundCloud truncates descs at ~50 chars,
 *  hiding "(TopKnot 5 Years Later Remix)" from the version guard — a 5:57
 *  remix imported as the 3:07 song. An unclosed final paren = a hidden
 *  version marker = refused. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestSoundcloudMatch } from '../streamrip-match.ts'

const hit = (desc: string) => ({ source: 'soundcloud', mediaType: 'track', id: 'x', desc })

test('a truncated-paren desc is refused — the marker it hides cannot be checked', () => {
  assert.equal(pickBestSoundcloudMatch('5 Years Time', 'Noah And The Whale',
    [hit('Noah And The Whale - 5 Years Time (TopKnot 5 Years L by TopKnot')]), null)
  assert.equal(pickBestSoundcloudMatch('5 Years Time', 'Noah And The Whale',
    [hit('5 Years Time- Noah And The Whale (Bent Spectrum Re by Unknown')]), null)
})

test('a CLOSED paren still judges normally, and the clean original passes', () => {
  const clean = hit('5 Years Time by Noah And The Whale')
  assert.deepEqual(pickBestSoundcloudMatch('5 Years Time', 'Noah And The Whale', [clean]), clean)
  assert.equal(pickBestSoundcloudMatch('5 Years Time', 'Noah And The Whale',
    [hit('Noah And The Whale - 5 Years Time (Cover) by Someone')]), null)
})
