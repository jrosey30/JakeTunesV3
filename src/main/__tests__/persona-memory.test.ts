/**
 * The personas' short-term memory.
 *
 * Extracted from index.ts on 2026-08-09. Two things are worth pinning down:
 * the rolling cap (a memory that grows forever eventually eats the prompt),
 * and the exact TEXT of the injected blocks. Music Man's block is not just a
 * list — its second half exists to stop him scolding Jake for pressing the
 * button twice, and a well-meaning edit that trims it for brevity would bring
 * the attitude straight back. So the wording is asserted, not just the shape.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initPersonaMemory,
  loadMusicManMemory, noteMusicManUtterance, recentUtterancesBlock,
  loadCynthiaMemory, noteCynthiaUtterance, recentCynthiaBlock,
} from '../persona-memory.ts'

/** Stand-in for JsonFileCache. */
function fakeCache() {
  let stored: unknown[] = []
  return {
    get: async () => stored,
    set: (v: unknown[]) => { stored = v },
    peek: () => stored,
  }
}

describe('persona memory', () => {
  let cache: ReturnType<typeof fakeCache>
  let dir: string

  beforeEach(async () => {
    cache = fakeCache()
    dir = await mkdtemp(join(tmpdir(), 'pm-'))
    initPersonaMemory({ cache, userDataDir: dir })
    // Real isolation between tests. The module's state is a singleton, and a
    // FAILED read deliberately leaves it alone (see the last test), so
    // pointing at an empty dir would carry the previous test's log forward.
    // An empty file is the only thing that actually clears it.
    await writeFile(join(dir, 'cynthia-memory.json'), '[]', 'utf-8')
    await loadMusicManMemory()
    await loadCynthiaMemory()
  })

  test('Music Man keeps only the last 12', async () => {
    for (let i = 1; i <= 14; i++) noteMusicManUtterance('dj', `take ${i}`)
    assert.equal(cache.peek().length, 12)
    const blk = recentUtterancesBlock()
    assert.ok(blk.includes('take 14'), 'newest kept')
    assert.ok(blk.includes('take 3'), 'twelfth-from-last kept')
    assert.ok(!blk.includes('take 1\n') && !blk.includes('take 2\n'), 'oldest two dropped')
  })

  test('utterances are tagged with the mode they came from', () => {
    noteMusicManUtterance('chat', 'Pearl Jam are underrated live')
    assert.ok(recentUtterancesBlock().includes('[chat] Pearl Jam are underrated live'))
  })

  test('blank utterances are ignored', () => {
    noteMusicManUtterance('dj', '   ')
    noteMusicManUtterance('dj', '')
    assert.equal(recentUtterancesBlock(), '')
  })

  test('an empty memory injects nothing at all', () => {
    // Not an empty header — nothing. An empty list in a prompt reads as
    // "you have said nothing", which is a claim we don't want to make.
    assert.equal(recentUtterancesBlock(), '')
    assert.equal(recentCynthiaBlock(), '')
  })

  test("Music Man's block forbids scolding the user for asking again", () => {
    noteMusicManUtterance('dj', 'anything')
    const blk = recentUtterancesBlock()
    assert.ok(blk.includes('so you stay CONSISTENT'), 'states the purpose')
    assert.ok(blk.includes('This log is NOT a cue to comment on repetition'))
    assert.ok(blk.includes('NEVER tell the user you "already talked about this,"'))
    assert.ok(blk.includes('find a genuinely FRESH angle'))
  })

  test('Music Man reloads what he said from the cache', async () => {
    noteMusicManUtterance('dj', 'a thing I said')
    await loadMusicManMemory()
    assert.ok(recentUtterancesBlock().includes('a thing I said'))
  })

  test('Cynthia persists to disk and reads back', async () => {
    noteCynthiaUtterance('fixed 3 covers')
    noteCynthiaUtterance('renamed 1 album')
    await new Promise(r => setTimeout(r, 150))

    const onDisk = JSON.parse(await readFile(join(dir, 'cynthia-memory.json'), 'utf-8'))
    assert.equal(onDisk.length, 2)
    assert.equal(onDisk[1].text, 'renamed 1 album')

    await loadCynthiaMemory()
    assert.equal(
      recentCynthiaBlock(),
      "Recent jobs you've finished:\n  - fixed 3 covers\n  - renamed 1 album",
    )
  })

  test('Cynthia keeps only the last 8', async () => {
    for (let i = 1; i <= 10; i++) noteCynthiaUtterance(`job ${i}`)
    const blk = recentCynthiaBlock()
    assert.equal(blk.split('\n').length - 1, 8, 'eight lines under the header')
    assert.ok(blk.includes('job 10') && !blk.includes('job 1\n'))
  })

  test('an unreadable memory file never erases what is already remembered', async () => {
    // A missing file is the normal first run and must not throw. But the
    // no-op on failure is doing a second job: if the read fails LATER — a
    // stalled NAS, a torn write — the correct move is to keep the memory we
    // have, not to wipe it because one read didn't come back.
    noteCynthiaUtterance('fixed 3 covers')
    initPersonaMemory({ cache, userDataDir: join(dir, 'does-not-exist') })

    await assert.doesNotReject(() => loadCynthiaMemory())
    assert.ok(recentCynthiaBlock().includes('fixed 3 covers'), 'memory survived the failed read')
  })

  test('without init, Cynthia writes nothing rather than into the cwd', async () => {
    initPersonaMemory({ cache, userDataDir: '' })
    await assert.doesNotReject(() => loadCynthiaMemory())
    noteCynthiaUtterance('should not hit disk')
    await new Promise(r => setTimeout(r, 100))
    await assert.rejects(() => readFile('cynthia-memory.json', 'utf-8'))
  })
})
