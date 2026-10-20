/**
 * Phone playlist edits reach the desktop — newest edit wins, per track
 * (2026-10-20, the cross-device sync audit's playlist item).
 *
 * The real cases this locks:
 *   - XTC "Complicated Game" (track 11376) was removed from JUSTIFICATION V
 *     (pl-1789004986098) on the phone on 9/12. homemini's
 *     playlist-removals.json still says {"pl-1789004986098": ["11376"]}, and
 *     both Macs still had the song a month later, because V3 never read it.
 *   - Phone adds were re-applied at every launch, so a song the Mac deleted
 *     came straight back.
 *   - "007" (mobile:a0676f86-…) was deleted on the desktop 10/10; its phone
 *     copy must never be adopted again.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, writeFile, readFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  applyPhonePlaylistEdits,
  parseEditFile,
  editFileForWrite,
  editTime,
  parseDeletionLedger,
  type PhonePlaylistInputs,
} from '../phone-playlist-edits.ts'
import { createPhonePlaylistSync, PHONE_PLAYLIST_FILES, PHONE_PLAYLIST_LEDGERS } from '../phone-playlist-sync.ts'
import { stampModifiedPlaylists, type HubPlaylistLike } from '../playlist-hub-sync.ts'
import { loadTombstones } from '../playlist-tombstones.ts'
import { phonePlaylistSidecarsNeverPushFromDesktop } from '../sidecar-contracts.ts'

const JV = 'pl-1789004986098'           // JUSTIFICATION V: THE INDUSTRY STRIKES BACK
const XTC = '11376'                     // XTC — Complicated Game
const ZERO_ZERO_SEVEN = 'mobile:a0676f86-2ffb-4fb7-a7e3-1a6f10f0be15'

const jv = (extra: Partial<HubPlaylistLike> = {}): HubPlaylistLike => ({
  id: JV,
  name: 'JUSTIFICATION V: THE INDUSTRY STRIKES BACK',
  trackIds: [11724, 11819, 11376, 5411],
  modifiedAt: '2026-09-18T16:38:11.570Z',
  ...extra,
})

const inputs = (over: Partial<PhonePlaylistInputs> = {}): PhonePlaylistInputs => ({
  additions: parseEditFile({}, 'additions'),
  removals: parseEditFile({}, 'removals'),
  mobilePlaylists: [],
  phoneDeletions: parseDeletionLedger(null),
  desktopTombstoneIds: new Set(),
  ...over,
})

describe('edit file format (twin of homemini playlistEditRules.ts)', () => {
  test('a v1 file (no times) parses; every entry is time 0', () => {
    const set = parseEditFile({ [JV]: [XTC] }, 'removals')
    assert.deepEqual(set.lists, { [JV]: [XTC] })
    assert.equal(editTime(set, JV, XTC), 0)
    assert.equal(editTime(set, JV, '999'), undefined)
  })

  test('v2 round-trips with times and keeps the phone order', () => {
    const set = parseEditFile({ v: 2, additions: { [JV]: ['9', '1', '5'] }, at: { [JV]: { '9': 30, '1': 10 } } }, 'additions')
    assert.deepEqual(set.lists[JV], ['9', '1', '5'])
    assert.equal(editTime(set, JV, '9'), 30)
    assert.equal(editTime(set, JV, '5'), 0, 'listed without a time = v1 entry')
    const back = parseEditFile(editFileForWrite(set, 'additions'), 'additions')
    assert.deepEqual(back, set)
  })

  test('a mixed file (old backend wrote v1 keys into v2) reads as the union', () => {
    const set = parseEditFile({ v: 2, removals: { a: ['1'] }, at: { a: { '1': 5 } }, b: ['2'] }, 'removals')
    assert.deepEqual(set.lists, { b: ['2'], a: ['1'] })
    assert.equal(editTime(set, 'a', '1'), 5)
  })

  test('garbage never throws and never reads as edits', () => {
    for (const raw of [null, 'x', 42, [], { v: 2, additions: 'nope' }]) {
      assert.deepEqual(parseEditFile(raw, 'additions'), { lists: {}, at: {} })
    }
  })

  test('deletion ledger: v1 ({deletedIds}) and v2 (+ deletedAt)', () => {
    assert.deepEqual(parseDeletionLedger({ deletedIds: ['mobile:a'] }), { deletedIds: ['mobile:a'], deletedAt: {} })
    assert.deepEqual(parseDeletionLedger({ deletedIds: ['mobile:a'], deletedAt: { 'mobile:a': 7, 'mobile:x': 9 } }),
      { deletedIds: ['mobile:a'], deletedAt: { 'mobile:a': 7 } })
  })
})

describe('applyPhonePlaylistEdits — newest edit wins, per track', () => {
  test('XTC: the 9/12 phone removal (a v1 entry) finally reaches the Mac', () => {
    const out = applyPhonePlaylistEdits([jv()], inputs({
      removals: parseEditFile({ [JV]: [XTC] }, 'removals'),   // homemini's file today, byte for byte
    }))
    assert.equal(out.changed, true)
    assert.deepEqual(out.playlists[0].trackIds, [11724, 11819, 5411])
    assert.deepEqual(out.report.removed, [{ playlistId: JV, trackId: XTC }])
  })

  test('XTC re-added on the Mac AFTER the phone removed it stays (the Mac is newer)', () => {
    const macReAdd = Date.parse('2026-10-21T09:00:00Z')
    const out = applyPhonePlaylistEdits([jv({ memberChangedAt: { [XTC]: macReAdd } })], inputs({
      removals: parseEditFile({ v: 2, removals: { [JV]: [XTC] }, at: { [JV]: { [XTC]: Date.parse('2026-09-12T13:51:00Z') } } }, 'removals'),
    }))
    assert.equal(out.changed, false)
    assert.ok((out.playlists[0].trackIds as number[]).includes(11376))
  })

  test('a phone add the Mac LATER deleted is not re-added at the next launch', () => {
    // The old App.tsx merge re-appended every phone add on every launch.
    const macDelete = Date.parse('2026-10-20T15:00:00Z')
    const p = jv({ trackIds: [11819, 5411], memberChangedAt: { '11724': macDelete } })
    const out = applyPhonePlaylistEdits([p], inputs({
      additions: parseEditFile({ [JV]: ['11724'] }, 'additions'),   // v1 add, applied long ago
    }))
    assert.equal(out.changed, false)
    assert.deepEqual(out.playlists[0].trackIds, [11819, 5411])
  })

  test('a phone add NEWER than the Mac delete wins and is appended at the end', () => {
    const p = jv({ trackIds: [11819, 5411], memberChangedAt: { '11724': 1_000 } })
    const out = applyPhonePlaylistEdits([p], inputs({
      additions: parseEditFile({ v: 2, additions: { [JV]: ['11724'] }, at: { [JV]: { '11724': 2_000 } } }, 'additions'),
    }))
    assert.deepEqual(out.playlists[0].trackIds, [11819, 5411, 11724])
  })

  test('a phone removal NEWER than the Mac add wins', () => {
    const out = applyPhonePlaylistEdits([jv({ memberChangedAt: { [XTC]: 1_000 } })], inputs({
      removals: parseEditFile({ v: 2, removals: { [JV]: [XTC] }, at: { [JV]: { [XTC]: 2_000 } } }, 'removals'),
    }))
    assert.ok(!(out.playlists[0].trackIds as number[]).includes(11376))
  })

  test('already-applied edits are no-ops (nothing changes, nothing is stamped)', () => {
    const out = applyPhonePlaylistEdits([jv()], inputs({
      additions: parseEditFile({ [JV]: ['11724'] }, 'additions'),   // already in the playlist
      removals: parseEditFile({ [JV]: ['424242'] }, 'removals'),    // already absent
    }))
    assert.equal(out.changed, false)
  })

  test('playlists are matched by id, never by name', () => {
    const twin = { ...jv(), id: 'pl-other' }   // same NAME, different playlist
    const out = applyPhonePlaylistEdits([twin], inputs({ removals: parseEditFile({ [JV]: [XTC] }, 'removals') }))
    assert.equal(out.changed, false)
    assert.ok((out.playlists[0].trackIds as number[]).includes(11376))
  })
})

describe('phone-made playlists and phone deletes', () => {
  test('"007" (deleted on the desktop 10/10) is never adopted from the phone file again', () => {
    const out = applyPhonePlaylistEdits([], inputs({
      mobilePlaylists: [{ id: ZERO_ZERO_SEVEN, name: '007', trackIds: ['4245'] }],
      desktopTombstoneIds: new Set([ZERO_ZERO_SEVEN]),
    }))
    assert.equal(out.changed, false)
    assert.deepEqual(out.playlists, [])
  })

  test('a new phone playlist is adopted (live now, not just at launch)', () => {
    const out = applyPhonePlaylistEdits([jv()], inputs({
      mobilePlaylists: [{ id: 'mobile:new', name: 'Road Trip', trackIds: ['1', '2'] }],
    }))
    assert.deepEqual(out.report.adopted, ['mobile:new'])
    assert.deepEqual(out.playlists[1], { id: 'mobile:new', name: 'Road Trip', trackIds: [1, 2], source: 'mobile' })
  })

  test('a playlist deleted on the phone leaves the Mac (v1 ledger entry: always)', () => {
    const bad = { id: 'mobile:51dfd77d-a53e-4fc3-893a-095715d0d94a', name: 'Bad Ass Music', trackIds: [1], modifiedAt: '2026-10-01T00:00:00Z' }
    const out = applyPhonePlaylistEdits([jv(), bad], inputs({
      phoneDeletions: parseDeletionLedger({ deletedIds: [bad.id] }),
    }))
    assert.deepEqual(out.report.deleted, [bad.id])
    assert.deepEqual(out.playlists.map((p) => p.id), [JV])
  })

  test('a desktop edit made AFTER the phone delete keeps the playlist (newest wins)', () => {
    const p = { id: 'mobile:x', name: 'Kept', trackIds: [1], modifiedAt: '2026-10-20T12:00:00Z' }
    const out = applyPhonePlaylistEdits([p], inputs({
      phoneDeletions: parseDeletionLedger({ deletedIds: ['mobile:x'], deletedAt: { 'mobile:x': Date.parse('2026-10-20T11:00:00Z') } }),
    }))
    assert.equal(out.changed, false)
  })

  test('a phone-deleted playlist is not re-adopted from the phone file', () => {
    const out = applyPhonePlaylistEdits([], inputs({
      mobilePlaylists: [{ id: 'mobile:gone', name: 'Gone', trackIds: ['1'] }],
      phoneDeletions: parseDeletionLedger({ deletedIds: ['mobile:gone'] }),
    }))
    assert.equal(out.changed, false)
  })
})

describe('stampModifiedPlaylists — memberChangedAt', () => {
  const now = () => '2026-10-20T15:00:00.000Z'
  const nowMs = Date.parse(now())

  test('tracks that joined or left get now; the rest carry over', () => {
    const prev = [jv({ memberChangedAt: { '5411': 5 } })]
    const out = stampModifiedPlaylists(prev, [{ ...jv(), trackIds: [11724, 11819, 5411, 77] }], now)
    assert.deepEqual(out[0].memberChangedAt, { '5411': 5, [XTC]: nowMs, '77': nowMs })
  })

  test('a reorder changes modifiedAt but no member stamps', () => {
    const out = stampModifiedPlaylists([jv()], [{ ...jv(), trackIds: [5411, 11376, 11819, 11724] }], now)
    assert.equal(out[0].modifiedAt, now())
    assert.equal(out[0].memberChangedAt, undefined)
  })

  test('the renderer never sees stamps — they carry from the previous save', () => {
    const prev = [jv({ memberChangedAt: { [XTC]: 9 } })]
    const { memberChangedAt: _drop, ...fromRenderer } = prev[0]
    const out = stampModifiedPlaylists(prev, [fromRenderer], now)
    assert.deepEqual(out[0].memberChangedAt, { [XTC]: 9 })
    assert.equal(out[0].modifiedAt, prev[0].modifiedAt)
  })
})

describe('createPhonePlaylistSync — the live path', () => {
  async function world(files: Record<string, unknown>, playlists: HubPlaylistLike[]) {
    const dir = await mkdtemp(join(tmpdir(), 'phone-pl-'))
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(body))
    let saved = playlists
    const changes: Array<{ why: string; playlists: HubPlaylistLike[] }> = []
    const sync = createPhonePlaylistSync({
      mirrorDir: dir,
      tombstonesFile: join(dir, 'playlist-tombstones.json'),
      getPlaylists: async () => saved,
      setPlaylists: (p) => { saved = p },
      isSaveLocked: () => null,
      onChanged: (p, why) => { changes.push({ why, playlists: p }) },
      now: () => '2026-10-20T15:00:00.000Z',
      log: () => {},
    })
    return { dir, sync, changes, saved: () => saved }
  }

  test('XTC leaves JUSTIFICATION V once, is stamped, and a second pass changes nothing', async () => {
    const w = await world({ 'playlist-removals.json': { [JV]: [XTC] } }, [jv()])
    await w.sync.apply('phone-mirror')
    const after = w.saved()[0]
    assert.ok(!(after.trackIds as number[]).includes(11376))
    assert.deepEqual(after.memberChangedAt, { [XTC]: Date.parse('2026-10-20T15:00:00.000Z') })
    assert.equal(after.modifiedAt, '2026-10-20T15:00:00.000Z', 'a newer modifiedAt is what carries it through the hub to workmini')
    assert.equal(w.changes.length, 1)

    // Jake re-adds it on the Mac (a normal save) — the old phone removal must not fire again.
    const reAdded = stampModifiedPlaylists(w.saved(), [{ ...after, trackIds: [...(after.trackIds as number[]), 11376] }], () => '2026-10-21T09:00:00.000Z')
    w.saved().splice(0, 1, reAdded[0])
    await w.sync.apply('phone-mirror')
    assert.ok((w.saved()[0].trackIds as number[]).includes(11376))
    assert.equal(w.changes.length, 1, 'nothing re-applied')
  })

  test('a phone delete drops the playlist AND writes a desktop tombstone (so the hub drops it too)', async () => {
    const bad = { id: 'mobile:51dfd77d-a53e-4fc3-893a-095715d0d94a', name: 'Bad Ass Music', trackIds: [1] }
    const w = await world({ 'mobile-playlist-deletions.json': { deletedIds: [bad.id] } }, [jv(), bad])
    await w.sync.apply('phone-mirror')
    assert.deepEqual(w.saved().map((p) => p.id), [JV])
    const stones = await loadTombstones(join(w.dir, 'playlist-tombstones.json'))
    assert.deepEqual(stones.map((t) => t.id), [bad.id])
  })

  test('locked saves skip the pass (the next refresh retries)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phone-pl-'))
    await writeFile(join(dir, 'playlist-removals.json'), JSON.stringify({ [JV]: [XTC] }))
    let set = 0
    const sync = createPhonePlaylistSync({
      mirrorDir: dir, tombstonesFile: join(dir, 't.json'),
      getPlaylists: async () => [jv()], setPlaylists: () => { set++ },
      isSaveLocked: () => 'restore in progress', log: () => {},
    })
    assert.equal(await sync.apply('phone-mirror'), null)
    assert.equal(set, 0)
  })

  test('missing or torn mirrors are "no edits", never "delete everything"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phone-pl-'))
    await writeFile(join(dir, 'playlist-removals.json'), '{"pl-1789004986098": ["113')   // torn
    let set = 0
    const sync = createPhonePlaylistSync({
      mirrorDir: dir, tombstonesFile: join(dir, 't.json'),
      getPlaylists: async () => [jv()], setPlaylists: () => { set++ }, isSaveLocked: () => null, log: () => {},
    })
    await sync.apply('launch')
    assert.equal(set, 0)
    assert.equal(await readFile(join(dir, 'playlist-removals.json'), 'utf-8'), '{"pl-1789004986098": ["113', 'mirrors are never written')
  })
})

describe('wiring — the tested code is the live code', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const src = (rel: string) => readFileSync(join(here, '..', '..', rel), 'utf-8')

  test('index.ts applies phone edits at launch (load-playlists) and on every mirror refresh', () => {
    const idx = src('main/index.ts')
    assert.match(idx, /beforeLoadPlaylists: \(\) => phonePlaylistSync\.apply\('launch'\)/)
    assert.match(idx, /PHONE_PLAYLIST_FILES as readonly string\[\]\)\.includes\(n\)\)\) void phonePlaylistSync\.apply\('phone-mirror'\)/)
    assert.match(idx, /sendToRenderer\('playlists-updated'/)
    assert.match(src('main/ipc/library-ipc.ts'), /await host\.beforeLoadPlaylists\?\.\(\)/)
  })

  test('the removal + delete ledgers are mirrored (PHONE_AUTHORED_FILES) and never pushed', () => {
    const idx = src('main/index.ts')
    assert.match(idx, /\.\.\.phonePlaylistSidecarsNeverPushFromDesktop, \.\.\.PHONE_PLAYLIST_LEDGERS,/)
    const stateFiles = idx.slice(idx.indexOf('const STATE_FILE_NAMES = ['), idx.indexOf('] as const', idx.indexOf('const STATE_FILE_NAMES = [')))
    for (const f of PHONE_PLAYLIST_FILES) assert.ok(!stateFiles.includes(`'${f}'`), `${f} must never be in STATE_FILE_NAMES`)
    for (const f of phonePlaylistSidecarsNeverPushFromDesktop) assert.ok((PHONE_PLAYLIST_FILES as readonly string[]).includes(f))
    assert.deepEqual([...PHONE_PLAYLIST_LEDGERS], ['playlist-removals.json', 'mobile-playlist-deletions.json'])
  })

  test('the renderer no longer re-applies phone adds at every launch', () => {
    const app = src('renderer/App.tsx')
    assert.doesNotMatch(app, /loadPlaylistAdditions|loadMobilePlaylists/)
    assert.doesNotMatch(src('preload/index.ts'), /read-playlist-additions|read-mobile-playlists/)
  })
})
