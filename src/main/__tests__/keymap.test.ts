// V7 ONE KEYBOARD: the keymap (src/common/keymap.ts) owns every global
// shortcut and decides who gets each key. These tests pin the ownership
// rules (which handler gets each key in each state), Escape's order, the
// generated Keyboard Shortcuts sheet, and the menu: one wiring per shortcut.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SHORTCUTS, routeKey, layerOrder, shortcutSheet, displayAccelerator, eventMatches, eventKeyName, parseAccelerator, menuKeys,
  type KeyEventLike, type RouteContext, type FocusState,
} from '../../common/keymap.ts'
import { buildAppMenu } from '../app-menu.ts'
import type { MenuItemConstructorOptions } from 'electron'

const CODE: Record<string, string> = {
  ' ': 'Space', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  Escape: 'Escape', Enter: 'Enter', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight', F8: 'F8', F7: 'F7', F9: 'F9',
}
function key(k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  const code = CODE[k] ?? (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : k)
  return { key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}
const cmd = (k: string, more: Partial<KeyEventLike> = {}): KeyEventLike => key(k, { metaKey: true, ...more })
function ctx(over: Partial<RouteContext> & { focus?: FocusState } = {}): RouteContext {
  return { focus: 'none', claimed: () => false, escape: [], undo: [], ...over }
}
const to = (e: KeyEventLike, c: RouteContext = ctx()): string => {
  const r = routeKey(e, c)
  return r.to === 'shortcut' || r.to === 'escape' || r.to === 'undo' ? `${r.to}:${r.id}` : r.to
}

describe('who gets each key — nothing open, nothing focused', () => {
  it('Space plays / pauses; F8 is the menu\'s (registered there, so the host leaves it)', () => {
    assert.equal(to(key(' ')), 'shortcut:play-pause')
    assert.equal(to(key('F8')), 'native')
  })
  it('skip is ⌘← / ⌘→ (F7 / F9 are the menu\'s); a plain ← / → no longer skips', () => {
    assert.equal(to(cmd('ArrowLeft')), 'shortcut:previous')
    assert.equal(to(cmd('ArrowRight')), 'shortcut:next')
    assert.equal(to(key('F7')), 'native')
    assert.equal(to(key('F9')), 'native')
    assert.equal(to(key('ArrowLeft')), 'native')
    assert.equal(to(key('ArrowRight')), 'native')
  })
  it('volume is ⌘↑ / ⌘↓; a plain ↑ / ↓ is never volume (it moves the selection, or scrolls)', () => {
    assert.equal(to(cmd('ArrowUp')), 'shortcut:volume-up')
    assert.equal(to(cmd('ArrowDown')), 'shortcut:volume-down')
    assert.equal(to(key('ArrowUp')), 'native')
    assert.equal(to(key('ArrowDown')), 'native')
    assert.equal(to(key('ArrowUp', { shiftKey: true })), 'native')
  })
  it('Ctrl stands for ⌘ (CmdOrCtrl), as the app always read it', () => {
    assert.equal(to(key('ArrowRight', { ctrlKey: true })), 'shortcut:next')
  })
  it('a modifier the shortcut does not name means another key', () => {
    assert.equal(to(cmd('ArrowRight', { shiftKey: true })), 'native')
    assert.equal(to(key(' ', { metaKey: true })), 'native')
  })
  it('/ goes to Search; ⌘[ / ⌘] go back and forward', () => {
    assert.equal(to(key('/')), 'shortcut:search')
    assert.equal(to(cmd('[')), 'shortcut:back')
    assert.equal(to(cmd(']')), 'shortcut:forward')
  })
  it('menu-wired keys are never the renderer\'s: ⌘I, ⌘L, ⌘K, ⌘1, ⌘F, ⌘T, ⌥⌘L, ⌘/ fall through', () => {
    for (const e of [cmd('i'), cmd('l'), cmd('k'), cmd('1'), cmd('f'), cmd('t'), cmd('/'), key('¬', { code: 'KeyL', metaKey: true, altKey: true }), cmd('s', { shiftKey: true })]) {
      assert.equal(to(e), 'native', `${e.code}`)
    }
  })
  it('a composing (IME) key or one the focused element already handled is left alone', () => {
    assert.equal(to({ ...key(' '), isComposing: true }), 'native')
    assert.equal(to({ ...key(' '), defaultPrevented: true }), 'native')
  })
})

describe('who gets each key — a text field has focus', () => {
  const field = ctx({ focus: 'field' })
  it('Space, ⌘←/⌘→, ⌘↑/⌘↓, ⌘[ ⌘] and / are the field\'s', () => {
    for (const e of [key(' '), cmd('ArrowLeft'), cmd('ArrowRight'), cmd('ArrowUp'), cmd('ArrowDown'), cmd('['), cmd(']'), key('/')]) {
      assert.equal(to(e, field), 'native', e.key)
    }
  })
})

describe('who gets each key — a page holds a claim', () => {
  const claimSpace = ctx({ claimed: (c) => c === 'Space' })
  it('the claimed key is the page\'s; everything else is the app\'s', () => {
    assert.equal(to(key(' '), claimSpace), 'native')
    assert.equal(to(cmd('ArrowRight'), claimSpace), 'shortcut:next')
  })
  it('a claim holds the plain key only: ⌘←/⌘→ still skip in the Supreme Court room', () => {
    const arrows = ctx({ claimed: (c) => c === 'ArrowLeft' || c === 'ArrowRight' || c === 'Space' })
    assert.equal(to(cmd('ArrowLeft'), arrows), 'shortcut:previous')
    assert.equal(to(cmd('ArrowRight'), arrows), 'shortcut:next')
  })
  it('a claim never withholds Escape', () => {
    assert.equal(to(key('Escape'), ctx({ claimed: () => true, escape: [{ id: 'up-next' }] })), 'escape:up-next')
  })
})

describe('Escape — the top-most surface, everywhere', () => {
  it('closes the newest open surface, then the one under it', () => {
    const stack = [{ id: 'up-next' }, { id: 'settings' }, { id: 'confirm' }]
    assert.equal(to(key('Escape'), ctx({ escape: stack })), 'escape:confirm')
    assert.equal(to(key('Escape'), ctx({ escape: stack.slice(0, 2) })), 'escape:settings')
    assert.equal(to(key('Escape'), ctx({ escape: stack.slice(0, 1) })), 'escape:up-next')
  })
  it('with nothing open it clears Search', () => {
    assert.equal(to(key('Escape')), 'clear-search')
  })
  it('in a text field beside the page it lets go of the field and closes nothing', () => {
    assert.equal(to(key('Escape'), ctx({ focus: 'field', escape: [{ id: 'music-man' }] })), 'let-go')
  })
  it('in a text field inside a dialog it closes the dialog (Go Anywhere, Get Info, a picker)', () => {
    assert.equal(to(key('Escape'), ctx({ focus: 'field-in-overlay', escape: [{ id: 'up-next' }, { id: 'go-anywhere' }] })), 'escape:go-anywhere')
    assert.equal(to(key('Escape'), ctx({ focus: 'field-in-overlay' })), 'let-go')
  })
  it('a field that used Escape itself (cancelled a rename) keeps it', () => {
    assert.equal(to({ ...key('Escape'), defaultPrevented: true }, ctx({ escape: [{ id: 'up-next' }] })), 'native')
  })
})

describe('⌘Z — the latest Undo toast, outside a text field', () => {
  it('presses the newest Undo on screen', () => {
    assert.equal(to(cmd('z'), ctx({ undo: [{ id: 'a' }, { id: 'b' }] })), 'undo:b')
  })
  it('is the field\'s own undo while typing, and native with no toast', () => {
    assert.equal(to(cmd('z'), ctx({ focus: 'field', undo: [{ id: 'a' }] })), 'native')
    assert.equal(to(cmd('z')), 'native')
  })
  it('⇧⌘Z is never the toast\'s', () => {
    assert.equal(to(cmd('z', { shiftKey: true }), ctx({ undo: [{ id: 'a' }] })), 'native')
  })
})

describe('layers — dialogs, pages and lists that claim keys', () => {
  const L = (id: string, seq: number, modal = false, late = false) => ({ id, seq, modal, late })
  it('dialogs first, newest first, then pages and lists newest first', () => {
    const ls = [L('songs', 1), L('track-list', 2), L('confirm', 3, true), L('get-info', 4, true)]
    assert.deepEqual(layerOrder(ls, 'early', false).map((l) => l.id), ['get-info', 'confirm', 'track-list', 'songs'])
  })
  it('while a dialog is open the list under it gets nothing (no ↑/↓ under Get Info)', () => {
    const ls = [L('songs', 1), L('track-list', 2), L('get-info', 3, true)]
    assert.deepEqual(layerOrder(ls, 'early', true).map((l) => l.id), ['get-info'])
    assert.deepEqual(layerOrder([L('track-list', 2)], 'early', true), [])
  })
  it('late layers are offered after the focused element, early ones before it', () => {
    const ls = [L('quiz', 1, false, true), L('track-list', 2)]
    assert.deepEqual(layerOrder(ls, 'early', false).map((l) => l.id), ['track-list'])
    assert.deepEqual(layerOrder(ls, 'late', false).map((l) => l.id), ['quiz'])
  })
})

describe('the table', () => {
  it('ids are unique and every key parses', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const s of SHORTCUTS) for (const k of s.keys) assert.ok(parseAccelerator(k).key, `${s.id}: ${k}`)
  })
  it('one wiring per key: no two app-level shortcuts share a key', () => {
    const seen = new Map<string, string>()
    for (const s of SHORTCUTS) {
      if (s.wiring === 'page') continue
      for (const k of s.keys) {
        const c = parseAccelerator(k)
        const norm = `${c.ctrl}|${c.cmd}|${c.alt}|${c.shift}|${c.key}`
        assert.ok(!seen.has(norm), `${k} is both ${seen.get(norm)} and ${s.id}`)
        seen.set(norm, s.id)
      }
    }
  })
  it('the event-side spelling: ⌥⌘L reads its letter from the code, not the ¬ macOS reports', () => {
    assert.equal(eventKeyName(key('¬', { code: 'KeyL', metaKey: true, altKey: true })), 'L')
    assert.equal(eventKeyName(key('?', { code: 'Slash', shiftKey: true })), '/')
    assert.ok(eventMatches(cmd('ArrowUp'), 'CmdOrCtrl+Up'))
    assert.ok(!eventMatches(key('ArrowUp'), 'CmdOrCtrl+Up'))
    assert.ok(!eventMatches(key('f', { metaKey: true, ctrlKey: true }), 'CmdOrCtrl+F'), '⌃⌘F is full screen, not Find')
  })
})

describe('the Keyboard Shortcuts sheet (⌘/) is generated from the keymap', () => {
  const sheet = shortcutSheet()
  const rows = sheet.flatMap((s) => s.rows.map((r) => ({ ...r, section: s.title })))
  it('shows every shortcut the table has, in its section, once', () => {
    for (const s of SHORTCUTS.filter((x) => !x.hidden)) {
      const hits = rows.filter((r) => r.label === s.label && r.section === s.section)
      assert.equal(hits.length, 1, s.id)
    }
    assert.equal(rows.length, SHORTCUTS.filter((x) => !x.hidden).length, 'nothing the table lacks')
  })
  it('prints keys the Mac way', () => {
    assert.equal(displayAccelerator('Shift+CmdOrCtrl+L'), '⇧⌘L')
    assert.equal(displayAccelerator('Alt+CmdOrCtrl+U'), '⌥⌘U')
    assert.equal(displayAccelerator('Ctrl+CmdOrCtrl+F'), '⌃⌘F')
    const row = (label: string): string[] => rows.find((r) => r.label === label)!.keys
    assert.deepEqual(row('Previous Song'), ['⌘←', 'F7'])
    assert.deepEqual(row('Volume Up'), ['⌘↑'])
    assert.deepEqual(row('Play / Pause'), ['Space', 'F8'])
    assert.deepEqual(row('Go Anywhere…'), ['⌘K'])
    assert.deepEqual(row('Move the selection'), ['↑', '↓'])
  })
  it('sections come in a fixed order, Playback first', () => {
    assert.deepEqual(sheet.map((s) => s.title), ['Playback', 'Go', 'Panels', 'Lists', 'Library', 'Editing', 'Window'])
  })
})

describe('the Mac menu bar — one wiring per shortcut', () => {
  const sent: string[] = []
  const menu = buildAppMenu({ about: { label: 'About JakeTunes' }, send: (a) => sent.push(a), hubOffload: () => {} })
  const all: { item: MenuItemConstructorOptions; path: string }[] = []
  const walk = (items: MenuItemConstructorOptions[], path: string): void => {
    for (const it of items) {
      const p = `${path} > ${it.label ?? it.role ?? it.type}`
      all.push({ item: it, path: p })
      if (Array.isArray(it.submenu)) walk(it.submenu as MenuItemConstructorOptions[], p)
    }
  }
  walk(menu, '')
  const byLabel = (label: string) => all.find((x) => x.item.label === label)
  const menuNamed = (label: string) => menu.find((m) => m.label === label)

  it('no accelerator appears twice in the menu', () => {
    const accels = all.map((x) => x.item.accelerator).filter(Boolean) as string[]
    assert.equal(new Set(accels).size, accels.length, accels.join(', '))
  })
  it('macOS: no key the keyboard host answers is a menu accelerator (Electron registers every accelerator shown there, even with registerAccelerator: false)', () => {
    assert.ok(all.every((x) => x.item.registerAccelerator === undefined), 'registerAccelerator: false is a no-op on darwin; never lean on it')
    const accels = all.map((x) => x.item.accelerator).filter(Boolean) as string[]
    for (const s of SHORTCUTS.filter((x) => x.wiring === 'keymap')) {
      for (const k of s.keys) {
        if (k === s.menuAccelerator) continue
        assert.ok(!accels.includes(k), `${s.id}: ${k} on the menu would fire while typing`)
      }
    }
    // The ones that matter most, by name: typing a space, or ⌘← in a field.
    for (const bad of ['Space', 'CmdOrCtrl+Left', 'CmdOrCtrl+Right', 'CmdOrCtrl+Up', 'CmdOrCtrl+Down', 'CmdOrCtrl+[', 'CmdOrCtrl+]', 'Escape', '/']) {
      assert.ok(!accels.includes(bad), `${bad} is on the menu`)
    }
  })
  it('every menu-wired and role shortcut is on the menu once with its key; keymap ones by their menu key (F7/F8/F9) or by name', () => {
    for (const s of SHORTCUTS) {
      if (s.wiring === 'page' || s.id === 'close-top' || s.id === 'search') continue
      if (s.wiring === 'keymap') {
        const it = all.find((x) => x.item.label === s.label)
        assert.ok(it, `${s.id} is on the menu`)
        assert.equal(it!.item.accelerator, s.menuAccelerator, s.id)
        continue
      }
      assert.equal(all.filter((x) => x.item.accelerator === s.keys[0]).length, 1, `${s.id} (${s.keys[0]}) is on the menu once`)
    }
    assert.throws(() => menuKeys('list-move'), /belongs to a page/)
  })
  it('the menu sends each menu-wired shortcut\'s action', () => {
    for (const s of SHORTCUTS.filter((x) => x.wiring === 'menu')) {
      const it = all.find((x) => x.item.accelerator === s.keys[0])!.item
      sent.length = 0
      ;(it.click as () => void)()
      assert.deepEqual(sent, [s.action], s.id)
    }
  })
  it('real Mac menus: Hide, Window (Minimize, Zoom), Full Screen, Help', () => {
    const app = menuNamed('JakeTunes')!.submenu as MenuItemConstructorOptions[]
    assert.ok(app.some((x) => x.role === 'hide' && x.accelerator === 'CmdOrCtrl+H'))
    assert.ok(app.some((x) => x.role === 'hideOthers'))
    assert.ok(app.some((x) => x.role === 'unhide'))
    const win = menuNamed('Window')!
    assert.equal(win.role, 'windowMenu')
    const ws = win.submenu as MenuItemConstructorOptions[]
    assert.ok(ws.some((x) => x.role === 'minimize' && x.accelerator === 'CmdOrCtrl+M'))
    assert.ok(ws.some((x) => x.role === 'zoom'))
    assert.ok(all.some((x) => x.item.role === 'togglefullscreen' && x.item.label === 'Enter Full Screen'))
    const help = menuNamed('Help')!
    assert.equal(help.role, 'help')
    assert.ok((help.submenu as MenuItemConstructorOptions[]).some((x) => x.label === 'Keyboard Shortcuts' && x.accelerator === 'CmdOrCtrl+/'))
  })
  it('a Go menu: Back, Forward (⌘[ ⌘] are the host\'s, so typing never goes back), then ⌘1–⌘6 in order, then Go Anywhere ⌘K', () => {
    const items = menuNamed('Go')!.submenu as MenuItemConstructorOptions[]
    assert.deepEqual(items.slice(0, 2).map((x) => [x.label, x.accelerator]), [['Back', undefined], ['Forward', undefined]])
    sent.length = 0
    ;(items[0].click as () => void)(); (items[1].click as () => void)()
    assert.deepEqual(sent, ['history-back', 'history-forward'])
    assert.deepEqual(items.filter((x) => x.accelerator).map((x) => `${x.label} ${x.accelerator}`), [
      'Home CmdOrCtrl+1', 'Songs CmdOrCtrl+2', 'Albums CmdOrCtrl+3', 'Artists CmdOrCtrl+4', 'Live Albums CmdOrCtrl+5', 'Record Shop CmdOrCtrl+6',
      'Go Anywhere… CmdOrCtrl+K',
    ])
  })
  it('Up Next ⌥⌘U and Downloads ⌥⌘L', () => {
    assert.equal(byLabel('Up Next')!.item.accelerator, 'Alt+CmdOrCtrl+U')
    assert.equal(byLabel('Downloads')!.item.accelerator, 'Alt+CmdOrCtrl+L')
  })
  it('the menu says volume moves 5% a press, and it does', () => {
    const vol = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'audio', 'volumeModel.ts'), 'utf8')
    assert.match(vol, /export const VOLUME_STEP = 0\.05/)
  })
  it('every menu action is handled in the renderer', () => {
    const r = (p: string): string => readFileSync(join(import.meta.dirname, '..', '..', 'renderer', p), 'utf8')
    const handled = r('App.tsx') + r('context/NavigationContext.tsx')
    sent.length = 0
    for (const { item } of all) if (typeof item.click === 'function' && item.label !== 'About JakeTunes' && !/Offload/.test(String(item.label))) (item.click as () => void)()
    for (const a of new Set(sent)) {
      assert.ok(handled.includes(`case '${a}'`) || handled.includes(`action === '${a}'`), `nobody handles menu action "${a}"`)
    }
  })
  it('index.ts builds the menu from app-menu.ts and carries no accelerator of its own', () => {
    const index = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')
    assert.match(index, /const menuTemplate: Electron\.MenuItemConstructorOptions\[\] = buildAppMenu\(\{/)
    assert.doesNotMatch(index, /accelerator:/)
  })
})
