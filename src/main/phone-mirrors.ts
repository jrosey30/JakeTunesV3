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
import { join, dirname } from 'path'

export interface PhoneMirrorDeps {
  files: string[]
  localDir: string
  nasDir: string
  backendUrl: string
  nasAvailable: () => Promise<boolean>
  fetchFn?: typeof fetch
  log?: (m: string) => void
}

async function writeAtomic(dest: string, body: string | Buffer): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, body)
  await rename(tmp, dest)
}

/** Mirror every phone-authored file that is newer at the source. HTTP
 *  first, NAS fallback. Returns the names that actually refreshed. */
export async function refreshPhoneMirrors(deps: PhoneMirrorDeps): Promise<string[]> {
  const fetchFn = deps.fetchFn ?? fetch
  const refreshed: string[] = []
  const viaNas: string[] = []

  for (const name of deps.files) {
    const localPath = join(deps.localDir, name)
    const localStat = await stat(localPath).catch(() => null)
    let done = false
    try {
      const res = await fetchFn(`${deps.backendUrl}/api/phone-sidecars/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const d = await res.json() as { mtimeMs?: number; body?: string }
        if (typeof d.body === 'string' && typeof d.mtimeMs === 'number') {
          if (!localStat || d.mtimeMs > localStat.mtimeMs + 1000) {
            JSON.parse(d.body)   // a torn payload must never replace a good mirror
            await writeAtomic(localPath, d.body)
            refreshed.push(name)
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
          const localStat = await stat(localPath).catch(() => null)
          if (!localStat || nasStat.mtimeMs > localStat.mtimeMs + 1000) {
            const body = await readFile(nasPath, 'utf-8')
            JSON.parse(body)
            await writeAtomic(localPath, body)
            refreshed.push(name)
          }
        } catch { /* per-file best effort */ }
      }
    } catch { /* NAS asleep — keep what we have */ }
  }
  if (refreshed.length > 0) deps.log?.(`[phone-mirrors] refreshed ${refreshed.length} file(s): ${refreshed.join(', ')}`)
  return refreshed
}

export interface MobileImportRow { id?: unknown; path?: unknown; title?: unknown }

/**
 * Pull any pending phone-download audio that is missing locally, straight
 * from homemini. Identity-addressed by the row's own id; the destination
 * comes from the row's own path, gated inside iPod_Control; an existing
 * file is never touched. Returns how many files landed.
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
      const res = await fetchFn(`${opts.backendUrl}/audio/${encodeURIComponent(String(id))}`, { signal: AbortSignal.timeout(5 * 60_000) })
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
