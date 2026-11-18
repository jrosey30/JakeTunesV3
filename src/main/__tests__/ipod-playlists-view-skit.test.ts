import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { skippedAddNotice } from '../../common/ipod-playlists-view.ts'

describe('homemini refusing a skit on a list (2026-11-17)', () => {
  it('says why in words', () => {
    assert.match(skippedAddNotice('punkPod', 5000, 'skit', 'Intro'), /skit, intro or segue.*Best of Bandcamp.*punkPod/)
  })
  it('the outbox takes a skit out of the waiting playlist, like full and not-in-library', () => {
    const src = readFileSync(new URL('../ipod-playlists-outbox.ts', import.meta.url), 'utf8')
    assert.match(src, /s\.reason === 'full' \|\| s\.reason === 'not-in-library' \|\| s\.reason === 'skit'/)
  })
})
