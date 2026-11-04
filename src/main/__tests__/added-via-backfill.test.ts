/**
 * The one-shot share source repair. Every library here is a scratch copy in a
 * temp dir; nothing in this file can reach live data (--library is required,
 * and the app's own path is only ever a fake HOME).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyStamps,
  diffLibraries,
  evidenceFromRecoRows,
  evidenceFromShareLog,
  mergeEvidence,
  planBackfill,
  type LibraryRow,
  type PlannedStamp,
} from '../added-via-backfill.ts'

const row = (over: Partial<LibraryRow> & { id: number }): LibraryRow => ({
  title: `Song ${over.id}`, artist: 'Artist', dateAdded: '2026-11-03T22:00:00.000Z',
  path: `:iPod_Control:Music:F00:imported_${over.id}.m4a`, audioFingerprint: `sha1:${over.id}|1000`, ...over,
})

// The lines homemini really logged on 2026-11-03.
const TILL_ITS_OVER = [
  `2026-11-03T20:14:55.678Z [add-resolve] source=tiktok status=match n=1 q="3DDY Till It's Over" shape=video redirected=yes http=200 stage=page-json author="3DDY" 1792ms`,
  `2026-11-03T20:14:57.604Z [add-request] song "Till It's Over" — 3DDY → reco 3ffe322d-7bd2-465e-957d-2272a6e8b580`,
  `2026-11-03T20:14:57.689Z [reco-download] id=3ffe322d-7bd2-465e-957d-2272a6e8b580 query="3DDY Till It's Over"`,
]

describe('what counts as proof of a share source', () => {
  test('a Listen List row: its via, else its "via <Label>" note; a row with neither is no proof', () => {
    const rows = [
      { id: 'a', song: 'A', artist: 'X', via: 'tiktok', note: 'via TikTok', link: 'https://www.tiktok.com/t/abc/', createdAt: '2026-11-03T20:00:00Z' },
      { id: 'b', song: 'B', artist: 'X', note: 'via Savant', createdAt: '2026-10-30T20:00:00Z' },
      { id: 'c', song: 'C', artist: 'X', note: 'from Dan · great song', createdAt: '2026-11-03T20:00:00Z' },
      { id: 'd', song: 'D', artist: 'X', createdAt: '2026-11-03T20:00:00Z' },
    ]
    const e = evidenceFromRecoRows(rows)
    assert.deepEqual(e.map((x) => [x.recoId, x.key, x.how, x.link]), [['a', 'tiktok', 'via', 'https://www.tiktok.com/t/abc/'], ['b', 'savant', 'note', undefined]])
  })

  test('the share log: the resolve that named the song, right before the add', () => {
    const e = evidenceFromShareLog(TILL_ITS_OVER)
    assert.equal(e.length, 1)
    assert.equal(e[0].recoId, '3ffe322d-7bd2-465e-957d-2272a6e8b580')
    assert.equal(e[0].key, 'tiktok'); assert.equal(e[0].how, 'log')
    assert.ok(e[0].identityKeys.includes(`tillitsover|3ddy`))
  })

  test('the share log refuses what it cannot prove', () => {
    const add = (at: string, title: string, artist: string, reco: string) => `${at} [add-request] song "${title}" — ${artist} → reco ${reco}`
    const reco = (n: number) => `${String(n).repeat(8)}-0000-0000-0000-000000000000`
    // A share given up on, then typed: the last resolve is a typed search, which has no key.
    assert.equal(evidenceFromShareLog([
      `2026-10-29T16:34:26.322Z [add-resolve] source=tiktok status=choose n=3 q="LOVE SONG" 832ms`,
      `2026-10-29T16:34:32.923Z [add-resolve] source=text status=choose n=3 q="haywire" 413ms`,
      add('2026-10-29T16:34:39.341Z', 'HAYWIRE', 'Haywire 617', reco(1)),
    ]).length, 0)
    // An add whose song the resolve never named (Savant logs no resolve of its own).
    assert.equal(evidenceFromShareLog([
      `2026-10-30T22:17:00.000Z [add-resolve] source=tiktok status=match n=1 q="The Doors An American Prayer" 500ms`,
      add('2026-10-30T22:17:38.000Z', 'Johnny And Mary', 'Robert Palmer', reco(2)),
    ]).length, 0)
    // Too long after the sheet to be the same share.
    assert.equal(evidenceFromShareLog([
      `2026-10-30T22:00:00.000Z [add-resolve] source=tiktok status=match n=1 q="Robert Palmer Johnny And Mary" 500ms`,
      add('2026-10-30T22:03:00.000Z', 'Johnny And Mary', 'Robert Palmer', reco(3)),
    ]).length, 0)
    // A sheet that found nothing produced nothing.
    assert.equal(evidenceFromShareLog([
      `2026-10-30T22:00:00.000Z [add-resolve] source=tiktok status=unresolvable n=0 q="Robert Palmer Johnny And Mary" 500ms`,
      add('2026-10-30T22:00:10.000Z', 'Johnny And Mary', 'Robert Palmer', reco(4)),
    ]).length, 0)
    // One sheet, one add: the second song needs its own resolve.
    assert.deepEqual(evidenceFromShareLog([
      `2026-10-29T21:28:02.248Z [add-resolve] source=instagram status=choose n=2 q="Noah Parks" 1458ms`,
      add('2026-10-29T21:28:05.443Z', 'Fucking It Up', 'Noah Parks', reco(5)),
      add('2026-10-29T21:28:15.000Z', 'Another', 'Noah Parks', reco(6)),
    ]).map((x) => [x.recoId, x.key]), [[reco(5), 'instagram']])
  })

  test('an "(already listed)" re-add keeps the first time it was shared', () => {
    const id = 'd995974f-ebfb-4f60-82a9-9addac170ca2'
    const e = evidenceFromShareLog([
      `2026-11-03T21:11:58.024Z [add-resolve] source=tiktok status=match n=1 q="Chalk Bliss" 954ms`,
      `2026-11-03T21:12:01.081Z [add-request] song "Bliss" — Chalk → reco ${id}`,
      `2026-11-03T22:46:49.000Z [add-resolve] source=tiktok status=match n=1 q="Chalk Bliss" 954ms`,
      `2026-11-03T22:46:50.558Z [add-request] song "Bliss" — Chalk → reco ${id} (already listed)`,
    ])
    assert.deepEqual(e.map((x) => x.createdAt), ['2026-11-03T21:12:01.081Z'])
  })

  test('one record per Listen List row: the strongest proof, every name it went by', () => {
    const merged = mergeEvidence(
      evidenceFromRecoRows([{ id: 'r', song: 'Bliss', artist: 'Chalk', matchedTitle: 'Bliss (feat. Fears)', matchedArtist: 'Chalk', via: 'tiktok', link: 'https://www.tiktok.com/t/x/', createdAt: '2026-11-03T21:12:00Z' }]),
      [{ recoId: 'r', key: 'tiktok', how: 'log', createdAt: '2026-11-03T21:12:01Z', identityKeys: ['bliss|chalk'] }],
    )
    assert.equal(merged.length, 1)
    assert.equal(merged[0].how, 'via'); assert.equal(merged[0].link, 'https://www.tiktok.com/t/x/')
    assert.ok(merged[0].identityKeys.includes('blissfeatfears|chalk'))
  })
})

describe('the plan', () => {
  const evidence = mergeEvidence(evidenceFromRecoRows([
    { id: 'bug', song: "Till It's Over", artist: '3DDY', via: 'tiktok', link: 'https://www.tiktok.com/t/x/', createdAt: '2026-11-03T20:14:56Z' },
    { id: 'old', song: 'Pins', artist: 'Gurriers', note: 'via TikTok', link: 'https://www.tiktok.com/t/y/', createdAt: '2026-10-30T14:19:51Z' },
    { id: 'owned', song: 'expectations', artist: 'Olivia Rodrigo & Chappell Roan', matchedTitle: 'expectations', matchedArtist: 'Olivia Rodrigo & Chappell Roan', note: 'via TikTok', createdAt: '2026-10-31T05:09:23Z' },
    { id: 'matched', song: 'Good Times', artist: 'Nite Music', matchedTitle: 'Good Times (Late Nite Tuff Guy Remix) [feat. Boris G. Jennings]', matchedArtist: 'Ferry Ultra', note: 'via TikTok', createdAt: '2026-10-31T15:37:31Z' },
    { id: 'tt', song: 'Twice', artist: 'Both', via: 'tiktok', createdAt: '2026-11-01T00:00:00Z' },
    { id: 'sv', song: 'Twice', artist: 'Both', via: 'savant', createdAt: '2026-11-02T00:00:00Z' },
  ]), evidenceFromShareLog([
    `2026-10-29T21:45:14.042Z [add-resolve] source=tiktok status=match n=1 q="Modest Mouse Paper Thin Walls" 1022ms`,
    `2026-10-29T21:45:16.265Z [add-request] song "Paper Thin Walls" — Modest Mouse → reco 66837c5c-2324-47d3-8178-78a46952a029`,
  ]))
  const tracks = [
    row({ id: 13919, title: "Till It's Over", artist: '3ddy', source: 'streamrip', dateAdded: '2026-11-03T22:49:29.147Z' }),
    row({ id: 13918, title: 'Canned Heat', artist: 'Jamiroquai', source: 'streamrip', dateAdded: '2026-11-03T22:49:03.251Z' }),
    row({ id: 13509, title: 'Pins', artist: 'Gurriers', dateAdded: '2026-10-30T14:20:10.000Z' }),
    row({ id: 13461, title: 'Paper Thin Walls', artist: 'Modest Mouse', dateAdded: '2026-10-29T21:45:22.000Z' }),
    row({ id: 8573, title: 'expectations', artist: 'Olivia Rodrigo', source: 'streamrip', dateAdded: '2026-06-12T18:55:43.000Z' }),
    row({ id: 13586, title: 'expectations (feat. Chappell Roan)', artist: 'Olivia Rodrigo', dateAdded: '2026-10-31T05:09:30.000Z' }),
    row({ id: 13589, title: 'Good Times (Late Nite Tuff Guy Remix)', artist: 'Ferry Ultra', dateAdded: '2026-10-31T15:37:40.000Z' }),
    row({ id: 13915, title: 'Pins', artist: 'Gurriers', addedVia: 'tiktok', dateAdded: '2026-11-03T22:30:39.000Z' }),
    row({ id: 20000, title: 'Twice', artist: 'Both', dateAdded: '2026-11-03T00:00:00.000Z' }),
  ]
  const { stamps, excluded } = planBackfill(tracks, evidence)
  const byId = new Map(stamps.map((s) => [s.id, s]))

  test('a desktop download of a shared row is the bug, stamped with the phone\'s key', () => {
    const s = byId.get(13919)!
    assert.equal(s.addedVia, 'tiktok'); assert.equal(s.group, 'desktop')
    assert.equal(s.evidence.recoId, 'bug'); assert.equal(s.evidence.link, 'https://www.tiktok.com/t/x/')
  })
  test('phone imports from before the stamp are told apart by how strong the proof is', () => {
    assert.equal(byId.get(13509)!.group, 'phone-listed')
    assert.equal(byId.get(13461)!.group, 'phone-log')
  })
  test('credits are forgiven when finding: "A & B" on the share, "(feat. B)" on the row, "[feat. C]" on the iTunes match', () => {
    assert.equal(byId.get(13586)!.addedVia, 'tiktok')
    assert.equal(byId.get(13589)!.addedVia, 'tiktok')
    assert.equal(byId.get(13589)!.evidence.recoId, 'matched')
  })
  test('a different song by the same artist is never a match', () => {
    const none = planBackfill([row({ id: 1, title: 'Good Times', artist: 'Chic' }), row({ id: 2, title: 'Bad Times', artist: 'Ferry Ultra' })], evidence)
    assert.deepEqual(none.stamps, [])
  })
  test('a song with no share on record is never touched (Canned Heat, same desktop batch)', () => {
    assert.equal(byId.has(13918), false)
    assert.equal(excluded.some((x) => x.id === 13918), false)
  })
  test('a row older than the share was already owned: the share did not bring it in', () => {
    assert.equal(byId.has(8573), false)
    assert.deepEqual(excluded.find((x) => x.id === 8573), { id: 8573, title: 'expectations', artist: 'Olivia Rodrigo', reason: 'already-owned', keys: ['tiktok'] })
  })
  test('two shares with different sources: left out, not guessed', () => {
    assert.equal(byId.has(20000), false)
    assert.equal(excluded.find((x) => x.id === 20000)?.reason, 'ambiguous')
  })
  test('a row that already has a source is not a candidate', () => {
    assert.equal(byId.has(13915), false)
  })
})

describe('the write gate', () => {
  const lib = { tracks: [row({ id: 1, source: 'streamrip' }), row({ id: 2 })], playlists: [{ id: 'p', name: 'List' }] }
  const stamp = (over: Partial<PlannedStamp> & { id: number }): PlannedStamp => {
    const t = lib.tracks.find((x) => x.id === over.id)!
    return { title: t.title!, artist: t.artist!, dateAdded: t.dateAdded!, path: t.path, audioFingerprint: t.audioFingerprint, addedVia: 'tiktok', group: 'desktop', evidence: { recoId: 'r', how: 'via', sharedAt: '2026-11-03T00:00:00Z' }, ...over }
  }

  test('only the named row changes, and only by addedVia', () => {
    const r = applyStamps(lib, [stamp({ id: 1 })])
    assert.deepEqual(r.refused, [])
    assert.deepEqual(r.changed.map((c) => [c.id, c.addedVia]), [[1, 'tiktok']])
    assert.deepEqual(r.library.tracks[0], { ...lib.tracks[0], addedVia: 'tiktok' })
    assert.equal(r.library.tracks[1], lib.tracks[1], 'every other row is the same object')
    assert.equal(lib.tracks[0].addedVia, undefined, 'the input is not mutated')
    assert.deepEqual(diffLibraries(lib, r.library), { changedIds: [1], problems: [] })
  })
  test('a row that is not the one reviewed is refused, field by field', () => {
    for (const field of ['title', 'artist', 'dateAdded', 'path', 'audioFingerprint'] as const) {
      const r = applyStamps(lib, [stamp({ id: 1, [field]: 'something else' })])
      assert.equal(r.changed.length, 0, field)
      assert.match(r.refused[0].why, new RegExp(`^${field} changed since the plan`))
    }
    assert.equal(applyStamps(lib, [stamp({ id: 2, addedVia: 'tiktok', path: lib.tracks[0].path })]).refused.length, 1, 'the id alone is not enough')
  })
  test('an id the library no longer has is refused', () => {
    const r = applyStamps(lib, [{ ...stamp({ id: 1 }), id: 99 }])
    assert.deepEqual(r.refused, [{ id: 99, why: 'no row with this id' }])
  })
  test('a key the phone would not stamp is refused', () => {
    for (const addedVia of ['text', 'TikTok', 'not a key!', '']) assert.equal(applyStamps(lib, [stamp({ id: 1, addedVia })]).refused.length, 1, addedVia)
  })
  test('the same stamp twice is a no-op; a different one is refused', () => {
    const once = applyStamps(lib, [stamp({ id: 1 })]).library
    const again = applyStamps(once, [stamp({ id: 1 })])
    assert.deepEqual(again.already, [1]); assert.deepEqual(again.changed, [])
    assert.match(applyStamps(once, [stamp({ id: 1, addedVia: 'savant' })]).refused[0].why, /already stamped "tiktok"/)
  })
  test('the proof catches any change that is not a new addedVia', () => {
    const edited = { ...lib, tracks: [{ ...lib.tracks[0], addedVia: 'tiktok', title: 'Edited' }, lib.tracks[1]] }
    assert.deepEqual(diffLibraries(lib, edited).problems, ['row 1: more than addedVia differs'])
    const dropped = { ...lib, tracks: [lib.tracks[0]] }
    assert.deepEqual(diffLibraries(lib, dropped).problems, ['row count 2 → 1'])
    const playlists = { ...lib, playlists: [] }
    assert.deepEqual(diffLibraries(lib, playlists).problems, ['top-level "playlists" differs'])
  })
})

describe('scripts/backfill-added-via.ts, on a scratch copy', () => {
  const SCRIPT = join(import.meta.dirname, '../../../scripts/backfill-added-via.ts')

  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'jt-backfill-'))
    const library = join(dir, 'library.json')
    const tracks = [
      row({ id: 13916, title: 'Bliss', artist: 'Chalk', source: 'streamrip', dateAdded: '2026-11-03T22:47:59.654Z' }),
      row({ id: 13918, title: 'Canned Heat', artist: 'Jamiroquai', source: 'streamrip', dateAdded: '2026-11-03T22:49:03.251Z' }),
      row({ id: 13919, title: "Till It's Over", artist: '3ddy', source: 'streamrip', dateAdded: '2026-11-03T22:49:29.147Z' }),
    ]
    writeFileSync(library, JSON.stringify({ tracks, playlists: [{ id: 'p', name: 'List', trackIds: [13916] }] }, null, 2))
    const snapshots = join(dir, 'snapshots')
    mkdirSync(snapshots)
    writeFileSync(join(snapshots, 'recommendations_1.json'), JSON.stringify([
      { id: 'r-bliss', song: 'Bliss', artist: 'Chalk', via: 'tiktok', link: 'https://www.tiktok.com/t/x/', createdAt: '2026-11-03T21:12:00Z' },
    ]))
    const log = join(dir, 'share.log')
    writeFileSync(log, TILL_ITS_OVER.join('\n'))
    return { dir, library, snapshots, log, plan: join(dir, 'plan.json') }
  }
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  const planFor = (s: ReturnType<typeof scratch>) => {
    const r = run(['--library', s.library, '--snapshots', s.snapshots, '--log', s.log, '--plan-out', s.plan])
    assert.equal(r.status, 0, r.stderr)
    return r
  }

  test('no --library, no run: there is no default that reaches live data', () => {
    const home = mkdtempSync(join(tmpdir(), 'jt-backfill-home-'))   // so a default added later still could not
    for (const args of [[], ['--commit']]) {
      const r = run(args, { HOME: home })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /Pass --library/)
    }
  })

  test('the plan names the rows and the proof, and writes nothing to the library', () => {
    const s = scratch()
    const before = readFileSync(s.library, 'utf8')
    const r = planFor(s)
    assert.match(r.stdout, /13916 {2}tiktok/); assert.match(r.stdout, /13919 {2}tiktok/)
    assert.doesNotMatch(r.stdout, /13918/)
    assert.equal(readFileSync(s.library, 'utf8'), before)
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith('.bak')), [])
  })

  test('--commit writes only the ids named: one added line per row, a byte-identical backup, and it is safe to run again', () => {
    const s = scratch()
    const before = readFileSync(s.library, 'utf8')
    planFor(s)
    const r = run(['--library', s.library, '--plan', s.plan, '--ids', '13916', '--commit'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /13916 {2}addedVia: \(none\) → tiktok {2}Bliss — Chalk/)

    const after = JSON.parse(readFileSync(s.library, 'utf8'))
    assert.equal(after.tracks[0].addedVia, 'tiktok')
    assert.equal('addedVia' in after.tracks[1], false, 'Canned Heat')
    assert.equal('addedVia' in after.tracks[2], false, 'on the plan, but not named')

    const oldLines = before.split('\n'), newLines = readFileSync(s.library, 'utf8').split('\n')
    assert.equal(newLines.length, oldLines.length + 1)
    assert.deepEqual(newLines.filter((l) => l.includes('addedVia')), ['      "addedVia": "tiktok"'])

    const backups = readdirSync(s.dir).filter((f) => f.endsWith('.bak'))
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(s.dir, backups[0]), 'utf8'), before)

    const again = run(['--library', s.library, '--plan', s.plan, '--ids', '13916', '--commit'])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /Nothing to do/)
    assert.equal(readdirSync(s.dir).filter((f) => f.endsWith('.bak')).length, 1, 'no second backup, no second write')
  })

  test('--commit needs ids that are on the plan', () => {
    const s = scratch()
    const before = readFileSync(s.library, 'utf8')
    planFor(s)
    assert.equal(run(['--library', s.library, '--plan', s.plan, '--commit']).status, 2)
    assert.equal(run(['--library', s.library, '--ids', '13916', '--commit']).status, 2)
    assert.equal(run(['--library', s.library, '--plan', s.plan, '--ids', '13918', '--commit']).status, 1, 'Canned Heat is not on the plan')
    assert.equal(readFileSync(s.library, 'utf8'), before)
  })

  test('a row edited since the plan refuses the whole write', () => {
    const s = scratch()
    planFor(s)
    const lib = JSON.parse(readFileSync(s.library, 'utf8'))
    lib.tracks[2].title = 'Till It’s Over (fixed in Get Info)'
    const edited = JSON.stringify(lib, null, 2)
    writeFileSync(s.library, edited)
    const r = run(['--library', s.library, '--plan', s.plan, '--ids', '13916,13919', '--commit'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /13919: title changed since the plan/)
    assert.equal(readFileSync(s.library, 'utf8'), edited, '13916 was fine, and it still was not written')
  })

  test('the app\'s own library.json goes through the Brief 165 gate: refused while the app runs', () => {
    const s = scratch()
    planFor(s)
    const home = join(s.dir, 'home')
    const appDir = join(home, 'Library/Application Support/JakeTunes')
    mkdirSync(appDir, { recursive: true })
    const appLibrary = join(appDir, 'library.json')
    const before = readFileSync(s.library, 'utf8')
    writeFileSync(appLibrary, before)
    const bin = join(s.dir, 'bin')
    mkdirSync(bin)
    const fakePgrep = (code: number) => { writeFileSync(join(bin, 'pgrep'), `#!/bin/sh\nexit ${code}\n`); chmodSync(join(bin, 'pgrep'), 0o755) }
    const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` }

    fakePgrep(0)   // the app is running
    const refused = run(['--library', appLibrary, '--plan', s.plan, '--ids', '13916', '--commit'], env)
    assert.equal(refused.status, 3, refused.stderr)
    assert.equal(readFileSync(appLibrary, 'utf8'), before)

    // A scratch copy is not the app's file, so the gate does not apply to it.
    assert.equal(run(['--library', s.library, '--plan', s.plan, '--ids', '13916', '--commit'], env).status, 0)

    fakePgrep(1)   // the app is quit
    const ok = run(['--library', appLibrary, '--plan', s.plan, '--ids', '13916', '--commit'], env)
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(JSON.parse(readFileSync(appLibrary, 'utf8')).tracks[0].addedVia, 'tiktok')
  })
})
