/**
 * NAS → laptop brain pull. homemini's nightly trainer owns embeddings.bin
 * and mood-index.bin on the NAS; the laptop adopts each new copy instead
 * of pushing its own over it. The decision + merge are pure in
 * src/common/brain-adopt.ts; this file only moves bytes.
 *
 * Cheap when idle: one stat per file per tick. A copy is read (≈68 MB)
 * only when the NAS file's mtime changed since the last one we looked at,
 * and a refused copy is not re-read until the NAS writes a new one.
 */
import { join } from 'path'
import { readFile, stat, writeFile, rename } from 'fs/promises'
import { STATE_DIR, NAS_STATE_DIR_PATH, nasAvailable } from './state-dir'
import { parseEmbeddingsBlob, getEmbeddingsMap, adoptEmbeddingsMap } from './ai/embeddings'
import { getMoodIndexMap, adoptMoodIndexMap } from './ai/mood-index'
import { planBrainAdopt, assertNoBrainPush } from '../common/brain-adopt'

interface PullState { [file: string]: { nasMtimeMs: number; adopted: boolean; at: string; note: string } }

const STATE_PATH = (): string => join(STATE_DIR, 'brain-pull-state.json')

async function readState(): Promise<PullState> {
  try { return JSON.parse(await readFile(STATE_PATH(), 'utf8')) as PullState } catch { return {} }
}
async function writeState(s: PullState): Promise<void> {
  const tmp = `${STATE_PATH()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 2))
  await rename(tmp, STATE_PATH())
}

const FILES = [
  { name: 'embeddings.bin', getLocal: getEmbeddingsMap, adopt: adoptEmbeddingsMap },
  { name: 'mood-index.bin', getLocal: getMoodIndexMap, adopt: adoptMoodIndexMap },
] as const

let busy = false

export async function pullBrainFromNas(getLibraryIds: () => Promise<Set<number>>): Promise<void> {
  if (busy) return
  if (!(await nasAvailable())) return
  busy = true
  try {
    const state = await readState()
    let changed = false
    for (const f of FILES) {
      const nasPath = join(NAS_STATE_DIR_PATH, f.name)
      const st = await stat(nasPath).catch(() => null)
      if (!st || state[f.name]?.nasMtimeMs === st.mtimeMs) continue
      const buf = await readFile(nasPath)
      const headerCount = buf.length >= 12 ? buf.readUInt32LE(8) : 0
      const nas = parseEmbeddingsBlob(buf)
      const plan = planBrainAdopt(headerCount, nas, await f.getLocal(), await getLibraryIds())
      if (plan.adopt && plan.merged) {
        await f.adopt(plan.merged)
        console.log(`[brain-pull] adopted homemini's ${f.name}: ${nas.size} trained vectors + ${plan.keptLocal} from this Mac's fresh imports = ${plan.merged.size}`)
      } else {
        console.warn(`[brain-pull] NOT adopting ${f.name}: ${plan.reason}. Keeping this Mac's copy until the NAS writes a new one.`)
      }
      state[f.name] = { nasMtimeMs: st.mtimeMs, adopted: plan.adopt, at: new Date().toISOString(), note: plan.reason }
      changed = true
    }
    if (changed) await writeState(state)
  } catch (err) {
    console.warn('[brain-pull] failed (will retry next tick):', err instanceof Error ? err.message : err)
  } finally {
    busy = false
  }
}

/**
 * Boot + every 10 minutes. `pushList` is the auto-backup list; checking it
 * here makes re-adding a brain file to the push a boot error.
 */
export function startBrainPull(getLibraryIds: () => Promise<Set<number>>, nasUp: boolean, pushList: readonly string[]): void {
  assertNoBrainPush(pushList, 'STATE_FILE_NAMES')
  if (nasUp) void pullBrainFromNas(getLibraryIds)
  setInterval(() => { void pullBrainFromNas(getLibraryIds) }, 10 * 60_000)
}
