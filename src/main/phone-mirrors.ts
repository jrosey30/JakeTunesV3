/**
 * Phone-authored sidecar mirrors + phone-download audio arrival
 * (2026-08-30 — "do a better job of adding the songs i download on
 * mobile to the library").
 *
 * The old mirror rode the MacBook's NAS mount, which flaps (nas-breaker
 * cycling every ~20 minutes) — measured NINE DAYS stale while phone
 * downloads sat invisible on the NAS. homemini answers over HTTP from
 * anywhere, office or home, so the mirror now goes:
 *
 *   1. HTTP first — GET /api/phone-sidecars/:name from the backend
 *      (newest readable copy, served read-only by the single writer).
 *   2. NAS fallback — the old copy path, only when HTTP misses.
 *
 * And the AUDIO half: a phone download's bytes used to arrive only via
 * the 60-second rsync return-leg (home-LAN only, killed at the office by
 * the remote gates). ensureMobileImportAudio pulls each pending track's
 * file straight from homemini's /audio/:id — identity-addressed, never
 * overwriting, path-gated inside iPod_Control — so the absorb hands the
 * renderer rows whose audio is already on disk.
 *
 * Electron-free: deps injected, node --test loads it.
 */
import { readFile, writeFile, rename, stat, mkdir } from 'fs/promises'
import type { Stats } from 'fs'
import { join, dirname } from 'path'
import { withCompanionInit } from './hub-companion.ts'

export interface PhoneMirrorDeps {
  files: string[]
  localDir: string
  nasDir: string
  backendUrl: string
  nasAvailable: () => Promise<boolean>
  fetchFn?: typeof fetch
  log?: (m: string) => void
  /**
   * Files MERGED into this Mac's state instead of copied over it (2026-10-20:
   * mobile-stars.json — a copy wiped the stars made here and not yet
   * anywhere else). The merger owns the local file; it gets the source's
   * body whenever the source changed since the last merge. Never listed in
   * the returned names, so no cache is dropped under a pending write.
   */
  merge?: Partial<Record<string, (body: string) => Promise<void>>>
}

/** Source mtime last merged, per local path (process lifetime; the first tick always merges). */
const mergedSourceMtime = new Map<string, number>()

async function mergeIfChanged(deps: PhoneMirrorDeps, name: string, mtimeMs: number, body: () => Promise<string>): Promise<boolean> {
  const merger = deps.merge?.[name]
  if (!merger) return false
  const key = join(deps.localDir, name)
  if (mergedSourceMtime.get(key) === mtimeMs) return true
  const text = await body()
  JSON.parse(text)   // a torn payload must never reach the merge
  await merger(text)
  mergedSourceMtime.set(key, mtimeMs)
  deps.log?.(`[phone-mirrors] merged ${name} (never copied over the local file)`)
  return true
}

/** Returns the placed file's stat, taken BEFORE the rename (rename keeps
 *  mtime and size), so a writer racing in right after can't pass as ours. */
async function writeAtomic(dest: string, body: string | Buffer): Promise<Stats> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, body)
  const placed = await stat(tmp)
  await rename(tmp, dest)
  return placed
}

// ── Which source version each mirror holds (2026-10-20) ─────────────
// A mirror's own mtime is when WE wrote it, not the source's mtime, so
// "source newer than local + 1s" skipped a phone edit landing within a
// second after a mirror write — and kept skipping it until the phone
// touched that file again (found testing phone playlist sync, #209).
// Compare like with like: remember the source mtime we mirrored, plus the
// local mtime + size we produced. While the local copy is still exactly
// that, any newer source mtime wins. Anything else (no record yet, or the
// app wrote the file itself — it does write mobile-stars.json) keeps the
// old guard, so a local write is never made easier to replace.
//
// V3-private and local-only: never in STATE_FILE_NAMES or the sync lists.
// We never utimes() the mirrors instead — the homemini sync script pushes
// some of them with `rsync --update`, which reads those mtimes.
const MIRROR_SOURCES_FILE = 'phone-mirrors-sources.json'

interface MirroredSource { sourceMtimeMs: number; localMtimeMs: number; size: number }

/** Should a source at `sourceMtimeMs` replace the local mirror? */
function sourceIsNewer(
  sourceMtimeMs: number,
  local: { mtimeMs: number; size: number } | null,
  mirrored: MirroredSource | undefined,
): boolean {
  if (!local) return true
  if (mirrored && mirrored.localMtimeMs === local.mtimeMs && mirrored.size === local.size) {
    return sourceMtimeMs > mirrored.sourceMtimeMs
  }
  return sourceMtimeMs > local.mtimeMs + 1000
}

async function readMirroredSources(path: string): Promise<Record<string, MirroredSource>> {
  const out: Record<string, MirroredSource> = {}
  let raw: unknown
  try { raw = JSON.parse(await readFile(path, 'utf-8')) } catch { return out }   // none yet / unreadable → old guard everywhere
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, v] of Object.entries(raw as Record<string, Partial<MirroredSource>>)) {
    if (Number.isFinite(v?.sourceMtimeMs) && Number.isFinite(v?.localMtimeMs) && Number.isFinite(v?.size)) {
      out[name] = { sourceMtimeMs: v.sourceMtimeMs!, localMtimeMs: v.localMtimeMs!, size: v.size! }
    }
  }
  return out
}

/** Mirror every phone-authored file that is newer at the source. HTTP
 *  first, NAS fallback. Returns the names that actually refreshed. */
export async function refreshPhoneMirrors(deps: PhoneMirrorDeps): Promise<string[]> {
  const fetchFn = deps.fetchFn ?? fetch
  const refreshed: string[] = []
  const viaNas: string[] = []
  const sourcesPath = join(deps.localDir, MIRROR_SOURCES_FILE)
  const mirrored = await readMirroredSources(sourcesPath)
  const place = async (name: string, body: string, sourceMtimeMs: number): Promise<void> => {
    const placed = await writeAtomic(join(deps.localDir, name), body)
    mirrored[name] = { sourceMtimeMs, localMtimeMs: placed.mtimeMs, size: placed.size }
    refreshed.push(name)
  }

  for (const name of deps.files) {
    const localPath = join(deps.localDir, name)
    let done = false
    try {
      const res = await fetchFn(`${deps.backendUrl}/api/phone-sidecars/${encodeURIComponent(name)}`, withCompanionInit({ signal: AbortSignal.timeout(8000) }))
      if (res.ok) {
        const d = await res.json() as { mtimeMs?: number; body?: string }
        if (typeof d.body === 'string' && typeof d.mtimeMs === 'number') {
          const body = d.body
          if (await mergeIfChanged(deps, name, d.mtimeMs, async () => body)) {
            done = true
            continue
          }
          const localStat = await stat(localPath).catch(() => null)
          if (sourceIsNewer(d.mtimeMs, localStat, mirrored[name])) {
            JSON.parse(d.body)   // a torn payload must never replace a good mirror
            await place(name, d.body, d.mtimeMs)
          }
          done = true   // HTTP answered authoritatively (fresh or already-current)
        }
      }
    } catch { /* backend unreachable — NAS gets its turn */ }
    if (done) continue
    viaNas.push(name)
  }

  if (viaNas.length > 0 && await deps.nasAvailable()) {
    try {
      await stat(deps.nasDir)
      for (const name of viaNas) {
        try {
          const nasPath = join(deps.nasDir, name)
          const localPath = join(deps.localDir, name)
          const nasStat = await stat(nasPath)
          if (await mergeIfChanged(deps, name, nasStat.mtimeMs, () => readFile(nasPath, 'utf-8'))) continue
          const localStat = await stat(localPath).catch(() => null)
          if (sourceIsNewer(nasStat.mtimeMs, localStat, mirrored[name])) {
            const body = await readFile(nasPath, 'utf-8')
            JSON.parse(body)
            await place(name, body, nasStat.mtimeMs)
          }
        } catch { /* per-file best effort */ }
      }
    } catch { /* NAS asleep — keep what we have */ }
  }
  if (refreshed.length > 0) {
    // Losing this write only costs the old guard next pass: a stale entry's
    // local mtime no longer matches, so sourceIsNewer falls back.
    await writeAtomic(sourcesPath, JSON.stringify(mirrored, null, 2))
      .catch((err) => deps.log?.(`[phone-mirrors] could not record mirrored sources: ${err instanceof Error ? err.message : err}`))
    deps.log?.(`[phone-mirrors] refreshed ${refreshed.length} file(s): ${refreshed.join(', ')}`)
  }
  return refreshed
}

export interface MobileImportRow { id?: unknown; path?: unknown; title?: unknown }

/**
 * Pull any pending phone-download audio that is missing locally, straight
 * from homemini. Identity-addressed by the row's own id; the destination
 * comes from the row's own path, gated inside iPod_Control; an existing
 * file is never touched. Returns how many files landed.
 *
 * Not the laptop import pipeline. The phone already chose the container
 * and the path is the identity the sidecar shares with the catalog.
 * Re-encoding a FLAC to ALAC here would rename the file out from under
 * that path, and the next poll would download it again. Laptop streamrip,
 * inbox, and drag-drop go through importOneFile, which converts lossless
 * sources to the library format (default ALAC).
 */
export async function ensureMobileImportAudio(
  rows: MobileImportRow[],
  opts: { libraryRoot: string; backendUrl: string; fetchFn?: typeof fetch; log?: (m: string) => void },
): Promise<number> {
  const fetchFn = opts.fetchFn ?? fetch
  let pulled = 0
  for (const row of rows) {
    const id = row?.id
    const colon = String(row?.path || '')
    if (id == null || !colon.startsWith(':iPod_Control:')) continue
    const rel = colon.slice(1).split(':').join('/')
    if (rel.includes('..')) continue                     // a row's path can never escape the library
    const dest = join(opts.libraryRoot, rel)
    const have = await stat(dest).catch(() => null)
    if (have && have.size > 0) continue                  // already here — never overwrite
    try {
      const res = await fetchFn(`${opts.backendUrl}/audio/${encodeURIComponent(String(id))}`, withCompanionInit({ signal: AbortSignal.timeout(5 * 60_000) }))
      if (!res.ok) { opts.log?.(`[phone-mirrors] audio ${id} → ${res.status} (rsync return-leg will retry)`); continue }
      const buf = Buffer.from(await res.arrayBuffer())
      const want = Number(res.headers.get('content-length')) || 0
      if (buf.length === 0 || (want > 0 && buf.length !== want)) { opts.log?.(`[phone-mirrors] audio ${id} short read — refused`); continue }
      await writeAtomic(dest, buf)
      pulled++
      opts.log?.(`[phone-mirrors] pulled audio for “${String(row?.title ?? id)}” (${(buf.length / 1e6).toFixed(1)} MB)`)
    } catch (err) {
      opts.log?.(`[phone-mirrors] audio ${id} pull failed: ${err instanceof Error ? err.message : err}`)
    }
  }
  return pulled
}
