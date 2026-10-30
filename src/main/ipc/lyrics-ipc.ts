/**
 * Lyrics IPC — Get Info's read of the lyrics.json sidecar (moved out of
 * main/index.ts 2026-10-29 so the replica pull could ride beside its reader).
 *
 * lyrics.json holds grounded lyrics from LRCLIB, written by
 * scripts/lyrics-fetch.mjs and keyed by String(track.id). The MacBook's
 * nightly enrichment is the SINGLE writer; the LOCAL→NAS mirror
 * (STATE_FILE_NAMES in index.ts) carries it to homemini for the brain-trainer
 * and the phone. NEVER fabricated: a genuine not-found is { miss:true }, an
 * instrumental { instrumental:true }. Read-only here.
 *
 * On a replica (workmini) the file is homemini's copy, pulled every couple of
 * minutes (src/main/replica-hub-files.ts createLyricsPuller) — before that it
 * froze at whatever the last deploy copied (10-26, 43 songs behind). A pull
 * that lands drops the in-memory cache, so the next Get Info reads the new
 * file, and tells the renderer (lyrics-updated) so Now Playing's lyricsStore
 * forgets its answers too. Inert on the MacBook.
 *
 * ⚠️ Schema mirror: scripts/lyrics-sources.mjs (recordFrom + lookup) writes this exact shape.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { JsonFileCache } from '../state-cache.ts'
import { createLyricsPuller, startReplicaTimer } from '../replica-hub-files.ts'

export interface LyricsRecord {
  plain?: string
  synced?: string
  instrumental?: boolean
  miss?: boolean; likelyInstrumental?: boolean   // likely = still a MISS (180-day retry), never shown as Instrumental
  source?: string   // 'lrclib' | 'lyrics.ovh' (plain-only fallback) | 'lrclib+ovh' (double miss)
  lrclibId?: number // absent on lyrics.ovh hits
  fetchedAt?: number
}

export function registerLyricsIpc(ipc: IpcRegistrar, host: { file: () => string; hubBase?: () => Promise<string | null>; notify?: () => void }): void {
  const lyricsCache = new JsonFileCache<Record<string, LyricsRecord>>(host.file, () => ({}), 'lyrics')

  ipc.handle('get-track-lyrics', async (_e, trackId: number): Promise<{ ok: boolean; plain?: string; synced?: string; instrumental?: boolean }> => {
    try {
      const store = await lyricsCache.get()
      const rec = store[String(trackId)]
      if (!rec || rec.miss) return { ok: true }
      return { ok: true, plain: rec.plain, synced: rec.synced, instrumental: rec.instrumental }
    } catch {
      return { ok: true }
    }
  }, { public: true })

  if (host.hubBase) {
    const puller = createLyricsPuller({ file: host.file(), hubBase: host.hubBase, onAdopted: () => { lyricsCache.invalidate(); host.notify?.() }, log: (m) => console.warn(m) })
    startReplicaTimer(puller.pull, 25_000)
  }
}
