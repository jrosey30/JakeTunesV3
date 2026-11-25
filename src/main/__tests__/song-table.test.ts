// V7 — ONE SONG LIST (2026-11-24). The song list used to be built six times
// (Songs, a playlist, a smart playlist, an album, Genres, an iPod's playlist)
// and the six had drifted. They now draw one table,
// src/renderer/components/SongTable.tsx, over the pure rules in
// src/renderer/utils/songTableRules.ts. This file tests the rules, and locks
// that every page uses the table instead of growing a seventh copy.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALWAYS_VISIBLE, ORIGINAL_ORDER, SONG_COLUMNS, SONG_MENU_CORE, assembleSongMenu, deleteSongsWording, dragLabel, savedSongsSort,
  filterSongs, ipodPlaylistMenuEntry, menuSlot, moveRows, nextSort, removedFromListNotice, rowWindow, sortSongs,
  type SongMenuParts,
} from '../../renderer/utils/songTableRules.ts'
import { shuffle } from '../../common/shuffle.ts'
import { formatDuration } from '../../common/format-duration.ts'
import { parseViewModes } from '../../renderer/utils/viewModes.ts'
import type { MenuEntry } from '../../renderer/components/ContextMenu.tsx'

const R = join(import.meta.dirname, '..', '..', 'renderer')
const read = (...p: string[]): string => readFileSync(join(R, ...p), 'utf8')
const labels = (items: MenuEntry[]): string[] => items.map((m) => (m.separator ? '—' : m.label))

describe('sorting: ascending, descending, then the list\'s own order', () => {
  test('three states on one column', () => {
    const a = nextSort(null, 'artist')
    assert.deepEqual(a, { column: 'artist', direction: 'asc' })
    const b = nextSort(a, 'artist')
    assert.deepEqual(b, { column: 'artist', direction: 'desc' })
    assert.equal(nextSort(b, 'artist'), null, 'third click = Original Order')
  })
  test('a new column always starts ascending', () => {
    assert.deepEqual(nextSort({ column: 'title', direction: 'desc' }, 'time'), { column: 'time', direction: 'asc' })
  })
  test('the own order is called "Original Order" everywhere', () => {
    assert.equal(ORIGINAL_ORDER, 'Original Order')
    const table = read('components', 'SongTable.tsx')
    assert.match(table, /label: ORIGINAL_ORDER, checked: !sort/)
    for (const f of ['PlaylistView.tsx', 'SmartPlaylistView.tsx']) {
      assert.doesNotMatch(read('views', f), /'Playlist Order'|'Default Order'/, f)
    }
  })

  const rows = [
    { id: 1, title: 'b', duration: 300_000, year: 100, camelotKey: '10A', artist: 'The Strokes' },
    { id: 2, title: 'a', duration: 72_000, year: 72, camelotKey: '2A', artist: 'Arcade Fire' },
    { id: 3, title: 'c', duration: 72_000, year: 9, camelotKey: '1B', artist: 'Blur' },
  ]
  test('null hands back the list as it came (a copy)', () => {
    const out = sortSongs(rows, null)
    assert.deepEqual(out.map((r) => r.id), [1, 2, 3])
    assert.notEqual(out, rows)
  })
  test('Time sorts, by length, ties keep the list\'s order', () => {
    assert.deepEqual(sortSongs(rows, { column: 'time', direction: 'asc' }).map((r) => r.id), [2, 3, 1])
    assert.deepEqual(sortSongs(rows, { column: 'time', direction: 'desc' }).map((r) => r.id), [1, 2, 3])
  })
  test('numbers as numbers, Key around the wheel, Artist without "The"', () => {
    assert.deepEqual(sortSongs(rows, { column: 'year', direction: 'asc' }).map((r) => r.id), [3, 2, 1])
    assert.deepEqual(sortSongs(rows, { column: 'camelotKey', direction: 'asc' }).map((r) => r.id), [3, 2, 1])
    assert.deepEqual(sortSongs(rows, { column: 'artist', direction: 'asc' }).map((r) => r.id), [2, 3, 1])
  })
  test('"This page" search: every word somewhere in the row', () => {
    assert.deepEqual(filterSongs(rows, 'arcade a').map((r) => r.id), [2])
    assert.equal(filterSongs(rows, '  '), rows)
  })
})

describe('columns: one set for every page', () => {
  test('every column but the speaker sorts — Time included; BPM, Key, Subgenre exist', () => {
    for (const c of SONG_COLUMNS) assert.equal(c.sortable, c.key !== 'playing', c.key)
    const keys = SONG_COLUMNS.map((c) => c.key)
    for (const k of ['bpm', 'camelotKey', 'subgenre', 'time', 'origin']) assert.ok(keys.includes(k as never), k)
    assert.ok(ALWAYS_VISIBLE.has('title') && ALWAYS_VISIBLE.has('playing'))
  })
  test('no page keeps a column list of its own', () => {
    for (const f of ['SongsView.tsx', 'PlaylistView.tsx', 'SmartPlaylistView.tsx', 'AlbumDetailView.tsx', 'GenresView.tsx', 'IpodPlaylistView.tsx']) {
      assert.doesNotMatch(read('views', f), /ALL_COLUMN_DEFS|const GRID = |gridCols\(/, f)
    }
  })
  test('the layout is saved once and shared (useColumnLayout over columnState)', () => {
    const hook = read('hooks', 'useColumnLayout.ts')
    assert.match(hook, /useSyncExternalStore\(subscribeColumnCache, read\)/)
    assert.match(hook, /'jaketunes-save-columns'/)
    assert.match(hook, /'jaketunes-restore-columns'/)
    assert.match(read('components', 'SongTable.tsx'), /useColumnLayout\(fixedColumns\)/)
  })
})

describe('the menu: one order on every page', () => {
  const item = (label: string): MenuEntry => ({ label, onClick: () => {} })
  const parts = (over: Partial<SongMenuParts> = {}): SongMenuParts => ({
    queue: [item('Play Next'), item('Add to Up Next')],
    playlist: { label: 'Add to Playlist', submenu: [] },
    ipodPlaylist: { label: 'Add to iPod Playlist', disabled: true },
    goAlbum: item('Go to Album'),
    goArtist: item('Go to Artist'),
    star: item('Unstar'),
    download: item('Download 3 Songs'),
    share: item('Share…'),
    getInfo: item('Get Info'),
    more: [item('Cynthia')],
    extras: [item('Remove from Playlist')],
    del: item('Delete Song'),
    ...over,
  })
  test('the ten come first, in Jake\'s order', () => {
    const slots = assembleSongMenu(parts()).filter((m) => !m.separator).map((m) => menuSlot((m as { label: string }).label)).filter(Boolean)
    assert.deepEqual(slots, [...SONG_MENU_CORE])
  })
  test('then the rest, the page\'s own, and Delete last; separators only between groups', () => {
    const out = labels(assembleSongMenu(parts()))
    assert.deepEqual(out.slice(-7), ['Get Info', '—', 'Cynthia', '—', 'Remove from Playlist', '—', 'Delete Song'])
    assert.equal(out.at(-1), 'Delete Song')
    assert.ok(out.indexOf('Remove from Playlist') > out.indexOf('Get Info'))
    assert.notEqual(out[0], '—')
    assert.ok(!out.some((l, i) => l === '—' && out[i + 1] === '—'), 'no double separators')
  })
  test('no Download on a Mac that keeps every song; Play only where asked (the Home\'s cards)', () => {
    assert.ok(!labels(assembleSongMenu(parts({ download: undefined }))).some((l) => l.startsWith('Download')))
    assert.equal(labels(assembleSongMenu(parts({ play: item('Play "x"') })))[0], 'Play "x"')
    assert.equal(labels(assembleSongMenu(parts()))[0], 'Play Next')
  })
  test('libraryMenus builds every song menu through it, and the table passes the page\'s extras', () => {
    const menus = read('utils', 'libraryMenus.ts')
    const fn = menus.slice(menus.indexOf('export function songMenuEntries'), menus.indexOf('export interface AlbumMenuOptions'))
    assert.match(fn, /return assembleSongMenu\(\{/)
    assert.match(fn, /label: 'Share…'/)
    const table = read('components', 'SongTable.tsx')
    assert.match(table, /songMenuEntries\(\{/)
    assert.match(table, /extras,/)
  })
  test('"Add to iPod Playlist ▸" is ONE submenu naming each iPod', () => {
    const one = ipodPlaylistMenuEntry([
      { ipodName: 'punkPod', playlists: [{ name: 'Fast', onClick: () => {} }] },
      { ipodName: 'Nano', playlists: [] },
      { ipodName: 'iBANDCAMP', playlists: [{ name: 'A', onClick: () => {} }, { name: 'B', onClick: () => {} }] },
    ])
    assert.equal(!one.separator && one.label, 'Add to iPod Playlist')
    const sub = !one.separator ? one.submenu ?? [] : []
    assert.deepEqual(labels(sub), ['punkPod', 'Fast', '—', 'iBANDCAMP', 'A', 'B'])
    assert.equal(!sub[0].separator && sub[0].disabled, true, 'the iPod name is a heading')
    const none = ipodPlaylistMenuEntry([{ ipodName: 'Nano', playlists: [] }])
    assert.equal(!none.separator && none.disabled, true)
    assert.match(read('ipodPlaylistAdd.ts'), /return \[ipodPlaylistMenuEntry\(/)
  })
})

describe('delete and remove: the words fit one or many', () => {
  test('one song is "it", many are "them"', () => {
    const one = deleteSongsWording(1)
    assert.match(one.message, /this song/)
    assert.match(one.detail, /remove it from/)
    assert.doesNotMatch(one.detail, /them/)
    const many = deleteSongsWording(12)
    assert.match(many.message, /12 songs/)
    assert.match(many.detail, /remove them from/)
  })
  test('the Undo line', () => {
    assert.equal(removedFromListNotice(1, 'Gym'), 'Removed 1 song from “Gym”')
    assert.equal(removedFromListNotice(3, 'Gym'), 'Removed 3 songs from “Gym”')
  })
  test('one dialog asks it everywhere; no page writes its own', () => {
    assert.match(read('components', 'DeleteSongsDialog.tsx'), /deleteSongsWording\(ids\.length, alsoLeaves\)/)
    for (const f of ['SongsView.tsx', 'PlaylistView.tsx', 'SmartPlaylistView.tsx', 'AlbumDetailView.tsx', 'GenresView.tsx', 'IpodPlaylistView.tsx']) {
      assert.doesNotMatch(read('views', f), /delete this song from your library|remove them from all playlists/, f)
    }
  })
  test('Delete: out of the list with Undo where the page allows, else the library after asking', () => {
    const t = read('components', 'SongTable.tsx')
    assert.match(t, /if \(live\.current\.onRemove\) removeSongs\(songs\)\s*else if \(deleteKeyDeletes\) setDeleteIds/)
    assert.match(t, /<UndoToast/)
    assert.match(t, /<DeleteSongsDialog ids=\{deleteIds\}/)
    assert.match(read('views', 'PlaylistView.tsx'), /onRemove=\{removeFromPlaylist\}/)
    assert.match(read('views', 'IpodPlaylistView.tsx'), /onRemove=\{editable \? removeSongs : undefined\}/)
  })
})

describe('drag', () => {
  test('the preview says the song, or "12 Songs"', () => {
    assert.equal(dragLabel([{ title: 'Holiday' }]), 'Holiday')
    assert.equal(dragLabel(Array.from({ length: 12 }, () => ({ title: 'x' }))), '12 Songs')
    assert.match(read('components', 'SongTable.tsx'), /ghost\.textContent = dragLabel\(songs\)/)
  })
  test('several rows move together, keeping their order', () => {
    const order = [1, 2, 3, 4, 5, 6]
    assert.deepEqual(moveRows(order, [5, 2], 0), [2, 5, 1, 3, 4, 6], 'to the top')
    assert.deepEqual(moveRows(order, [1, 2], 5), [3, 4, 5, 1, 2, 6], 'before the 6')
    assert.deepEqual(moveRows(order, [1, 3], 6), [2, 4, 5, 6, 1, 3], 'to the end')
    assert.deepEqual(moveRows(order, [3, 4], 3), order, 'onto itself: nothing moves')
    assert.deepEqual(moveRows(order, [9], 2), order, 'an id not in the list moves nothing')
  })
  test('reorder only in the list\'s own order, unfiltered', () => {
    assert.match(read('components', 'SongTable.tsx'), /const canReorder = !!onReorder && !sort && !lib\.searchQuery/)
  })
})

describe('long lists draw only what is in view', () => {
  test('the window around the scroll position', () => {
    const w = rowWindow({ count: 10_000, rowHeight: 18, bodyTop: 0, scrollTop: 18 * 5000, viewHeight: 18 * 40, overscan: 14 })
    assert.deepEqual(w, { start: 4986, end: 5054 })
    assert.ok(w.end - w.start < 100, 'a screenful, not ten thousand rows')
  })
  test('rows that start below an ad or a sleeve', () => {
    assert.deepEqual(rowWindow({ count: 1000, rowHeight: 18, bodyTop: 400, scrollTop: 0, viewHeight: 600, overscan: 0 }), { start: 0, end: 12 })
    assert.deepEqual(rowWindow({ count: 0, rowHeight: 18, bodyTop: 0, scrollTop: 0, viewHeight: 600, overscan: 10 }), { start: 0, end: 0 })
    assert.deepEqual(rowWindow({ count: 30, rowHeight: 18, bodyTop: 0, scrollTop: 9000, viewHeight: 600, overscan: 5 }), { start: 30, end: 30 })
  })
  test('the table draws tracks.slice(start, end), not the whole list; the smart page no longer maps every row', () => {
    const t = read('components', 'SongTable.tsx')
    assert.match(t, /const rows = tracks\.slice\(winStart, winEnd\)/)
    assert.doesNotMatch(read('views', 'SmartPlaylistView.tsx'), /sortedTracks\.map\(\(track, i\)/)
  })
})

describe('one shuffle, and it is fair', () => {
  // A seeded generator, so the test is the same every run.
  const mulberry32 = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  test('every order of three songs comes up about equally', () => {
    const rng = mulberry32(7)
    const counts = new Map<string, number>()
    const N = 60_000
    for (let i = 0; i < N; i++) {
      const k = shuffle(['a', 'b', 'c'], rng).join('')
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    assert.equal(counts.size, 6)
    for (const [k, n] of counts) assert.ok(Math.abs(n / N - 1 / 6) < 0.01, `${k}: ${n}`)
  })
  test('the first song of ten is any of the ten, evenly', () => {
    const rng = mulberry32(11)
    const first = new Array(10).fill(0)
    const N = 50_000
    const list = Array.from({ length: 10 }, (_, i) => i)
    for (let i = 0; i < N; i++) first[shuffle(list, rng)[0]]++
    for (const n of first) assert.ok(Math.abs(n / N - 0.1) < 0.01, String(first))
  })
  test('the list itself is never changed, and nothing is lost', () => {
    const list = [1, 2, 3, 4, 5]
    const out = shuffle(list)
    assert.deepEqual(list, [1, 2, 3, 4, 5])
    assert.deepEqual([...out].sort(), [1, 2, 3, 4, 5])
  })
  test('no random comparator left anywhere in the app', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
    })
    for (const f of walk(R)) {
      assert.doesNotMatch(readFileSync(f, 'utf8'), /sort\(\(\) => Math\.random\(\) - 0\.5\)/, f)
    }
  })
})

describe('small things, once', () => {
  test('formatDuration: floored seconds, an hour form, blank for nothing', () => {
    assert.equal(formatDuration(210_946), '3:30')
    assert.equal(formatDuration(3_725_000), '1:02:05')
    assert.equal(formatDuration(0), '')
    assert.equal(formatDuration(undefined), '')
    for (const f of ['SongsView.tsx', 'PlaylistView.tsx', 'SmartPlaylistView.tsx', 'AlbumDetailView.tsx', 'IpodPlaylistView.tsx', 'MixDetailView.tsx', 'CoverFlowView.tsx']) {
      assert.doesNotMatch(read('views', f), /function formatDuration|const fmtDur/, f)
    }
  })
  test('one StarRating: no view draws its own', () => {
    for (const f of ['SongsView.tsx', 'PlaylistView.tsx', 'SmartPlaylistView.tsx', 'AlbumDetailView.tsx']) {
      const v = read('views', f)
      assert.doesNotMatch(v, /function StarRating|<polygon points="5,1/, f)
    }
    assert.match(read('components', 'SongTable.tsx'), /<TitleStar track=\{track\}/)
  })
  test('List / Grid / Cover Flow survives a relaunch', () => {
    assert.deepEqual(parseViewModes({ songs: 'grid', 'playlist:a': 'coverflow', bad: 'tiles', n: 3 }), { songs: 'grid', 'playlist:a': 'coverflow' })
    assert.deepEqual(parseViewModes(null), {})
    assert.deepEqual(parseViewModes(['list']), {})
    const ctx = read('context', 'ViewModeContext.tsx')
    assert.match(ctx, /saveUiState\(\{ \[VIEW_MODES_KEY\]: next \}\)/)
    assert.match(ctx, /parseViewModes\(/)
  })
})

describe('structure: all six pages draw the one table', () => {
  const pages = ['SongsView.tsx', 'PlaylistView.tsx', 'SmartPlaylistView.tsx', 'AlbumDetailView.tsx', 'GenresView.tsx', 'IpodPlaylistView.tsx']
  for (const f of pages) {
    test(f, () => {
      const v = read('views', f)
      assert.match(v, /import SongTable\b[^\n]*from '\.\.\/components\/SongTable'/)
      assert.match(v, /<SongTable\b/)
      // Nothing of a table of its own: rows, row menus, list keys, Get Info, delete prompts.
      assert.doesNotMatch(v, /className=\{`songs-row|genres-track-row|apd-row/, 'draws no rows of its own')
      assert.doesNotMatch(v, /useTrackListKeys\(|<GetInfoModal|<DeleteSongsDialog|getContextMenuItems/, 'keys, Get Info, delete come from the table')
    })
  }
  test('the table wires the shared pieces', () => {
    const t = read('components', 'SongTable.tsx')
    assert.match(t, /useTrackListKeys\(\{/)
    assert.match(t, /useRowWindow\(/)
    assert.match(t, /<GetInfoModal/)
    assert.match(t, /'jaketunes-get-info'/)
    assert.match(t, /enabled: active && !dialogOpen/)
  })
  test('Get Info opens on the song right-clicked', () => {
    assert.match(read('components', 'SongTable.tsx'), /: \{ tracks: \[track\], index: ctxMenu\.idx \}\)/)
  })
})

describe('review fixes (V7 PR 481)', () => {
  test('Songs\' Original Order survives a relaunch', () => {
    assert.equal(savedSongsSort({ sortColumn: null, sortDirection: 'asc' }), null, 'saved Original Order comes back as Original Order')
    assert.deepEqual(savedSongsSort({ sortColumn: 'artist', sortDirection: 'desc' }), { column: 'artist', direction: 'desc' })
    assert.deepEqual(savedSongsSort({ sortColumn: 'time' }), { column: 'time', direction: 'asc' })
    assert.equal(savedSongsSort({}), undefined, 'nothing saved: keep the default')
    assert.equal(savedSongsSort({ sortColumn: 'rating' }), undefined, 'a retired column is not restored')
    assert.equal(savedSongsSort({ sortColumn: 42 }), undefined)
    const app = read('App.tsx')
    assert.match(app, /const savedSort = savedSongsSort\(ui\)\s*if \(savedSort !== undefined\) dispatch\(\{ type: 'SET_SORT_STATE', sort: savedSort \}\)/)
    assert.doesNotMatch(app, /typeof ui\.sortColumn === 'string'/, 'the string-only restore is gone')
    assert.match(app, /sortColumn: libState\.sortColumn,/, 'and null is what gets saved')
  })

  test('Delete key: library pages ask, lists of other things do nothing', () => {
    for (const f of ['SongsView.tsx', 'AlbumDetailView.tsx', 'GenresView.tsx']) {
      assert.doesNotMatch(read('views', f), /deleteKeyDeletes=\{false\}/, `${f} is a library view: Delete asks to delete`)
    }
    const smart = read('views', 'SmartPlaylistView.tsx')
    assert.match(smart, /deleteKeyDeletes=\{false\}/, 'Top 1000, iPod lists, smart playlists: Delete does nothing')
    assert.doesNotMatch(smart, /libraryDeleteInMenu=\{false\}/, '…but the menu still offers it')
    assert.match(smart, /alsoLeaves=\{displayName\}/)
    assert.match(read('components', 'SongTable.tsx'), /deleteKeyDeletes = true, libraryDeleteInMenu = true/)
    assert.match(read('components', 'SongTable.tsx'), /<DeleteSongsDialog ids=\{deleteIds\} alsoLeaves=\{alsoLeaves\}/)
  })

  test('the delete question names what else the songs leave', () => {
    assert.match(deleteSongsWording(1, 'punkPod').detail, /It also leaves punkPod\./)
    assert.match(deleteSongsWording(3, 'punkPod').detail, /They also leave punkPod\./)
    assert.doesNotMatch(deleteSongsWording(3).detail, /also/)
    assert.match(read('components', 'DeleteSongsDialog.tsx'), /deleteSongsWording\(ids\.length, alsoLeaves\)/)
  })

  test('a playlist keeps "Delete from Library" after Remove from Playlist', () => {
    const t = read('components', 'SongTable.tsx')
    assert.match(t, /askDelete: libraryDeleteInMenu \?/)
    assert.match(t, /deleteLabel: onRemove \? \(songs\.length > 1 \? `Delete \$\{songs\.length\} Songs from Library` : 'Delete from Library'\) : undefined/)
    assert.doesNotMatch(read('views', 'PlaylistView.tsx'), /libraryDeleteInMenu=\{false\}/)
    const out = labels(assembleSongMenu({
      queue: [], playlist: { label: 'Add to Playlist', submenu: [] }, ipodPlaylist: { label: 'Add to iPod Playlist', disabled: true },
      goAlbum: { label: 'Go to Album' }, goArtist: { label: 'Go to Artist' }, star: { label: 'Star' }, share: { label: 'Share…' }, getInfo: { label: 'Get Info' },
      more: [], extras: [{ label: 'Remove from Playlist' }], del: { label: 'Delete from Library' },
    }))
    assert.ok(out.indexOf('Delete from Library') > out.indexOf('Remove from Playlist'))
  })

  test('the album page keeps its own short columns, one speaker', () => {
    const v = read('views', 'AlbumDetailView.tsx')
    assert.doesNotMatch(v.slice(v.indexOf('const ALBUM_COLUMNS')), /'playing'/, 'no speaker column: the # shows it')
    const hook = read('hooks', 'useColumnLayout.ts')
    assert.match(hook, /const hidden = new Set\(fixedKey \? \[\] : state\.hidden\)/, 'a fixed set is all shown')
    assert.match(read('components', 'SongTable.tsx'), /\.\.\.\(columns\.fixed \? \[\] : columns\.ordered\)/, 'and has no column picker')
  })

  test('the menu is memoized, not rebuilt on each playback tick', () => {
    const t = read('components', 'SongTable.tsx')
    assert.match(t, /const menuItems = useMemo\(\(\): MenuEntry\[\] =>/)
    assert.match(t, /items=\{menuItems\}/)
    assert.doesNotMatch(t.slice(t.indexOf('const menuItems = useMemo'), t.indexOf('const header = (')), /\bpb\b/, 'nothing from playback in its deps')
  })
})
