// Tests for mobile/src/services/nas/streamUrl.ts::joinNasPath.
//
// This is the path-format contract function. The desktop snapshot
// exporter writes Track.path as "iPod_Control/Music/F12/ABCD.m4a"
// (slash-separated, no leading slash). Mobile prepends
// libraryRootPath (e.g. "/music") to get the absolute NAS path.
// If joinNasPath ever doubles a slash, drops one, or strips when
// it should prepend, mobile playback breaks at the URL layer.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { joinNasPath } from '../services/nas/streamUrl.ts'

describe('joinNasPath', () => {
  test('prepends prefix to slash-relative path', () => {
    assert.equal(
      joinNasPath('/music', 'iPod_Control/Music/F12/ABCD.m4a'),
      '/music/iPod_Control/Music/F12/ABCD.m4a',
    )
  })

  test('handles trailing slash on prefix without doubling', () => {
    assert.equal(
      joinNasPath('/music/', 'iPod_Control/A.m4a'),
      '/music/iPod_Control/A.m4a',
    )
  })

  test('handles leading slash on rel without doubling', () => {
    assert.equal(
      joinNasPath('/music', '/iPod_Control/A.m4a'),
      '/music/iPod_Control/A.m4a',
    )
  })

  test('handles trailing+leading slashes together', () => {
    assert.equal(
      joinNasPath('/music/', '/iPod_Control/A.m4a'),
      '/music/iPod_Control/A.m4a',
    )
  })

  test('empty prefix yields a leading-slash absolute path', () => {
    assert.equal(joinNasPath('', 'iPod_Control/A.m4a'), '/iPod_Control/A.m4a')
  })

  test('multi-segment prefix works (Synology shared folder + sub-folder)', () => {
    assert.equal(
      joinNasPath('/volume1/music/jaketunes', 'iPod_Control/Music/F12/A.m4a'),
      '/volume1/music/jaketunes/iPod_Control/Music/F12/A.m4a',
    )
  })

  test('does NOT strip the prefix from rel (regression: old version stripped)', () => {
    // Earlier draft had `joinNasPath` written as `trimPrefix` — given
    // an already-absolute path it would strip libraryRootPath. The
    // snapshot format never includes a prefix to strip; the right
    // behavior is unconditional prepend. This test pins that.
    assert.equal(
      joinNasPath('/music', 'music/already-here/A.m4a'),
      '/music/music/already-here/A.m4a',
    )
  })
})
