import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { libraryAudioUrl } from '../../common/library-audio-url.ts'

describe('libraryAudioUrl', () => {
  it('turns an iPod-style path into an absolute ipod-audio URL', () => {
    const u = libraryAudioUrl('/Users/j/Music/iPod', ':iPod_Control:Music:F39:imported_8439.m4a')
    assert.equal(decodeURIComponent(u!.slice('ipod-audio://'.length)), '/Users/j/Music/iPod/iPod_Control/Music/F39/imported_8439.m4a')
  })
  it('passes an absolute path through', () => {
    assert.equal(libraryAudioUrl('', '/tmp/a.m4a'), 'ipod-audio://' + encodeURIComponent('/tmp/a.m4a'))
  })
  it('never emits a relative path when the root is unknown', () => {
    assert.equal(libraryAudioUrl('', ':iPod_Control:Music:F01:a.m4a'), null)
    assert.equal(libraryAudioUrl('/r', ''), null)
  })
})
