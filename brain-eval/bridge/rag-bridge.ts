/**
 * brain-eval production-path bridge (scorecard v3).
 *
 * Runs the REAL desktop retrieval code from a main-branch source tree —
 * router (pickRetrievalIndex), ragRetrieveByQuery, mood index, audio
 * fusion, decade hard-gate, genre reranker, subgenre lexicon — outside
 * Electron, via the electron stub in ./node_modules.
 *
 * Ported from main:brain-eval/bridge/rag-bridge.ts (3a, 2026-09-01). What
 * changed, and why:
 *   - The production code is loaded from JT_MAIN_SRC (a `git archive` of
 *     origin/main's src/, extracted under bridge/.main-src/<sha>/ by
 *     run_eval.py) because the brain-eval branch's own src/ is months old.
 *     The extract sits UNDER this directory so node's resolver walks up to
 *     the electron stub — no tsconfig path magic needed.
 *   - Input rows carry their own k: ragRetrieveByQuery's rerank pool is
 *     k × 4, so slicing a k=30 call to 25 is NOT what production returns
 *     for k=25. Every probe now gets exactly its own k.
 *   - Query embeddings go through a frozen cache (JT_QVEC_FROZEN, plus a
 *     local overflow file JT_QVEC_OVERFLOW for texts the frozen file lacks)
 *     by wrapping globalThis.fetch for the OpenAI embeddings URL only. The
 *     production code path is untouched; only the transport is memoised, so
 *     baseline and candidate (and night N and N+1) see bit-identical query
 *     vectors. Same cache file format as run_eval.py.
 *   - stdout carries ONLY the JSON result lines; every console line goes to
 *     stderr, and the [rag] lines for each query ride along in its row so
 *     run_eval can tell fusion / mood / main / decade-gate apart.
 *
 * Input (argv[2]): a JSON file — an array of strings or {query, k} objects.
 * Output: one JSON line per input row:
 *   {"query","k","index":"main"|"mood","hits":[{"trackId","score"}],"rag":[...]}
 * then a final {"_stats": {...}} line.
 *
 * READ-ONLY: reads library.json / embeddings.bin / mood-index.bin /
 * audio-index.bin / artist-members.json under JT_STATE_DIR, calls the OpenAI
 * embed API on cache misses, and writes nothing but JT_QVEC_OVERFLOW.
 */
import { readFile, writeFile, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, resolve } from 'path'

const STATE_DIR = process.env.JT_STATE_DIR
const MAIN_SRC = process.env.JT_MAIN_SRC
if (!STATE_DIR) { console.error('[bridge] JT_STATE_DIR is required (point it at a snapshot)'); process.exit(2) }
if (!MAIN_SRC || !existsSync(join(MAIN_SRC, 'src', 'main', 'ai', 'rag-retrieval.ts'))) {
  console.error(`[bridge] JT_MAIN_SRC (${MAIN_SRC}) has no src/main/ai/rag-retrieval.ts`); process.exit(2)
}
const LIB = join(STATE_DIR, 'library.json')

// ── stdout is for JSON rows only; capture [rag] lines per query ─────────
let ragLines: string[] = []
const toErr = (...a: unknown[]): void => { process.stderr.write(a.map(String).join(' ') + '\n') }
const capture = (...a: unknown[]): void => {
  const line = a.map(String).join(' ')
  if (line.startsWith('[rag]') || line.startsWith('[audio-query]')) ragLines.push(line)
  toErr(...a)
}
console.log = capture
console.info = capture
console.warn = capture

// ── frozen query-vector cache (shared format with run_eval.py) ──────────
type CacheFile = { model: string; dim: number; vectors: Record<string, { text: string; b64: string }> }
const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings'
const cacheKey = (model: string, text: string): string => createHash('sha1').update(`${model}\n${text}`).digest('hex')
const frozen: CacheFile['vectors'] = {}
const overflow: CacheFile['vectors'] = {}
const stats = { cached: 0, fresh: 0, queries: 0 }
const seenTexts = new Set<string>()   // every text this run embedded (run_eval --freeze-qvec keeps them)

async function loadCache(path: string | undefined, into: CacheFile['vectors']): Promise<void> {
  if (!path || !existsSync(path)) return
  const j = JSON.parse(await readFile(path, 'utf-8')) as CacheFile
  Object.assign(into, j.vectors || {})
}
const b64ToArray = (b64: string): number[] => {
  const buf = Buffer.from(b64, 'base64')
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
}
const arrayToB64 = (xs: number[]): string => Buffer.from(Float32Array.from(xs).buffer).toString('base64')

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url !== OPENAI_EMBED_URL || !init?.body) return realFetch(input, init)
  const body = JSON.parse(String(init.body)) as { model: string; input: string | string[] }
  const texts = Array.isArray(body.input) ? body.input : [body.input]
  for (const t of texts) seenTexts.add(t)
  const get = (t: string): { text: string; b64: string } | undefined => frozen[cacheKey(body.model, t)] ?? overflow[cacheKey(body.model, t)]
  const missing = [...new Set(texts.filter((t) => !get(t)))]
  if (missing.length) {
    const r = await realFetch(input, { ...init, body: JSON.stringify({ ...body, input: missing }) })
    if (!r.ok) return r
    const j = await r.json() as { data: Array<{ index: number; embedding: number[] }> }
    for (const row of j.data) overflow[cacheKey(body.model, missing[row.index])] = { text: missing[row.index], b64: arrayToB64(row.embedding) }
    stats.fresh += missing.length
  }
  stats.cached += texts.length - missing.length
  const data = texts.map((t, index) => ({ object: 'embedding', index, embedding: b64ToArray(get(t)!.b64) }))
  return new Response(JSON.stringify({ object: 'list', data, model: body.model }), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

async function main(): Promise<void> {
  const [, , queriesPath, kArg] = process.argv
  const defaultK = Number(kArg) || 25
  await loadCache(process.env.JT_QVEC_FROZEN, frozen)
  await loadCache(process.env.JT_QVEC_OVERFLOW, overflow)

  const root = resolve(MAIN_SRC!)
  const rr = await import(join(root, 'src', 'main', 'ai', 'rag-retrieval.ts'))
  const aq = await import(join(root, 'src', 'main', 'ai', 'audio-query.ts'))
  let libCache: unknown | null = null
  rr.initRagRetrieval({
    libraryCache: {
      get: async () => {
        if (!libCache) libCache = JSON.parse(await readFile(LIB, 'utf-8'))
        return libCache
      },
    },
    libraryPath: () => LIB,
  })

  const rows = JSON.parse(await readFile(queriesPath, 'utf-8')) as Array<string | { query: string; k?: number }>
  for (const r of rows) {
    const query = typeof r === 'string' ? r : r.query
    const k = (typeof r === 'string' ? undefined : r.k) || defaultK
    ragLines = []
    const index = await rr.pickRetrievalIndex(query)
    const hits = await rr.ragRetrieveByQuery(query, k)
    stats.queries++
    process.stdout.write(JSON.stringify({ query, k, index, hits, rag: ragLines }) + '\n')
  }
  const overflowPath = process.env.JT_QVEC_OVERFLOW
  if (overflowPath && stats.fresh > 0) {
    const out: CacheFile = { model: 'text-embedding-3-small', dim: 1536, vectors: overflow }
    await writeFile(overflowPath + '.tmp', JSON.stringify(out))
    await rename(overflowPath + '.tmp', overflowPath)
  }
  process.stdout.write(JSON.stringify({ _stats: { ...stats, texts: [...seenTexts] } }) + '\n')
  // 3d (2026-09-02): the CLAP helper child + its idle timer keep the event
  // loop alive after main() returns — kill it and exit explicitly.
  aq.stopAudioQueryServer()
  process.exit(0)
}
main().catch((e) => { toErr('[bridge] FATAL', e instanceof Error ? e.stack : e); process.exit(1) })
