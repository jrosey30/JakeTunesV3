/**
 * Every audio rewrite leaves a line for the sync script's quick leg (2026-11-06). The leg's own
 * side is sync-script-owed-edits.test.ts. Reviewer's finding: an edit made away never reached
 * the NAS copy.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AUDIO_EDITS_OWED_FILE, audioEditsOwedPath, noteAudioEditOwed } from '../audio-edits-owed.ts'
import { writeTagsToFile } from '../tag-writer.ts'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const root = mkdtempSync(join(tmpdir(), 'jt-owed-'))
after(() => rmSync(root, { recursive: true, force: true }))

// Stand-in for core/tag_writer.py. .mp3 is not decode-checked, so this needs no ffmpeg.
const writerOk = join(root, 'writer_ok.py')
writeFileSync(writerOk, 'import sys\nsys.stdin.read()\n')
const writerBad = join(root, 'writer_bad.py')
writeFileSync(writerBad, 'import sys\nsys.stdin.read()\nsys.exit(3)\n')

function fresh(name: string): { song: string; noted: string[]; noteEdit: (p: string) => Promise<void> } {
  const dir = mkdtempSync(join(root, name))
  const song = join(dir, 'a.mp3')
  writeFileSync(song, 'audio')
  const noted: string[] = []
  return { song, noted, noteEdit: async (p) => { noted.push(p) } }
}

describe('the list', () => {
  it('one absolute path a line, nothing lost when writers overlap', async () => {
    const dir = mkdtempSync(join(root, 'list-'))
    const list = join(dir, AUDIO_EDITS_OWED_FILE)
    const paths = Array.from({ length: 40 }, (_, i) => `/lib/iPod_Control/Music/F00/s${i}.m4a`)
    await Promise.all(paths.map((p) => noteAudioEditOwed(p, { listPath: list })))
    assert.deepEqual(readFileSync(list, 'utf8').trim().split('\n').sort(), [...paths].sort())
  })

  it('a list it can\'t write never fails the edit: it says so and goes on', async () => {
    const logs: string[] = []
    await noteAudioEditOwed('/lib/a.m4a', { listPath: join(root, 'no', 'such', 'folder', 'x.txt'), log: (m) => logs.push(m) })
    assert.match(logs[0], /could not note \/lib\/a\.m4a/)
  })

  it('outside the app there is no list: a test run on temp files must never reach the real one', async () => {
    assert.equal(process.versions.electron, undefined)
    assert.equal(audioEditsOwedPath(), null)
    await noteAudioEditOwed('/lib/a.m4a') // nowhere to write, and no throw
  })

  it('the script reads the same file, by the same name', () => {
    const script = readFileSync(join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh'), 'utf8')
    assert.ok(script.includes(`OWED_EDITS="$JT_DATA_LOCAL/${AUDIO_EDITS_OWED_FILE}"`))
  })

  it('in the app it is the folder the script means', () => {
    const src = readFileSync(join(repoRoot, 'src', 'main', 'audio-edits-owed.ts'), 'utf8')
    assert.match(src, /join\(homedir\(\), 'Library', 'Application Support', 'JakeTunes', AUDIO_EDITS_OWED_FILE\)/)
    const script = readFileSync(join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh'), 'utf8')
    assert.ok(script.includes('JT_DATA_LOCAL="$HOME/Library/Application Support/JakeTunes"'))
  })
})

describe('a tag write', () => {
  it('that lands leaves a line, after the file is in place', async () => {
    const w = fresh('ok-')
    const r = await writeTagsToFile({ audioFilePath: w.song, overrides: { genre: 'Rock' } }, { script: writerOk, noteEdit: w.noteEdit })
    assert.equal(r.ok, true, r.error)
    assert.deepEqual(w.noted, [w.song])
  })

  it('that fails leaves none: the file did not change', async () => {
    const w = fresh('bad-')
    const r = await writeTagsToFile({ audioFilePath: w.song, overrides: { genre: 'Rock' } }, { script: writerBad, noteEdit: w.noteEdit })
    assert.equal(r.ok, false)
    assert.deepEqual(w.noted, [])
  })

  it('with nothing to write leaves none', async () => {
    const w = fresh('none-')
    const r = await writeTagsToFile({ audioFilePath: w.song, overrides: { playCount: 3 } }, { script: writerOk, noteEdit: w.noteEdit })
    assert.equal(r.ok, true)
    assert.deepEqual(w.noted, [])
  })

  it('in the app, with no test seam, goes through the real note', () => {
    const src = readFileSync(join(repoRoot, 'src', 'main', 'tag-writer.ts'), 'utf8')
    assert.match(src, /if \(writeResult\.ok\) await \(opts\.noteEdit \?\? noteAudioEditOwed\)\(audioFilePath\)/)
  })
})
