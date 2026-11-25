// V7 ONE KEYBOARD: the renderer's keyboard host (src/renderer/keyboard.ts).
// Runs the real registries and dispatch on plain objects standing in for
// KeyboardEvents: which handler gets each key in each state, Escape's order,
// ⌘Z, claims, and that a re-render never moves a surface on the stack.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  addKeyLayer, addEscape, addUndo, claimKeys, isClaimed, escapeStack, offerToLayers, routeGlobal, applyRoute, modalOpen,
  resetKeyboardForTests,
} from '../../renderer/keyboard.ts'

interface FakeEvent {
  key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean
  defaultPrevented: boolean; cancelBubble: boolean; isComposing: boolean; repeat: boolean
  target: { tagName: string; isContentEditable?: boolean; closest?: (s: string) => unknown; blur?: () => void }
  preventDefault(): void; stopPropagation(): void; stopImmediatePropagation(): void
}
function ev(k: string, code: string, mods: Partial<FakeEvent> = {}): KeyboardEvent {
  const e: FakeEvent = {
    key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    defaultPrevented: false, cancelBubble: false, isComposing: false, repeat: false,
    target: { tagName: 'DIV' },
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.cancelBubble = true },
    stopImmediatePropagation() { this.cancelBubble = true },
    ...mods,
  }
  return e as unknown as KeyboardEvent
}
const SPACE = (): KeyboardEvent => ev(' ', 'Space')
const UP = (): KeyboardEvent => ev('ArrowUp', 'ArrowUp')
const ESC = (): KeyboardEvent => ev('Escape', 'Escape')

/** One keydown through the host, as installKeyboard runs it (minus the DOM). */
function press(e: KeyboardEvent): string {
  if (offerToLayers(e, 'early')) return 'layer'
  if (offerToLayers(e, 'late')) return 'layer'
  const r = routeGlobal(e)
  const fired: string[] = []
  applyRoute(r, e, { shortcut: (id) => fired.push(id), clearSearch: () => fired.push('clear-search') })
  return r.to === 'shortcut' ? `shortcut:${fired[0]}` : r.to === 'escape' || r.to === 'undo' ? `${r.to}:${r.id}` : r.to
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the keyboard host', () => {
  beforeEach(() => resetKeyboardForTests())

  it('↑ on a song list moves the selection; never the volume', () => {
    let moved = 0
    addKeyLayer('track-list', (e) => { if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moved++ } })
    assert.equal(press(UP()), 'layer')
    assert.equal(moved, 1)
    resetKeyboardForTests()
    assert.equal(press(UP()), 'native', 'no list: the page scrolls, the volume stays')
  })

  it('Space: the list plays the highlighted row when nothing is loaded; otherwise play/pause', () => {
    let loaded = false
    let played = 0
    addKeyLayer('track-list', (e) => { if (e.key === ' ' && !loaded) { e.preventDefault(); e.stopPropagation(); played++ } })
    assert.equal(press(SPACE()), 'layer')
    loaded = true
    assert.equal(press(SPACE()), 'shortcut:play-pause')
    assert.equal(played, 1)
  })

  it('a layer that takes nothing passes the key on to the next, then to the app', () => {
    const seen: string[] = []
    addKeyLayer('songs-view', () => { seen.push('songs') })
    addKeyLayer('find-bar', () => { seen.push('find') })
    assert.equal(press(SPACE()), 'shortcut:play-pause')
    assert.deepEqual(seen, ['find', 'songs'], 'newest first, both asked')
  })

  it('a dialog silences the list under it; its own keys still work; the app keeps Space', () => {
    let listKeys = 0
    addKeyLayer('track-list', (e) => { listKeys++; e.preventDefault() })
    const close = addEscape('get-info', () => {})
    assert.equal(modalOpen(), true)
    assert.equal(press(UP()), 'native')
    assert.equal(listKeys, 0)
    assert.equal(press(SPACE()), 'shortcut:play-pause')
    close()
    assert.equal(press(UP()), 'layer')
  })

  it('a drawer beside the page (modal: false) does not silence the list', () => {
    let listKeys = 0
    addKeyLayer('track-list', (e) => { listKeys++; e.preventDefault() })
    addEscape('up-next', () => {}, { modal: false })
    assert.equal(press(UP()), 'layer')
    assert.equal(listKeys, 1)
  })

  it('Escape is never offered to a layer: it closes the top-most surface', () => {
    const closed: string[] = []
    // A dialog's own layer (modal, so it is asked even with surfaces open) never sees Escape.
    addKeyLayer('get-info', (e) => { e.preventDefault(); closed.push('layer-saw-escape') }, { modal: true })
    addEscape('up-next', () => closed.push('up-next'), { modal: false })
    addEscape('settings', () => closed.push('settings'))
    const confirm = addEscape('confirm', () => closed.push('confirm'))
    assert.equal(press(ESC()), 'escape:confirm')
    confirm()
    assert.equal(press(ESC()), 'escape:settings')
    assert.deepEqual(closed, ['confirm', 'settings'])
  })

  it('a re-render (release and re-add in one commit) keeps a surface in its place; a real reopen goes on top', async () => {
    const off1 = addEscape('settings', () => {})
    addEscape('confirm', () => {})
    off1(); addEscape('settings', () => {})                      // same commit: React effect cleanup + setup
    assert.deepEqual(escapeStack().map((x) => x.id), ['settings', 'confirm'])
    resetKeyboardForTests()
    const off2 = addEscape('settings', () => {})
    addEscape('confirm', () => {})
    off2(); await tick()                                         // closed for a tick
    addEscape('settings', () => {})
    assert.deepEqual(escapeStack().map((x) => x.id), ['confirm', 'settings'])
  })

  it('⌘Z outside a field presses the newest Undo toast; in a field it is the field\'s', () => {
    const undone: string[] = []
    addUndo('playlist-remove', () => undone.push('playlist'))
    const toss = addUndo('listen-list-toss', () => undone.push('toss'))
    assert.equal(press(ev('z', 'KeyZ', { metaKey: true })), 'undo:listen-list-toss')
    toss()
    assert.equal(press(ev('z', 'KeyZ', { metaKey: true })), 'undo:playlist-remove')
    assert.equal(press(ev('z', 'KeyZ', { metaKey: true, target: { tagName: 'INPUT' } })), 'native')
    assert.deepEqual(undone, ['toss', 'playlist'])
  })

  it('claims: a key any live claim names is withheld from the app, with any modifiers', () => {
    const a = claimKeys('listen-list', ['Space', 'ArrowUp', 'ArrowDown'])
    const b = claimKeys('scotus', ['Space', 'ArrowLeft', 'ArrowRight'])
    assert.equal(press(SPACE()), 'native')
    assert.equal(press(ev('ArrowLeft', 'ArrowLeft', { metaKey: true })), 'native')
    assert.equal(isClaimed('ArrowUp'), true, 'an older claim still holds its own keys under a newer one')
    b()
    assert.equal(isClaimed('ArrowLeft'), false)
    assert.equal(isClaimed('Space'), true, 'the Listen List still holds Space')
    a()
    assert.equal(press(SPACE()), 'shortcut:play-pause')
  })

  it('typing in a field: Space and ⌘→ are the field\'s; Escape lets go and closes nothing', () => {
    let blurred = 0
    const closed: string[] = []
    addEscape('music-man', () => closed.push('music-man'), { modal: false })
    const input = { tagName: 'INPUT', closest: () => null, blur: () => { blurred++ } }
    assert.equal(press(ev(' ', 'Space', { target: input })), 'native')
    assert.equal(press(ev('ArrowRight', 'ArrowRight', { metaKey: true, target: input })), 'native')
    assert.equal(press(ev('Escape', 'Escape', { target: input })), 'let-go')
    assert.equal(blurred, 1)
    assert.deepEqual(closed, [])
  })

  it('typing in a dialog\'s field: Escape closes the dialog', () => {
    const closed: string[] = []
    addEscape('go-anywhere', () => closed.push('go-anywhere'))
    const input = { tagName: 'INPUT', closest: () => ({}) }
    assert.equal(press(ev('Escape', 'Escape', { target: input })), 'escape:go-anywhere')
    assert.deepEqual(closed, ['go-anywhere'])
  })

  it('late layers (the Top 1000 quiz) answer after the early ones, before the app', () => {
    const seen: string[] = []
    addKeyLayer('top1000-quiz', (e) => { if (e.key === '1') { e.preventDefault(); seen.push('quiz') } }, { late: true })
    addKeyLayer('track-list', () => { seen.push('list') })
    assert.equal(press(ev('1', 'Digit1')), 'layer')
    assert.deepEqual(seen, ['list', 'quiz'])
  })
})
