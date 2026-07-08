// Brief 126 — sync protocol v2: identity parity + the pure merge engine.
//
// ⚠️ TWIN FIXTURES: PARITY_FIXTURES is copy-shared VERBATIM with the backend
// suite (~/JakeTunesMobile/backend/src/util/__tests__/reco-identity.test.ts).
// If you change a fixture here, change it there in the same sitting — drift
// between the suites means the two repos disagree about what "the same song"
// means, which is exactly the bug class the identity module exists to kill.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECO_IDENTITY_PREFIX,
  isTombstonedRecord,
  pickBetterReco,
  recoDedupeKey,
  recordIdentityKeys,
} from '../reco-match.ts'
import { computeMirror, computeNasFallback, identitiesForDelete, type RecoSyncRow } from '../reco-sync.ts'
import { parseOutbox, scrubOutboxAgainstBackend, scrubOutboxForDelete, type RecoOutboxOp } from '../reco-outbox.ts'

// ── PARITY FIXTURES (shared verbatim with the backend suite) ──────────────
const PARITY_FIXTURES: Array<{ name: string; record: Record<string, string | undefined>; keys: string[] }> = [
  {
    name: 'plain pair',
    record: { song: "Can't Stop Playing", artist: 'Dr. Kucho' },
    keys: ['cantstopplaying|drkucho'],
  },
  {
    name: 'raw + canonical pairs',
    record: {
      song: 'Move Bitch (feat. Ludacris)', artist: 'Disturbing tha Peace',
      matchedTitle: 'Move Bitch', matchedArtist: 'Ludacris',
    },
    keys: ['movebitchfeatludacris|disturbingthapeace', 'movebitch|ludacris'],
  },
  {
    name: 'artist-less jot → solo key only',
    record: { song: 'Grateful Dead Nassau 1980 may 15 and 16' },
    keys: ['solo:gratefuldeadnassau1980may15and16~~'],
  },
  {
    name: 'artist-less with album + note folds both into solo',
    record: { song: 'Angel', album: 'Mezzanine', note: 'the dark one' },
    keys: ['solo:angel~mezzanine~thedarkone'],
  },
  {
    name: 'concert with archive.org id → ext strongest, solo still emitted',
    record: { song: 'Grateful Dead Nassau 1980', externalId: 'gd1980-05-15.nassau.sbd' },
    keys: ['ext:gd19800515nassausbd', 'solo:gratefuldeadnassau1980~~'],
  },
  {
    name: 'matched artist closes the solo gate',
    record: { song: 'Angel', matchedTitle: 'Angel', matchedArtist: 'Massive Attack' },
    keys: ['angel|massiveattack'],
  },
  {
    name: 'note-only jot has no identity keys',
    record: { note: 'check that band from the party' },
    keys: [],
  },
]

test('parity fixtures: recordIdentityKeys matches the backend byte-for-byte', () => {
  for (const f of PARITY_FIXTURES) {
    assert.deepEqual(recordIdentityKeys(f.record), f.keys, f.name)
  }
})

test('solo isolation + dedupe fallback + pickBetterReco', () => {
  const solo = recordIdentityKeys({ song: 'Angel' })
  const pair = recordIdentityKeys({ song: 'Angel', artist: 'Massive Attack' })
  assert.deepEqual(solo.filter((k) => pair.includes(k)), [])
  assert.equal(recoDedupeKey({ song: 'X', artist: 'Y' }), 'x|y')
  assert.equal(recoDedupeKey({ note: 'just a note' }), 'full:|||justanote')
  const resolved = { id: 'a', createdAt: '2026-01-01', matchedTitle: 'T', resolvedAt: '2026-01-01' }
  const newer = { id: 'b', createdAt: '2026-06-01' }
  assert.equal(pickBetterReco(resolved, newer).id, 'a')
})

test('isTombstonedRecord blocks by id, pair, solo, and ext entries', () => {
  const r = { id: 'u1', song: 'Song', artist: 'Band' }
  assert.ok(isTombstonedRecord(new Set(['u1']), r))
  assert.ok(isTombstonedRecord(new Set([`${RECO_IDENTITY_PREFIX}song|band`]), r))
  assert.ok(isTombstonedRecord(new Set([`${RECO_IDENTITY_PREFIX}solo:nassau1980~~`]), { id: 'u2', song: 'Nassau 1980' }))
  assert.ok(isTombstonedRecord(new Set([`${RECO_IDENTITY_PREFIX}ext:gd80sbd`]), { id: 'u3', song: 'Show', externalId: 'gd80.sbd' }))
})

// ── The merge engine ───────────────────────────────────────────────────────
const row = (id: string, song: string, artist?: string, extra: Partial<RecoSyncRow> = {}): RecoSyncRow =>
  ({ id, song, artist, createdAt: '2026-07-01', ...extra })

test('H1 REGRESSION: a local row absent from the backend and the outbox is DROPPED, never re-added', () => {
  // The resurrection disease: phone deletes a song; the desktop's cache still
  // has it; the old sync re-POSTed it as an "offline add". computeMirror must
  // drop it silently — absence on the backend means deleted.
  const local = [row('a', 'Deleted On Phone', 'Ghost Band'), row('b', 'Still Alive', 'Real Band')]
  const backend = [row('b', 'Still Alive', 'Real Band')]
  const { merged, dupeDeleteIds } = computeMirror({ backend, local, ops: [] })
  assert.deepEqual(merged.map((r) => r.id), ['b'])
  assert.deepEqual(dupeDeleteIds, [])
})

test('computeMirror: outbox-pending adds survive; pending deletes filter re-minted backend rows by identity', () => {
  const ops: RecoOutboxOp[] = [
    { op: 'add', localId: 'temp1', input: { song: 'Offline Add', artist: 'New Band' }, identities: ['offlineadd|newband'], queuedAt: '' },
    { op: 'delete', ids: ['old-uuid'], identities: ['killed|band'], queuedAt: '' },
  ]
  const local = [row('temp1', 'Offline Add', 'New Band')]
  // backend re-minted the killed song under a FRESH uuid — identity must still filter it
  const backend = [row('fresh-uuid', 'Killed', 'Band')]
  const { merged } = computeMirror({ backend, local, ops })
  assert.deepEqual(merged.map((r) => r.id).sort(), ['temp1'])
})

test('computeMirror: local enrichment overlays the backend row by id; identity dupes heal id-only', () => {
  const backendRow = row('x', 'Song', 'Band')
  const localEnriched = row('x', 'Song', 'Band', { matchedTitle: 'Song', matchedArtist: 'Band', resolvedAt: '2026-07-01' })
  const dupe = row('y', 'Song', 'Band', { createdAt: '2026-06-01' })
  const { merged, dupeDeleteIds } = computeMirror({ backend: [backendRow, dupe], local: [localEnriched], ops: [] })
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'x')
  assert.ok(merged[0].resolvedAt, 'kept the enriched local copy')
  assert.deepEqual(dupeDeleteIds, ['y'])
})

test('computeNasFallback: live NAS tombstones gate every shape (id, pair, solo)', () => {
  const local: RecoSyncRow[] = []
  const nas = [
    row('n1', 'Tombstoned By Id', 'Band'),
    row('n2', 'Tombstoned Pair', 'Band'),
    row('n3', 'Nassau 1980'),                    // artist-less, solo-tombstoned
    row('n4', 'Genuinely New', 'Fresh Band'),
  ]
  const nasTombstones = new Set([
    'n1',
    'identity:tombstonedpair|band',
    'identity:solo:nassau1980~~',
  ])
  const incoming = computeNasFallback({ local, nas, nasTombstones, ops: [] })
  assert.deepEqual(incoming.map((r) => r.id), ['n4'])
})

test('identitiesForDelete dooms every same-song row and yields the wire keys', () => {
  const target = row('a', 'Song', 'Band')
  const all = [target, row('b', 'Song!', 'BAND', { createdAt: '2026-06-01' }), row('c', 'Other', 'Band')]
  const { doomedIds, identities } = identitiesForDelete(target, all)
  assert.deepEqual(doomedIds.sort(), ['a', 'b'])
  assert.deepEqual(identities, ['song|band'])
})

// ── Outbox: v1 back-compat + reset scrub ──────────────────────────────────
test('parseOutbox accepts legacy single-identity ops and the v2 identities[] shape', () => {
  const legacy = [
    { op: 'add', localId: 'l1', input: { song: 'A' }, identity: 'a|b', queuedAt: 't' },
    { op: 'delete', ids: ['x'], identity: null, queuedAt: 't' },
  ]
  const parsed = parseOutbox(legacy)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0].identities, ['a|b'])
  assert.deepEqual(parsed[1].identities, [])
  const v2 = parseOutbox([{ op: 'delete', ids: ['y'], identities: ['k1', 'k2'], queuedAt: 't' }])
  assert.deepEqual(v2[0].identities, ['k1', 'k2'])
})

test('scrubOutboxForDelete cancels queued adds by ANY shared identity key', () => {
  const ops: RecoOutboxOp[] = [
    { op: 'add', localId: 'l1', input: { song: 'S' }, identities: ['s|b', 'solo:s~~'], queuedAt: '' },
  ]
  const { ops: kept, remoteIds } = scrubOutboxForDelete(ops, ['l1'], ['solo:s~~'])
  assert.equal(kept.length, 0)
  assert.deepEqual(remoteIds, [])
})

test('scrubOutboxAgainstBackend drops tombstoned/live-dupe adds, keeps novel adds and all deletes', () => {
  const ops: RecoOutboxOp[] = [
    { op: 'add', localId: 'a1', input: { song: 'Tombstoned' }, identities: ['tombstoned|band'], queuedAt: '' },
    { op: 'add', localId: 'a2', input: { song: 'Already Live' }, identities: ['alreadylive|band'], queuedAt: '' },
    { op: 'add', localId: 'a3', input: { song: 'Novel' }, identities: ['novel|band'], queuedAt: '' },
    { op: 'delete', ids: ['d1'], identities: ['whatever|band'], queuedAt: '' },
  ]
  const { ops: kept, dropped } = scrubOutboxAgainstBackend(
    ops,
    new Set(['alreadylive|band']),
    new Set(['identity:tombstoned|band']),
  )
  assert.deepEqual(kept.map((o) => (o.op === 'add' ? o.localId : 'del')), ['a3', 'del'])
  assert.equal(dropped.length, 2)
})
