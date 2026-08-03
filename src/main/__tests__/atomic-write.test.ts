/**
 * writeJsonAtomic — the property that matters is that CONCURRENT writers never
 * corrupt the destination.
 *
 * The bug this replaces was subtle precisely because rename() is genuinely
 * atomic: the pattern looks correct. The failure needs two writers sharing one
 * staging path AND a size difference — a shorter payload written over a longer
 * one leaves the long write's tail past the end of the short one. So the test
 * interleaves writes of deliberately different lengths, which is the shape that
 * produced 22 trailing bytes on ui-state.json.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from '../atomic-write.ts'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'jt-atomic-'))
  return { dir, file: join(dir, 'state.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('concurrent writes of different sizes never corrupt the file', async () => {
  const s = scratch()
  try {
    // Payload length varies wildly with i — the mismatch is the whole point.
    const writes = Array.from({ length: 40 }, (_, i) =>
      writeJsonAtomic(s.file, { i, filler: 'x'.repeat(i * 500) }))
    await Promise.all(writes)

    const raw = readFileSync(s.file, 'utf-8')
    const parsed = JSON.parse(raw)          // throws on trailing-byte corruption
    assert.equal(typeof parsed.i, 'number')
    // Whatever landed last must be EXACTLY one payload, with no tail.
    assert.equal(raw, JSON.stringify({ i: parsed.i, filler: 'x'.repeat(parsed.i * 500) }, null, 2))
  } finally { s.cleanup() }
})

test('leaves no staging files behind', async () => {
  const s = scratch()
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(s.file, { i })))
    const strays = readdirSync(s.dir).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(strays, [], `orphaned staging files: ${strays.join(', ')}`)
  } finally { s.cleanup() }
})

test('round-trips content and honours pretty=false', async () => {
  const s = scratch()
  try {
    await writeJsonAtomic(s.file, { a: 1, b: [2, 3] })
    assert.ok(readFileSync(s.file, 'utf-8').includes('\n'), 'pretty by default')
    await writeJsonAtomic(s.file, { a: 1, b: [2, 3] }, false)
    const raw = readFileSync(s.file, 'utf-8')
    assert.equal(raw, '{"a":1,"b":[2,3]}')
    assert.deepEqual(JSON.parse(raw), { a: 1, b: [2, 3] })
  } finally { s.cleanup() }
})

test('a failed write does not leave a staging file or clobber the destination', async () => {
  const s = scratch()
  try {
    await writeJsonAtomic(s.file, { good: true })
    const circular: Record<string, unknown> = {}
    circular.self = circular                       // JSON.stringify throws
    await assert.rejects(() => writeJsonAtomic(s.file, circular))
    assert.deepEqual(JSON.parse(readFileSync(s.file, 'utf-8')), { good: true }, 'destination survived')
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith('.tmp')), [], 'no staging litter')
    assert.ok(existsSync(s.file))
  } finally { s.cleanup() }
})
