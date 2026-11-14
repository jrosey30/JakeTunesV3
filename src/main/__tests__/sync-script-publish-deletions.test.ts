/**
 * The guarded library publish and a song Jake deleted (2026-11-12).
 *
 * Jake, away from home: "i am missing 6 songs on workmini". He had deleted
 * a duplicate "Save Yourself" (id 15122, added that day) on the laptop.
 * The publish guard on homemini read the missing song as one the laptop
 * "has never seen" and refused every publish after it, so an album
 * imported three minutes later never reached homemini, the phone or
 * workmini. At home the save-time NAS mirror carries a deletion round the
 * guard; away there is no NAS.
 *
 * This runs the guard's own Python, cut out of the sync script, with real
 * python3 in a folder laid out like homemini's ~/JakeTunesState. No ssh,
 * no network.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh')

/** The Python the script sends to homemini for the library publish. */
function guardSource(): string {
  const src = readFileSync(SCRIPT, 'utf8')
  const fn = src.indexOf('publish_backend_library() {')
  assert.ok(fn > 0, 'publish_backend_library is in the script')
  const open = 'python3 - <<"EOF"\n'
  const start = src.indexOf(open, fn)
  const end = src.indexOf("\nEOF'", start)
  assert.ok(start > fn && end > start, 'the guard heredoc is where it was')
  const py = src.slice(start + open.length, end)
  // The text sits inside a single-quoted ssh argument: one apostrophe ends it.
  assert.equal(py.includes("'"), false, 'no apostrophe inside the quoted remote script')
  return py
}

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

interface Row { id: number; title: string; dateAdded: string; audioFingerprint?: string }
const row = (id: number, title: string, msAgo: number, fp: string | null = `fp-${id}`): Row =>
  ({ id, title, dateAdded: iso(msAgo), ...(fp ? { audioFingerprint: fp } : {}) })
const tomb = (fp: string, msAgo: number, id = '0') =>
  ({ id, audioFingerprint: fp, title: 'x', artist: 'y', durationMs: 1000, deletedAt: iso(msAgo) })

const OLD = [row(1, 'Old One', 200 * DAY), row(2, 'Old Two', 90 * DAY)]
// What homemini held on 2026-11-12: the duplicate, added three hours ago.
const DUPLICATE = row(15122, 'Save Yourself', 3 * 60 * 60 * 1000, 'dc6b107e')
// What the laptop had by then: the duplicate deleted, an album imported after.
const ALBUM = [row(15128, 'Shackled By Lust', 2 * 60 * 60 * 1000), row(15129, 'Egoismus', 2 * 60 * 60 * 1000)]

interface Outcome { out: string; err: string; served: Row[] }

function publish(opts: { homemini: Row[]; incoming: Row[]; tombstones?: unknown; tombstonesRaw?: string }): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'jt-publish-deletions-'))
  try {
    writeFileSync(join(dir, 'library.json'), JSON.stringify({ tracks: opts.homemini }))
    writeFileSync(join(dir, '.library.json.incoming'), JSON.stringify({ tracks: opts.incoming }))
    if (opts.tombstonesRaw !== undefined) writeFileSync(join(dir, 'track-tombstones.json'), opts.tombstonesRaw)
    else if (opts.tombstones !== undefined) writeFileSync(join(dir, 'track-tombstones.json'), JSON.stringify(opts.tombstones))
    const r = spawnSync('python3', ['-'], { cwd: dir, input: guardSource(), encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(dir, 'library.json')))
    return {
      out: r.stdout.trim(),
      err: r.stderr.trim(),
      served: JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')).tracks,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
}

const ids = (rows: Row[]) => rows.map((r) => r.id)

describe('guarded publish: a song Jake deleted does not hold the library back', () => {
  it('2026-11-12: the deleted duplicate leaves and the new album arrives', () => {
    const r = publish({
      homemini: [...OLD, DUPLICATE],
      incoming: [...OLD, ...ALBUM],
      tombstones: { v: 1, tombstones: [tomb('dc6b107e', 2.9 * 60 * 60 * 1000, '15122')] },
    })
    assert.equal(r.out, 'published 4')
    assert.deepEqual(ids(r.served), [1, 2, 15128, 15129])
    assert.match(r.err, /1 song\(s\) Jake deleted left homemini with this copy \(Save Yourself\)/)
  })

  it('a bare-array tombstone file counts too', () => {
    const r = publish({ homemini: [...OLD, DUPLICATE], incoming: [...OLD, ...ALBUM], tombstones: [tomb('dc6b107e', 60_000)] })
    assert.equal(r.out, 'published 4')
  })

  it('deleting the newest song publishes too', () => {
    const r = publish({ homemini: [...OLD, DUPLICATE], incoming: OLD, tombstones: { v: 1, tombstones: [tomb('dc6b107e', 60_000)] } })
    assert.equal(r.out, 'published 2')
    assert.deepEqual(ids(r.served), [1, 2])
  })
})

describe('guarded publish: everything the guard refused before, it still refuses', () => {
  const refusedAndKept = (r: Outcome, held: Row[]) => {
    assert.match(r.out, /^refused-/)
    assert.deepEqual(ids(r.served), ids(held), 'homemini keeps its own copy')
    assert.equal(r.err, '')
  }

  it('no deletion on record: a recent song the copy lacks refuses, by name (Brief 197)', () => {
    const held = [...OLD, DUPLICATE]
    const r = publish({ homemini: held, incoming: [...OLD, ...ALBUM] })
    assert.equal(r.out, 'refused-recent 1 Save Yourself')
    refusedAndKept(r, held)
  })

  it('a stale copy is still stale (2026-10-05)', () => {
    const held = [...OLD, DUPLICATE]
    const r = publish({ homemini: held, incoming: OLD })
    assert.equal(r.out, 'refused-stale 1')
    refusedAndKept(r, held)
  })

  it('a deletion of some other song excuses nothing', () => {
    const held = [...OLD, DUPLICATE]
    refusedAndKept(publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstones: { v: 1, tombstones: [tomb('another-fp', 60_000, '15122')] } }), held)
  })

  it('a deletion is matched by fingerprint, never by id: a row with no fingerprint is not excused', () => {
    const held = [...OLD, row(15122, 'Save Yourself', 3 * 60 * 60 * 1000, null)]
    refusedAndKept(publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstones: { v: 1, tombstones: [tomb('dc6b107e', 60_000, '15122')] } }), held)
  })

  it('a song added again after its deletion is a song, not a deletion', () => {
    const held = [...OLD, DUPLICATE]   // added 3 h ago
    refusedAndKept(publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstones: { v: 1, tombstones: [tomb('dc6b107e', 5 * 60 * 60 * 1000)] } }), held)
  })

  it('the same audio still in the incoming copy under another id is not a deletion', () => {
    const held = [...OLD, DUPLICATE]
    const incoming = [...OLD, row(15140, 'Save Yourself', 60_000, 'dc6b107e')]
    refusedAndKept(publish({ homemini: held, incoming, tombstones: { v: 1, tombstones: [tomb('dc6b107e', 2 * 60 * 60 * 1000)] } }), held)
  })

  it('one deleted, one never seen: refused, and only the unseen one is named', () => {
    const phone = row(15135, 'Ritual Aristocrat', 2.5 * 60 * 60 * 1000)   // older than the album, so the recent rule is the one that answers
    const held = [...OLD, DUPLICATE, phone]
    const r = publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstones: { v: 1, tombstones: [tomb('dc6b107e', 60_000)] } })
    assert.equal(r.out, 'refused-recent 1 Ritual Aristocrat')
    refusedAndKept(r, held)
  })

  it('a tombstone file that does not parse is no deletions', () => {
    const held = [...OLD, DUPLICATE]
    refusedAndKept(publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstonesRaw: '{"v":1,"tombstones":[{"audioFingerpr' }), held)
    refusedAndKept(publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstonesRaw: '"dc6b107e"' }), held)
    refusedAndKept(publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstones: { v: 1, tombstones: [{ audioFingerprint: 'dc6b107e', deletedAt: 'yesterday' }, null, 7] } }), held)
  })

  it('an empty incoming copy is refused whatever was deleted', () => {
    const held = [...OLD, DUPLICATE]
    const r = publish({ homemini: held, incoming: [], tombstones: { v: 1, tombstones: [tomb('dc6b107e', 60_000)] } })
    assert.equal(r.out, 'refused-corrupt')
    assert.deepEqual(ids(r.served), ids(held))
  })
})
