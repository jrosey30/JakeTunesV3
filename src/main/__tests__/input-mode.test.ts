import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { claimTransportKeys, transportKeysClaimed, shouldYieldToClaim } from '../../renderer/input-mode.ts'

describe('the transport-key claim', () => {
  beforeEach(() => { claimTransportKeys('reset')() })

  it('withholds nothing until something claims', () => {
    assert.equal(transportKeysClaimed(), false)
    for (const k of ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      assert.equal(shouldYieldToClaim(k), false)
    }
  })

  it('withholds exactly the transport keys while claimed', () => {
    const release = claimTransportKeys('step-inside')
    assert.equal(shouldYieldToClaim('Space'), true)
    assert.equal(shouldYieldToClaim('ArrowLeft'), true)
    assert.equal(shouldYieldToClaim('ArrowRight'), true)
    assert.equal(shouldYieldToClaim('ArrowUp'), true)
    assert.equal(shouldYieldToClaim('ArrowDown'), true)
    // The way out, search, and explicit hardware intent all still work.
    for (const k of ['Escape', 'KeyF', 'Slash', 'MediaPlayPause', 'MediaTrackNext', 'KeyW', 'KeyE', 'Enter']) {
      assert.equal(shouldYieldToClaim(k), false, `${k} must not be withheld`)
    }
    release()
  })

  it('restores the app the instant the claim is released', () => {
    const release = claimTransportKeys('step-inside')
    assert.equal(shouldYieldToClaim('ArrowRight'), true)
    release()
    assert.equal(shouldYieldToClaim('ArrowRight'), false)
    assert.equal(transportKeysClaimed(), false)
  })

  it('survives leaving and re-entering', () => {
    for (let i = 0; i < 3; i++) {
      const release = claimTransportKeys('step-inside')
      assert.equal(shouldYieldToClaim('Space'), true, `claim ${i} took`)
      release()
      assert.equal(shouldYieldToClaim('Space'), false, `release ${i} gave it back`)
    }
  })

  it('a narrow claim withholds only the keys it names', () => {
    const release = claimTransportKeys('listen-list', ['Space', 'ArrowUp', 'ArrowDown'])
    assert.equal(shouldYieldToClaim('Space'), true)
    assert.equal(shouldYieldToClaim('ArrowUp'), true)
    assert.equal(shouldYieldToClaim('ArrowDown'), true)
    // The Listen List never moves sideways — ←/→ keep skipping tracks.
    assert.equal(shouldYieldToClaim('ArrowLeft'), false)
    assert.equal(shouldYieldToClaim('ArrowRight'), false)
    release()
    assert.equal(shouldYieldToClaim('Space'), false)
  })

  it('a full claim after a narrow one withholds all five again', () => {
    const narrow = claimTransportKeys('listen-list', ['Space', 'ArrowUp', 'ArrowDown'])
    const full = claimTransportKeys('step-inside')
    narrow()                                        // late unmount of the Listen List
    for (const k of ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      assert.equal(shouldYieldToClaim(k), true, `${k} withheld by the full claim`)
    }
    full()
  })

  it('ignores a stale release from a view that already handed over', () => {
    const staleRelease = claimTransportKeys('old-view')
    const freshRelease = claimTransportKeys('new-view')
    staleRelease()                                  // late unmount of the old one
    assert.equal(shouldYieldToClaim('Space'), true, 'the live claim survives')
    freshRelease()
    assert.equal(shouldYieldToClaim('Space'), false)
  })
})
