/**
 * Brief 266, defect B: the Undo toast must leave once, about 5 s after it shows,
 * however often its parent redraws. SongTable reads playback state, so while
 * music plays it redraws about 10 times a second and hands the toast a new
 * `onDismiss` each time. With `onDismiss` in the timer effect's deps the 5 s
 * timer restarted on every redraw and never fired, and the toast's ⌘Z stayed
 * armed for as long as the music played.
 *
 * This renders the real component with the real react-dom (bundled by esbuild)
 * into a small fake DOM, with node's fake setTimeout, and redraws it every
 * 100 ms with a new onDismiss, the way SongTable does while a song plays.
 */
import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// ── just enough DOM for react-dom to mount a div, a span and a button ──
class FakeNode {
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  attributes: Record<string, string> = {}
  style: Record<string, string> = {}
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  nodeValue: string | null = null
  nodeType: number
  nodeName: string
  ownerDocument: FakeDocument | null
  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = ownerDocument
  }
  get tagName(): string { return this.nodeName }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null }
  get lastChild(): FakeNode | null { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode
    if (!p) return null
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null
  }
  appendChild(c: FakeNode): FakeNode { c.parentNode?.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c }
  insertBefore(c: FakeNode, ref: FakeNode | null): FakeNode {
    if (!ref) return this.appendChild(c)
    c.parentNode?.removeChild(c)
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c)
    c.parentNode = this
    return c
  }
  removeChild(c: FakeNode): FakeNode { this.childNodes = this.childNodes.filter((x) => x !== c); c.parentNode = null; return c }
  setAttribute(k: string, v: string): void { this.attributes[k] = String(v) }
  removeAttribute(k: string): void { delete this.attributes[k] }
  getAttribute(k: string): string | null { return this.attributes[k] ?? null }
  hasAttribute(k: string): boolean { return k in this.attributes }
  addEventListener(): void {}
  removeEventListener(): void {}
  get textContent(): string { return this.nodeType === 3 ? (this.nodeValue ?? '') : this.childNodes.map((c) => c.textContent).join('') }
  set textContent(v: string) {
    this.childNodes = []
    if (v) { const t = new FakeNode(3, '#text', this.ownerDocument); t.nodeValue = v; this.appendChild(t) }
  }
  get className(): string { return this.attributes.class ?? '' }
  set className(v: string) { this.attributes.class = v }
}
class FakeDocument extends FakeNode {
  documentElement: FakeNode
  body: FakeNode
  activeElement: FakeNode | null = null
  constructor() {
    super(9, '#document', null)
    this.documentElement = this.createElement('html')
    this.body = this.createElement('body')
    this.documentElement.appendChild(this.body)
  }
  createElement(tag: string): FakeNode { return new FakeNode(1, tag.toUpperCase(), this) }
  createElementNS(_ns: string, tag: string): FakeNode { return this.createElement(tag) }
  createTextNode(text: string): FakeNode { const t = new FakeNode(3, '#text', this); t.nodeValue = text; return t }
}

interface Harness {
  createRoot: (c: unknown) => { render: (el: unknown) => void; unmount: () => void }
  act: (fn: () => void) => void
  h: (props: Record<string, unknown>) => unknown
  undoStack: () => readonly { id: string }[]
}

async function loadHarness(): Promise<{ harness: Harness; cleanup: () => void }> {
  const { build } = await import('esbuild')
  const root = join(import.meta.dirname, '..', '..', '..')
  const dir = mkdtempSync(join(tmpdir(), 'undo-toast-'))
  const out = join(dir, 'harness.cjs')
  await build({
    stdin: {
      contents: [
        `import { createElement } from 'react'`,
        `export { createRoot } from 'react-dom/client'`,
        `export { act } from 'react'`,
        `export { undoStack } from ${JSON.stringify(join(root, 'src/renderer/keyboard.ts'))}`,
        `import UndoToast from ${JSON.stringify(join(root, 'src/renderer/components/UndoToast.tsx'))}`,
        `export const h = (p) => createElement(UndoToast, p)`,
      ].join('\n'),
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    loader: { '.css': 'empty' },
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  })
  const doc = new FakeDocument()
  const g = globalThis as Record<string, unknown>
  const saved = { window: g.window, document: g.document, act: g.IS_REACT_ACT_ENVIRONMENT }
  g.document = doc
  g.window = { document: doc, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} }
  g.IS_REACT_ACT_ENVIRONMENT = true
  const harness = createRequire(import.meta.url)(out) as Harness
  return {
    harness,
    cleanup: () => {
      g.window = saved.window
      g.document = saved.document
      g.IS_REACT_ACT_ENVIRONMENT = saved.act
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('UndoToast leaves on time while its parent redraws (Brief 266, defect B)', () => {
  test('redrawn every 100 ms with a new onDismiss, it dismisses once at about 5 s and its ⌘Z ends', async () => {
    const { harness, cleanup } = await loadHarness()
    // Only setTimeout is faked: React's scheduler runs on setImmediate, and act() flushes it.
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { createRoot, act, h, undoStack } = harness
      const container = (globalThis as unknown as { document: FakeDocument }).document.createElement('div')
      const root = createRoot(container)
      let dismissed = 0
      let dismissedAt = -1
      let now = 0
      // A new closure every time, like SongTable's `onDismiss={() => setUndo(null)}`.
      const draw = (): void => act(() => root.render(h({
        message: 'Removed 1 song',
        onUndo: () => {},
        onDismiss: () => { dismissed++; if (dismissedAt < 0) dismissedAt = now },
      })))

      draw()
      assert.equal(undoStack().length, 1, '⌘Z is armed while the toast shows')
      const toast = container.firstChild!
      assert.match(toast.className, /undo-toast/)
      assert.doesNotMatch(toast.className, /exiting/)

      // 8 s of a playing song: a redraw every 100 ms.
      while (now < 8000) {
        now += 100
        act(() => { mock.timers.tick(100) })
        draw()
      }

      assert.equal(dismissed, 1, `onDismiss called once in 8 s of redraws, got ${dismissed}`)
      // 5 s to start leaving, 300 ms to go; within one 100 ms redraw of that.
      assert.ok(dismissedAt >= 5300 && dismissedAt <= 5400, `dismissed at ${dismissedAt} ms, expected about 5.3 s`)
      assert.match(toast.className, /undo-toast--exiting/)
      assert.equal(undoStack().length, 0, '⌘Z no longer reaches a toast that has gone')

      act(() => root.unmount())
      assert.equal(undoStack().length, 0)
    } finally {
      mock.timers.reset()
      cleanup()
    }
  })

  test('the timer never depends on a callback prop', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'components', 'UndoToast.tsx'), 'utf8')
    assert.match(src, /\}, \[duration\]\)/)
    assert.doesNotMatch(src, /\[[^\]]*on(Dismiss|Undo)[^\]]*\]\)/)
  })
})
