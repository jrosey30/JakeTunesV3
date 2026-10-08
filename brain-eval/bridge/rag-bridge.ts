/**
 * brain-eval production-path bridge.
 *
 * Runs the REAL desktop retrieval code — router (pickRetrievalIndex),
 * ragRetrieveByQuery, mood index, decade hard-gate — outside Electron,
 * via the local electron stub in ./node_modules. Reads a JSON array of
 * queries on argv[2] (path to a file), emits JSON lines:
 *   {"query": "...", "index": "main"|"mood", "hits": [{"trackId": n, "score": x}]}
 *
 * READ-ONLY: touches nothing but library.json/embeddings.bin/mood-index.bin
 * reads and the OpenAI embed API (key from env).
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import {
  initRagRetrieval, pickRetrievalIndex, ragRetrieveByQuery,
} from '../../src/main/ai/rag-retrieval.ts'
import { stopAudioQueryServer } from '../../src/main/ai/audio-query.ts'

const STATE_DIR = process.env.JT_STATE_DIR
  || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIB = join(STATE_DIR, 'library.json')

let libCache: unknown | null = null
initRagRetrieval({
  libraryCache: {
    get: async () => {
      if (!libCache) libCache = JSON.parse(await readFile(LIB, 'utf-8'))
      return libCache
    },
  },
  libraryPath: () => LIB,
})

async function main(): Promise<void> {
  const [, , queriesPath, kArg] = process.argv
  const k = Number(kArg) || 25
  const queries: string[] = JSON.parse(await readFile(queriesPath, 'utf-8'))
  for (const query of queries) {
    const index = await pickRetrievalIndex(query)
    const hits = await ragRetrieveByQuery(query, k)
    console.log(JSON.stringify({ query, index, hits }))
  }
  // 3d (2026-09-02): with JT_AUDIO_ROUTE set, the CLAP helper child and
  // its 10-minute idle timer kept the event loop alive after main()
  // returned — run_eval's 300 s wait expired and the whole production
  // bucket was SKIPPED. Kill the helper and exit explicitly.
  stopAudioQueryServer()
  process.exit(0)
}
void main()
