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
 * This runs the guard's own Python, cut out of the sync script, in a folder
 * laid out like homemini's ~/JakeTunesState. No ssh, no network. homemini
 * runs it on the system Python (/usr/bin/python3, 3.9.6 there), which reads
 * dates differently from a newer one, so every case runs on that AND on
 * PATH's python3 wherever the two are different programs.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
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

/** homemini's interpreter first, then PATH's when it is another program. */
function interpreters(): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const cmd of ['/usr/bin/python3', 'python3']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.executable); print(sys.version.split()[0])'], { encoding: 'utf8' })
    if (r.status !== 0) continue
    const [exe, version] = r.stdout.trim().split('\n')
    let key = `${exe} ${version}`
    try { key = `${realpathSync(exe)} ${version}` } catch { /* keep the name */ }
    if (seen.has(key)) continue
    seen.add(key)
    found.push(cmd)
  }
  assert.ok(found.length > 0, 'a python3 to run the guard with')
  return found
}
const PYTHONS = interpreters()

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const NOW = Date.now()
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

interface Row { id: number; title: string; dateAdded: unknown; audioFingerprint?: unknown }
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

interface Case { homemini: Row[]; incoming: Row[]; tombstones?: unknown; tombstonesRaw?: string }

/** The same case on every interpreter; they must agree, and the answer is returned once. */
function publish(opts: Case): Outcome {
  const all = PYTHONS.map((py) => publishWith(py, opts))
  for (const o of all.slice(1)) assert.deepEqual(o, all[0], `${PYTHONS.join(' and ')} disagree`)
  return all[0]
}

function publishWith(python: string, opts: Case): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'jt-publish-deletions-'))
  try {
    writeFileSync(join(dir, 'library.json'), JSON.stringify({ tracks: opts.homemini }))
    writeFileSync(join(dir, '.library.json.incoming'), JSON.stringify({ tracks: opts.incoming }))
    if (opts.tombstonesRaw !== undefined) writeFileSync(join(dir, 'track-tombstones.json'), opts.tombstonesRaw)
    else if (opts.tombstones !== undefined) writeFileSync(join(dir, 'track-tombstones.json'), JSON.stringify(opts.tombstones))
    const r = spawnSync(python, ['-'], { cwd: dir, input: guardSource(), encoding: 'utf8' })
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
const T = (...t: unknown[]) => ({ v: 1, tombstones: t })

/** n songs added a week ago, and a deletion for each an hour ago. */
function clearOut(n: number): { rows: Row[]; tombstones: unknown } {
  const rows = Array.from({ length: n }, (_, i) => row(20000 + i, `Gone ${i}`, 7 * DAY, `gone-${i}`))
  return { rows, tombstones: T(...rows.map((r) => tomb(String(r.audioFingerprint), HOUR))) }
}

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

describe('guarded publish: at most 50 deletions in one publish', () => {
  it('50 deleted songs publish', () => {
    const { rows, tombstones } = clearOut(50)
    const r = publish({ homemini: [...OLD, ...rows], incoming: [...OLD, ...ALBUM], tombstones })
    assert.equal(r.out, 'published 4')
    assert.deepEqual(ids(r.served), [1, 2, 15128, 15129])
  })

  it('51 are refused by name of the rule, and homemini keeps its copy', () => {
    const { rows, tombstones } = clearOut(51)
    const held = [...OLD, ...rows]
    const r = publish({ homemini: held, incoming: [...OLD, ...ALBUM], tombstones })
    assert.equal(r.out, 'refused-too-many-deletions 51')
    assert.deepEqual(ids(r.served), ids(held))
    assert.equal(r.err, '')
  })

  it('a library shrunk to one row, every lost song tombstoned, is refused', () => {
    const { rows, tombstones } = clearOut(400)
    const held = [...OLD, ...rows]
    const r = publish({ homemini: held, incoming: [OLD[0]], tombstones })
    assert.match(r.out, /^refused-/)
    assert.deepEqual(ids(r.served), ids(held))
  })

  it('the script says the refusal in words', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    assert.match(src, /refused-too-many-deletions\*\) log "backend publish REFUSED: [^"]*more than 50 at once[^"]*"; return 1 ;;/)
  })
})

describe('guarded publish: what a deletion never excuses', () => {
  const INCOMING = [...OLD, ...ALBUM]
  const kept = (c: Case) => {
    const r = publish(c)
    assert.match(r.out, /^refused-recent 1 /)
    assert.deepEqual(ids(r.served), ids(c.homemini), 'homemini keeps its own copy')
  }

  it('no fingerprint matches no fingerprint: empty, blank, absent, not a string', () => {
    const blankTombs = T(
      { id: '15122', audioFingerprint: '', deletedAt: iso(HOUR) },
      { id: '15122', audioFingerprint: '   ', deletedAt: iso(HOUR) },
      { id: '15122', deletedAt: iso(HOUR) },
      { id: '15122', audioFingerprint: null, deletedAt: iso(HOUR) },
      { id: '15122', audioFingerprint: 0, deletedAt: iso(HOUR) },
    )
    for (const fp of ['', '   ', undefined, null, 0]) {
      const lost: Row = { id: 15122, title: 'Save Yourself', dateAdded: iso(3 * HOUR), ...(fp === undefined ? {} : { audioFingerprint: fp }) }
      kept({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: blankTombs })
    }
  })

  it('a deletion dated in the future (a fast clock) is not a deletion', () => {
    // Without the rule this tombstone would also excuse the song added again tomorrow.
    kept({ homemini: [...OLD, DUPLICATE], incoming: INCOMING, tombstones: T(tomb('dc6b107e', -2 * DAY)) })
    kept({ homemini: [...OLD, DUPLICATE], incoming: INCOMING, tombstones: T(tomb('dc6b107e', -10 * 60 * 1000)) })
    // A real one beside it still counts.
    const r = publish({ homemini: [...OLD, DUPLICATE], incoming: INCOMING, tombstones: T(tomb('dc6b107e', -2 * DAY), tomb('dc6b107e', HOUR)) })
    assert.equal(r.out, 'published 4')
  })

  it('a row whose date nobody can read is not excused', () => {
    for (const dateAdded of ['', 'yesterday', '2026-11-12T18:00:15', '12/11/2026', 1794500000000, null]) {
      const lost: Row = { id: 15122, title: 'Save Yourself', dateAdded, audioFingerprint: 'dc6b107e' }
      const held = [...OLD, lost]
      const r = publish({ homemini: held, incoming: INCOMING, tombstones: T(tomb('dc6b107e', HOUR)) })
      // An unreadable date is not "recent" to the old rule either: what matters is that
      // the row is still counted as missing, never waved through as deleted.
      assert.equal(r.err, '', `dateAdded ${JSON.stringify(dateAdded)} was excused`)
    }
  })

  it('a deletion whose date nobody can read is not a deletion', () => {
    for (const deletedAt of ['', 'yesterday', '2026-11-12T18:13:42', 1794500000000, null]) {
      kept({ homemini: [...OLD, DUPLICATE], incoming: INCOMING, tombstones: T({ id: '15122', audioFingerprint: 'dc6b107e', deletedAt }) })
    }
  })
})

describe('guarded publish: dates the way JavaScript writes them, on every Python', () => {
  const INCOMING = [...OLD, ...ALBUM]
  // Fixed instants around a deletion at 2026-11-12T18:13:42.6Z, moved to "about now"
  // by keeping the row inside the 30-day window: the row is added a few hours ago.
  const base = new Date(NOW - 3 * HOUR)
  const stamp = (d: Date, shape: 'ms' | 'one' | 'none' | 'six' | 'offset' | 'lower') => {
    const z = d.toISOString()                    // 2026-11-12T18:13:42.620Z
    const head = z.slice(0, 19)
    if (shape === 'ms') return z
    if (shape === 'one') return `${head}.${z.slice(20, 21)}Z`
    if (shape === 'none') return `${head}Z`
    if (shape === 'six') return `${head}.${z.slice(20, 23)}000Z`
    if (shape === 'lower') return z.replace('T', 't').replace('Z', 'z')
    const shifted = new Date(d.getTime() + 5.5 * HOUR).toISOString()
    return `${shifted.slice(0, 23)}+05:30`
  }

  it('every shape of the same instant is read as that instant', () => {
    const shapes = ['ms', 'one', 'none', 'six', 'offset', 'lower'] as const
    const added = base
    const later = new Date(base.getTime() + HOUR)
    const earlier = new Date(base.getTime() - HOUR)
    for (const a of shapes) {
      for (const d of shapes) {
        const lost: Row = { id: 15122, title: 'Save Yourself', dateAdded: stamp(added, a), audioFingerprint: 'dc6b107e' }
        const after = publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: T({ audioFingerprint: 'dc6b107e', deletedAt: stamp(later, d) }) })
        assert.equal(after.out, 'published 4', `added ${a}, deleted an hour later ${d}`)
        const before = publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: T({ audioFingerprint: 'dc6b107e', deletedAt: stamp(earlier, d) }) })
        assert.match(before.out, /^refused-/, `added ${a}, deleted an hour EARLIER ${d}`)
      }
    }
  })

  it('a date with no time is UTC midnight, as Date.parse has it', () => {
    const day = new Date(NOW - 2 * DAY).toISOString().slice(0, 10)
    const midnight = Date.parse(day)
    const lost: Row = { id: 15122, title: 'Save Yourself', dateAdded: day, audioFingerprint: 'dc6b107e' }
    const at = (ms: number) => T({ audioFingerprint: 'dc6b107e', deletedAt: new Date(ms).toISOString() })
    assert.equal(publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: at(midnight) }).out, 'published 4')
    assert.match(publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: at(midnight - 1000) }).out, /^refused-/)
  })

  it("homemini's own Python is one of the interpreters wherever it exists", () => {
    if (existsSync('/usr/bin/python3')) assert.equal(PYTHONS[0], '/usr/bin/python3')
  })
})
