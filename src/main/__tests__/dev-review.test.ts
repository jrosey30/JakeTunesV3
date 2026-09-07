import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyDevReview, devReviewRequested, devReviewWebPreferences, suppressListeningWrites } from '../dev-review.ts'

describe('dev review launches', () => {
  it('mute and title only when JT_DEV_REVIEW=1; normal startup untouched', () => {
    const calls: string[] = []
    const win = { webContents: { setAudioMuted: (m: boolean) => calls.push(`mute:${m}`), on: (ev: string) => calls.push(`on:${ev}`) }, setTitle: (t: string) => calls.push(`title:${t}`) }
    applyDevReview(win as never, {})
    assert.deepEqual(calls, [])
    assert.equal(devReviewRequested({}), false)
    applyDevReview(win as never, { JT_DEV_REVIEW: '1' })
    assert.deepEqual(calls, ['mute:true', 'title:JakeTunes V3 — dev review (muted)', 'on:did-finish-load'])
    assert.equal(devReviewRequested({ JT_DEV_REVIEW: '1' }), true)
  })
  it('review windows require a real gesture for audio; listening writes are suppressed; normal mode changes nothing', () => {
    assert.deepEqual(devReviewWebPreferences({}), {})
    assert.deepEqual(devReviewWebPreferences({ JT_DEV_REVIEW: '1' }), { autoplayPolicy: 'user-gesture-required' })
    assert.equal(suppressListeningWrites({}), false)
    assert.equal(suppressListeningWrites({ JT_DEV_REVIEW: '1' }), true)
  })
})
