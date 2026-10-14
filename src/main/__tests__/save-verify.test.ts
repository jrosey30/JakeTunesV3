/**
 * Brief 166 — save-verify: hash verification + atomic heal.
 *
 * The properties that matter:
 *   - verification compares CONTENT (sha256), so a landing with the
 *     right track count but wrong bytes fails;
 *   - the heal goes through staging + rename, never an in-place write —
 *     proven by the inode changing when a file is healed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPayload, verifyLandedFile, stagePayloadAndRename } from '../save-verify.ts'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'jt-save-verify-'))
  return { dir, file: join(dir, 'library.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('hashPayload matches the known sha256 vectors', () => {
  assert.equal(hashPayload(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(hashPayload('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('verifyLandedFile passes when the landed bytes are the written bytes', async () => {
  const s = scratch()
  try {
    const payload = JSON.stringify({ tracks: [{ id: 1 }, { id: 2 }] }, null, 2)
    writeFileSync(s.file, payload, 'utf-8')
    const res = await verifyLandedFile(s.file, hashPayload(payload))
    assert.equal(res.ok, true)
    assert.equal(res.actualHash, hashPayload(payload))
  } finally { s.cleanup() }
})

test('verifyLandedFile FAILS a same-track-count landing with wrong content', async () => {
  const s = scratch()
  try {
    // Same shape, same track count as the intended payload — the old
    // count-only check would have passed this. The hash must not.
    const intended = JSON.stringify({ tracks: [{ id: 1, title: 'right' }] }, null, 2)
    const landed = JSON.stringify({ tracks: [{ id: 1, title: 'WRONG' }] }, null, 2)
    writeFileSync(s.file, landed, 'utf-8')
    const res = await verifyLandedFile(s.file, hashPayload(intended))
    assert.equal(res.ok, false)
    assert.equal(res.actualHash, hashPayload(landed))
  } finally { s.cleanup() }
})

test('verifyLandedFile treats a missing landed file as a mismatch, not a throw', async () => {
  const s = scratch()
  try {
    const res = await verifyLandedFile(s.file, hashPayload('anything'))
    assert.deepEqual(res, { ok: false, actualHash: null })
  } finally { s.cleanup() }
})

test('stagePayloadAndRename lands the payload via rename (inode changes, no staging litter)', async () => {
  const s = scratch()
  try {
    writeFileSync(s.file, '{"tracks":[{"id":1,"title":"torn"}]}', 'utf-8')
    const inoBefore = statSync(s.file).ino
    const staging = `${s.file}.partial.json`
    const payload = JSON.stringify({ tracks: [{ id: 1, title: 'healed' }] }, null, 2)
    await stagePayloadAndRename(staging, s.file, payload)
    assert.equal(readFileSync(s.file, 'utf-8'), payload)
    assert.notEqual(statSync(s.file).ino, inoBefore, 'heal must rename a staged file, not write in place')
    assert.throws(() => statSync(staging), 'staging file must be consumed by the rename')
  } finally { s.cleanup() }
})
