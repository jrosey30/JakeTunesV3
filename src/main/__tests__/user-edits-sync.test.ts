/**
 * user-edits-sync.ts end to end with fakes (2026-10-20): roles, the first
 * journal, the hub's absorb tick, a replica's verdict tick, and the safety
 * locks (a journal that does not parse is never overwritten; homemini's own
 * app keeps no journal; a locked save absorbs nothing).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUserEditsSync, userEditsRole, parseUserEditsReply, type UserEditsHost, type UserEditsRole, type FetchLike } from '../user-edits-sync.ts'
import { emptyUserEdits, recordUserEdit, rowFingerprint, USER_EDITS_FILE, type RowLike, type UserEditsDoc } from '../../common/user-edits.ts'
import { mergeOverrideField } from '../override-merge.ts'

const NOW = Date.UTC(2026, 9, 21, 15)
const rows = new Map<string, RowLike>([
  ['1', { id: 1, title: 'Roxanne', artist: 'The Police', duration: 192_000, rating: 0, genre: 'Rock' }],
  ['2', { id: 2, title: 'F.M.', artist: 'Steely Dan', duration: 307_000, rating: 0, genre: 'Classic Rock' }],
])

interface Harness {
  host: UserEditsHost
  dir: string
  overrides: Record<string, unknown>
  stars: { trackIds: string[]; removed: Record<string, number>; added: Record<string, number> }
  starCalls: Array<[number, boolean, number]>
  applied: Array<Array<{ id: number; field: string; value: string }>>
  published: number
  setReply: (status: number, body?: unknown, etag?: string) => void
}

function harness(role: UserEditsRole, opts: { overrides?: Record<string, unknown>; locked?: string | null } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ue-'))
  let reply: { status: number; body?: unknown; etag?: string } = { status: 404 }
  const h: Harness = {
    dir, overrides: opts.overrides ?? {}, stars: { trackIds: [], removed: {}, added: {} },
    starCalls: [], applied: [], published: 0,
    setReply: (status, body, etag) => { reply = { status, body, etag } },
    host: undefined as unknown as UserEditsHost,
  }
  const fetchImpl: FetchLike = async () => ({
    ok: reply.status >= 200 && reply.status < 300, status: reply.status,
    json: async () => reply.body, headers: { get: (n: string) => (n === 'etag' ? reply.etag ?? null : null) },
  })
  h.host = {
    dir, baseUrl: 'http://hub', role: async () => role, rows: async () => rows,
    overrides: async () => h.overrides, stars: async () => h.stars, isLocked: () => opts.locked ?? null,
    writeOverride: async (id, field, value, fp) => { mergeOverrideField(h.overrides, id, field, value, fp) },
    starAt: async (id, starred, at) => { h.starCalls.push([id, starred, at]) },
    applied: (u) => { h.applied.push(u) }, publish: () => { h.published++ },
    fetchImpl, now: () => NOW, log: () => {}, warn: () => {},
  }
  return h
}

const readJournal = (dir: string): UserEditsDoc => JSON.parse(readFileSync(join(dir, USER_EDITS_FILE), 'utf-8'))

describe('roles', () => {
  test('no homemini sync script = off (homemini\'s own app); else replica or hub', () => {
    assert.equal(userEditsRole({ isReplica: false, syncScriptPresent: false }), 'off')
    assert.equal(userEditsRole({ isReplica: true, syncScriptPresent: false }), 'off')
    assert.equal(userEditsRole({ isReplica: true, syncScriptPresent: true }), 'replica')
    assert.equal(userEditsRole({ isReplica: false, syncScriptPresent: true }), 'hub')
  })

  test('off: records nothing, writes no file, changes nothing at load', async () => {
    const h = harness('off')
    const sync = createUserEditsSync(h.host)
    await sync.record(1, 'rating', '5', NOW)
    await sync.flush()
    assert.equal(existsSync(join(h.dir, USER_EDITS_FILE)), false)
    const merged = { '2': { fp: 'x', fields: { genre: 'Yacht Rock' } } }
    assert.equal(await sync.overlay(merged), merged)
  })
})

describe('the journal file', () => {
  test('a journal that does not parse is never overwritten and stops recording', async () => {
    const h = harness('hub')
    writeFileSync(join(h.dir, USER_EDITS_FILE), '{"version":1,"since":')
    const sync = createUserEditsSync(h.host)
    await sync.record(1, 'genre', 'Jazz', NOW)
    await sync.flush()
    assert.equal(readFileSync(join(h.dir, USER_EDITS_FILE), 'utf-8'), '{"version":1,"since":')
  })

  test('a replica\'s first journal carries its earlier stars in from starredAt', async () => {
    const T = NOW - 3 * 86_400_000
    const h = harness('replica', { overrides: { '1': { fp: rowFingerprint(rows.get('1')!), fields: { rating: '5', starredAt: String(T), genre: 'Yacht Rock' } } } })
    const sync = createUserEditsSync(h.host)
    await sync.record(2, 'rating', '5', NOW)
    await sync.flush()
    const j = readJournal(h.dir)
    assert.equal(j.since, NOW)
    assert.deepEqual(j.edits['1'].rating, { v: '5', at: T, seed: true, dur: 192_000 })
    assert.equal(j.edits['1'].genre, undefined, 'a copied genre is never an edit')
    assert.deepEqual(j.edits['2'].rating, { v: '5', at: NOW, dur: 307_000 })
  })

  test('play counters never reach the journal', async () => {
    const h = harness('hub')
    const sync = createUserEditsSync(h.host)
    await sync.record(1, 'playCount', '9', NOW)
    await sync.record(1, 'lastPlayedAt', String(NOW), NOW)
    await sync.flush()
    assert.equal(existsSync(join(h.dir, USER_EDITS_FILE)), false)
  })
})

describe('the hub absorbs', () => {
  const replicaJournal = (): UserEditsDoc => {
    let d = emptyUserEdits(NOW - 86_400_000)
    d = recordUserEdit(d, 1, 'rating', '5', NOW + 1000, { dur: 192_000 })
    d = recordUserEdit(d, 1, 'starredAt', String(NOW + 1000), NOW + 1000, { dur: 192_000 })
    return d
  }

  test('writes the edit, stars the sidecar AT THE EDIT\'S TIME, tells the window, publishes, records', async () => {
    const h = harness('hub')
    const sync = createUserEditsSync(h.host)
    await sync.record(2, 'genre', 'Classic Rock', NOW)   // creates the hub journal (since = NOW)
    h.setReply(200, { version: 1, hub: null, replicas: [{ name: 'workmini', mtimeMs: 1, doc: replicaJournal() }] }, '"e1"')
    await sync.tick()
    await sync.flush()
    assert.deepEqual((h.overrides['1'] as { fields: Record<string, string> }).fields, { rating: '5', starredAt: String(NOW + 1000) })
    assert.equal((h.overrides['1'] as { fp: string }).fp, rowFingerprint(rows.get('1')!))
    assert.deepEqual(h.starCalls, [[1, true, NOW + 1000]])
    assert.equal(h.applied.length, 1)
    assert.equal(h.published, 1)
    assert.equal(readJournal(h.dir).edits['1'].rating.from, 'workmini')
    // a 304 re-plans against the same journals and writes nothing new
    h.setReply(304)
    await sync.tick()
    assert.equal(h.published, 1)
  })

  test('saves locked (iPod sync) → absorbs nothing this tick', async () => {
    const h = harness('hub', { locked: 'ipod-sync' })
    h.setReply(200, { version: 1, hub: null, replicas: [{ name: 'workmini', mtimeMs: 1, doc: replicaJournal() }] })
    const sync = createUserEditsSync(h.host)
    await sync.tick()
    assert.deepEqual(h.overrides, {})
  })

  test('homemini unreachable or a non-journal reply → nothing changes', async () => {
    const h = harness('hub')
    const sync = createUserEditsSync(h.host)
    h.setReply(500)
    await sync.tick()
    h.setReply(200, '<html>')
    await sync.tick()
    assert.deepEqual(h.overrides, {})
  })
})

describe('a replica learns the hub\'s verdicts', () => {
  test('caches the hub journal, updates the window, and the next boot\'s overlay uses it', async () => {
    const h = harness('replica')
    const sync = createUserEditsSync(h.host)
    await sync.record(1, 'rating', '5', NOW + 1000)
    const hub = recordUserEdit(emptyUserEdits(NOW), 1, 'rating', '0', NOW + 1001, { from: 'workmini', kept: true })
    h.setReply(200, { version: 1, hub: { mtimeMs: 1, doc: hub }, replicas: [] }, '"h1"')
    await sync.tick()
    assert.deepEqual(h.applied, [[{ id: 1, field: 'rating', value: '0' }]])
    await sync.flush()
    // a fresh process (next boot) reads the cached verdict while homemini is away
    const boot = createUserEditsSync(h.host)
    h.setReply(500)
    const merged = await boot.overlay({ '2': { fp: rowFingerprint(rows.get('2')!), fields: { genre: 'Yacht Rock', bpm: '101' } } })
    assert.deepEqual(merged['2'], { fp: rowFingerprint(rows.get('2')!), fields: { bpm: '101' } }, 'the stale genre is gone')
    assert.equal((merged['1'] as { fields: Record<string, string> }).fields.rating, '0')
  })

  test('the hub catalog payload keeps Jake\'s standing edits — only after the boot overlay ran', async () => {
    const h = harness('replica')
    const sync = createUserEditsSync(h.host)
    await sync.record(2, 'genre', 'Jazz', NOW + 5)
    const payload = { full: true, version: 'v9', upserts: [{ id: 2, title: 'F.M.', artist: 'Steely Dan', duration: 307_000, genre: 'Classic Rock' }], removedIds: [] }
    assert.equal(sync.pinPending(payload), payload, 'no overlay yet → unchanged')
    await sync.overlay({})
    const pinned = sync.pinPending(payload)
    assert.equal(pinned.upserts[0].genre, 'Jazz')
    assert.equal(payload.upserts[0].genre, 'Classic Rock')
    const hubSync = createUserEditsSync(harness('hub').host)
    assert.equal(hubSync.pinPending(payload), payload, 'the hub never pins')
  })

  test('reply parser: replica names are [a-z0-9-], bad docs dropped', () => {
    const doc = emptyUserEdits(NOW)
    const r = parseUserEditsReply({ version: 1, hub: { doc }, replicas: [{ name: 'workmini', doc }, { name: '../x', doc }, { name: 'ok', doc: { nope: 1 } }] })
    assert.deepEqual(r?.replicas.map((x) => x.name), ['workmini'])
    assert.equal(parseUserEditsReply({ version: 2, replicas: [] }), null)
  })
})

// ── 2026-10-22 — "unstar everywhere" (Jake): applyPhoneUnstars ────────────────
describe('the hub lowers a rating the phone un-starred (applyPhoneUnstars)', () => {
  const ratedRows = new Map<string, RowLike>([
    ['1', { id: 1, title: 'Roxanne', artist: 'The Police', duration: 192_000, rating: 5, genre: 'Rock' }],
    ['2', { id: 2, title: 'F.M.', artist: 'Steely Dan', duration: 307_000, rating: 3, genre: 'Classic Rock' }],
  ])
  function hub(role: UserEditsRole = 'hub', opts: { locked?: string | null; removed?: Record<string, number>; trackIds?: string[]; added?: Record<string, number> } = {}) {
    const h = harness(role, { locked: opts.locked })
    h.host.rows = async () => ratedRows
    h.stars = { trackIds: opts.trackIds ?? [], removed: opts.removed ?? { '1': NOW - 1000 }, added: opts.added ?? {} }
    h.host.stars = async () => h.stars
    return h
  }

  test('writes rating 0 through the override writer, journals it at the un-star\'s time (from: phone), tells the window, publishes', async () => {
    const h = hub()
    const sync = createUserEditsSync(h.host)
    assert.equal(await sync.applyPhoneUnstars(), 1)
    await sync.flush()
    assert.deepEqual((h.overrides['1'] as { fields: Record<string, string> }).fields, { rating: '0' })
    assert.equal((h.overrides['1'] as { fp: string }).fp, rowFingerprint(ratedRows.get('1')!))
    assert.deepEqual(h.applied, [[{ id: 1, field: 'rating', value: '0' }]])
    assert.equal(h.published, 1)
    assert.deepEqual(readJournal(h.dir).edits['1'].rating, { v: '0', at: NOW - 1000, from: 'phone', dur: 192_000 })
    assert.deepEqual(h.starCalls, [], 'the tombstone is already in the star record — nothing is re-written there')
    assert.equal(h.overrides['2'], undefined, 'a song with no tombstone is untouched')
  })

  test('idempotent: the next pass (and the next merge) changes nothing', async () => {
    const h = hub()
    const sync = createUserEditsSync(h.host)
    await sync.applyPhoneUnstars()
    assert.equal(await sync.applyPhoneUnstars(), 0)
    assert.equal(h.published, 1)
    assert.equal(h.applied.length, 1)
  })

  test('concurrent calls (the star merge and the 5-minute tick) lower it once', async () => {
    const h = hub()
    const sync = createUserEditsSync(h.host)
    const r = await Promise.all([sync.applyPhoneUnstars(), sync.applyPhoneUnstars(), sync.tick()])
    assert.equal(r[0] + r[1], 1)
    assert.equal(h.applied.length, 1)
  })

  test('the hub\'s own newer star stands (journal), and a star made after the un-star keeps the sidecar\'s verdict', async () => {
    const h = hub()
    const sync = createUserEditsSync(h.host)
    await sync.record(1, 'rating', '5', NOW)   // Jake starred it on this Mac AFTER the phone un-starred it
    assert.equal(await sync.applyPhoneUnstars(), 0)
    assert.equal(h.overrides['1'], undefined)
    const h2 = hub('hub', { trackIds: ['1'], added: { '1': NOW }, removed: { '1': NOW - 1000 } })
    assert.equal(await createUserEditsSync(h2.host).applyPhoneUnstars(), 0)
  })

  test('only the MacBook (hub) does it: a replica, homemini\'s own app and a locked save change nothing', async () => {
    for (const [role, locked] of [['replica', null], ['off', null], ['hub', 'ipod-sync']] as Array<[UserEditsRole, string | null]>) {
      const h = hub(role, { locked })
      assert.equal(await createUserEditsSync(h.host).applyPhoneUnstars(), 0, `${role}/${locked}`)
      assert.deepEqual(h.overrides, {})
      assert.equal(h.published, 0)
    }
  })

  test('the tick runs it before the absorb, with no replicas and no network', async () => {
    const h = hub()
    h.setReply(500)   // homemini unreachable
    const sync = createUserEditsSync(h.host)
    await sync.tick()
    assert.deepEqual((h.overrides['1'] as { fields: Record<string, string> }).fields, { rating: '0' })
  })

  test('a failing override write is reported, not thrown, and the next pass retries', async () => {
    const h = hub()
    const warns: string[] = []
    h.host.warn = (_k, m) => { warns.push(m) }
    let fail = true
    const write = h.host.writeOverride
    h.host.writeOverride = async (...a) => { if (fail) throw new Error('disk full'); return write(...a) }
    const sync = createUserEditsSync(h.host)
    assert.equal(await sync.applyPhoneUnstars(), 0)
    assert.match(warns.join('\n'), /could not lower 1/)
    fail = false
    assert.equal(await sync.applyPhoneUnstars(), 1)
  })
})
