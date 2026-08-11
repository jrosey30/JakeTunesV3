/**
 * Session import-path allowlist — closes exfil-via-import.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  allowImportPaths,
  isImportPathAllowed,
  clearImportAllowlist,
  importAllowlistSize,
} from '../import-allowlist.ts'

beforeEach(() => {
  clearImportAllowlist()
})

test('ungranted paths are refused', () => {
  assert.equal(isImportPathAllowed('/tmp/secret.mp3'), false)
  assert.equal(isImportPathAllowed('/etc/passwd'), false)
})

test('exact grant allows that path only', () => {
  const file = join('/tmp', 'album', 'track.mp3')
  allowImportPaths([file])
  assert.equal(isImportPathAllowed(file), true)
  assert.equal(isImportPathAllowed(join('/tmp', 'album', 'other.mp3')), false)
  assert.equal(isImportPathAllowed(join('/tmp', 'other', 'track.mp3')), false)
})

test('directory grant allows children (folder pick / drop expand)', () => {
  const dir = join('/tmp', 'picked-album')
  allowImportPaths([dir])
  assert.equal(isImportPathAllowed(join(dir, '01.mp3')), true)
  assert.equal(isImportPathAllowed(join(dir, 'disc2', '02.flac')), true)
  // Sibling of the allowed dir must not match via prefix tricks.
  assert.equal(isImportPathAllowed(join('/tmp', 'picked-album-evil', 'x.mp3')), false)
})

test('null bytes and empty strings never grant or match', () => {
  assert.deepEqual(allowImportPaths(['', '/tmp/ok.mp3', '/tmp/bad\0.mp3']), [
    join('/tmp', 'ok.mp3'),
  ])
  assert.equal(isImportPathAllowed(''), false)
  assert.equal(isImportPathAllowed('/tmp/bad\0.mp3'), false)
  assert.equal(importAllowlistSize(), 1)
})

test('allowImportPaths normalizes relative segments', () => {
  allowImportPaths(['/tmp/foo/../bar/track.mp3'])
  assert.equal(isImportPathAllowed('/tmp/bar/track.mp3'), true)
  assert.equal(isImportPathAllowed('/tmp/foo/../bar/track.mp3'), true)
})

test('clearImportAllowlist empties the session set', () => {
  allowImportPaths(['/tmp/a.mp3', '/tmp/b.mp3'])
  assert.equal(importAllowlistSize(), 2)
  clearImportAllowlist()
  assert.equal(importAllowlistSize(), 0)
  assert.equal(isImportPathAllowed('/tmp/a.mp3'), false)
})
