/**
 * Rename… an iPod list or the Top 1000 (2026-11-09, Jake: "allow me to rename
 * the ipod playlists too!! if i want").
 *
 *   • the name rules (common/ipod-list-name.ts): non-empty, 60 at most, never another list's
 *   • an iPod list: PATCH homemini { name }; homemini away = on disk, shown at once, sent later;
 *     homemini refusing (409) = dropped and said so (main/ipod-list-rename.ts)
 *   • the Top 1000: PUT /api/top1000/name, same queue rules (main/top1000-name.ts)
 *   • the sidebar shows the new names (common/sidebar-ipods.ts, main/ipod-lists-gather.ts)
 *   • the UI is wired: Rename… on the iPODS rows and in the header, never a native dialog
 *
 * No homemini here: fetch is a fake.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkListName, sameListName, LIST_NAME_MAX, TOP_1000_DEFAULT_NAME } from '../../common/ipod-list-name.ts'
import { renameIpodList } from '../ipod-list-rename.ts'
import { flushAllHomeminiNames, queueHomeminiName, readPendingNames } from '../ipod-rename.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { createTop1000NameRemote, localTop1000Name, readTop1000Name, setTop1000Name, type Top1000NameDeps } from '../top1000-name.ts'
import { gatherIpodLists, ipodListsCachePath } from '../ipod-lists-gather.ts'
import { ipodSidebarRows, TOP_1000_PLAYLIST_ID } from '../../common/sidebar-ipods.ts'
import { buildDeviceMarker } from '../../common/ipod-identity.ts'
import type { IpodList } from '../../common/ipod-list-doc.ts'
import type { FetchLike } from '../top1000-client.ts'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ipod-list-rename-')); dirs.push(d); return d }

const PUNK_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const Y2K_ID = '842f4c4f-1111-4222-8333-444455556666'
const now = '2026-11-09T00:00:00.000Z'
const list = (id: string, name: string, ids: number[]): IpodList => ({
  id, name, purpose: null, cap: 1000, ids, adds: [], removed: [], updatedAt: now, brain: { enabled: true, perDay: 1 },
})

/** A fake homemini: answers each request with `status`, records what was asked. */
function fakeHomemini(status: number | 'down', body: unknown = {}) {
  const seen: Array<{ url: string; method: string; body: unknown }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, method: String(init?.method ?? 'GET'), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (status === 'down') throw new Error('connect ECONNREFUSED')
    return { ok: status === 200, status, json: async () => body }
  }
  return { seen, fetchImpl }
}

describe('a list name (common/ipod-list-name.ts)', () => {
  it('takes a trimmed name of 1 to 60 characters', () => {
    assert.deepEqual(checkListName('  Punk Classics ', []), { ok: true, name: 'Punk Classics' })
    assert.equal(checkListName('x'.repeat(LIST_NAME_MAX), []).ok, true)
  })
  it('refuses an empty name, a long one, two lines, and not-a-string, in plain words', () => {
    assert.deepEqual(checkListName('   ', []), { ok: false, error: 'Give it a name.' })
    assert.deepEqual(checkListName(null, []), { ok: false, error: 'Give it a name.' })
    const long = checkListName('x'.repeat(LIST_NAME_MAX + 1), [])
    assert.equal(long.ok, false)
    assert.match((long as { error: string }).error, /60 characters/)
    assert.equal(checkListName('one\ntwo', []).ok, false)
  })
  it('refuses another list\'s name, case and outer spaces aside', () => {
    const r = checkListName(' totally 80S ', ['punkPod', 'Totally 80s', TOP_1000_DEFAULT_NAME])
    assert.deepEqual(r, { ok: false, error: 'Another list is already called Totally 80s.' })
    assert.equal(checkListName('top 1000', [TOP_1000_DEFAULT_NAME]).ok, false)
    assert.equal(sameListName('Y2K Revival', 'Y2K  Revival'), false)
  })
})

describe('renaming an iPod list (main/ipod-list-rename.ts)', () => {
  it('PATCHes homemini { name } and says saved; nothing waits', async () => {
    const stateDir = tmp()
    const h = fakeHomemini(200)
    const client = createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl: h.fetchImpl, warn: () => {} })
    const r = await renameIpodList({ stateDir, send: client.renameList, others: async () => ['Y2K Revival', 'Top 1000'] }, PUNK_ID, ' Punk Classics ')
    assert.deepEqual(r, { ok: true, name: 'Punk Classics', homemini: 'saved' })
    assert.deepEqual(h.seen, [{ url: `http://homemini:3000/api/ipod-lists/${PUNK_ID}`, method: 'PATCH', body: { name: 'Punk Classics' } }])
    assert.deepEqual(await readPendingNames(stateDir), {})
  })

  it('refuses a duplicate before homemini is asked', async () => {
    const stateDir = tmp()
    const h = fakeHomemini(200)
    const client = createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl: h.fetchImpl, warn: () => {} })
    const r = await renameIpodList({ stateDir, send: client.renameList, others: async () => ['Y2K Revival', 'Top 1000'] }, PUNK_ID, 'y2k revival')
    assert.equal(r.ok, false)
    assert.equal(h.seen.length, 0)
    assert.equal(existsSync(join(stateDir, 'ipod-list-renames.json')), false)
  })

  it('homemini away: the name waits on disk, says later, and goes on the next flush', async () => {
    const stateDir = tmp()
    const away = createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini('down').fetchImpl, warn: () => {} })
    const r = await renameIpodList({ stateDir, send: away.renameList, others: async () => [] }, PUNK_ID, 'Punk Classics')
    assert.deepEqual(r, { ok: true, name: 'Punk Classics', homemini: 'later' })
    assert.deepEqual(await readPendingNames(stateDir), { [PUNK_ID]: 'Punk Classics' })
    // still away: still waiting
    assert.equal(await flushAllHomeminiNames(stateDir, away.renameList), 'still-waiting')
    // back: sent, and the queue is empty
    const back = fakeHomemini(200)
    const client = createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl: back.fetchImpl, warn: () => {} })
    assert.equal(await flushAllHomeminiNames(stateDir, client.renameList), 'sent')
    assert.deepEqual(back.seen.map((s) => s.body), [{ name: 'Punk Classics' }])
    assert.deepEqual(await readPendingNames(stateDir), {})
  })

  it('homemini refusing (409: another list took it meanwhile) drops the name and says why', async () => {
    const stateDir = tmp()
    const client = createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini(409).fetchImpl, warn: () => {} })
    const r = await renameIpodList({ stateDir, send: client.renameList, others: async () => [] }, PUNK_ID, 'Totally 80s')
    assert.equal(r.ok, false)
    assert.deepEqual(await readPendingNames(stateDir), {}, 'a name homemini will never take is not retried forever')
  })

  it('the client maps homemini\'s answers: 200 done, 400/404/409 drop, 5xx and no answer retry', async () => {
    const at = (s: number | 'down') => createIpodListClient({ baseUrl: 'http://x', fetchImpl: fakeHomemini(s).fetchImpl, warn: () => {} }).renameList(PUNK_ID, 'n')
    assert.deepEqual(await Promise.all([at(200), at(400), at(404), at(409), at(503), at('down')]), ['done', 'drop', 'drop', 'drop', 'retry', 'retry'])
  })

  it('one queue with the iPod rename: the newest name wins, other iPods\' names are kept', async () => {
    const stateDir = tmp()
    await queueHomeminiName(stateDir, PUNK_ID, 'punkPod')
    await queueHomeminiName(stateDir, Y2K_ID, 'Y2K Forever')
    const away = createIpodListClient({ baseUrl: 'http://x', fetchImpl: fakeHomemini('down').fetchImpl, warn: () => {} })
    await renameIpodList({ stateDir, send: away.renameList, others: async () => [] }, PUNK_ID, 'Punk Classics')
    assert.deepEqual(await readPendingNames(stateDir), { [PUNK_ID]: 'Punk Classics', [Y2K_ID]: 'Y2K Forever' })
  })
})

describe('the Top 1000\'s name (main/top1000-name.ts)', () => {
  function deps(stateDir: string, status: number | 'down', custom: string | null = null) {
    const h = fakeHomemini(status, { name: custom ?? TOP_1000_DEFAULT_NAME, custom })
    const d: Top1000NameDeps = { stateDir, ...createTop1000NameRemote({ baseUrl: 'http://homemini:3000', fetchImpl: h.fetchImpl, warn: () => {} }) }
    return { d, seen: h.seen }
  }

  it('is "Top 1000" until renamed; a rename PUTs it and every read says it', async () => {
    const stateDir = tmp()
    assert.deepEqual(await readTop1000Name(deps(stateDir, 200).d), { name: 'Top 1000', custom: null, pending: false })
    const put = deps(stateDir, 200)
    const r = await setTop1000Name(put.d, ' The Thousand ', ['punkPod'])
    assert.deepEqual(r, { ok: true, name: 'The Thousand', custom: 'The Thousand', homemini: 'saved' })
    assert.deepEqual(put.seen, [{ url: 'http://homemini:3000/api/top1000/name', method: 'PUT', body: { name: 'The Thousand' } }])
    // homemini now answers with it; and the copy kept here says it with homemini away
    assert.equal((await readTop1000Name(deps(stateDir, 200, 'The Thousand').d)).name, 'The Thousand')
    assert.equal((await readTop1000Name(deps(stateDir, 'down').d)).name, 'The Thousand')
    assert.equal(await localTop1000Name(stateDir), 'The Thousand')
  })

  it('homemini away: shown at once (pending), sent on the next read', async () => {
    const stateDir = tmp()
    const r = await setTop1000Name(deps(stateDir, 'down').d, 'Jake 1000', [])
    assert.deepEqual(r, { ok: true, name: 'Jake 1000', custom: 'Jake 1000', homemini: 'later' })
    assert.deepEqual(await readTop1000Name(deps(stateDir, 'down').d), { name: 'Jake 1000', custom: 'Jake 1000', pending: true })
    assert.equal(await localTop1000Name(stateDir), 'Jake 1000')
    const back = deps(stateDir, 200, 'Jake 1000')
    assert.deepEqual(await readTop1000Name(back.d), { name: 'Jake 1000', custom: 'Jake 1000', pending: false })
    assert.deepEqual(back.seen.map((s) => s.method), ['PUT', 'GET'])
  })

  it('an older homemini (404) keeps the name waiting; a refusal (409) drops it', async () => {
    const stateDir = tmp()
    assert.equal((await setTop1000Name(deps(stateDir, 404).d, 'Jake 1000', [])).ok, true)
    assert.equal((await readTop1000Name(deps(stateDir, 404).d)).pending, true)
    const other = tmp()
    await setTop1000Name(deps(other, 409).d, 'Jake 1000', [])
    assert.deepEqual(await readTop1000Name(deps(other, 'down').d), { name: 'Top 1000', custom: null, pending: false })
  })

  it('refuses an iPod list\'s name and an over-long one; "Top 1000" puts the default back', async () => {
    const stateDir = tmp()
    const h = deps(stateDir, 200)
    assert.equal((await setTop1000Name(h.d, 'PUNKPOD', ['punkPod'])).ok, false)
    assert.equal((await setTop1000Name(h.d, 'x'.repeat(61), [])).ok, false)
    assert.equal(h.seen.length, 0)
    const back = await setTop1000Name(h.d, 'Top 1000', [])
    assert.deepEqual(back, { ok: true, name: 'Top 1000', custom: null, homemini: 'saved' })
    assert.deepEqual(h.seen[0].body, { name: null })
  })
})

describe('the sidebar shows the new names', () => {
  const punk = buildDeviceMarker({ id: PUNK_ID, name: 'punkPod', color: 'red', purpose: 'Punk', primary: false, now })!
  const original = buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now })!

  it('a rename waiting for homemini shows at once, on a replica and on the hub (where the iPod keeps its name)', async () => {
    const stateDir = tmp()
    await queueHomeminiName(stateDir, PUNK_ID, 'Punk Classics')
    const base = {
      registry: async () => [original, punk],
      refresh: async () => ({ poolIds: [1], listIds: [1], names: {}, source: 'homemini' as const, note: null, updatedAt: now }),
      all: async () => [list(PUNK_ID, 'punkPod', [1]), list(Y2K_ID, 'Y2K Revival', [2])],
      cacheFile: ipodListsCachePath(stateDir),
      pendingNames: () => readPendingNames(stateDir),
    }
    const replica = await gatherIpodLists({ ...base, isReplica: async () => true })
    assert.deepEqual(replica.lists.map((l) => l.name), ['Punk Classics', 'Y2K Revival'])
    const hub = await gatherIpodLists({ ...base, isReplica: async () => false })
    assert.deepEqual(hub.lists.map((l) => l.name), ['Punk Classics', 'Y2K Revival'])
    // homemini has it: its name, not the iPod's
    const later = await gatherIpodLists({ ...base, isReplica: async () => false, pendingNames: async () => ({}), all: async () => [list(PUNK_ID, 'Punk Classics', [1])] })
    assert.equal(later.lists[0].name, 'Punk Classics')
  })

  it('the rows: a renamed list under its new name; the Top 1000 under its name on a replica and as the Original\'s detail on the hub', () => {
    const lists = [{ id: PUNK_ID, name: 'Punk Classics', color: 'red', ids: [1], registered: true }]
    const hub = ipodSidebarRows({ role: 'hub', devices: [original, punk], lists, top1000Ids: [1], inLibrary: () => true, top1000Name: 'The Thousand' })
    assert.deepEqual(hub.map((r) => [r.name, r.detail]), [['Original', 'The Thousand'], ['Punk Classics', null]])
    const replica = ipodSidebarRows({ role: 'replica', devices: [], lists, top1000Ids: [1], inLibrary: () => true, top1000Name: 'The Thousand' })
    assert.deepEqual(replica.map((r) => r.name), ['The Thousand', 'Punk Classics'])
    assert.equal(replica[0].playlistId, TOP_1000_PLAYLIST_ID)
    // no name yet: "Top 1000"
    assert.equal(ipodSidebarRows({ role: 'replica', devices: [], lists: [], top1000Ids: null, inLibrary: () => true })[0].name, 'Top 1000')
  })
})

describe('the rename UI is wired', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf-8')

  it('Rename… on every iPODS row (Top 1000 included) and in the list\'s header, as an inline box', () => {
    const sidebar = read('renderer/components/sidebar/Sidebar.tsx')
    assert.match(sidebar, /isIpodPlaylistId\(plCtxMenu\.playlistId\) \? \[[\s\S]{0,120}label: 'Rename…'/)
    assert.match(sidebar, /renamingIpodRow === r\.playlistId \?/)
    assert.match(sidebar, /<ListRenameField/)
    const header = read('renderer/views/SmartPlaylistView.tsx')
    assert.match(header, /const renamable = playlistId === 'top-1000' \|\| ipodList !== null/)
    assert.match(header, /<ListRenameField/)
    assert.match(header, /playlistId === 'top-1000' \? top1000Name/)
  })

  it('the box: Enter saves, Esc cancels, never a native dialog', () => {
    const field = read('renderer/components/ListRenameField.tsx')
    assert.match(field, /e\.key === 'Enter'\) \{ e\.preventDefault\(\); void commit\(e\.currentTarget\.value, false\)/)
    assert.match(field, /e\.key === 'Escape'\) \{ e\.preventDefault\(\); finish\(\)/)
    assert.match(field, /checkListName\(value, others\)/)
    assert.doesNotMatch(field, /window\.(prompt|alert|confirm)/)
  })

  it('main answers the three channels; the two writes are main-window only', () => {
    const ipc = read('main/ipc/ipod-lists-ipc.ts')
    assert.match(ipc, /ipc\.handle\('ipod-lists:rename'[\s\S]*?\{ refuse: \{ ok: false, error: 'refused-sender' \} \}\)/)
    assert.match(ipc, /ipc\.handle\('top1000-name:set'[\s\S]*?\{ refuse: \{ ok: false, error: 'refused-sender' \} \}\)/)
    assert.match(ipc, /ipc\.handle\('top1000-name:get'/)
    assert.match(ipc, /pendingNames: \(\) => readPendingNames\(host\.stateDir\)/)
    const preload = read('preload/index.ts')
    for (const ch of ['ipod-lists:rename', 'top1000-name:get', 'top1000-name:set']) assert.match(preload, new RegExp(`'${ch}'`))
  })
})
