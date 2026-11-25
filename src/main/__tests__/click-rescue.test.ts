/**
 * A click during a page slide (renderer/clickRescue.ts), driven on a fake
 * <html> (a plain EventTarget) and a fake slide. During a View Transition
 * Electron 30's Chromium sends every press to <html>; these events do the same.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createClickRescuer, RESCUE_SLOP_PX, type RescuedClick } from '../../renderer/clickRescue.ts'

class Fake extends EventTarget {
  name: string
  field: boolean
  constructor(name: string, field = false) { super(); this.name = name; this.field = field }
}

function world(at: Fake | null | 'root' = new Fake('sidebar-icon'), sliding = false) {
  const root = new Fake('html')
  const delivered: Array<{ to: string; init: RescuedClick }> = []
  const focused: string[] = []
  let skips = 0
  let timer: (() => void) | null = null
  const rescuer = createClickRescuer({
    root,
    elementAt: () => (at === 'root' ? root : at),
    inSlidingArea: () => sliding,
    focusIfField: (el) => { if ((el as Fake).field) focused.push((el as Fake).name) },
    deliver: (el, init) => { delivered.push({ to: (el as Fake).name, init }) },
    setTimer: (fn) => { timer = fn },
  })
  const vt = { skipTransition: () => { skips++ } }
  const fire = (type: string, fields: Record<string, unknown> = {}): Event => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, { button: 0, clientX: 50, clientY: 60, screenX: 150, screenY: 260, detail: 1, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...fields })
    root.dispatchEvent(e)
    return e
  }
  const tap = (down: Record<string, unknown> = {}, up: Record<string, unknown> = {}, click: Record<string, unknown> = {}): void => {
    fire('pointerdown', down)
    fire('pointerup', up)
    fire('click', click)
  }
  // a second, ordinary listener on <html>: it must never see a rescued click
  let rootClicks = 0
  root.addEventListener('click', () => { rootClicks++ })
  return { root, rescuer, vt, delivered, focused, fire, tap, skips: () => skips, rootClicks: () => rootClicks, expire: () => timer?.() }
}

describe('a click during a page slide', () => {
  test('ends the slide and is delivered exactly once, to what is under the pointer', () => {
    const w = world()
    w.rescuer.arm(w.vt)
    w.rescuer.arm(w.vt) // arming twice never adds a second listener
    w.tap()
    assert.equal(w.skips(), 1)
    assert.equal(w.delivered.length, 1)
    assert.equal(w.delivered[0].to, 'sidebar-icon')
    assert.equal(w.rootClicks(), 0, 'the click on <html> itself goes no further')
    w.fire('click')
    assert.equal(w.delivered.length, 1, 'a second click with no new press delivers nothing')
  })

  test('reaches an SVG icon (any element, not only an HTMLElement)', () => {
    const svg = new Fake('svg-path')
    const w = world(svg)
    w.rescuer.arm(w.vt)
    w.tap()
    assert.deepEqual(w.delivered.map((d) => d.to), ['svg-path'])
  })

  test('keeps the modifiers, position and click count', () => {
    const w = world()
    w.rescuer.arm(w.vt)
    w.tap({}, {}, { metaKey: true, shiftKey: true, detail: 2 })
    const init = w.delivered[0].init
    assert.equal(init.metaKey, true)
    assert.equal(init.shiftKey, true)
    assert.equal(init.altKey, false)
    assert.equal(init.ctrlKey, false)
    assert.equal(init.detail, 2)
    assert.deepEqual([init.clientX, init.clientY, init.screenX, init.screenY], [50, 60, 150, 260])
    assert.equal(init.bubbles && init.cancelable && init.composed, true)
  })

  test('a drag is not turned into a click', () => {
    const w = world()
    w.rescuer.arm(w.vt)
    w.tap({}, { clientX: 50 + RESCUE_SLOP_PX + 1 })
    assert.equal(w.delivered.length, 0)
    assert.equal(w.skips(), 1, 'the slide still ends')
  })

  test('a cancelled press, a secondary button, or a press that never clicks delivers nothing', () => {
    const w = world()
    w.rescuer.arm(w.vt)
    w.fire('pointerdown'); w.fire('pointercancel'); w.fire('click')
    w.tap({ button: 2 })
    w.fire('pointerdown'); w.expire(); w.fire('pointerup'); w.fire('click')
    assert.equal(w.delivered.length, 0)
  })

  test('inside the page that was sliding: the slide ends, the click is dropped, a text field is focused', () => {
    const field = new Fake('search-field', true)
    const w = world(field, true)
    w.rescuer.arm(w.vt)
    w.tap()
    assert.equal(w.skips(), 1)
    assert.equal(w.delivered.length, 0)
    assert.deepEqual(w.focused, ['search-field'])
  })

  test('nothing happens when no slide runs (and after one has ended, a new press is left alone)', () => {
    const w = world()
    w.tap()
    assert.equal(w.delivered.length, 0)
    assert.equal(w.skips(), 0)
    w.rescuer.arm(w.vt)
    w.rescuer.disarm()
    w.tap()
    assert.equal(w.delivered.length, 0)
    assert.equal(w.rootClicks(), 2, 'ordinary clicks on <html> go on as usual')
  })

  test('a press made during the slide still gets its click after the slide ends', () => {
    const w = world()
    w.rescuer.arm(w.vt)
    w.fire('pointerdown')
    w.rescuer.disarm()
    w.fire('pointerup')
    w.fire('click')
    assert.equal(w.delivered.length, 1)
  })

  test('a press that reached its real target (newer Chromium) is left alone', () => {
    const w = world()
    w.rescuer.arm(w.vt)
    const other = new Fake('button')
    other.dispatchEvent(new Event('pointerdown'))
    w.fire('click')
    assert.equal(w.skips(), 0)
    assert.equal(w.delivered.length, 0)
  })

  test('nothing found under the pointer but <html> itself: nothing is delivered', () => {
    for (const at of [null, 'root'] as const) {
      const w = world(at)
      w.rescuer.arm(w.vt)
      w.tap()
      assert.equal(w.delivered.length, 0)
    }
  })
})
