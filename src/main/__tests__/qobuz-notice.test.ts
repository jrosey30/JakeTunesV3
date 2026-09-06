import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { qobuzNoticeFor } from '../../common/qobuz-notice.ts'

describe('the missing-Qobuz notice', () => {
  it('speaks only when a Get needs the account', () => {
    const missing = { configured: false }
    assert.equal(qobuzNoticeFor(missing, 'search'), null)
    assert.equal(qobuzNoticeFor(missing, 'preview'), null)
    assert.equal(qobuzNoticeFor(missing, 'link'), null)
    const n = qobuzNoticeFor(missing, 'get', { kind: 'album', title: 'Little Creatures' })
    assert.equal(n?.kind, 'qobuz-missing')
    assert.match(n!.body, /Little Creatures/)
    assert.equal(n?.action.preferencesTab, 'Music Sources')
  })
  it('stays quiet while the account state is unknown or connected', () => {
    assert.equal(qobuzNoticeFor(null, 'get'), null)
    assert.equal(qobuzNoticeFor({ configured: true, email: 'j@x' }, 'get'), null)
  })
  it('tells a song from a record — a song still has other providers', () => {
    assert.match(qobuzNoticeFor({ configured: false }, 'get', { kind: 'song', title: 'Cups' })!.body, /Bandcamp or SoundCloud/)
    assert.match(qobuzNoticeFor({ configured: false }, 'get', { kind: 'album', title: 'X' })!.body, /can’t be fetched/)
  })
})
