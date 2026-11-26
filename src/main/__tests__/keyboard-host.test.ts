// V7 ONE KEYBOARD: the renderer's keyboard host (src/renderer/keyboard.ts).
// Runs the real registries and dispatch on plain objects standing in for
// KeyboardEvents: which handler gets each key in each state, Escape's order,
// ⌘Z, claims, and that a re-render never moves a surface on the stack.
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  addKeyLayer, addEscape, addUndo, claimKeys, isClaimed, escapeStack, offerToLayers, routeGlobal, applyRoute, modalOpen,
  resetKeyboardForTests, installKeyboard, spaceFirst,
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

  it('claims: a key any live claim names is withheld from the app when pressed plain', () => {
    const a = claimKeys('listen-list', ['Space', 'ArrowUp', 'ArrowDown'])
    const b = claimKeys('scotus', ['Space', 'ArrowLeft', 'ArrowRight'])
    assert.equal(press(SPACE()), 'native')
    assert.equal(press(ev('ArrowLeft', 'ArrowLeft', { metaKey: true })), 'shortcut:previous', 'a claim holds the plain key only')
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

describe('installKeyboard: the two listeners together', () => {
  beforeEach(() => resetKeyboardForTests())

  // A window stand-in: node's EventTarget, listeners in the order added
  // (early before late, as on a real window at target).
  function withWindow(run: (fire: (k: string, code: string) => Event) => void): string[] {
    const fired: string[] = []
    const g = globalThis as unknown as { window?: EventTarget }
    const before = g.window
    g.window = new EventTarget()
    const off = installKeyboard({ shortcut: (id) => fired.push(id), clearSearch: () => fired.push('clear-search') })
    try {
      run((k, code) => {
        const e = new Event('keydown', { cancelable: true })
        Object.assign(e, { key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false })
        Object.defineProperty(e, 'target', { value: { tagName: 'DIV' } })
        g.window!.dispatchEvent(e)
        return e
      })
    } finally { off(); g.window = before }
    return fired
  }

  it('a layer that takes a key by returning true keeps it from the app (no preventDefault needed)', () => {
    let took = 0
    addKeyLayer('scotus', (e) => { if (e.key === ' ') { took++; return true } })
    const fired = withWindow((fire) => { fire(' ', 'Space') })
    assert.equal(took, 1)
    assert.deepEqual(fired, [], 'Space must not also toggle the music')
  })

  it('with no layer, Space reaches play/pause once', () => {
    const fired = withWindow((fire) => { fire(' ', 'Space') })
    assert.deepEqual(fired, ['play-pause'])
  })
})

// Brief 266: a mouse click in Electron focuses the button or card it lands
// on. Space after that must be play/pause, not the focused element's own
// Space (▶ playing the record again, a show card reopening its link).
describe('Space after a click: play/pause comes before the focused element', () => {
  beforeEach(() => resetKeyboardForTests())

  interface Focused {
    tagName: string; isContentEditable?: boolean; closest?: (s: string) => unknown
    /** The element's own onKeyDown (React runs it between window capture and window bubble). */
    onKeyDown?: (e: KeyboardEvent) => void
    /** The native press a button / role=button card gets from Space unless keydown was prevented. */
    activate?: () => void
  }

  /** One real-order keydown on a focused element: window capture, the element, window bubble, then the native press. */
  function pressSpaceOn(target: Focused, setup: () => void = () => {}, mods: Partial<FakeEvent> = {}): { fired: string[]; e: KeyboardEvent } {
    const fired: string[] = []
    const listeners: { fn: (e: KeyboardEvent) => void; capture: boolean }[] = []
    const g = globalThis as unknown as { window?: unknown }
    const before = g.window
    g.window = {
      addEventListener: (type: string, fn: (e: KeyboardEvent) => void, capture?: boolean) => { if (type === 'keydown') listeners.push({ fn, capture: !!capture }) },
      removeEventListener: () => {},
    }
    const off = installKeyboard({ shortcut: (id) => fired.push(id), clearSearch: () => fired.push('clear-search') })
    setup()
    const e = ev(' ', 'Space', { target, ...mods })
    try {
      for (const l of listeners.filter((x) => x.capture)) l.fn(e)
      if (!e.cancelBubble) target.onKeyDown?.(e)
      if (!e.cancelBubble) for (const l of listeners.filter((x) => !x.capture)) l.fn(e)
      if (!e.defaultPrevented) target.activate?.()
    } finally { off(); g.window = before }
    return { fired, e }
  }

  // PlayButton.tsx: onClick plays; onKeyDown stops Space / Enter.
  function playButton(onPlay: () => void): Focused {
    return {
      tagName: 'BUTTON',
      onKeyDown: (e) => { if (e.key === ' ' || e.key === 'Enter') e.stopPropagation() },
      activate: onPlay,
    }
  }

  it('focus on ▶: Space is play/pause once, and the button does not play again', () => {
    let played = 0
    const { fired } = pressSpaceOn(playButton(() => { played++ }))
    assert.deepEqual(fired, ['play-pause'])
    assert.equal(played, 0, 'the button\'s own Space press must not restart the record')
  })

  it('focus on a show card (role=button, its own Space opens it): Space is play/pause, the card stays shut', () => {
    let opened = 0
    const card: Focused = {
      tagName: 'DIV',
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opened++ } },
    }
    const { fired } = pressSpaceOn(card)
    assert.deepEqual(fired, ['play-pause'])
    assert.equal(opened, 0)
  })

  it('focus in a text field: Space types, no play/pause', () => {
    let typed = 0
    const { fired, e } = pressSpaceOn({ tagName: 'INPUT', closest: () => null, onKeyDown: () => { typed++ } })
    assert.deepEqual(fired, [])
    assert.equal(typed, 1)
    assert.equal(e.defaultPrevented, false)
    assert.deepEqual(pressSpaceOn({ tagName: 'DIV', isContentEditable: true }).fired, [], 'contenteditable too')
  })

  it('a page that claims Space (the blind check) wins over play/pause, even with ▶ focused', () => {
    let blind = 0
    let played = 0
    const { fired } = pressSpaceOn(playButton(() => { played++ }), () => {
      claimKeys('top1000-audit', ['Space'])
      addKeyLayer('top1000-audit', (e) => { if (e.key === ' ') { e.preventDefault(); blind++ } })
    })
    assert.deepEqual(fired, [])
    assert.equal(blind, 1)
    assert.equal(played, 0)
  })

  it('a claim alone (no layer took it) still keeps Space from play/pause', () => {
    let pressed = 0
    const { fired } = pressSpaceOn({ tagName: 'BUTTON', activate: () => { pressed++ } }, () => { claimKeys('listen-list', ['Space']) })
    assert.deepEqual(fired, [])
    assert.equal(pressed, 1, 'the focused button keeps its own Space')
  })

  it('a dialog open: its focused button keeps Space; no play/pause before it', () => {
    let confirmed = 0
    const { fired } = pressSpaceOn(playButton(() => { confirmed++ }), () => { addEscape('confirm', () => {}) })
    assert.deepEqual(fired, [])
    assert.equal(confirmed, 1)
  })

  it('a modified Space (⇧Space) is not taken early', () => {
    let pressed = 0
    const { fired } = pressSpaceOn({ tagName: 'BUTTON', activate: () => { pressed++ } }, () => {}, { shiftKey: true })
    assert.deepEqual(fired, [])
    assert.equal(pressed, 1)
  })

  it('Enter on a focused ▶ is still the button\'s (unchanged)', () => {
    const fired: string[] = []
    const listeners: { fn: (e: KeyboardEvent) => void; capture: boolean }[] = []
    const g = globalThis as unknown as { window?: unknown }
    const before = g.window
    g.window = { addEventListener: (_t: string, fn: (e: KeyboardEvent) => void, capture?: boolean) => listeners.push({ fn, capture: !!capture }), removeEventListener: () => {} }
    const off = installKeyboard({ shortcut: (id) => fired.push(id), clearSearch: () => {} })
    let played = 0
    const btn = playButton(() => { played++ })
    const e = ev('Enter', 'Enter', { target: btn })
    try {
      for (const l of listeners.filter((x) => x.capture)) l.fn(e)
      if (!e.cancelBubble) btn.onKeyDown?.(e)
      if (!e.cancelBubble) for (const l of listeners.filter((x) => !x.capture)) l.fn(e)
      if (!e.defaultPrevented) btn.activate?.()
    } finally { off(); g.window = before }
    assert.deepEqual(fired, [])
    assert.equal(played, 1)
  })

  it('a list layer that takes Space early still has it (plays the highlighted row)', () => {
    let rowPlayed = 0
    const { fired } = pressSpaceOn({ tagName: 'DIV' }, () => {
      addKeyLayer('track-list', (e) => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); rowPlayed++ } })
    })
    assert.deepEqual(fired, [])
    assert.equal(rowPlayed, 1)
  })

  it('spaceFirst names each case on its own (not only through routeKey)', () => {
    assert.equal(spaceFirst(SPACE()), true)
    assert.equal(spaceFirst(ev(' ', 'Space', { target: { tagName: 'BUTTON' } })), true)
    assert.equal(spaceFirst(ev(' ', 'Space', { target: { tagName: 'INPUT', closest: () => null } })), false, 'text field')
    assert.equal(spaceFirst(ev(' ', 'Space', { target: { tagName: 'TEXTAREA', closest: () => ({}) } })), false, 'field in a dialog')
    assert.equal(spaceFirst(ev(' ', 'Space', { target: { tagName: 'DIV', isContentEditable: true } })), false, 'contenteditable')
    assert.equal(spaceFirst(ev(' ', 'Space', { shiftKey: true })), false, '⇧Space')
    assert.equal(spaceFirst(ev(' ', 'Space', { metaKey: true })), false, '⌘Space')
    assert.equal(spaceFirst(ev('Enter', 'Enter')), false, 'Enter')
    const off = claimKeys('top1000-audit', ['Space'])
    assert.equal(spaceFirst(SPACE()), false, 'claimed')
    off()
    const close = addEscape('settings', () => {})
    assert.equal(spaceFirst(SPACE()), false, 'dialog open')
    close()
    assert.equal(spaceFirst(SPACE()), true)
  })
})
