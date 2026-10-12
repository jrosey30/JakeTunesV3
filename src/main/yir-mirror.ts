/**
 * Year in Review on this machine (2026-10-12, Jake: "build it").
 *
 * The facts are built every night at 04:00 on homemini, which holds the one
 * merged listening history (laptop + workmini + phone + iPod), and land in
 * homemini's yir/ plus a NAS copy (scripts/listening-history-nightly.sh). The
 * app shows them from a local mirror, userData/yir/year-in-review-<year>.json,
 * kept fresh the same way the phone sidecars are (phone-mirrors.ts):
 *
 *   1. HTTP first: GET /api/year-in-review/:year from the backend.
 *   2. NAS fallback: JakeTunesState/yir/year-in-review-<year>.json.
 *
 * A torn or non-JSON payload never replaces a good mirror. Electron-free:
 * deps injected, node --test loads it.
 */
import { readFile, writeFile, rename, stat, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { withCompanionInit } from './hub-companion.ts'

export interface YirMirrorDeps {
  year: number
  localDir: string
  nasDir: string
  backendUrl: string
  nasAvailable: () => Promise<boolean>
  fetchFn?: typeof fetch
}

export const yirFileName = (year: number): string => `year-in-review-${year}.json`
export const yirLocalPath = (localDir: string, year: number): string => join(localDir, 'yir', yirFileName(year))

async function writeAtomic(dest: string, body: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, body)
  await rename(tmp, dest)
}

/** Refresh the local mirror when the source copy is newer. Returns where
 *  the fresh copy came from, or null when nothing changed. */
export async function refreshYirMirror(deps: YirMirrorDeps): Promise<'http' | 'nas' | null> {
  const fetchFn = deps.fetchFn ?? fetch
  const localPath = yirLocalPath(deps.localDir, deps.year)
  const localStat = await stat(localPath).catch(() => null)
  const newer = (mtimeMs: number): boolean => !localStat || mtimeMs > localStat.mtimeMs + 1000

  try {
    const res = await fetchFn(`${deps.backendUrl}/api/year-in-review/${deps.year}`, withCompanionInit({ signal: AbortSignal.timeout(8000) }))
    if (res.ok) {
      const d = await res.json() as { mtimeMs?: number; body?: string }
      if (typeof d.body === 'string' && typeof d.mtimeMs === 'number') {
        if (!newer(d.mtimeMs)) return null
        JSON.parse(d.body)
        await writeAtomic(localPath, d.body)
        return 'http'
      }
    }
  } catch { /* backend unreachable or no route yet — the NAS gets its turn */ }

  if (!(await deps.nasAvailable())) return null
  try {
    const nasPath = join(deps.nasDir, 'yir', yirFileName(deps.year))
    const nasStat = await stat(nasPath)
    if (!newer(nasStat.mtimeMs)) return null
    const body = await readFile(nasPath, 'utf-8')
    JSON.parse(body)
    await writeAtomic(localPath, body)
    return 'nas'
  } catch { return null }
}

/** The mirrored facts, or null when this machine has never received them. */
export async function readYirMirror(localDir: string, year: number): Promise<{ builtAt?: string } & Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(yirLocalPath(localDir, year), 'utf-8')) } catch { return null }
}
