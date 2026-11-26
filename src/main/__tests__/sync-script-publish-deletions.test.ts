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
 *
 * Split in four files (2026-11-26) so each stays well under the runner's 300 s cap:
 * this one, -dates, -never-looser and -never-looser-east, sharing
 * sync-script-publish-rig.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ALBUM, type Case, DAY, DUPLICATE, HOUR, OLD, type Outcome, type Row, SCRIPT, T, clearOut, ids, iso, publish, row, tomb } from './sync-script-publish-rig.ts'

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
