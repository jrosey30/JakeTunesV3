/**
 * What the guarded-publish tests share (sync-script-publish-*.test.ts): the guard's own
 * Python cut out of the sync script, the interpreters to run it on, and one publish in a
 * folder laid out like homemini's ~/JakeTunesState. Not a test file (no `.test.ts`), so
 * the runner never picks it up by itself. The tests were one file until it reached the
 * runner's 300 s cap under load (143 s alone at background priority, 2026-11-26); they
 * are split so each file stays well under it.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh')

/** The Python the script sends to homemini for the library publish. */
export function guardSource(): string {
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
export function interpreters(): string[] {
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
export const PYTHONS = interpreters()

export const DAY = 24 * 60 * 60 * 1000
export const HOUR = 60 * 60 * 1000
export const NOW = Date.now()
export const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

export interface Row { id: number; title: string; dateAdded: unknown; audioFingerprint?: unknown }
export const row = (id: number, title: string, msAgo: number, fp: string | null = `fp-${id}`): Row =>
  ({ id, title, dateAdded: iso(msAgo), ...(fp ? { audioFingerprint: fp } : {}) })
export const tomb = (fp: string, msAgo: number, id = '0') =>
  ({ id, audioFingerprint: fp, title: 'x', artist: 'y', durationMs: 1000, deletedAt: iso(msAgo) })

export const OLD = [row(1, 'Old One', 200 * DAY), row(2, 'Old Two', 90 * DAY)]
// What homemini held on 2026-11-12: the duplicate, added three hours ago.
export const DUPLICATE = row(15122, 'Save Yourself', 3 * 60 * 60 * 1000, 'dc6b107e')
// What the laptop had by then: the duplicate deleted, an album imported after.
export const ALBUM = [row(15128, 'Shackled By Lust', 2 * 60 * 60 * 1000), row(15129, 'Egoismus', 2 * 60 * 60 * 1000)]

export interface Outcome { out: string; err: string; served: Row[] }

export interface Case { homemini: Row[]; incoming: Row[]; tombstones?: unknown; tombstonesRaw?: string }

/** The same case on every interpreter; they must agree, and the answer is returned once. */
export function publish(opts: Case, tz = 'America/New_York'): Outcome {
  const all = PYTHONS.map((py) => publishWith(py, opts, tz))
  for (const o of all.slice(1)) assert.deepEqual(o, all[0], `${PYTHONS.join(' and ')} disagree`)
  return all[0]
}

export function publishWith(python: string, opts: Case, tz: string): Outcome {
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

export const ids = (rows: Row[]) => rows.map((r) => r.id)
/** How far a zone's wall clock is ahead of UTC at an instant, in ms. */
export function offsetMs(tz: string, atMs: number): number {
  const digits = new Date(atMs).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T')
  return Date.parse(`${digits}Z`) - (atMs - (atMs % 1000))
}
export const T = (...t: unknown[]) => ({ v: 1, tombstones: t })

/** n songs added a week ago, and a deletion for each an hour ago. */
export function clearOut(n: number): { rows: Row[]; tombstones: unknown } {
  const rows = Array.from({ length: n }, (_, i) => row(20000 + i, `Gone ${i}`, 7 * DAY, `gone-${i}`))
  return { rows, tombstones: T(...rows.map((r) => tomb(String(r.audioFingerprint), HOUR))) }
}
