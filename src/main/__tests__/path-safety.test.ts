/**
 * Containment tests. The cases that matter are the ones that BREAK PLAYBACK if
 * this is too strict (streamed tracks are symlinks pointing outside the music
 * root) and the ones that leak files if it's too loose (traversal, symlink
 * escape, absolute path straight from a URL).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPathInside, resolveContainedPath, isSafeCacheKey } from '../path-safety.ts'

function scratch() {
  const base = mkdtempSync(join(tmpdir(), 'jt-pathsafe-'))
  const music = join(base, 'music'); mkdirSync(music, { recursive: true })
  const cache = join(base, 'play-cache'); mkdirSync(cache, { recursive: true })
  const nas = join(base, 'nas'); mkdirSync(nas, { recursive: true })
  const secret = join(base, 'secret'); mkdirSync(secret, { recursive: true })
  writeFileSync(join(music, 'song.m4a'), 'audio')
  writeFileSync(join(cache, 'abc.m4a'), 'transcode')
  writeFileSync(join(nas, 'streamed.m4a'), 'remote')
  writeFileSync(join(secret, 'id_rsa'), 'PRIVATE KEY')
  return { base, music, cache, nas, secret, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('isPathInside is separator-aware', () => {
  assert.equal(isPathInside('/music/a.m4a', '/music'), true)
  assert.equal(isPathInside('/music', '/music'), true)
  assert.equal(isPathInside('/music-old/a.m4a', '/music'), false, '/music-old must not count as inside /music')
})

test('serves a real file inside an allowed root', async () => {
  const s = scratch()
  try {
    const got = await resolveContainedPath(join(s.music, 'song.m4a'), [s.music, s.cache])
    assert.equal(got, await import('node:fs/promises').then(m => m.realpath(join(s.music, 'song.m4a'))))
  } finally { s.cleanup() }
})

test('refuses ../ traversal out of the root', async () => {
  const s = scratch()
  try {
    assert.equal(await resolveContainedPath(join(s.music, '..', 'secret', 'id_rsa'), [s.music]), null)
  } finally { s.cleanup() }
})

test('refuses an absolute path that is simply outside every root', async () => {
  const s = scratch()
  try {
    assert.equal(await resolveContainedPath(join(s.secret, 'id_rsa'), [s.music, s.cache]), null)
  } finally { s.cleanup() }
})

test('refuses a symlink that ESCAPES to an unlisted location', async () => {
  const s = scratch()
  try {
    const trap = join(s.music, 'trap.m4a')
    symlinkSync(join(s.secret, 'id_rsa'), trap)
    assert.equal(await resolveContainedPath(trap, [s.music, s.cache]), null,
      'symlink inside the root pointing outside it must be refused')
  } finally { s.cleanup() }
})

test('ALLOWS a streamed-track symlink when its target root is listed', async () => {
  // This is the playback-breaking case: streamed tracks are symlinks whose
  // targets live under streamRoot, outside the music dir.
  const s = scratch()
  try {
    const link = join(s.music, 'streamed.m4a')
    symlinkSync(join(s.nas, 'streamed.m4a'), link)
    assert.equal(await resolveContainedPath(link, [s.music, s.cache]), null, 'without streamRoot: refused')
    const ok = await resolveContainedPath(link, [s.music, s.cache, s.nas])
    assert.ok(ok && ok.endsWith('streamed.m4a'), 'with streamRoot listed: served')
  } finally { s.cleanup() }
})

test('a missing but contained path is returned so the caller can 404', async () => {
  const s = scratch()
  try {
    const p = join(s.music, 'nope.m4a')
    assert.equal(await resolveContainedPath(p, [s.music]), p)
  } finally { s.cleanup() }
})

test('rejects junk input', async () => {
  const s = scratch()
  try {
    for (const bad of ['', 'relative/path.m4a', join(s.music, 'a\0b.m4a')]) {
      assert.equal(await resolveContainedPath(bad, [s.music]), null, `should reject ${JSON.stringify(bad)}`)
    }
    assert.equal(await resolveContainedPath(join(s.music, 'song.m4a'), []), null, 'no roots = refuse everything')
  } finally { s.cleanup() }
})

test('cache keys reject separators and dot-segments', () => {
  assert.equal(isSafeCacheKey('a1b2c3d4'), true)
  assert.equal(isSafeCacheKey('artist-slug_2'), true)
  assert.equal(isSafeCacheKey('../../etc/passwd'), false)
  assert.equal(isSafeCacheKey('a/b'), false)
  assert.equal(isSafeCacheKey(''), false)
})
