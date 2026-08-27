/**
 * 2026-08-26 — Jake, screenshotting a search result reading 0:29:
 * "WHAT THE FUCK IS THIS????" Matt and Kim's "Let's Go" was being offered at
 * twenty-nine seconds. There was no minimum-duration guard anywhere in search,
 * so a 30-second snippet ranked like the real record and would have downloaded
 * as one. (Confirmed it never reached his library — the row was a search
 * result, not a track.)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPreviewLengthResult, PREVIEW_MAX_SECS } from '../download-search.ts'

describe('isPreviewLengthResult', () => {
  test('rejects a 30-second snippet of a real song', () => {
    assert.equal(isPreviewLengthResult(29, "Let's Go"), true)
    assert.equal(isPreviewLengthResult(30, 'Daylight'), true)
  })

  test('KEEPS the deliberately short pieces Jake actually owns', () => {
    // 122 tracks in his library are under 45s and every one announces itself.
    assert.equal(isPreviewLengthResult(11, 'Paul (Skit)'), false)
    assert.equal(isPreviewLengthResult(10, 'Horn Intro'), false)
    assert.equal(isPreviewLengthResult(6, 'Promiscuous (Interlude)'), false)
    assert.equal(isPreviewLengthResult(12, 'Miracle Cure — Outro'), false)
    assert.equal(isPreviewLengthResult(10, 'Untitled'), false)
  })

  test('never touches a normal-length track', () => {
    assert.equal(isPreviewLengthResult(171, 'Daylight'), false)
    assert.equal(isPreviewLengthResult(PREVIEW_MAX_SECS + 1, 'Anything'), false)
  })

  test('an unknown duration is not an accusation', () => {
    assert.equal(isPreviewLengthResult(undefined, 'Whatever'), false)
    assert.equal(isPreviewLengthResult(0, 'Whatever'), false)
  })
})
