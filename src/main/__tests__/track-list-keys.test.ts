// ↑/↓ on every song list (Jake, 2026-11-07: "i cant go up and down any
// playlist with the up down arrows!!!"). Only Songs had list keys; in a
// playlist ↑/↓ fell through to App.tsx's global volume. The keys now live in
// one hook (src/renderer/hooks/useTrackListKeys.ts) over the pure part
// tested here (src/renderer/utils/trackListKeys.ts).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  listKeyIntent, nextListIndex, shiftRange, typeToFindIndex, isTypingTarget,
  type ListKeyLike,
} from '../../renderer/utils/trackListKeys.ts'

const key = (k: string, mods: Partial<ListKeyLike> = {}): ListKeyLike =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('listKeyIntent', () => {
  test('↑/↓ move, ⇧ extends', () => {
    assert.deepEqual(listKeyIntent(key('ArrowDown')), { kind: 'move', dir: 1, extend: false })
    assert.deepEqual(listKeyIntent(key('ArrowUp')), { kind: 'move', dir: -1, extend: false })
    assert.deepEqual(listKeyIntent(key('ArrowUp', { shiftKey: true })), { kind: 'move', dir: -1, extend: true })
  })
  test('⌥↑/⌥↓ are left to the sidebar section headers', () => {
    assert.equal(listKeyIntent(key('ArrowDown', { altKey: true })), null)
  })
  test('⌘↑/⌘↓ and Ctrl+↑/↓ are the volume keys, never a selection move', () => {
    assert.equal(listKeyIntent(key('ArrowUp', { metaKey: true })), null)
    assert.equal(listKeyIntent(key('ArrowDown', { metaKey: true })), null)
    assert.equal(listKeyIntent(key('ArrowUp', { ctrlKey: true })), null)
    assert.equal(listKeyIntent(key('ArrowDown', { ctrlKey: true, shiftKey: true })), null)
  })
  test('←/→ are never taken (transport / Cover Flow)', () => {
    assert.equal(listKeyIntent(key('ArrowLeft')), null)
    assert.equal(listKeyIntent(key('ArrowRight')), null)
  })
  test('Enter, Space, a letter', () => {
    assert.deepEqual(listKeyIntent(key('Enter')), { kind: 'enter' })
    assert.deepEqual(listKeyIntent(key(' ')), { kind: 'space' })
    assert.deepEqual(listKeyIntent(key('B')), { kind: 'char', char: 'b' })
    assert.equal(listKeyIntent(key('a', { metaKey: true })), null, '⌘A is select-all, not a search')
    assert.equal(listKeyIntent(key('Delete')), null)
  })
})

describe('nextListIndex', () => {
  test('one step either way', () => {
    assert.equal(nextListIndex(3, 1, 10), 4)
    assert.equal(nextListIndex(3, -1, 10), 2)
  })
  test('clamped at both ends', () => {
    assert.equal(nextListIndex(9, 1, 10), 9)
    assert.equal(nextListIndex(0, -1, 10), 0)
  })
  test('nothing focused: ↓ starts at the top, ↑ at the bottom', () => {
    assert.equal(nextListIndex(-1, 1, 10), 0)
    assert.equal(nextListIndex(-1, -1, 10), 9)
  })
  test('a cursor past a list that shrank lands on the last row', () => {
    assert.equal(nextListIndex(40, 1, 10), 9)
  })
  test('empty list: nowhere', () => {
    assert.equal(nextListIndex(-1, 1, 0), -1)
    assert.equal(nextListIndex(2, -1, 0), -1)
  })
})

describe('shiftRange', () => {
  test('from the anchor to the new row, either direction', () => {
    assert.deepEqual(shiftRange(2, 5), { from: 2, to: 5 })
    assert.deepEqual(shiftRange(5, 2), { from: 2, to: 5 })
  })
  test('no anchor: just the new row', () => {
    assert.deepEqual(shiftRange(-1, 4), { from: 4, to: 4 })
  })
})

test('moves follow the order on screen (a sorted list), not library order', () => {
  const library = [{ id: 1, title: 'Zebra' }, { id: 2, title: 'Apple' }, { id: 3, title: 'Mango' }]
  const sorted = [...library].sort((a, b) => a.title.localeCompare(b.title))
  let idx = -1
  const seen: number[] = []
  for (let i = 0; i < 4; i++) {
    idx = nextListIndex(idx, 1, sorted.length)
    seen.push(sorted[idx].id)
  }
  assert.deepEqual(seen, [2, 3, 1, 1])
  const { from, to } = shiftRange(0, 2)
  assert.deepEqual(sorted.slice(from, to + 1).map(t => t.id), [2, 3, 1])
})

test('typeToFindIndex: first title starting with the typed letters', () => {
  const rows = [{ title: 'Blue Monday' }, { title: 'Bloodbuzz Ohio' }, { title: null }, { title: 'blue sky' }]
  assert.equal(typeToFindIndex(rows, 'blo'), 1)
  assert.equal(typeToFindIndex(rows, 'blue '), 0)
  assert.equal(typeToFindIndex(rows, 'x'), -1)
  assert.equal(typeToFindIndex(rows, ''), -1)
})

test('isTypingTarget: fields and contenteditable keep their keys', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true)
  assert.equal(isTypingTarget({ tagName: 'textarea' }), true)
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV' }), false)
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false)
  assert.equal(isTypingTarget(null), false)
})

describe('source lock: every song list uses the shared keys', () => {
  const root = join(import.meta.dirname, '../../renderer')
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

  // V7: the six song lists draw one table (components/SongTable.tsx), and the
  // table is the one caller of the keys — song-table.test.ts locks that each
  // page uses it. Its keys follow the order on screen and only answer while
  // its page is the one showing in list mode (Grid / Cover Flow aren't tables).
  test('the song table calls useTrackListKeys, for its page only', () => {
    const src = read('components/SongTable.tsx')
    assert.match(src, /import \{ useTrackListKeys \} from '\.\.\/hooks\/useTrackListKeys'/)
    const call = src.slice(src.indexOf('useTrackListKeys({'))
    assert.match(call.slice(0, 200), /enabled: active && !dialogOpen,/)
    assert.match(call.slice(0, 200), /\n    tracks,\n/, 'moves in the order on screen')
    for (const [file, view] of [
      ['views/PlaylistView.tsx', 'playlist'],
      ['views/SmartPlaylistView.tsx', 'smart-playlist'],
      ['views/SongsView.tsx', 'songs'],
      ['views/GenresView.tsx', 'genres'],
      ['views/AlbumDetailView.tsx', 'album-detail'],
      ['views/IpodPlaylistView.tsx', 'ipod-playlist'],
    ] as const) {
      assert.match(read(file), new RegExp(`active=\\{(lib|state|libState)\\.currentView === '${view}'\\}`), file)
    }
  })

  test('the hook claims ↑/↓ so the global volume shortcut does not also fire', () => {
    const src = read('hooks/useTrackListKeys.ts')
    const move = src.slice(src.indexOf("intent.kind === 'move'"), src.indexOf("intent.kind === 'enter'"))
    assert.match(move, /e\.preventDefault\(\)/)
    assert.match(move, /e\.stopPropagation\(\)/)
    assert.match(src, /addKeyLayer\('track-list', handleKeyDown\)/, 'a list layer on the keyboard host (V7), ahead of the app\'s shortcuts')
  })

  test('PlaylistView keeps its hooks above the not-found return', () => {
    const src = read('views/PlaylistView.tsx')
    assert.ok(src.indexOf('useListSort(') < src.indexOf('if (!playlist) {\n    return'))
  })
})
