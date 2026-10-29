/**
 * One genre filer, on the hub only (2026-10-29): a genre filed or chosen on
 * any device shows on every device; a replica (workmini) never runs a
 * competing filer. Plus Jake's ruling on The Avalanches "No Bad Memories".
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeHubCatalog } from '../../common/hub-catalog-merge.ts'
import { replicaOverlay, pinPendingEdits, recordUserEdit, emptyUserEdits, replicaLiveUpdates, type UserEditsDoc } from '../../common/user-edits.ts'
import { HUB_OWNED_FIELDS, HUB_DETAIL_OWNED, HUB_CARRIED_FIELDS } from '../user-edits-sync.ts'
import { filerRole, genreFilerPass, stripReplicaGenres, runReplicaGenreRepair, REPLICA_REPAIR_MARKER } from '../genre-replica.ts'
import { runGenreRulings, RULINGS, RULINGS_MARKER, type GenreRuling } from '../genre-rulings.ts'
import { genreOwner } from '../genre-provenance.ts'
import { isSettled, unfiledUnits, trackFingerprint, type FilerTrack, type CheckEntry, type GenreWhy } from '../genre-filer.ts'
import { GENRE_NAMES } from '../../common/genre-vocab.ts'

type Row = { id: number; title: string; artist: string; album: string; genre: string; duration: number; [k: string]: unknown }
const row = (id: number, artist: string, album: string, genre: string): Row => ({ id, title: `t${id}`, artist, album, genre, duration: 200000 + id })
const fpOf = (r: Row): string => `${r.title.toLowerCase()}|${r.artist.toLowerCase()}|${r.duration}`
const rowsMap = (rows: Row[]) => new Map(rows.map((r) => [String(r.id), r]))

/** What workmini's window shows for a song: the adopted row with its
 *  load-time overlay applied (App.tsx boot overlay; fp-checked). */
function shown(r: Row, overlay: Record<string, unknown>): string {
  const e = overlay[String(r.id)] as { fp?: string; fields?: Record<string, string> } | undefined
  return e?.fields?.genre !== undefined && e.fp === fpOf(r) ? e.fields.genre : r.genre
}

function tmp(): string { return mkdtempSync(join(tmpdir(), 'genre-replica-')) }

describe('a replica takes its genres from the hub', () => {
  it('hub refiles Blond to Alternative R&B → the replica shows it, even with a stale local override', () => {
    const blond = [row(501, 'Frank Ocean', 'Blond', 'R&B'), row(502, 'Frank Ocean', 'Blond', 'R&B')]
    // workmini's overrides file: the stale catch-all, next to a bpm it measured
    const local: Record<string, unknown> = Object.fromEntries(blond.map((r) => [String(r.id), { fp: fpOf(r), fields: { genre: 'R&B', bpm: '92' } }]))
    // the MacBook refiles; the hub's delta carries it
    const merged = mergeHubCatalog(blond, { full: false, version: 'v2', upserts: blond.map((r) => ({ ...r, genre: 'Alternative R&B' })), removedIds: [] }, { seenIds: ['501', '502'] })
    assert.equal(merged.updated, 2)
    const rows = merged.tracks as Row[]
    const ov = replicaOverlay(local, { hubFields: HUB_OWNED_FIELDS, hubDetailFields: HUB_DETAIL_OWNED, rows: rowsMap(rows), mine: null, hub: null })
    for (const r of rows) assert.equal(shown(r, ov.overrides), 'Alternative R&B')
    assert.equal((ov.overrides['501'] as { fields: Record<string, string> }).fields.bpm, '92', 'its own measurements stay')
  })

  it('the replica never runs the filer: no sweep, no corrections, no rulings — only its one-time repair', async () => {
    let hub = 0, replica = 0
    assert.equal(await genreFilerPass({ isReplica: async () => true, hub: async () => { hub++ }, replica: async () => { replica++ } }), 'replica')
    assert.equal(hub, 0); assert.equal(replica, 1)
    assert.equal(await genreFilerPass({ isReplica: async () => false, hub: async () => { hub++ }, replica: async () => { replica++ } }), 'hub')
    assert.equal(hub, 1)
  })

  it('cannot tell → does not write (an error reads as replica); no check = the hub', async () => {
    assert.equal(await filerRole(async () => { throw new Error('settings unreadable') }), 'replica')
    assert.equal(await filerRole(undefined), 'hub')
  })
})

describe("Jake's Get Info on workmini wins", () => {
  const r = row(601, 'Frank Ocean', 'Blond', 'Alternative R&B')
  const mine = recordUserEdit(emptyUserEdits(1), r.id, 'genre', 'Neo-Soul', 2_000, { dur: r.duration })

  it('his edit there beats the hub catalog — at load and against the next full snapshot', () => {
    const ov = replicaOverlay({}, { hubFields: HUB_OWNED_FIELDS, hubDetailFields: HUB_DETAIL_OWNED, rows: rowsMap([r]), mine, hub: null })
    assert.equal(shown(r, ov.overrides), 'Neo-Soul')
    const pinned = pinPendingEdits([{ ...r }], mine, null, HUB_CARRIED_FIELDS)
    assert.equal(pinned.upserts[0].genre, 'Neo-Soul', 'not undone before the hub absorbs it')
  })

  it('the repair keeps his journaled genre and strips only the stale ones', () => {
    const ovr = {
      '601': { fp: fpOf(r), fields: { genre: 'Neo-Soul', rating: '5' } },
      '602': { fp: 'x|y|1', fields: { genre: 'Alternative', bpm: '120' } },
      '603': { fp: 'x|y|2', fields: { bpm: '80' } },
    }
    const s = stripReplicaGenres(ovr, (id) => (id === '601' ? 'Neo-Soul' : undefined))
    assert.equal(s.kept, 1); assert.equal(s.stripped, 1)
    assert.deepEqual((s.next['602'] as { fields: object }).fields, { bpm: '120' })
    assert.deepEqual(s.next['601'], ovr['601'])
    assert.deepEqual(s.next['603'], ovr['603'])
  })

  it('a newer hub edit (a ruling, his edit on the MacBook) beats an older one made here', () => {
    const hub = recordUserEdit(emptyUserEdits(1), r.id, 'genre', 'Alternative R&B', 3_000, { dur: r.duration })
    const ov = replicaOverlay({}, { hubFields: HUB_OWNED_FIELDS, hubDetailFields: HUB_DETAIL_OWNED, rows: rowsMap([r]), mine, hub })
    assert.equal(shown(r, ov.overrides), 'Alternative R&B')
    assert.deepEqual(replicaLiveUpdates(null, hub, mine, HUB_CARRIED_FIELDS), [{ id: '601', field: 'genre', value: 'Alternative R&B' }])
  })
})

describe('the one-time replica repair', () => {
  it('backs up, strips, marks — and a second launch does nothing', async () => {
    const dir = tmp()
    let file: Record<string, unknown> = { '1': { fp: 'a|b|1', fields: { genre: 'Experimental', bpm: '100' } }, '2': { fp: 'c|d|2', fields: { genre: 'Ska-Punk' } } }
    writeFileSync(join(dir, 'metadata-overrides.json'), JSON.stringify(file))
    const deps = {
      userData: dir,
      updateOverrides: async (m: (c: Record<string, unknown>) => Record<string, unknown>) => { file = m(file) },
      journalGenres: async () => new Map([['2', { v: 'Ska-Punk' }]]),
    }
    const r1 = await runReplicaGenreRepair(deps)
    assert.equal(r1.ran, true); assert.equal(r1.stripped, 1); assert.equal(r1.kept, 1)
    assert.deepEqual((file['1'] as { fields: object }).fields, { bpm: '100' })
    assert.ok(readdirSync(dir).some((f) => f.startsWith('metadata-overrides.json.bak-replica-genres-')), 'backup written')
    assert.ok(JSON.parse(readFileSync(join(dir, REPLICA_REPAIR_MARKER), 'utf8')).id)
    file['1'] = { fp: 'a|b|1', fields: { genre: 'Experimental' } }
    const r2 = await runReplicaGenreRepair(deps)
    assert.equal(r2.ran, false)
    assert.equal((file['1'] as { fields: Record<string, string> }).fields.genre, 'Experimental', 'idempotent: never re-runs')
  })
})

describe("Jake's ruling: The Avalanches — No Bad Memories is Mashup", () => {
  it('the table names a shelf on his list, all 31 songs', () => {
    const r = RULINGS.find((x) => x.album === 'No Bad Memories')!
    assert.equal(r.genre, 'Mashup')
    assert.ok(GENRE_NAMES.has('Mashup'))
    assert.equal(r.ids.length, 31)
    assert.deepEqual([r.ids[0], r.ids[2], r.ids[3], r.ids[30]], [12774, 12776, 12882, 12909])
  })

  function harness(tracks: FilerTrack[], check: CheckEntry[] = []) {
    const dir = tmp()
    writeFileSync(join(dir, 'metadata-overrides.json'), '{}')
    const persisted: Array<{ id: number; genre: string; why?: GenreWhy }> = []
    const journal: Array<{ id: number; field: string; value: string }> = []
    const applied: unknown[] = []
    let saved: CheckEntry[] | null = null
    const deps = {
      userData: dir,
      tracks: async () => tracks,
      persist: async (t: FilerTrack, f: Record<string, string>, why?: GenreWhy) => { persisted.push({ id: t.id, genre: f.genre, why }); t.genre = f.genre },
      recordEdit: async (id: number, field: string, value: string) => { journal.push({ id, field, value }) },
      applied: (u: unknown[]) => { applied.push(...u) },
      loadCheck: async () => check,
      saveCheck: async (c: CheckEntry[]) => { saved = c },
      table: { id: 'test-rulings', rulings: [{ artist: 'The Avalanches', album: 'No Bad Memories', ids: [1, 2], genre: 'Mashup', why: 'test' }] as GenreRuling[] },
    }
    return { dir, deps, persisted, journal, applied, saved: () => saved }
  }

  it('files it as his: journaled (the Get Info path), provenance by jake, check list closed, once', async () => {
    const tracks: FilerTrack[] = [
      { id: 1, title: 'a', artist: 'The Avalanches', album: 'No Bad Memories', genre: 'Electronic', duration: 1 },
      { id: 2, title: 'b', artist: 'The Avalanches', album: 'No Bad Memories', genre: 'Experimental', duration: 2 },
      { id: 3, title: 'c', artist: 'The Avalanches', album: 'Wildflower', genre: 'Electronic', duration: 3 },
    ]
    const check: CheckEntry[] = [{ key: 'album:the avalanches|no bad memories', artist: 'The Avalanches', album: 'No Bad Memories', ids: [1, 2], tag: 'Electronic', at: 'x' } as CheckEntry]
    const h = harness(tracks, check)
    const r = await runGenreRulings(h.deps)
    assert.equal(r.ran, true)
    assert.deepEqual(h.persisted.map((p) => [p.id, p.genre, p.why?.by, p.why?.how]), [[1, 'Mashup', 'jake', 'ruling'], [2, 'Mashup', 'jake', 'ruling']])
    assert.deepEqual(h.journal, [{ id: 1, field: 'genre', value: 'Mashup' }, { id: 2, field: 'genre', value: 'Mashup' }])
    assert.equal(tracks[2].genre, 'Electronic', 'another album is untouched')
    assert.equal(h.applied.length, 2)
    assert.deepEqual(h.saved(), [])
    assert.ok(readdirSync(h.dir).some((f) => f.startsWith('metadata-overrides.json.bak-genre-rulings-')))
    assert.ok(readFileSync(join(h.dir, RULINGS_MARKER), 'utf8').includes('test-rulings'))
    const again = await runGenreRulings(h.deps)
    assert.equal(again.ran, false)
    assert.equal(h.persisted.length, 2)
  })

  it('once journaled it is his: the filer never moves it again', () => {
    const fp = 'together|the avalanches|198640'
    assert.equal(genreOwner({ genre: 'Mashup', fp, duration: 198640, inOverrides: true, journal: { v: 'Mashup', at: 5, dur: 198640 } }), 'jake')
    const t: FilerTrack = { id: 12882, title: 'Together', artist: 'The Avalanches', album: 'No Bad Memories', genre: 'Mashup', duration: 198640, genreApproved: true, genreBy: 'jake' }
    assert.ok(isSettled(t))
    assert.deepEqual(unfiledUnits([t]), [])
    assert.equal(trackFingerprint(t), fp)
  })

  it('the replica shows the ruling: hub catalog + hub journal, over an older Electronic typed on workmini', () => {
    const r = { ...row(12882, 'The Avalanches', 'No Bad Memories', 'Electronic') }
    const mine: UserEditsDoc = recordUserEdit(emptyUserEdits(1), r.id, 'genre', 'Electronic', 1_000, { dur: r.duration })
    const hub = recordUserEdit(emptyUserEdits(1), r.id, 'genre', 'Mashup', 9_000, { dur: r.duration })
    const pinned = pinPendingEdits([{ ...r, genre: 'Mashup' }], mine, hub, HUB_CARRIED_FIELDS)
    assert.equal(pinned.upserts[0].genre, 'Mashup', 'his older workmini edit is not pinned over the newer ruling')
    const merged = mergeHubCatalog([r], { full: false, version: 'v', upserts: pinned.upserts, removedIds: [] }, { seenIds: ['12882'] })
    const ov = replicaOverlay({ '12882': { fp: fpOf(r), fields: { genre: 'Experimental' } } }, { hubFields: HUB_OWNED_FIELDS, hubDetailFields: HUB_DETAIL_OWNED, rows: rowsMap(merged.tracks as Row[]), mine, hub })
    assert.equal(shown(merged.tracks[0] as Row, ov.overrides), 'Mashup')
  })
})
