/**
 * Live Concert IPC: live-sets sidecar, crowd tuning, live-set merge +
 * scratch cleanup (V5 Live Concert Mode).
 *
 * Extracted from main/index.ts (6.0 Phase 1 IPC migration) — bodies
 * verbatim; sidecar cache + artwork index arrive via the host.
 */
import { app } from 'electron'
import { join } from 'path'
import { readFile, rm, stat, writeFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { IS_WINDOWS } from '../platform'
import { STATE_DIR, NAS_STATE_DIR_PATH, nasAvailable } from '../state-dir'
import { mirrorCrowdClipToNas } from '../concert-crowd-mirror.ts'
import { allowImportPaths } from '../import-allowlist.ts'
import { safeIpcError } from '../safe-ipc-error'
import { getArtworkDir, invalidateArtBytes, nativeThumbJpeg } from '../artwork-engine.ts'
import { concertArtworkKeys, startReplicaConcertSync, type ReplicaTrackRow } from '../replica-concerts.ts'
import {
  startReplicaArtworkMirror, recentAlbumKeys, THIN_LINK_PACE_BYTES_PER_SEC, FAT_LINK_PACE_BYTES_PER_SEC, type RecentRow,
} from '../replica-artwork-mirror.ts'
import { pregenerateThumbs } from '../album-art-serve.ts'
import { coverFileName, installPosterImage, posterInStore, renderPosterForShow, withPosterKeys, type InstalledPoster, type PosterFields } from '../concert-poster.ts'
import { parseConcertMeta } from '../../common/concert-meta.ts'
import { triggerSync } from '../sync-orchestrator'
import type { LiveSetEntry } from '../index.ts'

export interface LiveSetsIpcHost {
  getMusicDir: () => string
  liveSetsCache: {
    get: () => Promise<Record<string, LiveSetEntry>>
    update: (fn: (sets: Record<string, LiveSetEntry>) => Record<string, LiveSetEntry>) => Promise<void>
    set: (next: Record<string, LiveSetEntry>) => void
  }
  artworkHash: (artist: string, album: string) => string
  loadArtworkIndex: () => Promise<Record<string, string>>
  saveArtworkIndex: (index: Record<string, string>) => Promise<void>
  /** Hub origin on a replica (workmini), null on the canonical laptop. A
   *  replica's live sets, concert posters and crowd clips MIRROR the laptop's
   *  through homemini (src/main/replica-concerts.ts). */
  replicaHubBase: () => Promise<string | null>
  /** This machine's library rows (each concert's band/show for its poster key). */
  libraryTracks: () => Promise<readonly unknown[]>
  sendToRenderer: (channel: string, ...args: unknown[]) => void
  /** The full artwork mirror yields to music and paces itself on thin links. */
  isPlaybackActive: () => boolean
  linkIsThin: () => Promise<boolean>
}

/** Why a replica refuses a live-set write: the next hub pull would undo it. */
export const REPLICA_LIVE_SETS_READ_ONLY = 'live sets on this machine mirror the laptop (through homemini) — change concerts on the laptop'

export function registerLiveSetsIpc(ipc: IpcRegistrar, host: LiveSetsIpcHost): void {
  // Replica concert mirror (2026-10-19, Jake: "the workmini should mimic the
  // live concert thing exactly"): inert on the laptop (no hub base).
  // The FULL artwork mirror (2026-10-19, "eye for eye"): every key + jpg of the
  // laptop's store through homemini, concert posters first. Inert on the laptop.
  const artMirror = startReplicaArtworkMirror({
    hubBase: host.replicaHubBase,
    artwork: { dir: getArtworkDir(), loadIndex: host.loadArtworkIndex, saveIndex: host.saveArtworkIndex },
    invalidate: invalidateArtBytes,
    priorityKeys: async () => {
      const rows = (await host.libraryTracks()) as ReplicaTrackRow[]
      return [...concertArtworkKeys(await host.liveSetsCache.get(), rows), ...recentAlbumKeys(rows as RecentRow[])]
    },
    isPlaying: host.isPlaybackActive,
    paceBytesPerSec: async () => ((await host.linkIsThin()) ? THIN_LINK_PACE_BYTES_PER_SEC : FAT_LINK_PACE_BYTES_PER_SEC),
    notify: (u) => host.sendToRenderer('artwork-mirror-updated', u),
    onLanded: (bares) => { void pregenerateThumbs({ artworkDir: getArtworkDir, makeThumb: nativeThumbJpeg, only: bares }) },
  })
  setTimeout(() => { void artMirror.tick() }, 45_000)
  const replica = startReplicaConcertSync({
    hubBase: host.replicaHubBase,
    liveSets: { get: () => host.liveSetsCache.get(), set: (next) => host.liveSetsCache.set(next as Record<string, LiveSetEntry>) },
    tracks: host.libraryTracks,
    artwork: { dir: getArtworkDir(), loadIndex: host.loadArtworkIndex, saveIndex: host.saveArtworkIndex, invalidate: invalidateArtBytes },
    postersCoveredElsewhere: artMirror.active,
    crowdDir: join(app.getPath('userData'), 'concert-crowd'),
    notify: (u) => host.sendToRenderer('live-sets-updated', u),
  })
  setTimeout(() => { void replica.tick() }, 12_000)
  const isReplica = async (): Promise<boolean> => (await host.replicaHubBase()) !== null

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
    if (await isReplica()) return { ok: false, error: REPLICA_LIVE_SETS_READ_ONLY }
    await host.liveSetsCache.update((sets) => ({ ...sets, [albumKey]: entry }))
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('remove-live-set', async (_e, albumKey: string) => {
    // A replica never deletes a set: its library can briefly lack a merged
    // row mid-adopt, and the renderer's self-heal would sweep the concert.
    if (await isReplica()) return { ok: false, error: REPLICA_LIVE_SETS_READ_ONLY }
    await host.liveSetsCache.update((sets) => {
      const next = { ...sets }
      delete next[albumKey]
      return next
    })
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  // ── The poster rule (src/common/concert-poster.ts) ────────────────────────
  // A poster sits under its OWN artwork key. A drop used to go through
  // set-custom-artwork onto the album's key, which replaced the album's cover:
  // that is why Unplugged and Stop Making Sense showed a cropped poster on the
  // Albums tab. These two write the artwork store only and hand back the
  // concert.* fields; the renderer saves those through updateConcertMeta, like
  // every other concert field, so its copy of the sets stays the one in charge.
  type PosterReply = { ok: boolean; hash?: string; fields?: PosterFields; existing?: boolean; error?: string }

  function posterFontPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'fonts', 'pixChicago.ttf')
      : join(app.getAppPath(), 'src', 'renderer', 'assets', 'fonts', 'pixChicago.ttf')
  }

  /** The index, the byte cache, the mirror to homemini, and the renderer's map. */
  async function publishPoster(installed: InstalledPoster): Promise<void> {
    invalidateArtBytes(installed.hash)
    await host.saveArtworkIndex(withPosterKeys(await host.loadArtworkIndex(), installed))
    triggerSync('artwork')
    host.sendToRenderer('live-sets-updated', {
      liveSets: false,
      artwork: [{ key: installed.key, hash: installed.versioned }, { key: installed.aliasKey, hash: installed.versioned }],
    })
  }

  // Jake's pick: whatever he drops on the concert page, always (the rule's first line).
  ipc.handle('set-concert-poster', async (_e, albumKey: string, imagePath: string): Promise<PosterReply> => {
    if (await isReplica()) return { ok: false, error: REPLICA_LIVE_SETS_READ_ONLY }
    if (!(await host.liveSetsCache.get())[albumKey]) return { ok: false, error: 'not a declared concert' }
    try {
      const installed = await installPosterImage({ artworkDir: getArtworkDir(), albumKey, imagePath: String(imagePath || ''), source: 'jake-pick' })
      await publishPoster(installed)
      return { ok: true, hash: installed.hash, fields: installed.fields }
    } catch (err) {
      console.warn('[concert-poster] set failed:', err instanceof Error ? err.message : err)
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  // A newly declared show with no poster gets a built one, made once from its
  // cover and its grounded words. A failure here never fails the declare: the
  // show just draws its cover whole in the frame until a poster arrives.
  ipc.handle('ensure-concert-poster', async (_e, albumKey: string, show: { band: string; show: string; year?: string | number }): Promise<PosterReply> => {
    const entry = (await host.liveSetsCache.get())[albumKey]
    if (!entry) return { ok: false, error: 'not a declared concert' }
    if (entry.concert?.poster) return { ok: true, existing: true, hash: entry.concert.poster }
    if (await isReplica()) return { ok: false, error: REPLICA_LIVE_SETS_READ_ONLY }
    const dir = getArtworkDir()
    // Declared before and undeclared since: a real poster is still in the store. It stands.
    const kept = await posterInStore(dir, albumKey)
    if (kept && kept.fields.posterSource !== 'built') {
      await publishPoster(kept)
      return { ok: true, hash: kept.hash, fields: kept.fields, existing: true }
    }
    const tmp = join(app.getPath('temp'), `concert-poster-${process.pid}-${Date.now()}.jpg`)
    try {
      const coverName = coverFileName((await host.loadArtworkIndex())[albumKey])
      const coverPath = coverName ? join(dir, coverName) : null
      const hasCover = coverPath ? await stat(coverPath).then((s) => s.size > 0, () => false) : false
      const { venue, date } = parseConcertMeta(show.show, entry.cues[0]?.title || '', entry.concert)
      await renderPosterForShow({
        facts: { band: show.band, show: show.show, venue, date, city: entry.concert?.city, year: show.year },
        coverPath: hasCover ? coverPath : null,
        outPath: tmp,
        fontPath: posterFontPath(),
      })
      const installed = await installPosterImage({ artworkDir: dir, albumKey, imagePath: tmp, source: 'built' })
      await publishPoster(installed)
      return { ok: true, hash: installed.hash, fields: installed.fields }
    } catch (err) {
      console.warn('[concert-poster] build failed (the cover stands in):', err instanceof Error ? err.message : err)
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    } finally {
      await rm(tmp, { force: true }).catch((err) => console.warn('[concert-poster] temp file left behind:', err instanceof Error ? err.message : err))
    }
  }, { refuse: REFUSED_SENDER })

  // Concert crowd ambience (LC-7): serve the short "that night's crowd" clip
  // extracted from the show's own between-song gap. Stored per merged-track-id in
  // userData/concert-crowd/<id>.m4a. Returns base64 (renderer makes a Blob URL) or
  // null when a show has no clip — the crowd layer then simply does nothing.
  ipc.handle('get-concert-crowd', async (_e, mergedTrackId: number): Promise<string | null> => {
    // Replica: the laptop's clip, fetched once from homemini and kept locally.
    if (await isReplica()) return (await replica.crowdClip(Number(mergedTrackId)))?.toString('base64') ?? null
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
    // Never on a replica: its music dir is streamed stubs / cache-farm links,
    // and reading through them is the SMB hot path CLAUDE.md forbids. The
    // laptop cuts the clip (when the show is opened there) and mirrors it to
    // homemini, which this machine then pulls (get-concert-crowd above).
    if (await isReplica()) return { ok: false, error: 'crowd clips are cut on the laptop' }
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
        // Into the NAS state dir for the phone's backend, when there is a NAS to
        // copy to. Best effort: anything this misses, the sync job carries.
        await mirrorCrowdClipToNas({ clipPath: out, mergedTrackId, nasDir: NAS_STATE_DIR_PATH, nasAvailable })
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
