import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isHomeminiPlaybackClient } from '../stream-playback.ts'

describe('isHomeminiPlaybackClient', () => {
  it('is on when streamSource is homemini (laptop streaming mode)', () => {
    assert.equal(
      isHomeminiPlaybackClient({ streamSource: 'homemini', streamRoot: null }),
      true,
    )
  })

  it('is on when streamRoot is set — THE WORKMINI SHAPE (cache-farm)', () => {
    // July 2026 kept this OFF so "NAS playback" would work. Aug 10 proved
    // that path hangs. streamRoot alone must engage homemini-first.
    assert.equal(
      isHomeminiPlaybackClient({
        streamSource: null,
        streamRoot: '/Users/jacobrosenbaum/JakeShareNAS/JakeTunesLibrary',
      }),
      true,
    )
  })

  it('is on when both are set', () => {
    assert.equal(
      isHomeminiPlaybackClient({
        streamSource: 'homemini',
        streamRoot: '/Users/jacobrosenbaum/JakeShareNAS/JakeTunesLibrary',
      }),
      true,
    )
  })

  it('is off on a fully-local MacBook (neither flag)', () => {
    assert.equal(
      isHomeminiPlaybackClient({ streamSource: null, streamRoot: null }),
      false,
    )
    assert.equal(
      isHomeminiPlaybackClient({ streamSource: null, streamRoot: undefined }),
      false,
    )
    assert.equal(
      isHomeminiPlaybackClient({ streamSource: null, streamRoot: '' }),
      false,
    )
  })
})
