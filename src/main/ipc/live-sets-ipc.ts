/**
 * Live Concert IPC: live-sets sidecar, crowd tuning, live-set merge +
 * scratch cleanup (V5 Live Concert Mode).
 *
 * Extracted from main/index.ts (6.0 Phase 1 IPC migration) — bodies
 * verbatim; sidecar cache + artwork index arrive via the host.
 */
import { app } from 'electron'
import { join } from 'path'
import { copyFile, mkdir, readFile, stat, writeFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { IS_WINDOWS } from '../platform'
import { STATE_DIR, NAS_STATE_DIR_PATH } from '../state-dir'
import { allowImportPaths } from '../import-allowlist.ts'
import { safeIpcError } from '../safe-ipc-error'
import type { LiveSetEntry } from '../index.ts'

export interface LiveSetsIpcHost {
  getMusicDir: () => string
  liveSetsCache: {
    get: () => Promise<Record<string, LiveSetEntry>>
    update: (fn: (sets: Record<string, LiveSetEntry>) => Record<string, LiveSetEntry>) => Promise<void>
  }
  artworkHash: (artist: string, album: string) => string
  loadArtworkIndex: () => Promise<Record<string, string>>
  saveArtworkIndex: (index: Record<string, string>) => Promise<void>
}

export function registerLiveSetsIpc(ipc: IpcRegistrar, host: LiveSetsIpcHost): void {
  // ─────────────────────────────────────────────────────────────────────
  // V5 Live Concert Mode — merge a declared live album into one gapless
  // ALAC "live set" + sidecar cue data. See src/main/live-set-merge.ts
  // for the engine; these handlers own IPC, path conversion, artwork
  // aliasing, and the sidecar. The renderer owns the import + library
  // steps (same division of labor as CD rip).
  // ─────────────────────────────────────────────────────────────────────

  function liveSetScratchDir(): string {
    return join(STATE_DIR, 'live-set-scratch')
  }

  ipc.handle('load-live-sets', async () => {
    const sets = await host.liveSetsCache.get()
    return { ok: true, sets }
  }, { public: true })

  ipc.handle('save-live-set', async (_e, albumKey: string, entry: LiveSetEntry) => {
    if (!albumKey || !entry || typeof entry.mergedTrackId !== 'number' || !Array.isArray(entry.cues)) {
      return { ok: false, error: 'invalid live-set entry' }
    }
    await host.liveSetsCache.update((sets) => ({ ...sets, [albumKey]: entry }))
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('remove-live-set', async (_e, albumKey: string) => {
    await host.liveSetsCache.update((sets) => {
      const next = { ...sets }
      delete next[albumKey]
      return next
    })
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  // Concert crowd ambience (LC-7): serve the short "that night's crowd" clip
  // extracted from the show's own between-song gap. Stored per merged-track-id in
  // userData/concert-crowd/<id>.m4a. Returns base64 (renderer makes a Blob URL) or
  // null when a show has no clip — the crowd layer then simply does nothing.
  ipc.handle('get-concert-crowd', async (_e, mergedTrackId: number): Promise<string | null> => {
    try {
      const p = join(app.getPath('userData'), 'concert-crowd', `${mergedTrackId}.m4a`)
      const buf = await readFile(p)
      return buf.toString('base64')
    } catch { return null }
  }, { public: true })
  // The crowd clip itself, cut from the show's own tape (concert-crowd-extract).
  // Renderer passes the merged track's colon path + cue starts; the clip
  // lands where get-concert-crowd already looks. Idempotent per merged id.
  const crowdInFlight = new Map<number, Promise<{ ok: boolean; error?: string; startSec?: number }>>()
  ipc.handle('extract-concert-crowd', async (_e, mergedTrackId: number, colonPath: string, cueStartsMs: number[], totalMs: number) => {
    const existing = crowdInFlight.get(mergedTrackId)
    if (existing) return existing
    const job = (async () => {
      try {
        const { extractCrowdClip } = await import('../concert-crowd-extract.ts')
        const LOCAL_MOUNT = host.getMusicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
        const src = join(LOCAL_MOUNT, String(colonPath || '').replace(/:/g, IS_WINDOWS ? '\\' : '/'))
        const out = join(app.getPath('userData'), 'concert-crowd', `${mergedTrackId}.m4a`)
        const r = await extractCrowdClip(src, cueStartsMs, totalMs, out)
        console.log(`[concert-crowd] ${mergedTrackId}: clip cut at ${r.startSec}s (score ${r.score.toFixed(2)}, ${r.scanned} windows)`)
        // Mirror the clip into the NAS state dir so the phone's backend
        // (homemini, STATE_DIR = NAS) can serve it: GET /api/live-sets/:id/crowd.
        // Best effort — the NAS being away never fails the extraction.
        try {
          const nasDir = join(NAS_STATE_DIR_PATH, 'concert-crowd')
          await mkdir(nasDir, { recursive: true })
          await copyFile(out, join(nasDir, `${mergedTrackId}.m4a`))
        } catch (e) { console.warn('[concert-crowd] NAS mirror skipped:', e instanceof Error ? e.message : e) }
        return { ok: true, startSec: r.startSec }
      } catch (err) {
        console.warn('[concert-crowd] extraction failed:', err instanceof Error ? err.message : err)
        return { ok: false, error: safeIpcError(err, 'unknown') }
      } finally { crowdInFlight.delete(mergedTrackId) }
    })()
    crowdInFlight.set(mergedTrackId, job)
    return job
  }, { refuse: REFUSED_SENDER })
  // Crowd tuning knobs (level / rise / tail) — persisted so the user's by-ear dial-in sticks.
  function crowdTuningPath(): string { return join(app.getPath('userData'), 'concert-crowd-tuning.json') }
  ipc.handle('save-crowd-tuning', async (_e, t: Record<string, number>): Promise<{ ok: boolean }> => {
    try { await writeFile(crowdTuningPath(), JSON.stringify(t, null, 2), 'utf-8') } catch { /* best effort */ }
    return { ok: true }
  }, { refuse: { ok: false } })
  ipc.handle('load-crowd-tuning', async (): Promise<Record<string, number> | null> => {
    try { return JSON.parse(await readFile(crowdTuningPath(), 'utf-8')) } catch { return null }
  }, { public: true })

  ipc.handle('live-set-merge', async (
    event,
    tracks: Array<{ id: number; title: string; artist: string; path: string; durationMs: number }>,
    album: { name: string; artist: string; genre?: string; year?: string | number },
  ) => {
    const { mergeLiveSet } = await import('../live-set-merge')
    // Colon-notation library paths → absolute, same conversion the
    // save-library unlink path uses.
    const LOCAL_MOUNT = host.getMusicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const pathSep = IS_WINDOWS ? '\\' : '/'
    const inputs = tracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
      absPath: join(LOCAL_MOUNT, String(t.path || '').replace(/:/g, pathSep)),
    }))
    try {
      const result = await mergeLiveSet(inputs, album, liveSetScratchDir(), (p: unknown) => {
        event.sender.send('live-set-progress', p)
      })
      // Artwork alias: the "(Live Set)" album inherits the source album's
      // cover — same JPG on disk, second index key. Best-effort; a missing
      // source entry just means the resolver's fallback chain runs later.
      try {
        const index = await host.loadArtworkIndex()
        const srcKey = `${album.artist.toLowerCase().trim()}|||${album.name.toLowerCase().trim()}`
        const liveKey = `${album.artist.toLowerCase().trim()}|||${`${album.name} (Live Set)`.toLowerCase().trim()}`
        if (index[srcKey] && !index[liveKey]) {
          await host.saveArtworkIndex({ ...index, [liveKey]: index[srcKey] })
        }
      } catch (err) {
        console.warn('[live-set] artwork alias failed (non-fatal):', err instanceof Error ? err.message : err)
      }
      allowImportPaths([result.mergedPath])  // scratch output must be importable — no grant source covers it (2026-08-30: declare died post-merge on path-not-allowed)
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })

  // Post-import cleanup of the merged source file. Identity-gated: only
  // paths inside OUR scratch dir are deletable — a confused caller can't
  // aim this at library audio.
  ipc.handle('live-set-cleanup', async (_e, absPath: string) => {
    const scratch = liveSetScratchDir()
    const normalized = String(absPath || '')
    if (!normalized.startsWith(scratch + (IS_WINDOWS ? '\\' : '/'))) {
      return { ok: false, error: 'path outside live-set scratch dir' }
    }
    const { rm } = await import('fs/promises')
    await rm(normalized, { force: true }).catch(() => {})
    return { ok: true }
  }, { refuse: REFUSED_SENDER })
}
