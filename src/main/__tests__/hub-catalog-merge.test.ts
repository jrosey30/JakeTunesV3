import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeHubCatalog, MAX_REMOVALS_PER_DELTA } from '../../common/hub-catalog-merge.ts'

const t = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, title: `T${id}`, artist: 'A', playCount: 0, path: `:iPod_Control:Music:F00:imported_${id}.flac`, ...extra })

describe('mergeHubCatalog: replicas adopt the hub without ever losing a song by accident', () => {
  it('the 10-08 incident: songs absorbed from the phone survive a full snapshot that lacks them', () => {
    const local = [t(1), t(2), t(12166, { title: 'Jesse', artist: 'Geese' })]
    const r = mergeHubCatalog(local, { full: true, version: 'v2', upserts: [t(1), t(2)], removedIds: [] })
    assert.equal(r.changed, false)
    assert.equal(r.tracks.length, 3)
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
  it('removals apply only from a delta, and a full snapshot ignores removedIds', () => {
    const local = [t(1), t(2)]
    const d = mergeHubCatalog(local, { full: false, version: 'v', upserts: [], removedIds: ['2'] })
    assert.equal(d.removed, 1)
    assert.equal(d.tracks.map((x) => x.id).join(','), '1')
    const f = mergeHubCatalog(local, { full: true, version: 'v', upserts: [t(1)], removedIds: ['2'] })
    assert.equal(f.removed, 0)
    assert.equal(f.tracks.length, 2)
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
