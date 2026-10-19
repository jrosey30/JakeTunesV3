/**
 * Thumbnail freshness (2026-10-19). Jake on workmini: Nirvana / Paul McCartney /
 * Rush posters "has to be the same eye for eye". The poster jpgs matched the
 * laptop byte for byte, but workmini served Jul 10 thumbs of the covers those
 * posters replaced on Sep 2. A thumb must never outlive the art it was made from.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { thumbIsFresh, readFreshThumb, thumbsToBuild } from '../thumb-freshness.ts'

const JUL10 = new Date('2026-07-10T14:30:00Z')
const SEP2 = new Date('2026-09-02T19:09:00Z')

async function artDir() {
  const dir = await mkdtemp(join(tmpdir(), 'thumbs-'))
  await mkdir(join(dir, 'thumbs'))
  return dir
}

describe('a thumbnail is only used if it is newer than its art', () => {
  it('workmini case: a poster copied in with its Sep 2 mtime beside a Jul 10 thumb is stale', async () => {
    const dir = await artDir()
    const thumb = join(dir, 'thumbs', 'b81fca3b_320.jpg')
    await writeFile(thumb, 'old Jul 10 cover thumb')
    await utimes(thumb, JUL10, JUL10)
    const full = join(dir, 'b81fca3b.jpg')
    await writeFile(full, 'Sep 2 poster')
    await utimes(full, SEP2, SEP2)   // rsync/ditto preserve the laptop's mtime
    assert.equal(await thumbIsFresh(thumb, full), false)
    await assert.rejects(readFreshThumb(thumb, full))
  })

  it('a copy that keeps an OLD mtime still counts as new art (ctime = when it landed here)', async () => {
    const dir = await artDir()
    const thumb = join(dir, 'thumbs', 'a_320.jpg')
    await writeFile(thumb, 'thumb')
    await new Promise((r) => setTimeout(r, 20))
    const full = join(dir, 'a.jpg')
    await writeFile(full, 'poster that just arrived')
    await utimes(full, JUL10, JUL10)   // mtime older than the thumb, but it landed after it
    assert.equal(await thumbIsFresh(thumb, full), false)
  })

  it('a thumb made after its art is served as-is', async () => {
    const dir = await artDir()
    const full = join(dir, 'a.jpg')
    await writeFile(full, 'poster')
    await new Promise((r) => setTimeout(r, 20))
    const thumb = join(dir, 'thumbs', 'a_320.jpg')
    await writeFile(thumb, 'fresh thumb')
    assert.equal(await thumbIsFresh(thumb, full), true)
    assert.equal(String(await readFreshThumb(thumb, full)), 'fresh thumb')
  })

  it('a missing thumb (or missing art) is never fresh', async () => {
    const dir = await artDir()
    await writeFile(join(dir, 'a.jpg'), 'poster')
    assert.equal(await thumbIsFresh(join(dir, 'thumbs', 'a_320.jpg'), join(dir, 'a.jpg')), false)
    assert.equal(await thumbIsFresh(join(dir, 'a.jpg'), join(dir, 'gone.jpg')), false)
  })

  it('pregeneration rebuilds stale and missing 320px thumbs, skips fresh ones and non-art', async () => {
    const dir = await artDir()
    for (const n of ['stale', 'missing', 'fresh']) await writeFile(join(dir, `${n}.jpg`), n)
    await writeFile(join(dir, 'stale.jpg'), 'new poster')
    await writeFile(join(dir, 'thumbs', 'stale_320.jpg'), 'old')
    await utimes(join(dir, 'thumbs', 'stale_320.jpg'), JUL10, JUL10)
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, 'thumbs', 'fresh_320.jpg'), 'ok')
    const todo = await thumbsToBuild(dir, join(dir, 'thumbs'), ['stale.jpg', 'missing.jpg', 'fresh.jpg', 'index.json', '.hidden.jpg', 'x.meta.json'])
    assert.deepEqual(todo.sort(), ['missing.jpg', 'stale.jpg'])
    assert.equal(String(await readFile(join(dir, 'fresh.jpg'))), 'fresh')
  })
})
