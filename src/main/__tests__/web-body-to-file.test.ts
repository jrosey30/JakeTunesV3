import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeWebBodyToFile } from '../web-body-to-file.ts'

function body(chunks: string[], failWith?: Error): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) { c.enqueue(new TextEncoder().encode(chunks[i++])); return }
      if (failWith) c.error(failWith)
      else c.close()
    },
  })
}

describe('writeWebBodyToFile', () => {
  it('writes the whole body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-wbf-'))
    try {
      const dest = join(dir, 'a.bin')
      await writeWebBodyToFile(body(['ab', 'cd']), dest)
      assert.equal(readFileSync(dest, 'utf8'), 'abcd')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('a connection dropped mid-body REJECTS (caught by the caller) — never an uncaught exception, never a hang', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-wbf-'))
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown): void => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)
    try {
      const terminated = new TypeError('terminated')
      await assert.rejects(writeWebBodyToFile(body(['ab'], terminated), join(dir, 'b.bin')), /terminated/)
      await new Promise((r) => setTimeout(r, 50)) // let any stray 'error' emit land
      assert.deepEqual(uncaught, [])
    } finally {
      process.off('uncaughtException', onUncaught)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
