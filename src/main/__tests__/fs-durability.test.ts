/**
 * Brief 168 — fsync helpers. Observable contract: fsyncFile resolves on
 * a real file and rejects on a missing one (a save must not proceed to
 * rename bytes it could not force to disk); fsyncParentDir never
 * throws, even for a path whose parent does not exist.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fsyncFile, fsyncParentDir } from '../fs-durability.ts'

test('fsyncFile resolves on a real staged file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jt-fsync-'))
  try {
    const file = join(dir, 'staged.json')
    writeFileSync(file, '{"ok":true}', 'utf-8')
    await fsyncFile(file)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fsyncFile rejects on a missing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jt-fsync-'))
  try {
    await assert.rejects(() => fsyncFile(join(dir, 'nope.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fsyncParentDir resolves for real and for nonsense paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jt-fsync-'))
  try {
    const file = join(dir, 'library.json')
    writeFileSync(file, '{}', 'utf-8')
    await fsyncParentDir(file)
    await fsyncParentDir(join(dir, 'missing-dir', 'library.json'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
