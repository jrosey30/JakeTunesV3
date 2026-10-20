/**
 * The user-edit journal's rules (src/common/user-edits.ts) — 2026-10-20.
 *
 * Locks: only Jake's edits are journaled, newest per (song, field); the hub
 * absorbs a replica's edit only when it is the newest real edit and NEVER
 * rolls the hub back; a replica's stale overrides copy can no longer lay old
 * hub values over the catalog; ids, durations and timestamps decide — never
 * text.
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/__tests__/userEditsDoc.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyUserEdits, parseUserEdits, recordUserEdit, seedStarsFromOverrides, planHubAbsorb,
  replicaOverlay, replicaLiveUpdates, rowFingerprint, sameValue, isUserEditField, pinPendingEdits,
  type UserEditsDoc, type RowLike,
} from '../../common/user-edits.ts'
import { HUB_CATALOG_FIELDS, HUB_DETAIL_FIELDS, mergeHubCatalog } from '../../common/hub-catalog-merge.ts'
import { mergeOverrideField } from '../override-merge.ts'
import { absorbFingerprint } from '../user-edits-sync.ts'

const DAY = 86_400_000
const SINCE = Date.UTC(2026, 9, 21, 12)          // the hub started its journal
const HUB_FIELDS = new Set<string>(HUB_CATALOG_FIELDS)
const DETAIL = new Set<string>(HUB_DETAIL_FIELDS)
const CARRIED = new Set<string>([...HUB_CATALOG_FIELDS, ...HUB_DETAIL_FIELDS])

const row = (id: number, extra: Record<string, unknown> = {}): [string, RowLike] =>
  [String(id), { id, title: `Song ${id}`, artist: 'Band', duration: 200_000 + id, rating: 0, genre: 'Rock', ...extra }]
const fpOf = (r: RowLike) => rowFingerprint(r)
const noStars = { trackIds: [] as string[], removed: {}, added: {} }

function replicaDoc(edits: Array<[number, string, string, number, Record<string, unknown>?]>): UserEditsDoc {
  let d = emptyUserEdits(SINCE - DAY)
  for (const [id, f, v, at, extra] of edits) d = recordUserEdit(d, id, f, v, at, { dur: 200_000 + id, ...(extra ?? {}) })
  return d
}

describe('the journal', () => {
  test('keeps the newest edit per song + field; play counters and analysis are not edits', () => {
    let d = emptyUserEdits(SINCE)
    d = recordUserEdit(d, 7, 'genre', 'Jazz', SINCE + 10)
    d = recordUserEdit(d, 7, 'genre', 'Blues', SINCE + 5)          // older — ignored
    assert.equal(d.edits['7'].genre.v, 'Jazz')
    d = recordUserEdit(d, 7, 'genre', 'Soul', SINCE + 20)
    assert.equal(d.edits['7'].genre.v, 'Soul')
    for (const f of ['playCount', 'lastPlayedAt', 'skipCount', 'bpm', 'audioAnalysisAt', 'subgenre', 'keyRoot']) {
      assert.equal(isUserEditField(f), false, f)
      assert.equal(recordUserEdit(d, 7, f, '1', SINCE + 30), d, `${f} must never be journaled`)
    }
  })

  test('round-trips through JSON; a file that is not a journal parses to null', () => {
    const d = recordUserEdit(emptyUserEdits(SINCE), 11952, 'rating', '5', SINCE + 1, { dur: 192_000 })
    assert.deepEqual(parseUserEdits(JSON.parse(JSON.stringify(d))), d)
    assert.equal(parseUserEdits({ version: 2, since: SINCE, edits: {} }), null)
    assert.equal(parseUserEdits({ tracks: [] }), null)
    assert.equal(parseUserEdits(null), null)
  })

  test('values: numbers by number, empty and "0" are both unset', () => {
    assert.ok(sameValue('5', 5))
    assert.ok(sameValue('', '0'))
    assert.ok(sameValue(undefined, '0'))
    assert.ok(!sameValue('Rock', 'rock'))
    assert.ok(!sameValue('5', '0'))
  })
})

describe('backfill: the stars a replica set before journals existed', () => {
  test('only rating > 0 WITH a starredAt, on an entry that applied here; at = starredAt', () => {
    const rows = new Map([row(1), row(2), row(3), row(4)])
    const T = SINCE - 5 * DAY
    const overrides = {
      '1': { fp: fpOf(rows.get('1')!), fields: { rating: '5', starredAt: String(T) } },                 // seeded
      '2': { fp: fpOf(rows.get('2')!), fields: { rating: '0', starredAt: String(T) } },                 // un-star: no time
      '3': { fp: 'stale|fp|1', fields: { rating: '5', starredAt: String(T) } },                         // never applied here
      '4': { fp: fpOf(rows.get('4')!), fields: { rating: '5', genre: 'Yacht Rock' } },                  // no starredAt
    }
    const { doc, seeded } = seedStarsFromOverrides(emptyUserEdits(SINCE), overrides, rows, SINCE)
    assert.equal(seeded, 1)
    assert.deepEqual(Object.keys(doc.edits), ['1'])
    assert.deepEqual(doc.edits['1'].rating, { v: '5', at: T, seed: true, dur: 200_001 })
    assert.equal(doc.edits['1'].starredAt.at, T)
    assert.equal(doc.edits['4'], undefined, 'a genre in the old copy is never treated as an edit')
  })
})

describe('the hub absorbs a replica edit only when it is the newest real edit', () => {
  const base = () => new Map([row(1), row(2), row(3), row(4), row(5), row(6), row(7)])

  test('a post-journal replica edit is written through the override writer and recorded', () => {
    const rows = base()
    const plan = planHubAbsorb({
      replicas: [{ name: 'workmini', doc: replicaDoc([[1, 'genre', 'Jazz', SINCE + 1000], [2, 'rating', '5', SINCE + 2000], [2, 'starredAt', String(SINCE + 2000), SINCE + 2000]]) }],
      hub: emptyUserEdits(SINCE), overrides: {}, rows, stars: noStars,
    })
    assert.deepEqual(plan.writes.map((w) => `${w.id}.${w.field}=${w.value}@${w.at - SINCE}`), ['1.genre=Jazz@1000', '2.rating=5@2000', `2.starredAt=${SINCE + 2000}@2000`])
    assert.equal(plan.hub.edits['1'].genre.from, 'workmini')
    assert.equal(plan.counts.absorbed, 3)
  })

  test('the hub keeps its own LATER edit (never rolled back)', () => {
    const rows = base()
    const hub = recordUserEdit(emptyUserEdits(SINCE), 1, 'genre', 'Classic Rock', SINCE + 5000)
    const plan = planHubAbsorb({
      replicas: [{ name: 'workmini', doc: replicaDoc([[1, 'genre', 'Yacht Rock', SINCE + 1000]]) }],
      hub, overrides: { '1': { fp: fpOf(rows.get('1')!), fields: { genre: 'Classic Rock' } } }, rows, stars: noStars,
    })
    assert.deepEqual(plan.writes, [])
    assert.equal(plan.counts['hub-newer'], 1)
    assert.equal(plan.hub, hub, 'nothing new recorded')
  })

  test('a star the phone took back after the replica starred it stays un-starred', () => {
    const rows = base()
    const plan = planHubAbsorb({
      replicas: [{ name: 'workmini', doc: replicaDoc([[3, 'rating', '5', SINCE + 1000]]) }],
      hub: emptyUserEdits(SINCE), overrides: {}, rows,
      stars: { trackIds: [], removed: { '3': SINCE + 9000 }, added: {} },
    })
    assert.deepEqual(plan.writes, [])
    assert.equal(plan.counts['star-newer-elsewhere'], 1)
    assert.deepEqual(plan.hub.edits['3'].rating, { v: '0', at: SINCE + 1001, from: 'workmini', kept: true })
  })

  test('before the hub journal: an undecided song takes the replica star; a decided one keeps the hub', () => {
    const rows = base()
    const T = SINCE - 3 * DAY
    const replica = replicaDoc([
      [4, 'rating', '5', T, { seed: true }],        // hub never touched song 4
      [5, 'rating', '5', T, { seed: true }],        // hub set rating 0 at some unknown time
      [6, 'rating', '5', T, { seed: true }],        // the phone un-starred song 6 once (an older tombstone)
      [7, 'rating', '5', T, { seed: true }],        // hub already starred it
    ])
    const plan = planHubAbsorb({
      replicas: [{ name: 'workmini', doc: replica }],
      hub: emptyUserEdits(SINCE),
      overrides: {
        '5': { fp: fpOf(rows.get('5')!), fields: { rating: '0' } },
        '7': { fp: fpOf(rows.get('7')!), fields: { rating: '5' } },
      },
      rows, stars: { trackIds: [], removed: { '6': T - DAY }, added: {} },
    })
    assert.deepEqual(plan.writes.map((w) => w.id), ['4'])
    assert.equal(plan.counts['hub-decided-earlier'], 2)
    assert.equal(plan.counts['same-value'], 1)
    assert.equal(plan.hub.edits['5'].rating.kept, true)
    assert.equal(plan.hub.edits['5'].rating.v, '0')
  })

  test('rating and starredAt are one star: when the star loses, its stamp loses too (7532)', () => {
    const rows = base()
    const T = SINCE - 6 * DAY
    const plan = planHubAbsorb({
      replicas: [{ name: 'workmini', doc: replicaDoc([[5, 'rating', '5', T, { seed: true }], [5, 'starredAt', String(T), T, { seed: true }]]) }],
      hub: emptyUserEdits(SINCE),
      overrides: { '5': { fp: fpOf(rows.get('5')!), fields: { rating: '0' } } },   // the MacBook had decided: no star
      rows, stars: noStars,
    })
    assert.deepEqual(plan.writes, [], 'not even the starredAt stamp lands')
    assert.equal(plan.hub.edits['5'].starredAt.kept, true)
  })

  test('a star the sidecar holds counts as the hub showing it starred (no verdict of 0)', () => {
    const rows = base()
    const plan = planHubAbsorb({
      replicas: [{ name: 'workmini', doc: replicaDoc([[6, 'rating', '5', SINCE - DAY, { seed: true }]]) }],
      hub: emptyUserEdits(SINCE),
      overrides: { '6': { fp: fpOf(rows.get('6')!), fields: { rating: '0' } } },
      rows, stars: { trackIds: ['6'], removed: {}, added: {} },
    })
    assert.deepEqual(plan.writes, [])
    assert.equal(plan.counts['same-value'], 1)
  })

  test('a crash between the rating and its stamp: the next tick still lands the stamp', () => {
    const rows = base()
    const replicas = [{ name: 'workmini', doc: replicaDoc([[2, 'rating', '5', SINCE + 2000], [2, 'starredAt', String(SINCE + 2001), SINCE + 2001]]) }]
    const hub = recordUserEdit(emptyUserEdits(SINCE), 2, 'rating', '5', SINCE + 2000, { from: 'workmini' })
    const overrides = { '2': { fp: fpOf(rows.get('2')!), fields: { rating: '5' } } }
    const plan = planHubAbsorb({ replicas, hub, overrides, rows, stars: noStars })
    assert.deepEqual(plan.writes.map((w) => w.field), ['starredAt'])
  })

  test('a song the hub does not have yet, or whose duration moved, is held — never guessed', () => {
    const rows = new Map([row(1, { duration: 999_999 })])
    const plan = planHubAbsorb({
      replicas: [{ name: 'workmini', doc: replicaDoc([[1, 'genre', 'Jazz', SINCE + 1], [42, 'genre', 'Jazz', SINCE + 1]]) }],
      hub: emptyUserEdits(SINCE), overrides: {}, rows, stars: noStars,
    })
    assert.deepEqual(plan.writes, [])
    assert.equal(plan.counts['held-different-song'], 1)
    assert.equal(plan.counts['held-not-on-hub'], 1)
    assert.equal(Object.keys(plan.hub.edits).length, 0, 'held songs are re-planned next tick, not recorded')
  })

  test('idempotent: planning again after the writes changes nothing', () => {
    const rows = base()
    const overrides: Record<string, unknown> = {}
    const replicas = [{ name: 'workmini', doc: replicaDoc([[1, 'genre', 'Jazz', SINCE + 1000], [2, 'rating', '5', SINCE + 2000]]) }]
    const first = planHubAbsorb({ replicas, hub: emptyUserEdits(SINCE), overrides, rows, stars: noStars })
    for (const w of first.writes) mergeOverrideField(overrides, w.id, w.field, w.value, absorbFingerprint(overrides, w.id, rows.get(w.id)!))
    const again = planHubAbsorb({ replicas, hub: first.hub, overrides, rows, stars: noStars })
    assert.deepEqual(again.writes, [])
    assert.equal(again.hub, first.hub)
    // and a crash between the override write and the journal save re-records without writing
    const crashed = planHubAbsorb({ replicas, hub: emptyUserEdits(SINCE), overrides, rows, stars: noStars })
    assert.deepEqual(crashed.writes, [])
    assert.equal(crashed.counts['same-value'], 2)
  })

  test('the absorb never wipes an entry: it writes with the entry\'s own fingerprint', () => {
    const rows = base()
    const overrides: Record<string, unknown> = {
      '1': { fp: 'old title|band|200001', fields: { bpm: '120', genre: 'Rock' } },   // stale fp, analysis inside
      '2': { fp: '', fields: { bpm: '90' } },                                       // empty fp
    }
    mergeOverrideField(overrides, 1, 'genre', 'Jazz', absorbFingerprint(overrides, '1', rows.get('1')!))
    mergeOverrideField(overrides, 2, 'rating', '5', absorbFingerprint(overrides, '2', rows.get('2')!))
    mergeOverrideField(overrides, 3, 'rating', '5', absorbFingerprint(overrides, '3', rows.get('3')!))
    assert.deepEqual(overrides['1'], { fp: 'old title|band|200001', fields: { bpm: '120', genre: 'Jazz' } })
    assert.deepEqual(overrides['2'], { fp: '', fields: { bpm: '90', rating: '5' } }, 'an empty fp stays empty — a skipped entry is not revived')
    assert.deepEqual(overrides['3'], { fp: fpOf(rows.get('3')!), fields: { rating: '5' } })
  })
})

describe('a replica: its stale copy can never beat the hub', () => {
  test('hub-owned fields from the overrides file and the phone overlay are left to the catalog', () => {
    const rows = new Map([row(358, { title: 'F.M.', artist: 'Steely Dan', genre: 'Classic Rock' })])
    const fp = fpOf(rows.get('358')!)
    const { overrides, droppedFields } = replicaOverlay(
      { '358': { fp, fields: { genre: 'Yacht Rock', rating: '5', trackCount: '14', bpm: '101', subgenre: 'Soft Rock' } } },
      { hubFields: HUB_FIELDS, rows, mine: null, hub: null },
    )
    assert.deepEqual(overrides['358'], { fp, fields: { bpm: '101', subgenre: 'Soft Rock' } })
    assert.equal(droppedFields, 3)
  })

  test('its journal puts back the edits Jake made here, until the hub has something newer', () => {
    const rows = new Map([row(1), row(2), row(3)])
    const mine = replicaDoc([[1, 'genre', 'Jazz', SINCE + 1000], [2, 'rating', '5', SINCE + 1000], [3, 'origin', 'Iceland', SINCE + 1000]])
    let hub = recordUserEdit(emptyUserEdits(SINCE), 2, 'rating', '0', SINCE + 2000)                   // MacBook un-starred later
    hub = recordUserEdit(hub, 1, 'genre', 'Jazz', SINCE + 1000, { from: 'workmini' })                   // absorbed
    const { overrides } = replicaOverlay({}, { hubFields: HUB_FIELDS, hubDetailFields: DETAIL, rows, mine, hub })
    assert.equal((overrides['1'] as { fields: Record<string, string> }).fields.genre, 'Jazz')
    assert.equal((overrides['2'] as { fields: Record<string, string> }).fields.rating, '0', 'the hub\'s newer verdict wins (and un-sticks the row)')
    assert.equal((overrides['3'] as { fields: Record<string, string> }).fields.origin, 'Iceland')
    assert.equal((overrides['1'] as { fp: string }).fp, fpOf(rows.get('1')!))
  })

  test('details the catalog carries (origin, subgenre, BPM…) yield to the hub when the hub knows them; a blank never erases', () => {
    const rows = new Map([row(1, { origin: 'Sweden', subgenre: 'Post-Punk' }), row(2)])
    const { overrides } = replicaOverlay(
      {
        '1': { fp: fpOf(rows.get('1')!), fields: { origin: 'Norway', subgenre: 'Shoegaze', bpm: '120' } },
        '2': { fp: fpOf(rows.get('2')!), fields: { origin: 'Iceland' } },
      },
      { hubFields: HUB_FIELDS, hubDetailFields: DETAIL, rows, mine: null, hub: null },
    )
    assert.deepEqual((overrides['1'] as { fields: Record<string, string> }).fields, { bpm: '120' }, 'the hub row has origin + subgenre')
    assert.deepEqual((overrides['2'] as { fields: Record<string, string> }).fields, { origin: 'Iceland' }, 'the hub knows no origin for song 2 — workmini keeps its own')
  })

  test('a hub journal entry alone never overrides the catalog (the catalog already has it, and any newer phone edit)', () => {
    const rows = new Map([row(1), row(2)])
    let hub = recordUserEdit(emptyUserEdits(SINCE), 1, 'origin', 'Sweden', SINCE + 10)
    hub = recordUserEdit(hub, 2, 'genre', 'Folk', SINCE + 10)
    const { overrides } = replicaOverlay({}, { hubFields: HUB_FIELDS, hubDetailFields: DETAIL, rows, mine: null, hub })
    assert.deepEqual(overrides, {})
    // a field the catalog does NOT carry would only arrive this way
    const custom = replicaOverlay({}, { hubFields: new Set(['genre']), rows, mine: null, hub })
    assert.equal((custom.overrides['1'] as { fields: Record<string, string> }).fields.origin, 'Sweden')
  })

  test('the launch-time FULL snapshot cannot undo an edit the hub has not absorbed yet', () => {
    const mine = replicaDoc([[1, 'rating', '5', SINCE + 1000], [1, 'starredAt', String(SINCE + 1000), SINCE + 1000], [2, 'genre', 'Jazz', SINCE + 1000], [3, 'genre', 'Jazz', SINCE + 1000]])
    const hub = recordUserEdit(emptyUserEdits(SINCE), 3, 'genre', 'Folk', SINCE + 5000)   // the MacBook re-edited 3 later
    const upserts = [row(1)[1], row(2)[1], row(3)[1], row(4)[1]] as Array<RowLike & { id: number }>
    const frozen = JSON.stringify(upserts)
    const r = pinPendingEdits(upserts, mine, hub, CARRIED)
    assert.equal(r.pinned, 3)
    assert.equal(r.upserts[0].rating, 5)
    assert.equal(r.upserts[0].starredAt, SINCE + 1000)
    assert.equal(r.upserts[1].genre, 'Jazz')
    assert.equal(r.upserts[2].genre, 'Rock', 'superseded by the MacBook — the hub wins')
    assert.equal(r.upserts[3], upserts[3])
    assert.equal(JSON.stringify(upserts), frozen, 'rows are copied, never mutated')
    assert.equal(pinPendingEdits(upserts, null, hub, CARRIED).pinned, 0)
    // through the real merge: the star Jake set here survives a full snapshot
    const local = [{ ...row(1)[1], rating: 5, starredAt: SINCE + 1000 }] as Array<{ id: number; rating?: number }>
    const merged = mergeHubCatalog(local, { full: true, version: 'v2', upserts: r.upserts.slice(0, 1) as never, removedIds: [] }, { seenIds: ['1'] })
    assert.equal(merged.tracks[0].rating, 5)
    const unpinned = mergeHubCatalog(local, { full: true, version: 'v2', upserts: upserts.slice(0, 1) as never, removedIds: [] }, { seenIds: ['1'] })
    assert.equal(unpinned.tracks[0].rating, 0, 'without the pin the snapshot would have undone it')
  })

  test('live: a newer hub verdict updates the open window once', () => {
    const mine = replicaDoc([[2, 'rating', '5', SINCE + 1000]])
    const prev = emptyUserEdits(SINCE)
    const next = recordUserEdit(prev, 2, 'rating', '0', SINCE + 1001, { from: 'workmini', kept: true })
    assert.deepEqual(replicaLiveUpdates(prev, next, mine, CARRIED), [{ id: '2', field: 'rating', value: '0' }])
    assert.deepEqual(replicaLiveUpdates(next, next, mine, CARRIED), [])
    const absorbed = recordUserEdit(prev, 2, 'rating', '5', SINCE + 1000, { from: 'workmini' })
    assert.deepEqual(replicaLiveUpdates(prev, absorbed, mine, CARRIED), [], 'absorbed = what it already shows')
  })
})
