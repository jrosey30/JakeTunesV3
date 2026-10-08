import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeHubCatalog, MAX_REMOVALS_PER_DELTA } from '../../common/hub-catalog-merge.ts'
import { idsPushedBySave, libraryPublishTargets } from '../../common/replica-library-push.ts'

const t = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: `T${id}`, artist: 'A', playCount: 0, path: `:iPod_Control:Music:F00:imported_${id}.flac`, ...extra })

describe('mergeHubCatalog: replicas adopt the hub without ever losing a song by accident', () => {
  it('songs the hub still lists survive a full snapshot (the 10-08 Geese tracks were on the hub)', () => {
    const local = [t(1), t(2), t(12166, { title: 'Jesse', artist: 'Geese' })]
    const r = mergeHubCatalog(local, {
      full: true, version: 'v2',
      upserts: [t(1), t(2), t(12166, { title: 'Jesse', artist: 'Geese' })],
      removedIds: [],
    })
    assert.equal(r.removed, 0)
    assert.ok(r.tracks.some((x) => x.id === 12166))
  })
  it('a full snapshot adds what the hub has and this machine lacks', () => {
    const r = mergeHubCatalog([t(1)], { full: true, version: 'v', upserts: [t(1), t(7, { title: 'New' })], removedIds: [] })
    assert.equal(r.added, 1)
    assert.equal(r.tracks.map((x) => x.id).join(','), '1,7')
  })
  it('hub catalog fields win (latest edit), local playCount is never lowered', () => {
    const local = [t(1, { title: 'old title', playCount: 9 })]
    const r = mergeHubCatalog(local, { full: false, version: 'v', upserts: [t(1, { title: 'fixed title', playCount: 3 })], removedIds: [] })
    assert.equal(r.updated, 1)
    assert.equal(r.tracks[0].title, 'fixed title')
    assert.equal(r.tracks[0].playCount, 9)
  })
  it('hub plays raise the local count (phone plays reach the desktop)', () => {
    const r = mergeHubCatalog([t(1, { playCount: 2 })], { full: false, version: 'v', upserts: [t(1, { playCount: 5 })], removedIds: [] })
    assert.equal(r.tracks[0].playCount, 5)
  })
  it('a delta removes only the ids it names; a full snapshot removes whatever the catalog omits', () => {
    const local = [t(1), t(2)]
    const d = mergeHubCatalog(local, { full: false, version: 'v', upserts: [], removedIds: ['2'] })
    assert.equal(d.removed, 1)
    assert.equal(d.tracks.map((x) => x.id).join(','), '1')
    // removedIds on a full reply are not a second list — membership is the
    // upsert set. Id 2 is absent from the catalog, so it leaves. Id 1 stays
    // even if a stale removedIds also names it.
    const f = mergeHubCatalog(local, { full: true, version: 'v', upserts: [t(1)], removedIds: ['1'] })
    assert.equal(f.removed, 1)
    assert.deepEqual(f.tracks.map((x) => x.id), [1])
  })
  it('a full snapshot is the catalog: songs the hub no longer lists are removed', () => {
    // Resurrection path. A hub restart (or any declined delta) answers
    // full:true with the songs that still exist and no removedIds. The
    // replica must end that adoption without the deleted id, so the save
    // that follows has nothing to put back.
    const local = [t(1), t(2), t(3, { title: 'deleted on the laptop' })]
    const r = mergeHubCatalog(local, { full: true, version: 'v', upserts: [t(1), t(2)], removedIds: [] })
    assert.equal(r.removed, 1)
    assert.deepEqual(r.tracks.map((x) => x.id), [1, 2])
  })
  it('an empty full snapshot can never blank the library', () => {
    const r = mergeHubCatalog([t(1), t(2)], { full: true, version: 'v', upserts: [], removedIds: [] })
    assert.equal(r.changed, false)
    assert.equal(r.ignoredReason, 'empty-full-snapshot')
    assert.equal(r.tracks.length, 2)
  })
  it('unchanged rows keep their identity (no spurious save)', () => {
    const local = [t(1), t(2)]
    const r = mergeHubCatalog(local, { full: false, version: 'v', upserts: [t(1), t(2)], removedIds: [] })
    assert.equal(r.changed, false)
    assert.equal(r.tracks, local)
  })
  it('a full snapshot that would drop more than half the library is not adopted', () => {
    const local = Array.from({ length: 100 }, (_, i) => t(i + 1))
    const torn = mergeHubCatalog(local, { full: true, version: 'v', upserts: local.slice(0, 40), removedIds: [] })
    assert.equal(torn.changed, false)
    assert.equal(torn.removed, 0)
    assert.equal(torn.tracks.length, 100)
    assert.match(torn.ignoredReason ?? '', /full-snapshot-shrink-guard/)
    // Under the floor (60 kept of 100) a real cleanup still lands, including
    // past the delta's 25-id cap — a full catalog is not a removedIds list.
    const ok = mergeHubCatalog(local, { full: true, version: 'v', upserts: local.slice(0, 60), removedIds: [] })
    assert.equal(ok.removed, 40)
    assert.equal(ok.tracks.length, 60)
  })
  it('full:true adoption followed by a save does not reintroduce deleted ids anywhere it pushes', () => {
    const deleted = 3
    const local = [t(1), t(2), t(deleted, { title: 'gone on the hub' })]
    const merged = mergeHubCatalog(local, { full: true, version: 'v9', upserts: [t(1), t(2)], removedIds: [] })
    assert.deepEqual(merged.tracks.map((x) => x.id), [1, 2])
    // The replica save that follows the adoption publishes nowhere — not the
    // NAS copy the phone reads, and not the hub. The pre-adoption superset
    // (still holding the deleted id) publishes nowhere either, so a save
    // that races the merge cannot put the song back.
    const adopted = idsPushedBySave({ isReplica: true, trackIds: merged.tracks.map((x) => x.id) })
    assert.deepEqual(adopted, { nas: [], hub: [] })
    const stale = idsPushedBySave({ isReplica: true, trackIds: local.map((x) => x.id) })
    assert.deepEqual(stale, { nas: [], hub: [] })
    assert.equal(stale.nas.includes(String(deleted)), false)
    assert.equal(stale.hub.includes(String(deleted)), false)
    // The canonical laptop still publishes, and the adopted set it would
    // publish does not contain the deleted id.
    assert.deepEqual(libraryPublishTargets(false), { nas: true, hub: true })
    const canon = idsPushedBySave({ isReplica: false, trackIds: merged.tracks.map((x) => x.id) })
    assert.deepEqual(canon.nas, ['1', '2'])
    assert.equal(canon.hub.includes(String(deleted)), false)
  })
  it('the live save and backup paths call the replica publish gate', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const mirror = index.slice(index.indexOf('async function mirrorLibraryToNas'), index.indexOf('async function mirrorLibraryToNas') + 700)
    assert.match(mirror, /libraryPublishTargets/)
    const detect = index.slice(index.indexOf('async function detectStateConflicts'), index.indexOf('async function detectStateConflicts') + 900)
    assert.match(detect, /libraryPublishTargets/)
    assert.match(index, /setBlocksHubLibraryPublish/)
  })
  it('a delta that removes a crowd is a torn publish, not a cleanup — nothing is removed', () => {
    const local = Array.from({ length: 200 }, (_, i) => t(i + 1))
    const ids = local.slice(0, MAX_REMOVALS_PER_DELTA + 1).map((x) => String(x.id))
    const r = mergeHubCatalog(local, { full: false, version: 'v', upserts: [], removedIds: ids })
    assert.equal(r.removed, 0)
    assert.equal(r.tracks.length, 200)
    assert.match(r.ignoredReason ?? '', /mass-removal-guard/)
    const ok = mergeHubCatalog(local, { full: false, version: 'v', upserts: [], removedIds: ids.slice(0, 3) })
    assert.equal(ok.removed, 3)
  })
})
