/**
 * E8's method (measure-only) — on a SCRATCH COPY: re-embed the mood vectors of
 * a seeded sample of N described tracks that also have a grounded lyrics
 * meaning (brain-descriptors.json `m`, written by the trainer from LRCLIB
 * lyrics), using the PRODUCTION mood text (main's buildMoodText).
 *
 *   --arm control   text = buildMoodText(track, descriptor)
 *   --arm meaning   text = buildMoodText(track, descriptor) + "\nmeaning: <m>"
 *                   (the trainer's historical meaning line, e364d7e)
 *
 * Both arms touch the SAME tracks, so control-vs-meaning isolates the meaning
 * line from any text drift. Writes only JT_STATE_DIR/mood-index.bin (refuses the
 * live dirs and symlinks). Usage (from brain-eval/bridge):
 *   JT_STATE_DIR=/tmp/e8-meaning JT_MAIN_SRC=$PWD/.main-src/<sha> \
 *     npx --yes tsx mood-meaning-sample.ts --arm meaning --n 300 --seed 8
 */
import { readFile, writeFile, rename, realpath } from 'fs/promises'
import { existsSync, lstatSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const ARM = arg('arm', '')
const N = Number(arg('n', '300'))
const SEED = Number(arg('seed', '8'))
const STATE = process.env.JT_STATE_DIR || ''
const LIVE = [join(homedir(), 'Library', 'Application Support', 'JakeTunes'), '/Volumes/JakeShared/JakeTunesState']

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function main(): Promise<void> {
  if (ARM !== 'control' && ARM !== 'meaning') throw new Error('--arm control|meaning is required')
  if (!STATE) throw new Error('JT_STATE_DIR (a scratch copy) is required')
  const real = await realpath(STATE)
  for (const l of LIVE) if (existsSync(l) && (await realpath(l)) === real) throw new Error(`${STATE} is a LIVE brain dir — scratch copies only`)
  const moodPath = join(STATE, 'mood-index.bin')
  if (lstatSync(moodPath).isSymbolicLink()) throw new Error(`${moodPath} is a symlink — cp -p it into the scratch dir`)

  const root = resolve(process.env.JT_MAIN_SRC || '')
  const mood = await import(join(root, 'src', 'main', 'ai', 'mood-index.ts'))
  const emb = await import(join(root, 'src', 'main', 'ai', 'embeddings.ts'))
  const lib = JSON.parse(await readFile(join(STATE, 'library.json'), 'utf-8')) as { tracks: Array<Record<string, unknown> & { id: number }> }
  const desc = JSON.parse(await readFile(join(STATE, 'brain-descriptors.json'), 'utf-8')) as Record<string, { d?: string; m?: string }>
  const map = emb.parseEmbeddingsBlob(await readFile(moodPath)) as Map<number, Float32Array>
  const before = map.size

  const pool = lib.tracks
    .filter((t) => map.has(Number(t.id)) && String(desc[String(t.id)]?.d || '').trim() && String(desc[String(t.id)]?.m || '').trim())
    .sort((a, b) => Number(a.id) - Number(b.id))
  const rnd = mulberry32(SEED)
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
  const sample = pool.slice(0, N)
  if (sample.length < N) throw new Error(`only ${sample.length} described tracks with a meaning — need ${N}`)
  const texts = sample.map((t) => {
    const e = desc[String(t.id)]
    const base = mood.buildMoodText(t, e.d) as string
    return ARM === 'meaning' ? `${base}\nmeaning: ${String(e.m).trim()}` : base
  })
  const vecs = (await emb.embedTexts(texts)) as Float32Array[]
  sample.forEach((t, i) => map.set(Number(t.id), vecs[i]))
  const tmp = moodPath + '.E8.tmp'
  await writeFile(tmp, emb.serializeEmbeddingsBlob(map))
  await rename(tmp, moodPath)
  const check = emb.parseEmbeddingsBlob(await readFile(moodPath)) as Map<number, Float32Array>
  if (check.size !== before) throw new Error(`verify failed: ${check.size} != ${before}`)
  await writeFile(join(STATE, `E8-${ARM}-sample-ids.json`), JSON.stringify(sample.map((t) => t.id)))
  process.stderr.write(`[E8] arm=${ARM} re-embedded ${sample.length} mood vectors (seed ${SEED}); index ${check.size} vectors\n`)
}
main().catch((e) => { process.stderr.write(`[E8] FATAL ${e instanceof Error ? e.message : e}\n`); process.exit(1) })
