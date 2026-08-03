import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { mkdir, writeFile, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import {
  isPathInside,
  resolveContainedPath,
  sanitizeArtworkHash,
} from '../path-safety.ts'

test('isPathInside accepts nested and equal paths', () => {
  const root = '/music/library'
  assert.equal(isPathInside('/music/library', root), true)
  assert.equal(isPathInside('/music/library/F00/a.m4a', root), true)
  assert.equal(isPathInside('/music/other/a.m4a', root), false)
  assert.equal(isPathInside('/music/library-evil/a.m4a', root), false)
  assert.equal(isPathInside('/music/library/../other/a.m4a', root), false)
})

test('sanitizeArtworkHash strips cache-bust and rejects traversal', () => {
  assert.equal(sanitizeArtworkHash('abc123def.jpg'), 'abc123def')
  assert.equal(sanitizeArtworkHash('abc123_1713100000000'), 'abc123')
  assert.equal(sanitizeArtworkHash('../etc/passwd'), null)
  assert.equal(sanitizeArtworkHash('abc/../def'), null)
  assert.equal(sanitizeArtworkHash(''), null)
})

test('resolveContainedPath rejects escapes and allows roots', async () => {
  const base = join(tmpdir(), `jaketunes-path-safety-${process.pid}-${Date.now()}`)
  const music = join(base, 'music')
  const cache = join(base, 'cache')
  await mkdir(music, { recursive: true })
  await mkdir(cache, { recursive: true })
  const track = join(music, 'song.m4a')
  await writeFile(track, 'audio')

  const { realpath } = await import('fs/promises')
  assert.equal(await resolveContainedPath(track, [music, cache]), await realpath(track))
  assert.equal(await resolveContainedPath(join(music, '..', 'cache', 'x.m4a'), [music]), null)
  assert.equal(await resolveContainedPath('/etc/passwd', [music, cache]), null)
  const missing = join(music, 'missing.m4a')
  assert.equal(await resolveContainedPath(missing, [music]), missing)
  // Symlink escape: link inside music pointing outside
  const outside = join(base, 'secret.txt')
  await writeFile(outside, 'secret')
  const link = join(music, 'escape.m4a')
  try {
    await symlink(outside, link)
    assert.equal(await resolveContainedPath(link, [music]), null)
  } catch (err) {
    // Some CI environments disallow symlinks — skip rather than fail.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
  }

  await rm(base, { recursive: true, force: true })
})
