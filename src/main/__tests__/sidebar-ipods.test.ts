/**
 * The sidebar's iPODS section, the section order, and the end of the iPod Pool's
 * entry points (2026-11-07).
 *
 * Jake: "activity sync on the sidebar is obsolete right? the ipod pool for each
 * ipod is in the playlists area...but now that I think about it, they should have
 * their own section". And: "justification should also be a subgroup of
 * playlists". And: "i want to be able to have the side bar categories
 * customizeable as to where i place them, click and drag and drop".
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ipodSidebarRows, isIpodPlaylistId, safeDotColor, TOP_1000_PLAYLIST_ID, type SidebarIpodDevice, type SidebarIpodList } from '../../common/sidebar-ipods.ts'
import { ipodListPlaylistId } from '../../common/ipod-list-doc.ts'
import { orderSections, moveSection, nudgeSection, parseSavedOrder, defaultOrder, DEFAULT_SECTION_ORDER, RETIRED_SECTION_KEYS } from '../../common/sidebar-order.ts'

const SRC = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const ORIGINAL: SidebarIpodDevice = { id: 'orig-1111', name: 'Original', color: '#c0c0c0', primary: true }
const PUNK: SidebarIpodDevice = { id: '0d8fc490-74d1-4232-9a35-1801a66f4fde', name: 'punkPod', color: 'red', primary: false }
const BLUE: SidebarIpodDevice = { id: 'blue-2222', name: 'Blue', color: null, primary: false }
const all = () => true

describe('iPODS rows from the registry', () => {
  it('one row per registered iPod, the Original first, opening its Top 1000', () => {
    const rows = ipodSidebarRows({ devices: [PUNK, ORIGINAL, BLUE], lists: [], top1000Ids: [1, 2, 3], inLibrary: all })
    assert.deepEqual(rows.map((r) => r.name), ['Original', 'Blue', 'punkPod'], 'Top 1000 first, then by name')
    assert.equal(rows[0].playlistId, TOP_1000_PLAYLIST_ID)
    assert.equal(rows[0].playlistId, 'top-1000')
    assert.equal(rows[0].detail, 'Top 1000')
    assert.equal(rows[0].primary, true)
  })
  it('every other iPod opens its own homemini list', () => {
    const rows = ipodSidebarRows({ devices: [ORIGINAL, PUNK, BLUE], lists: [], top1000Ids: null, inLibrary: all })
    assert.equal(rows[2].playlistId, ipodListPlaylistId(PUNK.id))
    assert.equal(rows[2].playlistId, 'ipod-list-0d8fc490-74d1-4232-9a35-1801a66f4fde')
    assert.equal(rows[1].playlistId, 'ipod-list-blue-2222')
    assert.equal(rows[1].detail, null)
    assert.equal(rows[1].planned, false)
  })
  it('counts are the songs of each list that are in this library; unknown until homemini answers', () => {
    const lists: SidebarIpodList[] = [{ id: PUNK.id, name: 'punkPod', color: 'red', ids: [10, 11, 12, 99] }]
    const rows = ipodSidebarRows({ devices: [ORIGINAL, PUNK, BLUE], lists, top1000Ids: [1, 2, 99], inLibrary: (id) => id !== 99 })
    assert.equal(rows[0].count, 2)
    assert.equal(rows[2].count, 3)
    assert.equal(rows[1].count, null, 'no list yet → no number, never a fake 0')
    assert.equal(ipodSidebarRows({ devices: [ORIGINAL], lists: [], top1000Ids: null, inLibrary: all })[0].count, null)
  })
  it('a Mac that never met the Original still shows the Top 1000 row (workmini)', () => {
    const rows = ipodSidebarRows({ devices: [], lists: [], top1000Ids: [5], inLibrary: all })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'Original')
    assert.equal(rows[0].playlistId, 'top-1000')
  })
  it('a list whose iPod the registry read missed still gets its row, once', () => {
    const lists: SidebarIpodList[] = [{ id: PUNK.id, name: 'punkPod', color: '#ff0000', ids: [1], registered: true }]
    const rows = ipodSidebarRows({ devices: [], lists, top1000Ids: null, inLibrary: all })
    assert.deepEqual(rows.map((r) => r.playlistId), ['top-1000', ipodListPlaylistId(PUNK.id)])
    assert.equal(rows[1].color, '#ff0000')
    assert.equal(rows[1].planned, false)
    const both = ipodSidebarRows({ devices: [ORIGINAL, PUNK], lists, top1000Ids: null, inLibrary: all })
    assert.equal(both.length, 2)
  })
  it('a renamed Original shows its own name', () => {
    assert.equal(ipodSidebarRows({ devices: [{ ...ORIGINAL, name: 'Silver' }], lists: [], top1000Ids: null, inLibrary: all })[0].name, 'Silver')
  })
  it('the dot colour is a hex or a plain colour word, nothing else reaches a style', () => {
    assert.equal(safeDotColor('#E03'), '#E03')
    assert.equal(safeDotColor('red'), 'red')
    assert.equal(safeDotColor(null), null)
    assert.equal(safeDotColor('red; background: url(x)'), null)
    assert.equal(safeDotColor('rgb(1,2,3)'), null)
  })
})

describe('iPODS: one place, on every Mac (2026-11-09)', () => {
  // homemini's lists as main hands them over: punkPod (registered on the MacBook only) and
  // the planned ones no iPod carries yet.
  const PLANNED: SidebarIpodList[] = [
    { id: 'y2k-revival-01', name: 'Y2K Revival', color: null, ids: [7, 8] },
    { id: 'best-of-bandcamp', name: 'Best of Bandcamp', color: null, ids: [9] },
    { id: 'totally-80s-001', name: 'Totally 80s', color: null, ids: [] },
  ]
  const PUNK_LIST: SidebarIpodList = { id: PUNK.id, name: 'punkPod', color: null, ids: [1, 2, 3] }

  it('a Mac with no registry (workmini) still shows punkPod and every planned list, Top 1000 first, then by name', () => {
    const rows = ipodSidebarRows({ role: 'replica', devices: [], lists: [PUNK_LIST, ...PLANNED], top1000Ids: [1], inLibrary: all })
    assert.deepEqual(rows.map((r) => r.name), ['Top 1000', 'Best of Bandcamp', 'punkPod', 'Totally 80s', 'Y2K Revival'])
    assert.equal(rows.find((r) => r.name === 'punkPod')?.count, 3)
  })
  it('a replica shows plain playlists: no registry, no dots, nothing "planned", no iPod names', () => {
    const rows = ipodSidebarRows({ role: 'replica', devices: [{ ...ORIGINAL, name: 'Silver' }, PUNK], lists: [{ ...PUNK_LIST, registered: true }, ...PLANNED], top1000Ids: null, inLibrary: all })
    assert.equal(rows[0].name, 'Top 1000')
    assert.equal(rows[0].detail, null)
    for (const r of rows) {
      assert.equal(r.color, null, r.name)
      assert.equal(r.planned, false, r.name)
      assert.equal(r.detail, null, r.name)
    }
  })
  it('the hub: the registry\'s dots on registered iPods, "planned" and no colour on the rest', () => {
    const rows = ipodSidebarRows({ role: 'hub', devices: [ORIGINAL, PUNK], lists: [{ ...PUNK_LIST, registered: true }, ...PLANNED], top1000Ids: null, inLibrary: all })
    assert.deepEqual(rows.map((r) => r.name), ['Original', 'Best of Bandcamp', 'punkPod', 'Totally 80s', 'Y2K Revival'])
    const punk = rows.find((r) => r.name === 'punkPod')
    assert.equal(punk?.color, 'red')
    assert.equal(punk?.planned, false)
    for (const name of ['Best of Bandcamp', 'Totally 80s', 'Y2K Revival']) {
      const r = rows.find((x) => x.name === name)
      assert.equal(r?.planned, true, name)
      assert.equal(r?.detail, 'planned', name)
      assert.equal(r?.color, null, name)
    }
  })
  it('each list has exactly one row, whatever the registry and the lists both say', () => {
    const rows = ipodSidebarRows({ role: 'hub', devices: [ORIGINAL, PUNK, PUNK], lists: [{ ...PUNK_LIST, registered: true }, PUNK_LIST, ...PLANNED], top1000Ids: null, inLibrary: all })
    const ids = rows.map((r) => r.playlistId)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(ids.filter((i) => i === 'top-1000').length, 1)
  })
  it('a pinned list moves up inside iPODS, right after Top 1000; Top 1000 stays first', () => {
    const pinned = ['pl-1', TOP_1000_PLAYLIST_ID, ipodListPlaylistId('y2k-revival-01')]
    const rows = ipodSidebarRows({ role: 'replica', devices: [], lists: [PUNK_LIST, ...PLANNED], top1000Ids: null, inLibrary: all, pinned })
    assert.deepEqual(rows.map((r) => r.name), ['Top 1000', 'Y2K Revival', 'Best of Bandcamp', 'punkPod', 'Totally 80s'])
  })
  it('isIpodPlaylistId: Top 1000 and every iPod list, nothing else', () => {
    assert.equal(isIpodPlaylistId('top-1000'), true)
    assert.equal(isIpodPlaylistId(ipodListPlaylistId(PUNK.id)), true)
    for (const id of ['top-25', 'top-rated', 'pl-1786144518145', 'listen-more-weekly', '', null, undefined]) assert.equal(isIpodPlaylistId(id), false, String(id))
  })
  it('the sidebar draws no iPod list anywhere but iPODS: pins skip them, no smart list names one', () => {
    const sidebar = read('renderer/components/sidebar/Sidebar.tsx')
    assert.match(sidebar, /pinned\.filter\(\(id\) => !isIpodPlaylistId\(id\)\)\.map/)
    assert.doesNotMatch(sidebar, /allSmart/)
    const smart = sidebar.slice(sidebar.indexOf('const smartPlaylists'), sidebar.indexOf(']', sidebar.indexOf('const smartPlaylists')))
    assert.doesNotMatch(smart, /id: 'top-1000'|ipod-list-/)
    const library = sidebar.slice(sidebar.indexOf('const libraryItems'), sidebar.indexOf(']', sidebar.indexOf('const libraryItems')))
    assert.doesNotMatch(library, /'top-1000'|ipod-list-/)
    assert.equal((sidebar.match(/ipodRows\.map\(/g) ?? []).length, 1, 'iPod rows are drawn in one place')
  })
  it('the sidebar knows hub from replica from main, never from the registry', () => {
    const sidebar = read('renderer/components/sidebar/Sidebar.tsx')
    assert.match(sidebar, /role: ipodListsRole === 'hub' \? 'hub' : 'replica'/)
    assert.match(read('main/index.ts'), /registerIpodListsIpc\(ipc, \{[^\n]*isReplica: isHomeminiPlaybackClientCached/)
  })
})

describe('section order: saved, merged with what is showing', () => {
  const ALL = ['library', 'store', 'archive', 'ipods', 'mixtapes', 'year:2026', 'playlists']
  it('nothing saved = the order the sidebar has always had', () => {
    assert.deepEqual(orderSections(ALL, []), ALL)
    assert.deepEqual(defaultOrder(['playlists', 'year:2025', 'library', 'year:2026']), ['library', 'year:2026', 'year:2025', 'playlists'])
  })
  it('a saved order is kept', () => {
    const saved = ['playlists', 'ipods', 'library', 'store', 'archive', 'mixtapes', 'year:2026']
    assert.deepEqual(orderSections(ALL, saved), saved)
  })
  it('a section that appears later (DEVICES with an iPod in) goes to its default slot', () => {
    const saved = ['playlists', 'library', 'store', 'archive', 'ipods', 'mixtapes', 'year:2026']
    assert.deepEqual(orderSections([...ALL, 'devices'], saved),
      ['playlists', 'library', 'store', 'archive', 'devices', 'ipods', 'mixtapes', 'year:2026'])
  })
  it('a new year section lands with its default neighbour', () => {
    const saved = ['library', 'store', 'archive', 'ipods', 'mixtapes', 'year:2026', 'playlists']
    assert.deepEqual(orderSections([...ALL, 'year:2027'], saved),
      ['library', 'store', 'archive', 'ipods', 'mixtapes', 'year:2027', 'year:2026', 'playlists'])
  })
  it('a saved section that is not showing is skipped, and comes back where it was', () => {
    const drawn = ['playlists', 'devices', 'library', 'store', 'archive', 'ipods', 'mixtapes', 'year:2026']
    const saved = moveSection(['devices', ...ALL], [], 'playlists', 'devices')
    assert.deepEqual(saved.slice(0, 2), ['playlists', 'devices'])
    // iPod unplugged: DEVICES isn't drawn, nothing else moves.
    assert.deepEqual(orderSections(ALL, saved), drawn.filter((k) => k !== 'devices'))
    // Moving something while DEVICES is away keeps DEVICES's place in the save.
    const next = moveSection(orderSections(ALL, saved), saved, 'ipods', 'library')
    assert.deepEqual(orderSections(['devices', ...ALL], next), ['playlists', 'devices', 'ipods', 'library', 'store', 'archive', 'mixtapes', 'year:2026'])
  })
  it('unknown keys in the default list (sections added in a later build) fall in at the end of their neighbours', () => {
    assert.deepEqual(orderSections(['library', 'brand-new'], ['library']), ['library', 'brand-new'])
  })
  it('move: before a section, or to the end; dropping a section on itself changes nothing', () => {
    assert.deepEqual(moveSection(['a', 'b', 'c'], [], 'c', 'a'), ['c', 'a', 'b'])
    assert.deepEqual(moveSection(['a', 'b', 'c'], [], 'a', null), ['b', 'c', 'a'])
    assert.deepEqual(moveSection(['a', 'b', 'c'], [], 'b', 'b'), ['a', 'b', 'c'])
    assert.deepEqual(moveSection(['a', 'b', 'c'], [], 'zz', 'a'), ['a', 'b', 'c'])
  })
  it('nudge (Move Up / Move Down, ⌥↑ / ⌥↓) swaps one step and stops at the ends', () => {
    assert.deepEqual(nudgeSection(['a', 'b', 'c'], [], 'b', -1), ['b', 'a', 'c'])
    assert.deepEqual(nudgeSection(['a', 'b', 'c'], [], 'b', 1), ['a', 'c', 'b'])
    assert.deepEqual(nudgeSection(['a', 'b', 'c'], [], 'a', -1), ['a', 'b', 'c'])
    assert.deepEqual(nudgeSection(['a', 'b', 'c'], [], 'c', 1), ['a', 'b', 'c'])
  })
  it('a saved value read back from ui-state: strings only, no repeats', () => {
    assert.deepEqual(parseSavedOrder(['a', 'a', 3, '', null, 'b']), ['a', 'b'])
    assert.deepEqual(parseSavedOrder('library'), [])
    assert.deepEqual(parseSavedOrder(undefined), [])
  })
  it('a saved order naming the removed SYNCED SETS section still draws, and forgets it', () => {
    const old = ['playlists', 'synced-sets', 'library', 'store', 'archive', 'ipods', 'mixtapes', 'year:2026']
    const saved = parseSavedOrder(old)
    assert.ok(!saved.includes('synced-sets'))
    assert.deepEqual(orderSections(ALL, saved), old.filter((k) => k !== 'synced-sets'))
    // Even unparsed, a key nothing draws is skipped and moves nothing.
    assert.deepEqual(orderSections(ALL, old), old.filter((k) => k !== 'synced-sets'))
    // The next save (a move) carries no retired key.
    const next = moveSection(orderSections(ALL, saved), saved, 'library', 'playlists')
    assert.ok(!next.includes('synced-sets'))
    assert.ok(!DEFAULT_SECTION_ORDER.includes('synced-sets'))
    assert.ok(RETIRED_SECTION_KEYS.has('synced-sets'))
  })
  it('the default list names every section the sidebar draws', () => {
    const sidebar = read('renderer/components/sidebar/Sidebar.tsx')
    const keys = [...sidebar.matchAll(/^ {4}\['([a-z-]+)', /gm)].map((m) => m[1])
    assert.ok(keys.length >= 7, `found ${keys.join(',')}`)
    for (const k of keys) assert.ok(DEFAULT_SECTION_ORDER.includes(k), `${k} missing from DEFAULT_SECTION_ORDER`)
    assert.match(sidebar, /`\$\{YEAR_PREFIX\}\$\{year\}`/)
  })
})

describe('the sidebar after #372', () => {
  const sidebar = read('renderer/components/sidebar/Sidebar.tsx')
  it('has an iPODS section built from the registry, and no ACTIVITY SYNC / iPod Pool row', () => {
    assert.match(sidebar, /title="iPODS"/)
    assert.match(sidebar, /ipodSidebarRows\(\{/)
    assert.match(sidebar, /useIpodRegistry\(\)/)
    assert.doesNotMatch(sidebar, /ACTIVITY SYNC/)
    assert.doesNotMatch(sidebar, /iPod Pool"/)
    assert.doesNotMatch(sidebar, /addTracksToPool|activityPool/)
  })
  it('Top 1000 and the iPod lists left the playlists list', () => {
    const smart = sidebar.slice(sidebar.indexOf('const smartPlaylists'), sidebar.indexOf(']', sidebar.indexOf('const smartPlaylists')))
    assert.doesNotMatch(smart, /id: 'top-1000'/)
    assert.match(sidebar, /\{smartPlaylists\.filter\(sp => !pinned\.includes\(sp\.id\)\)/)
  })
  it('no SYNCED SETS section: a playlist still marked synced-set shows in PLAYLISTS', () => {
    assert.doesNotMatch(sidebar, /SYNCED SETS|synced-set/)
    for (const f of ['renderer/utils/playlistMenu.ts', 'renderer/components/NewMixtapeSheet.tsx', 'renderer/types.ts', 'main/overnight-preload.ts']) {
      assert.doesNotMatch(read(f), /synced-set/, f)
    }
  })
  it('Justification is a subgroup of PLAYLISTS, not a section of its own', () => {
    assert.doesNotMatch(sidebar, /title="JUSTIFICATION"/)
    const playlists = sidebar.slice(sidebar.indexOf('title="PLAYLISTS"'))
    assert.match(playlists, /className="sidebar-subgroup"/)
    assert.match(playlists, /justifications\.map\(userPlaylistRow\)/)
  })
  it('the order is saved in ui-state, one key, and can be reset', () => {
    assert.match(sidebar, /saveUiState\(\{ \[SIDEBAR_ORDER_KEY\]: next \}\)/)
    assert.match(sidebar, /'Reset Sidebar Order'/)
    assert.match(sidebar, /'Move Up'/)
  })
  it('a section only takes section drags, so songs still drop on playlist rows', () => {
    const section = read('renderer/components/sidebar/SidebarSection.tsx')
    assert.match(section, /if \(!movable \|\| !e\.dataTransfer\.types\.includes\(SECTION_DRAG_TYPE\)\) return/)
    assert.notEqual('application/jaketunes-sidebar-section', 'application/jaketunes-tracks')
    assert.match(read('renderer/components/sidebar/SidebarItem.tsx'), /types\.includes\('application\/jaketunes-tracks'\)/)
  })
})

describe('no visible door to the Original’s old pool', () => {
  function files(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) out.push(...files(p))
      else if (/\.(tsx?|css)$/.test(name)) out.push(p)
    }
    return out
  }
  const renderer = files(join(SRC, 'renderer'))
  it('no "Add to iPod Pool" menu item, no pool page, no route to one', () => {
    for (const f of renderer) {
      const text = readFileSync(f, 'utf8')
      assert.doesNotMatch(text, /Add to iPod Pool|addToIpodPoolEntry|addTracksToPool/, f)
      assert.doesNotMatch(text, /view: 'activity-pool'|'activity-pool':|ActivityPoolView/, f)
    }
  })
  it('main keeps the pool IPC other iPods and the hub mirror read', () => {
    assert.match(read('main/ipc/activity-pool-ipc.ts'), /'activity-pool-get'/)
    assert.match(read('preload/index.ts'), /'ipod-registry:list'/)
    assert.match(read('main/ipc/ipod-ipc.ts'), /ipc\.handle\('ipod-registry:list'/)
  })
})
