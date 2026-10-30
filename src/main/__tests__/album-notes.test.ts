// Album notes on disk (main/album-notes.ts): the history and the take an
// album page shows survive a relaunch (Jake 2026-10-30: "once the AI comes
// up with something, it should stay there").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { albumNotesKey, createAlbumNotesStore } from '../album-notes.ts'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jt-album-notes-'))
}

test('a note written by one launch is read back by the next', async () => {
  const dir = await scratch()
  try {
    const path = join(dir, 'album-notes.json')
    const first = createAlbumNotesStore(path)
    assert.equal(await first.get('blurbs', 'qotsa|perfecth'), undefined)
    await first.set('blurbs', 'qotsa|perfecth', 'Perfecth is the ninth studio album.')
    await first.set('takes', 'qotsa|perfecth', 'Loose-limbed and warm.')
    const relaunch = createAlbumNotesStore(path)
    assert.equal(await relaunch.get('blurbs', 'qotsa|perfecth'), 'Perfecth is the ninth studio album.')
    assert.equal(await relaunch.get('takes', 'qotsa|perfecth'), 'Loose-limbed and warm.')
    const onDisk = JSON.parse(await readFile(path, 'utf-8')) as { v: number; blurbs: Record<string, string>; takes: Record<string, string> }
    assert.equal(onDisk.v, 1)
    assert.deepEqual(Object.keys(onDisk.blurbs), ['qotsa|perfecth'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('empty text is never kept; an existing note is replaced only by text', async () => {
  const dir = await scratch()
  try {
    const store = createAlbumNotesStore(join(dir, 'album-notes.json'))
    await store.set('blurbs', 'k', '   ')
    assert.equal(await store.get('blurbs', 'k'), undefined)
    await store.set('blurbs', 'k', 'Real words.')
    await store.set('blurbs', 'k', '')
    assert.equal(await store.get('blurbs', 'k'), 'Real words.')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a corrupt file starts empty with one warning; a missing file is silent', async () => {
  const dir = await scratch()
  try {
    const warnings: string[] = []
    const missing = createAlbumNotesStore(join(dir, 'none.json'), (m) => warnings.push(m))
    assert.equal(await missing.get('takes', 'x'), undefined)
    assert.deepEqual(warnings, [])
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{"v":1,"blurbs":{"k":"ok"', 'utf-8')
    const corrupt = createAlbumNotesStore(bad, (m) => warnings.push(m))
    assert.equal(await corrupt.get('blurbs', 'k'), undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /unreadable, starting empty/)
    // It still works from here on, and the next launch reads what it wrote.
    await corrupt.set('blurbs', 'k', 'Fresh.')
    assert.equal(await createAlbumNotesStore(bad).get('blurbs', 'k'), 'Fresh.')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('albumNotesKey folds case and space, the year apart', () => {
  assert.equal(albumNotesKey(' Queens of the Stone Age ', 'Perfecth'), 'queens of the stone age|perfecth')
  assert.equal(albumNotesKey('Geese', '3D Country', '2023'), 'geese|3d country|2023')
})
