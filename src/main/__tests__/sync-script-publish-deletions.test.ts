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
function publish(opts: Case, tz = 'America/New_York'): Outcome {
  const all = PYTHONS.map((py) => publishWith(py, opts, tz))
  for (const o of all.slice(1)) assert.deepEqual(o, all[0], `${PYTHONS.join(' and ')} disagree`)
  return all[0]
}

function publishWith(python: string, opts: Case, tz: string): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'jt-publish-deletions-'))
  try {
    writeFileSync(join(dir, 'library.json'), JSON.stringify({ tracks: opts.homemini }))
    writeFileSync(join(dir, '.library.json.incoming'), JSON.stringify({ tracks: opts.incoming }))
    if (opts.tombstonesRaw !== undefined) writeFileSync(join(dir, 'track-tombstones.json'), opts.tombstonesRaw)
    else if (opts.tombstones !== undefined) writeFileSync(join(dir, 'track-tombstones.json'), JSON.stringify(opts.tombstones))
    const r = spawnSync(python, ['-'], { cwd: dir, input: guardSource(), encoding: 'utf8', env: { ...process.env, TZ: tz } })
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
/** How far a zone's wall clock is ahead of UTC at an instant, in ms. */
function offsetMs(tz: string, atMs: number): number {
  const digits = new Date(atMs).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')
  return Date.parse(`${digits}Z`) - (atMs - (atMs % 1000))
}
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

  it('a missing song whose date nobody can read is recent: refused, deletion or no deletion', () => {
    const ABSENT = Symbol('absent')
    // The last three are dates Python 3.14 reads and JavaScript and 3.9 do not: old ones on purpose,
    // so only "nobody can read it" can be what refuses them, on either Python.
    for (const dateAdded of ['', 'yesterday', '12/11/2026', '2026-13-45', 1794500000000, null, ABSENT, '20200101', '2020-01-01T18', '2020-W01-3']) {
      const lost = { id: 15122, title: 'Save Yourself', audioFingerprint: 'dc6b107e', ...(dateAdded === ABSENT ? {} : { dateAdded }) } as Row
      const held = [...OLD, lost]
      for (const tombstones of [undefined, T(tomb('dc6b107e', HOUR))]) {
        const r = publish({ homemini: held, incoming: INCOMING, tombstones })
        assert.equal(r.out, 'refused-recent 1 Save Yourself', `dateAdded ${String(dateAdded)}`)
        assert.deepEqual(ids(r.served), ids(held))
        assert.equal(r.err, '')
      }
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

  /** x as wall-clock digits in a zone, no zone written: "2026-11-12T13:00:15". */
  const wall = (ms: number, tz: string) => new Date(ms).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')
  const lostAt = (dateAdded: string): Row => ({ id: 15122, title: 'Save Yourself', dateAdded, audioFingerprint: 'dc6b107e' })
  const deletedAtMs = (ms: number) => T({ audioFingerprint: 'dc6b107e', deletedAt: new Date(ms).toISOString() })
  const verdict = (dateAdded: string, deletedMs: number, tz: string) =>
    publish({ homemini: [...OLD, lostAt(dateAdded)], incoming: INCOMING, tombstones: deletedAtMs(deletedMs) }, tz).out

  it('a date with no time is the LATER of UTC midnight and local midnight, so it is never excused early', () => {
    const day = new Date(NOW - 2 * DAY).toISOString().slice(0, 10)
    const utcMidnight = Date.parse(day)
    for (const tz of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
      const localMidnight = utcMidnight - offsetMs(tz, utcMidnight - offsetMs(tz, utcMidnight))   // the offset in force AT local midnight
      const later = Math.max(utcMidnight, localMidnight)
      assert.equal(verdict(day, later, tz), 'published 4', `${tz}: deleted at the later midnight`)
      assert.match(verdict(day, later - 1000, tz), /^refused-/, `${tz}: deleted a second before the later midnight`)
    }
  })

  it('a time with no zone is local time, as JavaScript reads it', () => {
    const x = base.getTime() - (base.getTime() % 1000)
    for (const tz of ['America/New_York', 'Asia/Kolkata']) {
      assert.equal(verdict(wall(x, tz), x + 1000, tz), 'published 4', `${tz}: deleted a second after`)
      assert.match(verdict(wall(x, tz), x - 1000, tz), /^refused-/, `${tz}: deleted a second before`)
    }
  })

  it("an offset's sign matters: +05:00 is five hours east, -05:00 five hours west", () => {
    const x = base.getTime() - (base.getTime() % 1000)
    const written = (sign: '+' | '-') => `${new Date(x + (sign === '+' ? 5 : -5) * HOUR).toISOString().slice(0, 19)}${sign}05:00`
    for (const sign of ['+', '-'] as const) {
      assert.equal(verdict(written(sign), x + 1000, 'UTC'), 'published 4', `${sign}05:00, deleted a second after`)
      assert.match(verdict(written(sign), x - 1000, 'UTC'), /^refused-/, `${sign}05:00, deleted a second before`)
    }
    // And on the deletion: the same instant written both ways excuses the same song.
    for (const sign of ['+', '-'] as const) {
      const del = (ms: number) => T({ audioFingerprint: 'dc6b107e', deletedAt: `${new Date(ms + (sign === '+' ? 5 : -5) * HOUR).toISOString().slice(0, 19)}${sign}05:00` })
      const lost = lostAt(new Date(x).toISOString())
      assert.equal(publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: del(x + 1000) }, 'UTC').out, 'published 4')
      assert.match(publish({ homemini: [...OLD, lost], incoming: INCOMING, tombstones: del(x - 1000) }, 'UTC').out, /^refused-/)
    }
  })

  it("homemini's own Python is one of the interpreters wherever it exists", () => {
    if (existsSync('/usr/bin/python3')) assert.equal(PYTHONS[0], '/usr/bin/python3')
  })
})

/**
 * Never looser. The guard as it ran before PR 411 is frozen in
 * fixtures/publish-guard-before-pr411.py. Both guards get the same folder and the same
 * clock, for a missing song dated in every shape at every distance from the two lines
 * the old guard drew (30 days ago; this copy's newest song), in three time zones, on
 * every Python. Wherever the old guard refused, the new one must refuse, unless a
 * deletion on record covers the song, which is the one thing this PR lets through.
 */
describe('guarded publish: never looser than the guard before it', () => {
  const BEFORE = readFileSync(join(import.meta.dirname, 'fixtures', 'publish-guard-before-pr411.py'), 'utf8')
  // The clock is the harness's to set, so the lines are put where the readings disagree:
  // 30 days before each of these is between UTC midnight and New York's (02:00Z), between
  // Kolkata's and UTC's (21:00Z), clear of both (12:00Z), and wherever today happens to be.
  const TODAY = Math.floor(NOW / DAY) * DAY
  const CLOCKS = [Math.floor(NOW / 1000) * 1000, TODAY + 2 * HOUR, TODAY + 21 * HOUR, TODAY + 12 * HOUR]
  const ZONES = ['America/New_York', 'Asia/Kolkata', 'UTC']
  const MIN = 60 * 1000
  const NEAR = [1 * MIN, 30 * MIN, 3 * HOUR, 4.5 * HOUR, 5 * HOUR, 5.5 * HOUR, 6 * HOUR, 13 * HOUR, 25 * HOUR].flatMap((d) => [-d, d])
  const FEWER = [1 * MIN, 3 * HOUR, 5.5 * HOUR, 25 * HOUR].flatMap((d) => [-d, d])
  const ABSENT = '__absent__'

  /** One instant, written every way a date has been or could be written. */
  function shapes(ms: number, tz: string): Array<[string, unknown]> {
    const z = new Date(ms).toISOString()
    const head = z.slice(0, 19)
    const shifted = (h: number) => new Date(ms + h * HOUR).toISOString().slice(0, 23)
    const wallClock = new Date(ms).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')
    return [
      ['ms', z],
      ['one digit', `${head}.${z.slice(20, 21)}Z`],
      ['no fraction', `${head}Z`],
      ['six digits', `${head}.${z.slice(20, 23)}000Z`],
      ['+05:00', `${shifted(5)}+05:00`],
      ['-05:00', `${shifted(-5)}-05:00`],
      ['+0530', `${shifted(5.5)}+0530`],
      ['lower case', z.replace('T', 't').replace('Z', 'z')],
      ['space', z.replace('T', ' ')],
      ['no zone, local digits', wallClock],
      ['no zone, UTC digits', head],
      ['no zone, minutes only', wallClock.slice(0, 16)],
      ['date only, UTC day', z.slice(0, 10)],
      ['date only, local day', wallClock.slice(0, 10)],
    ]
  }
  const UNREADABLE: Array<[string, unknown]> = [
    ['text', 'yesterday'], ['empty', ''], ['null', null], ['epoch number', 1794500000000], ['absent', ABSENT],
    ['month 13', '2026-13-45'], ['compact', '20261112'], ['us', '11/12/2026'], ['true', true],
  ]

  interface Probe { label: string; now: number; cur: unknown[]; incoming: unknown[]; tombstones?: unknown; excused: boolean }
  const song = (id: number, dateAdded: unknown, fp = `fp-${id}`) =>
    ({ id, title: `Song ${id}`, audioFingerprint: fp, ...(dateAdded === ABSENT ? {} : { dateAdded }) })

  const probes = (tz: string): Probe[] => CLOCKS.flatMap((clock) => probesAt(tz, clock))

  function probesAt(tz: string, NOW_MS: number): Probe[] {
    const out: Probe[] = []
    const at = `${new Date(NOW_MS).toISOString().slice(11, 16)}Z`
    const add = (p: Omit<Probe, 'now'>) => out.push({ ...p, label: `[${at}] ${p.label}`, now: NOW_MS / 1000 })
    const old = [song(1, new Date(NOW_MS - 200 * DAY).toISOString()), song(2, new Date(NOW_MS - 90 * DAY).toISOString())]
    const covering = { v: 1, tombstones: [{ id: '9', audioFingerprint: 'fp-9', title: 't', artist: 'a', durationMs: 1, deletedAt: new Date(NOW_MS - MIN).toISOString() }] }
    const unrelated = { v: 1, tombstones: [{ ...covering.tombstones[0], audioFingerprint: 'someone-else' }] }

    // Line 1: 30 days ago. This copy has a song from an hour ago, so nothing missing is "newer".
    const line = NOW_MS - 30 * DAY
    const fresh = [...old, song(3, new Date(NOW_MS - HOUR).toISOString())]
    for (const d of NEAR) {
      for (const [name, text] of shapes(line + d, tz)) {
        const cur = [...fresh, song(9, text)]
        add({ label: `30-day line ${d / MIN} min, ${name}`, cur, incoming: fresh, excused: false })
        add({ label: `30-day line ${d / MIN} min, ${name}, someone else deleted`, cur, incoming: fresh, tombstones: unrelated, excused: false })
        add({ label: `30-day line ${d / MIN} min, ${name}, deleted`, cur, incoming: fresh, tombstones: covering, excused: true })
      }
    }
    // Line 2: this copy's newest song, 60 days ago, itself written every way.
    const newest = NOW_MS - 60 * DAY
    for (const [newestName, newestText] of shapes(newest, tz)) {
      const incoming = [...old, song(3, newestText)]
      for (const d of FEWER) {
        for (const [name, text] of shapes(newest + d, tz)) {
          add({ label: `newest (${newestName}) ${d / MIN} min, ${name}`, cur: [...incoming, song(9, text)], incoming, excused: false })
        }
      }
      for (const [name, value] of UNREADABLE) {
        add({ label: `newest (${newestName}), missing song dated ${name}`, cur: [...incoming, song(9, value)], incoming, excused: false })
      }
    }
    // Dates nobody can read: with and without a deletion that would cover the song.
    for (const [name, value] of UNREADABLE) {
      const cur = [...fresh, song(9, value)]
      add({ label: `unreadable ${name}`, cur, incoming: fresh, excused: false })
      add({ label: `unreadable ${name}, deleted`, cur, incoming: fresh, tombstones: covering, excused: false })
      // ... and as this copy's newest song.
      const incoming = [...old, song(3, value)]
      add({ label: `newest unreadable ${name}`, cur: [...incoming, song(9, new Date(NOW_MS - 45 * DAY).toISOString())], incoming, excused: false })
    }
    return out
  }

  const HARNESS = `
import sys, json, os, io, time, tempfile, shutil, contextlib
job = json.load(sys.stdin)
clock = [0.0]
time.time = lambda: clock[0]
guards = {"before": compile(job["before"], "before", "exec"), "after": compile(job["after"], "after", "exec")}
home = tempfile.mkdtemp()
os.chdir(home)
def run(which, case):
    clock[0] = float(case["now"])
    for name in os.listdir("."): os.remove(name)
    json.dump({"tracks": case["cur"]}, open("library.json", "w"))
    json.dump({"tracks": case["incoming"]}, open(".library.json.incoming", "w"))
    if case.get("tombstones") is not None: json.dump(case["tombstones"], open("track-tombstones.json", "w"))
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            exec(guards[which], {"__name__": "__main__"})
    except SystemExit:
        pass
    kept = len(json.load(open("library.json"))["tracks"])
    return [out.getvalue().strip(), kept]
answers = [[run("before", c), run("after", c)] for c in job["cases"]]
os.chdir("/")
shutil.rmtree(home, ignore_errors=True)
json.dump(answers, sys.stdout)
`

  type Answer = [[string, number], [string, number]]
  function ask(python: string, tz: string, cases: Probe[], after = guardSource()): Answer[] {
    const r = spawnSync(python, ['-c', HARNESS], {
      input: JSON.stringify({ before: BEFORE, after, cases }),
      encoding: 'utf8', env: { ...process.env, TZ: tz }, maxBuffer: 256 * 1024 * 1024,
    })
    assert.equal(r.status, 0, r.stderr.slice(-2000))
    return JSON.parse(r.stdout)
  }
  const refused = (out: string) => out.startsWith('refused-')

  it('the frozen guard is the one main ran', () => {
    assert.match(BEFORE, /datetime\.fromisoformat/)
    assert.equal(BEFORE.includes('track-tombstones'), false)
  })

  for (const python of PYTHONS) {
    for (const tz of ZONES) {
      it(`${python}, ${tz}: what the old guard refused is still refused`, () => {
        const cases = probes(tz)
        const answers = ask(python, tz, cases)
        assert.equal(answers.length, cases.length)
        const looser: string[] = []
        const count = { same: 0, stricter: 0, excused: 0, oldRefused: 0, oldPublished: 0 }
        answers.forEach(([[was, wasKept], [now, nowKept]], i) => {
          const c = cases[i]
          assert.match(was, /^(published \d+|refused-\S+.*)$/, c.label)
          assert.match(now, /^(published \d+|refused-\S+.*)$/, c.label)
          // The verdict is what happened to the file, not only what was printed.
          assert.equal(refused(was), wasKept === c.cur.length, c.label)
          assert.equal(refused(now), nowKept === c.cur.length, c.label)
          if (refused(was)) count.oldRefused++; else count.oldPublished++
          if (refused(was) === refused(now)) count.same++
          else if (refused(now)) count.stricter++
          else if (c.excused) count.excused++
          else looser.push(`${c.label}: was "${was}", now "${now}"`)
          // The shape every real row has, with no deletion in play: not one word changes.
          if (!c.tombstones && / ms$/.test(c.label) && (!c.label.includes('] newest') || c.label.includes('] newest (ms)'))) assert.equal(now, was, c.label)
        })
        assert.deepEqual(looser, [], `${looser.length} case(s) the old guard refused now publish`)
        // Not vacuous: both verdicts were on the table, and the deletion excuse did fire.
        assert.ok(count.oldRefused > 100 && count.oldPublished > 100, JSON.stringify(count))
        assert.ok(count.excused > 0, JSON.stringify(count))
      })
    }
  }

  it('the comparison can fail: a guard that reads a bare date as UTC only is caught', () => {
    // The reader PR 411 first shipped with (7da6501a): UTC midnight for a bare date, where
    // the old guard on homemini took local midnight. West of Greenwich that is hours looser.
    const loose = guardSource().replace('return (min(utc, loc), max(utc, loc)) if loc is not None else (utc, utc)', 'return (utc, utc)')
      .replace('    return max(r[1], old) if old is not None else r[1]\n', '    return r[1]\n')
    assert.notEqual(loose, guardSource())
    const cases = probes('America/New_York')
    const answers = ask(PYTHONS[0], 'America/New_York', cases, loose)
    const looser = answers.filter(([[was], [now]], i) => refused(was) && !refused(now) && !cases[i].excused)
    assert.ok(looser.length > 0, 'the differential saw nothing wrong with a looser guard')
  })
})
