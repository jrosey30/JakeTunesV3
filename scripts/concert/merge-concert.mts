// Headless live-set merge (recipe v2, re-created 2026-10-08 — the 9/2 copy
// lived in a scratch folder and was lost):
//   cd ~/JakeTunesV3 && JT_REPO_ROOT=$PWD npx tsx --import ./scripts/concert/shim-register.mjs \
//     scripts/concert/merge-concert.mts <scratchDir> <out.json> "<artist>" "<album>" <id> <id> ...
// Reads the laptop's library.json, resolves each id's audio under the library
// root, runs src/main/live-set-merge.ts mergeLiveSet (decode → concat → ALAC),
// and writes {mergedPath, cues, totalDurationMs} to out.json. NO app involvement.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeLiveSet, type LiveSetMergeInput } from '../../src/main/live-set-merge.ts'

const [scratchDir, outJson, artist, album, ...idArgs] = process.argv.slice(2)
if (!scratchDir || !outJson || !artist || !album || idArgs.length === 0) {
  console.error('usage: merge-concert.mts <scratchDir> <out.json> <artist> <album> <id...>')
  process.exit(2)
}
const userData = process.env.JT_USER_DATA || `${process.env.HOME}/Library/Application Support/JakeTunes`
const libraryRoot = process.env.JT_LIBRARY_ROOT || `${process.env.HOME}/Music2/JakeTunesLibrary`
const lib = JSON.parse(await readFile(join(userData, 'library.json'), 'utf-8')) as { tracks: Array<Record<string, unknown>> }
const byId = new Map(lib.tracks.map((t) => [Number(t.id), t]))
const ids = idArgs.map((s) => Number(s))
const inputs: LiveSetMergeInput[] = ids.map((id) => {
  const t = byId.get(id)
  if (!t) throw new Error(`id ${id} not in library.json`)
  const colon = String(t.path || '')
  const absPath = join(libraryRoot, ...colon.replace(/^:/, '').split(':'))
  return { id, title: String(t.title || ''), artist: String(t.artist || artist), absPath, durationMs: Number(t.duration || 0) }
})
for (const i of inputs) console.error(`  ${i.id}  ${i.title}  ${(i.durationMs / 1000).toFixed(1)}s  ${i.absPath}`)
const year = byId.get(ids[0])?.year
const result = await mergeLiveSet(inputs, { name: album, artist, year: year as string | number | undefined }, scratchDir,
  (p) => console.error(`[${p.stage}] ${p.current}/${p.total} ${p.label}`))
await writeFile(outJson, JSON.stringify(result, null, 2), 'utf-8')
console.error(`merged → ${result.mergedPath}  (${(result.totalDurationMs / 60000).toFixed(1)} min, ${result.cues.length} cues)`)
