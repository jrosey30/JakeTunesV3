/**
 * Brief 266, suspect 7: "if Jake's records can't be read, automatic writers
 * write NOTHING." The real functions, run against real files on disk: a torn
 * journal, a journal with an entry of the wrong shape, an unreadable phone
 * edits file, and (the fresh install) no journal at all.
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJakeEdits, createJakeNames, readJournalStrict } from '../jake-edits-guard.ts'
import { heldWhileRecordsUnreadable, LISTENING_COUNTER_FIELDS, mergeOverrideField } from '../override-merge.ts'
import { journalGenresStrict, REPLICA_REPAIR_MARKER, runReplicaGenreRepair } from '../genre-replica.ts'
import { emptyUserEdits, recordUserEdit, USER_EDITS_FILE } from '../../common/user-edits.ts'

const root = mkdtempSync(join(tmpdir(), 'jt-266-fail-closed-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const freshDir = (): string => mkdtempSync(join(root, `d${++n}-`))

// Jake's entry for song 21: his genre, year and rating, under the song's old fingerprint.
const OLD_FP = 'track 03|steely dan|237000'
const NEW_FP = 'peg|steely dan|237400'   // the title moved; same length
const hisEntry = (): Record<string, unknown> => ({ '21': { fp: OLD_FP, fields: { genre: 'Yacht Rock', year: '1977', rating: '100' } } })

/** The analysis writer's path in index.ts (persistOverrideFields): his names, then the one merge. */
async function automaticWrite(dir: string, overrides: Record<string, unknown>, fields: Record<string, string>, fp: string, readPhone: () => Promise<Record<string, { fp?: string; fields?: Record<string, string> }> | null> = async () => null): Promise<boolean> {
  const names = createJakeNames(createJakeEdits({ readJournal: () => readJournalStrict(dir), readPhone }))
  const jake = await names(21, fp)
  if (jake.unreadable && heldWhileRecordsUnreadable(overrides, 21, fp)) return false
  for (const [f, v] of Object.entries(fields)) mergeOverrideField(overrides, 21, f, v, fp, jake)
  return true
}

describe('gap 1: the override merge, his journal unreadable', () => {
  test('a torn journal on disk: the tempo write to a song whose fingerprint changed is held, his fields untouched', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, USER_EDITS_FILE), '{ "version": 1, "since": 1, "edits": { "21": { "title": { "v": "Pe')
    const o = hisEntry()
    assert.equal(await automaticWrite(dir, o, { bpm: '96', keyRoot: 'C' }, NEW_FP), false)
    assert.deepEqual(o, hisEntry(), 'nothing written: not his genre, not his year')
  })
  test('the merge itself holds too, whoever calls it, unless Jake is the one writing', () => {
    const o = hisEntry()
    mergeOverrideField(o, 21, 'skipCount', '3', NEW_FP, { title: [], artist: [], unreadable: true })
    assert.deepEqual(o, hisEntry(), 'the skip counter (automatic) is held')
    mergeOverrideField(o, 21, 'title', 'Peg', NEW_FP, { title: [], artist: [], unreadable: true }, { writtenByJake: true })
    assert.deepEqual(o['21'], { fp: NEW_FP, fields: { genre: 'Yacht Rock', year: '1977', rating: '100', title: 'Peg' } }, 'his Get Info save still works, and it merges')
  })
  test('a held write is only the changed-fingerprint case: the same song still merges, keeping every field', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, USER_EDITS_FILE), '{ torn')
    const o = hisEntry()
    assert.equal(await automaticWrite(dir, o, { bpm: '96' }, OLD_FP), true)
    assert.deepEqual(o['21'], { fp: OLD_FP, fields: { genre: 'Yacht Rock', year: '1977', rating: '100', bpm: '96' } })
    const fresh: Record<string, unknown> = {}
    assert.equal(await automaticWrite(dir, fresh, { bpm: '96' }, NEW_FP), true, 'no entry yet: nothing of his to lose')
    assert.deepEqual(fresh['21'], { fp: NEW_FP, fields: { bpm: '96' } })
  })
  test('a fresh install (no journal file): records read as no edits, and the re-parse safeguard works as it always did', async () => {
    const dir = freshDir()
    const o: Record<string, unknown> = { '21': { fp: 'other song|someone|301000', fields: { bpm: '80' } } }
    assert.equal(await automaticWrite(dir, o, { bpm: '96' }, NEW_FP), true)
    assert.deepEqual(o['21'], { fp: NEW_FP, fields: { bpm: '96' } }, 'another song under this id: a fresh entry')
  })
  test('a readable journal with his title: the fingerprint change is his correction, and the merge keeps his fields', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, USER_EDITS_FILE), JSON.stringify(recordUserEdit(emptyUserEdits(1), 21, 'title', 'Peg', 5_000, { dur: 237_000 })))
    const o = hisEntry()
    assert.equal(await automaticWrite(dir, o, { bpm: '96' }, NEW_FP), true)
    assert.deepEqual(o['21'], { fp: NEW_FP, fields: { genre: 'Yacht Rock', year: '1977', rating: '100', bpm: '96' } })
  })
  test('the play and skip counters are the automatic ones', () => {
    assert.deepEqual([...LISTENING_COUNTER_FIELDS].sort(), ['lastPlayedAt', 'playCount', 'skipCount'])
  })
})

describe('gap 2: the replica genre repair, his journal unreadable', () => {
  const overridesFile = (): Record<string, unknown> => ({
    '1': { fp: 'a|b|1', fields: { genre: 'Experimental', bpm: '100' } },
    '2': { fp: 'c|d|2', fields: { genre: 'Ska-Punk' } },
  })
  async function repair(dir: string): Promise<{ r: Awaited<ReturnType<typeof runReplicaGenreRepair>>; file: Record<string, unknown>; writes: number }> {
    writeFileSync(join(dir, 'metadata-overrides.json'), JSON.stringify(overridesFile()))
    let file = overridesFile()
    let writes = 0
    const r = await runReplicaGenreRepair({
      userData: dir,
      updateOverrides: async (m) => { writes++; file = m(file) },
      journalGenres: () => journalGenresStrict(dir),   // what genre-filer-ipc.ts passes
      log: () => {},
    })
    return { r, file, writes }
  }
  test('a torn journal on disk: nothing stripped, no marker, so it runs again once the journal reads', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, USER_EDITS_FILE), '{ torn')
    const { r, file, writes } = await repair(dir)
    assert.equal(r.ran, false)
    assert.equal(writes, 0, 'the override writer was never called')
    assert.deepEqual(file, overridesFile(), 'his genres are all there')
    assert.ok(!existsSync(join(dir, REPLICA_REPAIR_MARKER)), 'no marker: not "done"')
    assert.ok(!readdirSync(dir).some((f) => f.includes('.bak-replica-genres-')), 'nothing touched, not even a backup')
    writeFileSync(join(dir, USER_EDITS_FILE), JSON.stringify(recordUserEdit(emptyUserEdits(1), 2, 'genre', 'Ska-Punk', 5_000)))
    const again = await repair(dir)
    assert.equal(again.r.ran, true, 'readable again: the repair runs')
    assert.deepEqual(again.file, { '1': { fp: 'a|b|1', fields: { bpm: '100' } }, '2': { fp: 'c|d|2', fields: { genre: 'Ska-Punk' } } }, 'his own genre here kept')
  })
  test('a fresh install (no journal): runs as before, the missing file read as no edits', async () => {
    const dir = freshDir()
    const { r, file } = await repair(dir)
    assert.equal(r.ran, true)
    assert.equal(r.stripped, 2)
    assert.deepEqual(file['1'], { fp: 'a|b|1', fields: { bpm: '100' } })
    assert.ok(existsSync(join(dir, REPLICA_REPAIR_MARKER)))
  })
  test('the app passes the strict reader (wiring)', () => {
    const ipc = readFileSync(join(import.meta.dirname, '..', 'ipc', 'genre-filer-ipc.ts'), 'utf8')
    assert.match(ipc, /journalGenres: \(\) => journalGenresStrict\(app\.getPath\('userData'\)\), log/)
  })
})
