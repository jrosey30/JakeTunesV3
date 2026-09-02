/**
 * Artwork IPC: album-art fetch/set/remove/resolve, locks, embedded
 * backfill, artwork map, key migration.
 *
 * Extracted from main/index.ts (6.0 Phase 1 IPC migration) — bodies
 * verbatim; the engine lives in ../artwork-engine.ts and is imported
 * directly, so the host only carries genuinely main-owned state.
 */
import { app, dialog } from 'electron'
import { createHash } from 'crypto'
import { join } from 'path'
import { copyFile, mkdir, stat, unlink, writeFile } from 'fs/promises'
import type { BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { IS_WINDOWS } from '../platform'
import { safeIpcError } from '../safe-ipc-error'
import { getCoverArtUrlByMbid, getMusicBrainzReleaseMbid } from '../external'
import {
  type ParsedPicture, artworkHash, artworkLookupRebuildPromise, artworkNormIndexMem,
  artworkSidecarNormMem, extractAndSaveEmbeddedArtwork, getArtworkDir,
  getArtworkLockedBackupDir, invalidateArtBytes, loadArtworkIndex, loadArtworkLocks,
  mergeArtworkSidecarsIntoIndex, normalizeArtworkPartServer, resolveArtworkCache,
  saveArtworkIndex, scheduleArtworkLookupRebuild, setArtworkIndexMem, setArtworkLock,
  searchDeezerArt,
} from '../artwork-engine.ts'
import type { LiveSetEntry } from '../index.ts'

export interface ArtworkIpcHost {
  getMusicDir: () => string
  sendToRenderer: (channel: string, ...args: unknown[]) => void
  getMount: () => string | null
  getMainWindow: () => BrowserWindow | null
  liveSetsCache: { get: () => Promise<Record<string, LiveSetEntry>> }
}

export function registerArtworkIpc(ipc: IpcRegistrar, host: ArtworkIpcHost): void {
  // Album artwork
  ipc.handle('fetch-album-art', async (_event, artist: string, album: string, force?: boolean) => {
    const dir = getArtworkDir()
    await mkdir(dir, { recursive: true })
    const key = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
    const hash = artworkHash(artist, album)
    const filePath = join(dir, `${hash}.jpg`)

    const index = await loadArtworkIndex()

    // 4.4.57 — user-uploaded artwork is sacred. If the user has locked
    // this album's art (via set-custom-artwork), NEVER overwrite it — not
    // on an auto-fetch, not even on a forced re-fetch. To replace it the
    // user must explicitly remove it first (remove-artwork clears the lock).
    const locks = await loadArtworkLocks()
    if (locks.has(key)) {
      return { ok: true, key, hash: index[key] || hash }
    }

    // Use cached version unless force re-fetch
    if (index[key] && !force) {
      return { ok: true, key, hash: index[key] }
    }

    const artistLower = artist.toLowerCase().trim()
    const albumLower = album.toLowerCase().trim()

    try {
      // 4.3.0: Cover Art Archive first — higher quality than Deezer when
      // we can match a MusicBrainz release. Falls through to Deezer on
      // miss so existing behavior is preserved.
      let artUrl: string | null = null
      const mbid = await getMusicBrainzReleaseMbid(artist, album)
      if (mbid) {
        const candidate = getCoverArtUrlByMbid(mbid)
        // HEAD-check the URL — Cover Art Archive returns 404 when the
        // release exists in MusicBrainz but no front art has been uploaded.
        try {
          const head = await fetch(candidate, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' })
          if (head.ok) artUrl = candidate
        } catch { /* fall through to Deezer */ }
      }
      if (!artUrl) {
        artUrl = await searchDeezerArt(`${artist} ${album}`, artistLower, albumLower)
      }
      if (!artUrl) {
        artUrl = await searchDeezerArt(album, artistLower, albumLower)
      }

      if (!artUrl) return { ok: false, error: 'No matching artwork found' }

      const imgRes = await fetch(artUrl, { redirect: 'follow' })
      if (!imgRes.ok) return { ok: false, error: 'Failed to download image' }
      const imgBuf = Buffer.from(await imgRes.arrayBuffer())
      invalidateArtBytes(hash)
      await writeFile(filePath, imgBuf)

      // Append timestamp so renderer sees a new hash and re-renders the image
      const versionedHash = `${hash}_${Date.now()}`
      index[key] = versionedHash
      await saveArtworkIndex(index)
      return { ok: true, key, hash: versionedHash }
    } catch (err: unknown) {
      const msg = safeIpcError(err, 'api-failed')
      return { ok: false, error: msg }
    }
  }, { refuse: REFUSED_SENDER })

  // 4.5.0-79 — verification IPC. Returns the count of user-locked
  // covers so renderer / About panel can display "N covers locked."
  ipc.handle('get-artwork-lock-count', async (): Promise<{ ok: boolean; count: number }> => {
    try {
      const locks = await loadArtworkLocks()
      return { ok: true, count: locks.size }
    } catch {
      return { ok: false, count: 0 }
    }
  }, { public: true })

  ipc.handle('set-custom-artwork', async (_event, artist: string, album: string, imagePath: string) => {
    try {
      const dir = getArtworkDir()
      await mkdir(dir, { recursive: true })
      const key = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
      const hash = artworkHash(artist, album)
      const destPath = join(dir, `${hash}.jpg`)

      invalidateArtBytes(hash)
      // Convert to JPEG using macOS sips (handles PNG, TIFF, BMP, GIF, etc.)
      const ext = imagePath.slice(imagePath.lastIndexOf('.')).toLowerCase()
      if (ext === '.jpg' || ext === '.jpeg') {
        await copyFile(imagePath, destPath)
      } else {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execP = promisify(execFile)
        const tmpPath = destPath + '.tmp' + ext
        await copyFile(imagePath, tmpPath)
        await execP('sips', ['-s', 'format', 'jpeg', tmpPath, '--out', destPath])
        await unlink(tmpPath).catch(() => {})
      }

      // Append timestamp so renderer sees a new hash and re-renders the image
      const versionedHash = `${hash}_${Date.now()}`
      const index = await loadArtworkIndex()
      index[key] = versionedHash
      // A declared live set's "(Live Set)" album aliases the source album's art
      // (live-sets-ipc); keep the alias in step so the Albums grid and the concert
      // poster never disagree after a swap (2026-09-02).
      const aliasKey = `${key} (live set)`
      if (index[aliasKey]) index[aliasKey] = versionedHash
      await saveArtworkIndex(index)
      // 4.4.57 — the user chose this cover: lock it so no auto-fetch path
      // (online fetcher, embedded-art extraction, forced re-fetch) ever
      // overwrites it.
      await setArtworkLock(key, true)
      // 4.5.0-80 — defense layer 3: copy the locked JPG into
      // locked-backup/ so accidental deletion of the main file is
      // recoverable at next launch. Best-effort; failure here doesn't
      // block the set operation (the main file + lock + sidecar are
      // already in place).
      try {
        await mkdir(getArtworkLockedBackupDir(), { recursive: true })
        await copyFile(destPath, join(getArtworkLockedBackupDir(), `${hash}.jpg`))
      } catch (err) {
        console.warn('[artwork-lock-backup] copy failed (continuing):', err instanceof Error ? err.message : err)
      }
      // 4.5.0-55 — write sidecar so disk is fully self-describing.
      try {
        const meta = {
          artist: artist.trim(),
          album: album.trim(),
          key,
          source: 'user-custom',
          bytes: (await stat(destPath)).size,
          importedAt: new Date().toISOString(),
        }
        await writeFile(join(dir, `${hash}.meta.json`), JSON.stringify(meta, null, 2), 'utf-8')
      } catch (err) {
        console.warn('[artwork] sidecar write failed (continuing):', err instanceof Error ? err.message : err)
      }
      return { ok: true, key, hash: versionedHash }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  // 4.4.12: one-shot embedded-art backfill. Recovers art for tracks the
  // user imported BEFORE the import-time extractor landed. Runs once per
  // install (gated by a marker file in userData) — subsequent launches
  // no-op.
  //
  // Why a marker file rather than a per-track flag: the work is
  // idempotent (extractAndSaveEmbeddedArtwork's identity gate skips any
  // track whose album already has art in the index), so we just need to
  // know "have we walked the whole library once on this version?" The
  // marker is the simplest possible expression of that.
  //
  // Workload shape: parseFile is ~10-50ms per track on local SSD. A
  // 5000-track library is roughly 25-250 seconds in the background.
  // Yields between tracks via setImmediate so playback isn't impacted
  // (matches the 4.0.10 worker-yields pattern). The renderer awaits the
  // IPC and dispatches ADD_ARTWORK for each result as the batch progresses
  // via an `artwork-backfill-progress` event.
  function getArtworkBackfillMarkerPath(): string {
    return join(app.getPath('userData'), 'artwork-backfill-done')
  }
  async function markerExists(p: string): Promise<boolean> {
    try { await stat(p); return true } catch { return false }
  }
  ipc.handle('artwork-backfill-status', async () => {
    // "done" once the one-shot pre-4.4.12 embedded backfill has run.
    const done = await markerExists(getArtworkBackfillMarkerPath())
    return { ok: true, done }
  }, { public: true })
  ipc.handle('backfill-embedded-artwork', async (_event, tracks: Array<{ path: string; artist: string; album: string }>) => {
    // resolve iPod-style colon paths to absolute file paths
    const LOCAL_MOUNT = host.getMusicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const pathSep = IS_WINDOWS ? '\\' : '/'
    const results: Array<{ key: string; hash: string }> = []

    // One extraction pass over the library: seed seenKeys from the existing
    // index so albums that already have art are skipped — pure pre-4.4.12
    // embedded backfill. extractAndSaveEmbeddedArtwork's identity gate and
    // user-lock check keep this strictly non-destructive: it only fills in
    // albums that have no art at all, and never overwrites.
    const runPass = async (): Promise<void> => {
      const seenKeys = new Set<string>(Object.keys(await loadArtworkIndex()))
      let processed = 0
      const total = tracks.length
      const mm = await import('music-metadata')
      for (const t of tracks) {
        processed++
        const cleanArtist = (t.artist || '').trim()
        const cleanAlbum = (t.album || '').trim()
        if (!cleanArtist || !cleanAlbum) continue
        const key = `${cleanArtist.toLowerCase()}|||${cleanAlbum.toLowerCase()}`
        // Dedupe parseFile work per album within this pass.
        if (seenKeys.has(key)) continue
        seenKeys.add(key)

        // Resolve to absolute path. The colon-format path lives in
        // library.json; the underlying file lives in host.getMusicDir().
        const colon = String(t.path || '')
        if (!colon) continue
        const abs = colon.startsWith('/') ? colon : join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))

        try {
          const metadata = await mm.parseFile(abs)
          const result = await extractAndSaveEmbeddedArtwork(
            metadata.common.picture as ParsedPicture[] | undefined,
            cleanArtist,
            cleanAlbum,
          )
          if (result) results.push(result)
        } catch (err) {
          // parseFile can fail on weird codecs / inaccessible files.
          // Best-effort — log and move on; never block.
          console.warn(`[artwork-backfill] parseFile failed for ${abs}:`, err instanceof Error ? err.message : err)
        }

        // Progress + cooperative yield — give the audio decoder a thread
        // tick between every parseFile (the 4.0.10 "playback wins" rule).
        if (processed % 25 === 0) {
          host.sendToRenderer('artwork-backfill-progress', { processed, total })
        }
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    const writeMarker = async (markerPath: string): Promise<void> => {
      try {
        await mkdir(app.getPath('userData'), { recursive: true })
        await writeFile(markerPath, `done ${new Date().toISOString()}\n`, 'utf-8')
      } catch (err) {
        console.warn('[artwork-backfill] failed to write marker (will re-run next launch):', err instanceof Error ? err.message : err)
      }
    }

    try {
      // Pass 1 — original embedded backfill for pre-4.4.12 imports. One-shot.
      if (!(await markerExists(getArtworkBackfillMarkerPath()))) {
        await runPass()
        await writeMarker(getArtworkBackfillMarkerPath())
      }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed'), artwork: results }
    }

    host.sendToRenderer('artwork-backfill-progress', { processed: tracks.length, total: tracks.length })
    return { ok: true, artwork: results }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('remove-artwork', async (_event, artist: string, album: string, force?: boolean) => {
    try {
      const key = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
      // 4.5.0-80 — defense layer 4: refuse to silently nuke a user-
      // locked cover. A stray context-menu click can't undo hand-set
      // artwork anymore; caller must pass force:true (UI shows a
      // confirmation dialog first).
      const locks = await loadArtworkLocks()
      if (locks.has(key) && !force) {
        return { ok: false, locked: true, error: 'This cover is user-locked. Pass force:true to remove.' }
      }
      const hash = artworkHash(artist, album)
      const dir = getArtworkDir()
      const filePath = join(dir, `${hash}.jpg`)
      const sidecarPath = join(dir, `${hash}.meta.json`)
      const backupPath = join(getArtworkLockedBackupDir(), `${hash}.jpg`)

      await unlink(filePath).catch(() => {})
      // 4.5.0-55 — sidecar cleanup so disk stays consistent.
      await unlink(sidecarPath).catch(() => {})
      // 4.5.0-80 — also remove the locked-backup copy (only when forced
      // removal of a previously-locked cover). Without this, a
      // re-applied lock for the same (artist, album) would silently
      // re-resurrect the OLD cover from the backup.
      if (locks.has(key)) await unlink(backupPath).catch(() => {})

      const index = await loadArtworkIndex()
      delete index[key]
      await saveArtworkIndex(index)
      // 4.4.57 — removing the art also clears any user-lock, so the user
      // can auto-fetch fresh art for this album again.
      await setArtworkLock(key, false)
      return { ok: true, key }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('choose-artwork-file', async () => {
    const win = host.getMainWindow()
    if (!win) return { ok: false }
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Album Artwork',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'tiff', 'bmp', 'gif', 'webp'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  }, { refuse: { ok: false } })

  // Read-only: return the grounded lyrics for a track from the lyrics.json
  // sidecar (fetched by scripts/lyrics-fetch.mjs). Get Info's Lyrics section
  // self-fetches through this so the modal's props interface stays untouched
  // (one of its 7 call sites is the do-not-touch GenresView). A genuine miss /
  // instrumental / not-yet-fetched all return no text — the UI shows "No lyrics".

  ipc.handle('load-artwork-map', async () => {
    const index = await loadArtworkIndex()
    // Self-heal from synced .meta.json sidecars so custom art (concert posters,
    // user covers) that arrived via a deploy/sync resolves even though index.json
    // didn't travel. Persist + refresh so it's durable and the next boot is fast.
    if (await mergeArtworkSidecarsIntoIndex(index)) {
      setArtworkIndexMem(index)
      void saveArtworkIndex(index)
      scheduleArtworkLookupRebuild(index)
    }
    return { ok: true, map: index }
  }, { public: true })


  /**
   * 4.5.0-51 — Authoritative artwork resolver.
   *
   * The renderer's in-memory artworkMap is one source of truth, but it
   * drifts (Get Info edits, tag changes after import, partial migrations).
   * When the renderer can't find art for an (artist, album) pair, it
   * delegates to this IPC, which does the FULL chain:
   *
   *   1. Exact JSON key (`${artist.toLowerCase().trim()}|||${album...}`)
   *   2. Normalized JSON key — parens/diacritics/etc. stripped on both sides
   *   3. Recompute artworkHash from CURRENT strings; check if the file
   *      exists on disk (catches cases where the JSON index entry was lost
   *      but the JPG is still sitting there)
   *   4. Normalized-string hash variants checked on disk
   *
   * Returns the matching hash (versioned if present in the index) or null.
   * Renderer caches the result via ADD_ARTWORK so future lookups are sync.
   */
  async function fileExists(absPath: string): Promise<boolean> {
    try { await stat(absPath); return true } catch { return false }
  }

  ipc.handle('resolve-artwork', async (_event, artist: string, album: string): Promise<{ ok: boolean; hash: string | null; source?: 'exact' | 'normalized' | 'disk-hash' | 'disk-normalized' }> => {
    if (!artist || !album) return { ok: true, hash: null }
    const resolveKey = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
    if (resolveArtworkCache.has(resolveKey)) {
      return { ok: true, hash: resolveArtworkCache.get(resolveKey)! }
    }
    const dir = getArtworkDir()
    const index = await loadArtworkIndex()
    if (artworkLookupRebuildPromise) {
      await artworkLookupRebuildPromise.catch(() => {})
    }

    // 1. Exact JSON key
    const exactKey = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
    if (index[exactKey]) {
      const bareHash = String(index[exactKey]).replace(/_\d+$/, '')
      if (await fileExists(join(dir, `${bareHash}.jpg`))) {
        resolveArtworkCache.set(resolveKey, index[exactKey])
        return { ok: true, hash: index[exactKey], source: 'exact' }
      }
    }

    // 2. Normalized JSON key — O(1) via prebuilt index (was O(n) scan).
    const nArtist = normalizeArtworkPartServer(artist)
    const nAlbum = normalizeArtworkPartServer(album)
    const wantedNorm = `${nArtist}|||${nAlbum}`
    const normHit = artworkNormIndexMem?.get(wantedNorm)
    if (normHit) {
      const bareHash = String(normHit).replace(/_\d+$/, '')
      if (await fileExists(join(dir, `${bareHash}.jpg`))) {
        resolveArtworkCache.set(resolveKey, normHit)
        return { ok: true, hash: normHit, source: 'normalized' }
      }
    }

    // 3. Compute the hash from CURRENT strings (post-Get-Info edit case
    // where the JSON entry was never updated but the file IS on disk
    // under a key we can recompute).
    const directHash = artworkHash(artist, album)
    if (await fileExists(join(dir, `${directHash}.jpg`))) {
      resolveArtworkCache.set(resolveKey, directHash)
      return { ok: true, hash: directHash, source: 'disk-hash' }
    }

    // 4. Normalized-string hash variants — try hashing the normalized
    // (parens-stripped, diacritics-folded) artist+album. Catches the
    // case where a track was imported with "(Remastered)" in the title
    // and the user later cleaned it up, OR vice versa.
    const normalizedHash = createHash('md5')
      .update(`${nArtist}|||${nAlbum}`)
      .digest('hex')
    if (await fileExists(join(dir, `${normalizedHash}.jpg`))) {
      resolveArtworkCache.set(resolveKey, normalizedHash)
      return { ok: true, hash: normalizedHash, source: 'disk-normalized' }
    }

    // 5. Sidecar index — O(1) lookup (was linear readdir+parse per miss).
    const sidecarHash = artworkSidecarNormMem?.get(wantedNorm)
    if (sidecarHash && await fileExists(join(dir, `${sidecarHash}.jpg`))) {
      resolveArtworkCache.set(resolveKey, sidecarHash)
      return { ok: true, hash: sidecarHash, source: 'disk-normalized' }
    }

    resolveArtworkCache.set(resolveKey, null)
    return { ok: true, hash: null }
  }, { public: true })

  /**
   * 4.5.0-51 — Get Info migration. When the user changes a track's artist
   * or album in Get Info, copy the existing artwork map entry to the NEW
   * key so the cover follows the track. We COPY (don't move) so other
   * tracks under the original key keep their art too.
   */
  ipc.handle('migrate-artwork-key', async (_event, oldArtist: string, oldAlbum: string, newArtist: string, newAlbum: string) => {
    if (!oldArtist || !oldAlbum || !newArtist || !newAlbum) return { ok: false }
    const oldKey = `${oldArtist.toLowerCase().trim()}|||${oldAlbum.toLowerCase().trim()}`
    const newKey = `${newArtist.toLowerCase().trim()}|||${newAlbum.toLowerCase().trim()}`
    if (oldKey === newKey) return { ok: true, migrated: false }
    const index = await loadArtworkIndex()
    if (!index[oldKey]) return { ok: true, migrated: false }
    if (index[newKey]) return { ok: true, migrated: false }  // don't clobber an existing entry under the new key
    index[newKey] = index[oldKey]
    await saveArtworkIndex(index)
    return { ok: true, migrated: true, hash: index[newKey] }
  }, { refuse: REFUSED_SENDER })
}
