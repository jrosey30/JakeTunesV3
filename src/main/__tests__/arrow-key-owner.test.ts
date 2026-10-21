// The visible Cover Flow owns ←/→ (src/renderer/utils/arrowKeyOwner.ts) —
// Jake 2026-10-21: "i press arrow left and right on keyboard and it plays
// tracks. i have to click inside the home page for it to cover flow."
// Plain ←/→/Enter go to an on-screen flow; ⌘←/⌘→ are always the transport;
// text fields, arrow-using widgets and open menus/dialogs keep their keys.
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  arrowIntent, classifyFocus, focusAllows, claimArrowKeys, activeArrowKeyOwner, routeArrowKey,
  type KeyLike, type FocusLike, type ArrowKeyOwner,
} from '../../renderer/utils/arrowKeyOwner.ts'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

function el(tagName: string, attrs: Record<string, string> = {}, extra: { editable?: boolean; inOverlay?: boolean } = {}): FocusLike {
  return {
    tagName,
    isContentEditable: !!extra.editable,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    closest: () => (extra.inOverlay ? {} : null),
  }
}

describe('arrowIntent: plain ←/→/Enter only', () => {
  test('plain keys', () => {
    assert.equal(arrowIntent(key('ArrowLeft')), 'left')
    assert.equal(arrowIntent(key('ArrowRight')), 'right')
    assert.equal(arrowIntent(key('Enter')), 'enter')
  })
  test('⌘←/⌘→ (and every other modifier) pass through to the transport', () => {
    for (const m of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
      assert.equal(arrowIntent(key('ArrowRight', { [m]: true })), null, m)
      assert.equal(arrowIntent(key('ArrowLeft', { [m]: true })), null, m)
      assert.equal(arrowIntent(key('Enter', { [m]: true })), null, m)
    }
  })
  test('↑/↓, Space and the rest are never taken; nor an already-handled or composing key', () => {
    for (const k of ['ArrowUp', 'ArrowDown', ' ', 'a', 'Escape', 'Tab']) assert.equal(arrowIntent(key(k)), null, k)
    assert.equal(arrowIntent(key('ArrowRight', { defaultPrevented: true })), null)
    assert.equal(arrowIntent(key('Enter', { isComposing: true })), null)
  })
})

describe('classifyFocus', () => {
  test('nothing in particular', () => {
    assert.equal(classifyFocus(null, false), 'neutral')
    assert.equal(classifyFocus(el('BODY'), false), 'neutral')
    assert.equal(classifyFocus(el('DIV'), false), 'neutral')
    assert.equal(classifyFocus(el('DIV', { role: 'group', tabindex: '0' }), false), 'neutral')
  })
  test('text fields and arrow-using widgets keep their keys', () => {
    assert.equal(classifyFocus(el('INPUT'), false), 'text')
    assert.equal(classifyFocus(el('INPUT', { type: 'search' }), false), 'text')
    assert.equal(classifyFocus(el('INPUT', { type: 'range' }), false), 'text')
    assert.equal(classifyFocus(el('TEXTAREA'), false), 'text')
    assert.equal(classifyFocus(el('SELECT'), false), 'text')
    assert.equal(classifyFocus(el('DIV', {}, { editable: true }), false), 'text')
    for (const role of ['slider', 'listbox', 'menu', 'menuitem', 'grid', 'tablist', 'textbox', 'combobox']) {
      assert.equal(classifyFocus(el('DIV', { role }), false), 'text', role)
    }
  })
  test('controls: arrows free, Enter presses them', () => {
    assert.equal(classifyFocus(el('BUTTON'), false), 'control')
    assert.equal(classifyFocus(el('A', { href: '#' }), false), 'control')
    assert.equal(classifyFocus(el('DIV', { role: 'button', tabindex: '0' }), false), 'control')
    assert.equal(classifyFocus(el('INPUT', { type: 'checkbox' }), false), 'control')
  })
  test('an open menu or dialog anywhere, or focus inside one', () => {
    assert.equal(classifyFocus(el('BODY'), true), 'overlay')
    assert.equal(classifyFocus(el('BUTTON'), true), 'overlay')
    assert.equal(classifyFocus(el('BUTTON', {}, { inOverlay: true }), false), 'overlay')
  })
  test('focusAllows', () => {
    assert.ok(focusAllows('left', 'neutral') && focusAllows('right', 'neutral') && focusAllows('enter', 'neutral'))
    assert.ok(focusAllows('left', 'control') && focusAllows('right', 'control'))
    assert.ok(!focusAllows('enter', 'control'), 'Enter on a focused button presses the button')
    for (const k of ['text', 'overlay'] as const) {
      assert.ok(!focusAllows('left', k) && !focusAllows('right', k) && !focusAllows('enter', k), k)
    }
  })
})

describe('the registry', () => {
  const releases: Array<() => void> = []
  afterEach(() => { while (releases.length) releases.pop()!() })
  function owner(active: boolean, log: string[], name: string, enter = true): ArrowKeyOwner & { set: (a: boolean) => void } {
    let on = active
    const o = {
      isActive: () => on,
      step: (d: -1 | 1) => { log.push(`${name}:${d}`) },
      ...(enter ? { enter: () => { log.push(`${name}:enter`) } } : {}),
      set: (a: boolean) => { on = a },
    }
    releases.push(claimArrowKeys(o))
    return o
  }
  const run = (e: KeyLike, focus: Parameters<typeof routeArrowKey>[1] = 'neutral'): boolean => {
    const r = routeArrowKey(e, focus)
    if (!r) return false
    if (r.intent === 'enter') r.owner.enter?.()
    else r.owner.step(r.intent === 'left' ? -1 : 1)
    return true
  }
  test('no owner → the transport keeps ←/→', () => {
    assert.equal(activeArrowKeyOwner(), null)
    assert.equal(routeArrowKey(key('ArrowRight'), 'neutral'), null)
  })
  test('an on-screen owner takes ←/→/Enter; off screen it doesn\'t', () => {
    const log: string[] = []
    const home = owner(true, log, 'home')
    assert.ok(run(key('ArrowRight')))
    assert.ok(run(key('ArrowLeft')))
    assert.ok(run(key('Enter')))
    assert.deepEqual(log, ['home:1', 'home:-1', 'home:enter'])
    home.set(false) // scrolled out of view
    assert.ok(!run(key('ArrowRight')))
    assert.equal(log.length, 3)
  })
  test('⌘→ over the flow, a text field, an open menu: never taken', () => {
    const log: string[] = []
    owner(true, log, 'home')
    assert.ok(!run(key('ArrowRight', { metaKey: true })))
    assert.ok(!run(key('ArrowLeft', { metaKey: true })))
    assert.ok(!run(key('ArrowRight'), 'text'))
    assert.ok(!run(key('ArrowRight'), 'overlay'))
    assert.ok(!run(key('Enter'), 'control'))
    assert.ok(run(key('ArrowRight'), 'control'))
    assert.deepEqual(log, ['home:1'])
  })
  test('an owner without Enter leaves Enter alone', () => {
    const log: string[] = []
    owner(true, log, 'jukebox', false)
    assert.ok(!run(key('Enter')))
    assert.ok(run(key('ArrowLeft')))
    assert.deepEqual(log, ['jukebox:-1'])
  })
  test('the newest ACTIVE owner wins; release is idempotent', () => {
    const log: string[] = []
    const a = owner(true, log, 'a')
    const b = owner(true, log, 'b')
    run(key('ArrowRight'))
    b.set(false)
    run(key('ArrowRight'))
    assert.deepEqual(log, ['b:1', 'a:1'])
    const rel = releases.pop()!
    rel(); rel()
    a.set(false)
    assert.equal(activeArrowKeyOwner(), null)
  })
})

describe('wiring', () => {
  const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', '..', 'renderer', p), 'utf-8')
  test('App.tsx: the transport handler asks the owner first — after the typing check, before ←/→ skip tracks', () => {
    const app = src('App.tsx')
    const handler = app.slice(app.indexOf('if (shouldYieldToClaim(e.code)) return'), app.indexOf("document.addEventListener('keydown', handler)"))
    const typing = handler.indexOf('if (typing) return')
    const owned = handler.indexOf('if (handleOwnedArrowKey(e)) return')
    const right = handler.indexOf("if (e.key === 'ArrowRight')")
    assert.ok(typing >= 0 && owned > typing && right > owned, `order: typing ${typing}, owner ${owned}, ArrowRight ${right}`)
  })
  test('both Cover Flows own the arrows while on screen; focused, they let ⌘/Ctrl/⌥ arrows through and stand down under a menu', () => {
    for (const f of ['components/TonightOnJakeTunes.tsx', 'views/CoverFlowView.tsx']) {
      const s = src(f)
      assert.match(s, /useArrowKeyOwner\(stageRef,/, f)
      assert.match(s, /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey \|\| overlayOpen\(\)\) return/, f)
    }
  })
  test('the focused Home flow still stops ←/→ from reaching the transport (LOAD-BEARING)', () => {
    const s = src('components/TonightOnJakeTunes.tsx')
    const h = s.slice(s.indexOf('const onFlowKey'), s.indexOf('// ── Now Digging'))
    assert.match(h, /e\.stopPropagation\(\)/)
  })
})
