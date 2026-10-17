import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoNavHeld, stepCdPresence, CD_PRESENCE_START, type CdPresence } from '../../common/auto-nav.ts'

describe('hardware-arrival navigation waits for anything in flight', () => {
  const idle = { syncing: false, ripping: false, modalOpen: false }
  it('idle → free to navigate', () => assert.equal(autoNavHeld(idle), false))
  it('an iPod sync running holds it', () => assert.equal(autoNavHeld({ ...idle, syncing: true }), true))
  it('a rip/import in progress holds it', () => assert.equal(autoNavHeld({ ...idle, ripping: true }), true))
  it('an open modal holds it (Get Info would unmount with its view)', () => assert.equal(autoNavHeld({ ...idle, modalOpen: true }), true))
})

/** Feed a sequence of polls; return the poll indexes that announced a new disc. */
function run(polls: boolean[]): number[] {
  let s: CdPresence = CD_PRESENCE_START
  const hits: number[] = []
  polls.forEach((hasCd, i) => {
    const r = stepCdPresence(s, hasCd)
    s = r.next
    if (r.newDisc) hits.push(i)
  })
  return hits
}

describe('CD presence: only a NEW disc opens CD Import', () => {
  it('a disc already in the drive at launch is the baseline, not new', () => {
    assert.deepEqual(run([true, true, true]), [])
  })
  it('empty at launch, then a disc goes in → one announcement', () => {
    assert.deepEqual(run([false, false, true, true, true]), [2])
  })
  it('eject (two misses) then a new disc → announced again', () => {
    assert.deepEqual(run([false, true, true, false, false, true]), [1, 5])
  })
  it('a one-poll flicker mid-rip is NOT eject + re-insert', () => {
    assert.deepEqual(run([false, true, false, true, false, true]), [1])
  })
  it('two misses in a row count as gone', () => {
    let s = stepCdPresence(CD_PRESENCE_START, true).next
    s = stepCdPresence(s, false).next
    assert.equal(s.present, true)
    s = stepCdPresence(s, false).next
    assert.equal(s.present, false)
  })
})

describe('wired', () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8')
  it('the sidebar drive poll opens CD Import on a NEW disc, behind the guard', () => {
    assert.match(src('renderer/components/sidebar/Sidebar.tsx'), /step\.newDisc && currentViewRef\.current !== 'cd-import' && !autoNavBlocked\(\)/)
  })
  it('the iPod plug-in reads the persisted "Open JakeTunes when connected" option, behind the guard', () => {
    const app = src('renderer/App.tsx')
    assert.match(app, /r\.state\?\.optOpenOnConnect !== true/)
    assert.match(app, /currentView === 'device' \|\| autoNavBlocked\(\)/)
    // DeviceView still owns the setting under that key.
    assert.match(src('renderer/views/DeviceView.tsx'), /optOpenOnConnect: typeof s\.optOpenOnConnect === 'boolean'/)
  })
})
