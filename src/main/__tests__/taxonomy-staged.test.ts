/**
 * Subgenre hand-off (2026-10-19): the running app folds the classifier's
 * staged subgenres in through its own writer. The merge is a TWIN of
 * scripts/taxonomy-classify.py merge_staged — the fixture below is the same
 * one scripts/tests/test_taxonomy_merge.py uses, and a parity test runs the
 * shipped Python against it when python3 is available.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseStaged, mergeStagedSubgenres, applyStagedOnce, STAGED_FILE, DEFERRED_FILE, APPLIED_STATUS_FILE, type TaxonomyStagedHost } from '../taxonomy-staged.ts'
import { trackFingerprint } from '../genre-filer.ts'

const LIB = [
  { id: 1, title: 'Song One', artist: 'Artist A', duration: 200000 },
  { id: 2, title: 'Song Two', artist: 'Artist B', duration: 180000 },
  { id: 3, title: 'Song Three', artist: 'Artist C', duration: 190000 },
]
const ENTRIES = {
  '1': { subgenre: 'Synthpop', subgenrePath: 'Pop › Synthpop', subgenreLean: 'New Wave' },
  '2': { subgenre: 'Shoegaze', subgenrePath: 'Rock › Shoegaze' },
  '3': { subgenre: 'Grime', subgenrePath: 'Electronic › Grime' },
}
const onDisk = (): Record<string, unknown> => ({
  '1': { fp: 'song one|artist a|200000', fields: { subgenre: 'Dream Pop', subgenrePath: 'Rock › Dream Pop' } },
  '2': { fp: 'song two|artist b|180000', fields: { rating: '5', playCount: '12' } },
  '9': { fp: 'other|someone|1000', fields: { genre: 'Jazz' } },
})
const fpOf = (id: number): string | null => {
  const t = LIB.find((x) => x.id === id)
  return t ? trackFingerprint(t) : null
}

describe('mergeStagedSubgenres (twin of merge_staged)', () => {
  it('is additive: never overwrites a subgenre, keeps other fields and the accepted fp', () => {
    const ov = onDisk()
    const r = mergeStagedSubgenres(ov, ENTRIES, fpOf)
    assert.equal(r.applied.length, 2)
    assert.equal(r.alreadyFiled, 1)
    const e1 = ov['1'] as { fields: Record<string, string> }
    assert.equal(e1.fields.subgenre, 'Dream Pop')
    const e2 = ov['2'] as { fp: string; fields: Record<string, string> }
    assert.equal(e2.fields.playCount, '12')
    assert.equal(e2.fields.subgenre, 'Shoegaze')
    assert.equal(e2.fp, 'song two|artist b|180000')
    assert.deepEqual(ov['9'], { fp: 'other|someone|1000', fields: { genre: 'Jazz' } })
    const e3 = ov['3'] as { fp: string; fields: Record<string, string> }
    assert.equal(e3.fp, 'song three|artist c|190000')
    assert.equal(e3.fields.subgenrePath, 'Electronic › Grime')
  })

  it('drops a staged song that has left the library', () => {
    const ov: Record<string, unknown> = {}
    const r = mergeStagedSubgenres(ov, { '77': { subgenre: 'Techno' } }, fpOf)
    assert.equal(r.notInLibrary, 1)
    assert.deepEqual(ov, {})
  })

  it('matches the shipped Python merge_staged on the shared fixture', (t) => {
    const probe = spawnSync('python3', ['-c', 'print(1)'])
    if (probe.status !== 0) { t.skip('python3 not available'); return }
    const src = readFileSync(join(import.meta.dirname, '../../../scripts/taxonomy-classify.py'), 'utf8')
    const segment = src.slice(src.indexOf('def fp_of(t):'), src.indexOf('# First pass against the load-time copy'))
    const cache = Object.fromEntries(Object.entries(ENTRIES).map(([k, e]) => [k, { subgenre: e.subgenre, path: e.subgenrePath, lean: (e as { subgenreLean?: string }).subgenreLean ?? '' }]))
    const byid = Object.fromEntries(LIB.map((t) => [String(t.id), t]))
    const segFile = join(mkdtempSync(join(tmpdir(), 'tx-seg-')), 'seg.py')
    writeFileSync(segFile, segment)
    const script = `import json,os,shutil,datetime\ng={'json':json,'os':os,'shutil':shutil,'datetime':datetime,'SD':'/tmp','OVP':'/tmp/x','log':lambda *a:None}\nexec(open(${JSON.stringify(segFile)}).read(),g)\nov=json.loads(${JSON.stringify(JSON.stringify(onDisk()))})\ng['merge_staged'](ov, json.loads(${JSON.stringify(JSON.stringify(cache))}), json.loads(${JSON.stringify(JSON.stringify(byid))}))\nprint(json.dumps(ov))`
    const out = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    const pyResult = JSON.parse(out.stdout)
    const tsResult = onDisk()
    mergeStagedSubgenres(tsResult, ENTRIES, fpOf)
    assert.deepEqual(tsResult, pyResult)
  })
})

describe('parseStaged', () => {
  it('keeps only well-formed numeric-id entries', () => {
    const p = parseStaged(JSON.stringify({ version: 1, at: 'x', entries: { '5': { subgenre: 'Grime' }, abc: { subgenre: 'X' }, '6': { subgenre: '' } } }))
    assert.deepEqual(p?.entries, { '5': { subgenre: 'Grime' } })
    assert.equal(parseStaged('{"version":2,"at":"x","entries":{}}'), null)
    assert.equal(parseStaged('not json'), null)
  })
})

function fakeHost(dir: string, overrides: Record<string, unknown>, opts: { failFlush?: boolean } = {}) {
  const applied: Array<{ trackId: number; field: string; newValue: string }> = []
  let drops = 0
  const host: TaxonomyStagedHost = {
    stateDir: dir,
    libraryTracks: async () => LIB,
    updateOverrides: async (m) => { m(overrides); if (opts.failFlush) drops++ },
    flushOverrides: async () => {},
    overrideFlushStats: () => ({ flushFailures: 0, droppedWrites: drops }),
    onApplied: (u) => { applied.push(...u) },
    fingerprint: trackFingerprint,
    log: () => {},
  }
  return { host, applied }
}

describe('applyStagedOnce', () => {
  it('applies, clears the hand-off and the deferred marker, leaves a status line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-staged-'))
    writeFileSync(join(dir, STAGED_FILE), JSON.stringify({ version: 1, at: '2026-10-19T02:15:00', entries: ENTRIES }))
    writeFileSync(join(dir, DEFERRED_FILE), JSON.stringify({ at: 'x', pendingCount: 3 }))
    const ov = onDisk()
    const { host, applied } = fakeHost(dir, ov)
    const r = await applyStagedOnce(host)
    assert.equal(r?.applied.length, 2)
    assert.ok(!existsSync(join(dir, STAGED_FILE)))
    assert.ok(!existsSync(join(dir, `${STAGED_FILE}.applying`)))
    assert.ok(!existsSync(join(dir, DEFERRED_FILE)))
    const status = JSON.parse(readFileSync(join(dir, APPLIED_STATUS_FILE), 'utf8'))
    assert.equal(status.applied, 2)
    assert.ok(applied.some((u) => u.trackId === 3 && u.field === 'subgenre' && u.newValue === 'Grime'))
  })

  it('does nothing when nothing is staged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-staged-'))
    const { host } = fakeHost(dir, {})
    assert.equal(await applyStagedOnce(host), null)
  })

  it('keeps the hand-off for a retry when the write did not reach disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tx-staged-'))
    writeFileSync(join(dir, STAGED_FILE), JSON.stringify({ version: 1, at: 'x', entries: ENTRIES }))
    const { host } = fakeHost(dir, onDisk(), { failFlush: true })
    assert.equal(await applyStagedOnce(host), null)
    assert.ok(existsSync(join(dir, STAGED_FILE)), 'staged file restored for the next pass')
  })
})
