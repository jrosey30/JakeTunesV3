/**
 * Brief 180 — parseEmbeddingsBlob throws on truncation.
 *
 * A truncated embeddings read (short SMB read) used to parse silently
 * into a partial brain — the KNOWN HOLE of 2026-08-25 that once
 * amputated 1,280 vectors in the trainer before its reader learned to
 * throw. The desktop reader now matches the trainer: header-declared
 * count/dimension vs actual payload mismatch ⇒ throw.
 *
 * embeddings.ts has load-time side effects (Electron), so — same
 * approach as brain-text.test.ts — the REAL function source is
 * extracted, materialized into a temp module with the module's own
 * format constants, and driven with hand-built binary fixtures.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', '..', '..')
const src = readFileSync(join(root, 'src/main/ai/embeddings.ts'), 'utf8')
const trainerSrc = readFileSync(join(root, 'scripts/brain-trainer.mjs'), 'utf8')

const body = (s: string, header: string): string => {
  const i = s.indexOf(header)
  assert.ok(i >= 0, `missing ${header}`)
  let depth = 0
  for (let j = s.indexOf('{', i); j < s.length; j++) {
    if (s[j] === '{') depth++
    else if (s[j] === '}' && --depth === 0) return s.slice(i, j + 1)
  }
  throw new Error(`unterminated ${header}`)
}

const magic = src.match(/const EMBED_FORMAT_MAGIC = '([A-Z]+)'/)![1]
const version = Number(src.match(/const EMBED_FORMAT_VERSION = (\d+)/)![1])
const dim = Number(src.match(/const EMBED_DIM = (\d+)/)![1])
assert.ok(magic && version > 0 && dim > 0, 'format constants found in embeddings.ts')

type ParseFn = (buf: Buffer) => Map<number, Float32Array>

async function loadParser(): Promise<{ parse: ParseFn; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'jt-emb-parse-'))
  const file = join(dir, 'parseEmbeddingsBlob.mts')
  const fnText = body(src, 'export function parseEmbeddingsBlob(')
  await writeFile(file, [
    `const EMBED_FORMAT_MAGIC = '${magic}'`,
    `const EMBED_FORMAT_VERSION = ${version}`,
    `const EMBED_DIM = ${dim}`,
    fnText,
    '',
  ].join('\n'))
  const mod = await import(pathToFileURL(file).href) as { parseEmbeddingsBlob: ParseFn }
  return { parse: mod.parseEmbeddingsBlob, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Hand-build an EMBD blob whose header DECLARES `declared` records but whose payload holds `present` whole records. */
function buildBlob(declared: number, present: number): Buffer {
  const recordSize = 4 + dim * 4
  const buf = Buffer.alloc(12 + present * recordSize)
  buf.write(magic, 0, 4, 'ascii')
  buf.writeUInt16LE(version, 4)
  buf.writeUInt16LE(dim, 6)
  buf.writeUInt32LE(declared, 8)
  let off = 12
  for (let i = 0; i < present; i++) {
    const trackId = 100 + i
    buf.writeUInt32LE(trackId, off); off += 4
    const vec = new Float32Array(dim)
    for (let j = 0; j < dim; j++) vec[j] = trackId + j / 10000
    buf.set(new Uint8Array(vec.buffer, vec.byteOffset, dim * 4), off)
    off += dim * 4
  }
  return buf
}

describe('parseEmbeddingsBlob — truncation is fatal (Brief 180)', () => {
  it('parses a well-formed blob fully', async () => {
    const { parse, cleanup } = await loadParser()
    try {
      const map = parse(buildBlob(2, 2))
      assert.equal(map.size, 2)
      const v = map.get(101)!
      assert.ok(v, 'track 101 present')
      assert.equal(v.length, dim)
      assert.ok(Math.abs(v[0] - 101) < 1e-4, 'first component round-trips')
      assert.ok(Math.abs(v[dim - 1] - (101 + (dim - 1) / 10000)) < 1e-3, 'last component round-trips')
    } finally { await cleanup() }
  })

  it('throws when the header declares more records than the payload holds', async () => {
    const { parse, cleanup } = await loadParser()
    try {
      assert.throws(() => parse(buildBlob(3, 2)), /truncated/)
    } finally { await cleanup() }
  })

  it('throws when the payload is cut mid-record', async () => {
    const { parse, cleanup } = await loadParser()
    try {
      const whole = buildBlob(2, 2)
      const cut = whole.subarray(0, whole.length - 100)
      assert.throws(() => parse(cut), /truncated/)
    } finally { await cleanup() }
  })

  it('throws on a buffer shorter than the 12-byte header', async () => {
    const { parse, cleanup } = await loadParser()
    try {
      assert.throws(() => parse(Buffer.alloc(8)), /truncated/)
    } finally { await cleanup() }
  })

  it('a header-only blob declaring zero vectors parses to an empty map', async () => {
    const { parse, cleanup } = await loadParser()
    try {
      assert.equal(parse(buildBlob(0, 0)).size, 0)
    } finally { await cleanup() }
  })

  it('the stale KNOWN HOLE comment is gone, and the trainer twin still throws', () => {
    assert.equal(src.includes('KNOWN HOLE'), false, 'embeddings.ts no longer carries the stale hole comment')
    assert.ok(trainerSrc.includes('truncated read'), 'trainer readEmb still throws on truncation (twin semantics)')
    assert.ok(src.includes('⚠️ TWIN: scripts/brain-trainer.mjs readEmb'), 'twin declaration still present')
  })
})
