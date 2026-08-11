import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHomeminiPlaybackClient,
  mayFollowPlaybackSymlink,
  planPlaybackBytes,
} from '../stream-playback.ts'

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

describe('mayFollowPlaybackSymlink', () => {
  it('allows real local files everywhere', () => {
    assert.equal(mayFollowPlaybackSymlink({ isHomeminiClient: true, isSymlink: false }), true)
    assert.equal(mayFollowPlaybackSymlink({ isHomeminiClient: false, isSymlink: false }), true)
  })

  it('FORBIDS symlink follow on streaming/cache-farm clients — THE HANG', () => {
    assert.equal(mayFollowPlaybackSymlink({ isHomeminiClient: true, isSymlink: true }), false)
  })

  it('allows symlink follow on fully-local machines (legacy behavior)', () => {
    assert.equal(mayFollowPlaybackSymlink({ isHomeminiClient: false, isSymlink: true }), true)
  })
})

describe('planPlaybackBytes — workmini decision table', () => {
  const workmini = {
    streamSource: null as const,
    streamRoot: '/Users/jacobrosenbaum/JakeShareNAS/JakeTunesLibrary',
  }

  it('workmini cold start → fetch homemini before any fs', () => {
    assert.deepEqual(
      planPlaybackBytes({ ...workmini, localIsSymlink: null, homeminiReturnedAudio: false }),
      { action: 'fetch-homemini-first' },
    )
  })

  it('workmini homemini miss + symlink → refuse SMB (never hang)', () => {
    assert.deepEqual(
      planPlaybackBytes({ ...workmini, localIsSymlink: true, homeminiReturnedAudio: false }),
      { action: 'refuse-smb-symlink' },
    )
  })

  it('workmini homemini miss + real local cache file → serve local', () => {
    assert.deepEqual(
      planPlaybackBytes({ ...workmini, localIsSymlink: false, homeminiReturnedAudio: false }),
      { action: 'serve-local-file' },
    )
  })

  it('MacBook with neither flag → default disk path', () => {
    assert.deepEqual(
      planPlaybackBytes({
        streamSource: null,
        streamRoot: null,
        localIsSymlink: null,
        homeminiReturnedAudio: false,
      }),
      { action: 'serve-disk-default' },
    )
  })
})
