/**
 * The catalog-layout pass, tested against real files and real fcntl.
 *
 * The worker is embedded Python because Node has no fcntl and the calls that
 * matter (F_PREALLOCATE contiguous, F_NOCACHE, F_FULLFSYNC) are fcntl-only.
 * These tests run it for real in a temp dir — python3 is a hard requirement
 * of the app itself (the DB writer is Python), so the tests may assume it.
 *
 * What must hold, per the 79-of-500 night:
 *   - the rewritten catalog is byte-identical to the writer's output
 *   - the writer's original survives as .prefrag (the forensic artifact)
 *   - a missing/unreadable source fails CLOSED with the original untouched
 *   - the result reports whether contiguity was fcntl-guaranteed
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureContiguousDb } from '../ipod-db-contiguity.ts'

const md5 = (p: string): string => createHash('md5').update(readFileSync(p)).digest('hex')

describe('catalog contiguity pass', () => {
  test('rewrites byte-identical and keeps the original as .prefrag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-contig-'))
    const db = join(dir, 'iTunesDB')
    // Big enough to span multiple clusters — the mhbd magic keeps it honest.
    const payload = Buffer.concat([Buffer.from('mhbd'), Buffer.alloc(300_000, 7)])
    writeFileSync(db, payload)
    const before = md5(db)

    const r = await ensureContiguousDb(db, 'python3')
    assert.equal(r.ok, true, r.summary)
    assert.equal(r.bytes, payload.length)
    assert.equal(md5(db), before, 'shipped catalog must be byte-identical')
    assert.ok(existsSync(db + '.prefrag'), 'the writer output is kept for forensics')
    assert.equal(md5(db + '.prefrag'), before)
    assert.ok(r.summary.includes('one run'), r.summary)
    // APFS supports F_PREALLOCATE; on the temp dir the guarantee should hold.
    // Not asserted as MUST — the property that matters is byte identity; the
    // guarantee flag is reported so the sync log tells the truth either way.
  })

  test('a missing source fails closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-contig-'))
    const r = await ensureContiguousDb(join(dir, 'iTunesDB'), 'python3')
    assert.equal(r.ok, false)
    assert.ok(r.error, 'failure carries a reason')
    assert.ok(!existsSync(join(dir, 'iTunesDB')), 'nothing conjured into existence')
  })

  test('a broken python is a failed pass, not a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-contig-'))
    const db = join(dir, 'iTunesDB')
    writeFileSync(db, 'mhbd-tiny')
    const r = await ensureContiguousDb(db, '/nonexistent/python3')
    assert.equal(r.ok, false)
    assert.ok(existsSync(db), 'original untouched when the worker cannot run')
    assert.equal(readFileSync(db, 'utf-8'), 'mhbd-tiny')
  })
})
