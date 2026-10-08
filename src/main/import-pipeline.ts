/**
 * The import pipeline — P1C1 of the structural renovation (2026-08-16).
 *
 * Everything between "here is an audio file on disk" and "the library owns
 * it": text-fingerprint dedupe, id slot allocation, convert/copy into the
 * hashed F-dir layout, tag embedding, artwork extraction, the batch wrapper
 * the Bandcamp/streamrip stores share, and the spent-source cleanup.
 *
 * Moved OUT of main/index.ts by dependency map (roadmap Phase 1, cut 1).
 * Bodies are byte-identical to what shipped, modulo exactly these renames:
 *   MUSIC_DIR                    -> D().musicDir()
 *   LIBRARY_PATH                 -> D().libraryPath()
 *   readAppSettingsAsync()...    -> D().defaultImportFormat()
 *   computeAudioFingerprint      -> D().computeAudioFingerprint
 *   codecByAbsPath.set           -> D().setCodecForPath
 *   extractAndSaveEmbeddedArtwork-> D().extractEmbeddedArtwork
 *   readStreamSource             -> D().readStreamSource
 *   enqueueStreamConvert         -> D().enqueueStreamConvert
 *   enqueueAnalysisForImportedTrack -> D().enqueueAnalysis
 *   prewarmAlacCache             -> D().prewarmAlacCache
 *   shell.trashItem              -> D().trashItem
 *   mainWindow?.webContents.send -> D().emitToRenderer
 *   common.picture as ParsedPicture[]... -> bare common.picture (the cast
 *     moved INTO the injected extractEmbeddedArtwork wrapper in index.ts)
 * Suppliers, not values, for anything mutable at runtime (MUSIC_DIR moves
 * when settings change) — the frozen-supplier lesson from the personas
 * extraction. Electron never appears here; node --test can reach all of it.
 *
 * Name-adjacent, NOT a twin: core/tools/refresh_fingerprints.py's
 * compute_fingerprint is the BINARY audio hash (sha1 of leading bytes).
 * _normFingerprint below is the TEXT dedupe key. Different domains; the
 * binary hash stays in index.ts (five consumers outside this cluster) and
 * arrives here injected.
 */

import { join } from 'path'
import { stat, mkdir, copyFile, readFile, lstat } from 'fs/promises'
import {
  IS_WINDOWS,
  convertAudio,
  ensureFaststart,
  extensionForFormat,
  resolveImportFormat,
  type AudioFormat,
} from './platform.ts'
import { safeIpcError } from './safe-ipc-error.ts'
import { searchTitle } from './streamrip-match.ts'

export interface SingleImportResult {
  ok: boolean
  track?: Record<string, unknown>
  dupe?: { src: string; matchedTitle: string; matchedArtist: string }
  error?: string
  // 4.4.12: when the imported file had embedded album art that we just
  // saved, the artwork's index key + versioned hash so the renderer can
  // dispatch ADD_ARTWORK immediately, without a second IPC round-trip.
  artwork?: { key: string; hash: string }
}

export interface ImportPipelineDeps {
  /** Current MUSIC_DIR — a supplier because it can be re-resolved at runtime. */
  musicDir: () => string
  /** Path of library.json. */
  libraryPath: () => string
  /** settings.library.defaultImportFormat, or undefined. */
  defaultImportFormat: () => Promise<string | undefined>
  /** The BINARY audio hash (sha1:<hex16>|<ms>) — shared with the sync verifier. */
  computeAudioFingerprint: (absPath: string, durationMs: number) => Promise<string | null>
  /** Feed the protocol handler's in-memory codec map. */
  setCodecForPath: (absPath: string, codec: string) => void
  extractEmbeddedArtwork: (
    pictures: unknown,
    artist: string,
    album: string,
  ) => Promise<{ key: string; hash: string } | null>
  readStreamSource: () => Promise<string | null>
  enqueueStreamConvert: (colonPath: string, audioFingerprint: string, at: number) => void
  enqueueAnalysis: (track: Record<string, unknown>) => void
  prewarmAlacCache: (absPaths: string[]) => Promise<void>
  trashItem: (absPath: string) => Promise<void>
  emitToRenderer: (channel: string, payload: unknown) => void
}

let deps: ImportPipelineDeps | null = null

/** Wire the pipeline's world. Called once at startup, before any import. */
export function initImportPipeline(d: ImportPipelineDeps): void {
  deps = d
}

function D(): ImportPipelineDeps {
  if (!deps) throw new Error('import-pipeline used before initImportPipeline()')
  return deps
}

export const _normFingerprint = (s: unknown): string => String(s || '')
  .replace(/^\s*\d{1,2}\s*[-._]\s*/, '')
  .replace(/\s*\b(feat(?:uring)?|ft)\b\.?[^)]*/ig, '')
  .replace(/[()[\]{}"',.\-!?:;#/\\]+/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase()

/** The TITLE half of the dupe key, with edition packaging stripped first.
 *  2026-09-05, first live album run: Qobuz stamps every track of a reissue
 *  "(2001 Digital Remaster)", the library's copies carry no stamp, so all
 *  fourteen "Helicopter (2001 Digital Remaster)"-style titles missed the key
 *  and an album Jake already owned was imported twice. A remaster is the
 *  same recording (the identity contracts say so too); version markers
 *  ("(Live)", "(Remix)") survive searchTitle and still split the key. */
export const _normTitleFingerprint = (s: unknown): string => _normFingerprint(searchTitle(String(s || '')))

// Why this set exists:
// `save-library` on the renderer side is debounced ~1s, so during a
// rapid multi-file drop every `import-track` call sees a stale
// library.json on disk that does NOT yet contain the track we just
// imported on the previous call. Without this set, dropping the same
// audio file twice (same drag, two drags, or a folder containing
// duplicates) sneaks both copies into the library — the user sees
// "the same song twice" and the playback queue auto-advances from
// one copy to the other, looking like the track is repeating itself.
// We seed loadDupeFingerprintsFromLibrary() with this set, add to it
// on every successful import, and clear it whenever save-library
// flushes to disk (after which the on-disk library.json is the
// truth and the in-memory set is no longer needed).
const sessionImportedFingerprints = new Set<string>()

/** save-library flushed: on-disk library.json is truth again. */
export function clearSessionImportedFingerprints(): void {
  sessionImportedFingerprints.clear()
}

/** The drag-drop / import-track IPC paths record their successes here. */
export function addSessionImportedFingerprint(fp: string): void {
  for (const k of dupeKeyVariants(fp)) sessionImportedFingerprints.add(k)
}

export function fingerprintTrack(t: { title?: unknown; artist?: unknown; duration?: unknown }): string | null {
  const title  = _normTitleFingerprint(t.title)
  const artist = _normFingerprint(t.artist)
  const dur    = Math.round(Number(t.duration || 0) / 1000)
  if (!title || !artist || dur <= 0) return null
  return `${title}|${artist}|${dur}`
}

/**
 * The three keys a track claims: its rounded duration and both neighbours.
 *
 * The Slippery case (2026-08-16, found by the album-gate verification):
 * the library's "Slippery (feat. Gucci Mane)" runs 304.813s, Qobuz's
 * "Slippery" runs 304.041s — the same recording off two edition masters,
 * rounding to 305 and 304. Exact-second equality called them different
 * songs and imported the second copy; ±1s of tolerance on the CLAIM side
 * (inserts, not lookups) closes the boundary without loosening identity:
 * a genuinely different edit is seconds apart, not milliseconds.
 */
function dupeKeyVariants(fp: string): string[] {
  const bar = fp.lastIndexOf('|')
  const secs = Number(fp.slice(bar + 1))
  if (!Number.isFinite(secs)) return [fp]
  const base = fp.slice(0, bar + 1)
  return [`${base}${secs - 1}`, fp, `${base}${secs + 1}`]
}

export async function loadDupeFingerprintsFromLibrary(): Promise<Set<string>> {
  // Seed with the session set so back-to-back imports during a
  // single drop catch each other before save-library flushes.
  const set = new Set<string>(sessionImportedFingerprints)
  try {
    const raw = await readFile(D().libraryPath(), 'utf-8')
    const libData = JSON.parse(raw) as { tracks?: Array<Record<string, unknown>> }
    const sep = IS_WINDOWS ? '\\' : '/'
    // LOCAL music root only. Never existsSync into streamRoot — that follows
    // farm symlinks into SMB on the MAIN THREAD and beachballs workmini for
    // every import (thousands of sync probes). A local real file OR symlink
    // counts as present; homemini serves symlink bytes at play time.
    const localRoot = D().musicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
    for (const t of libData.tracks || []) {
      // An entry with NO PLAYABLE FILE must not block its own replacement.
      //
      // Dupe detection is text — title|artist|duration — so a library row whose
      // audio is missing, or which was found to hold the WRONG song, still
      // claimed the signature and made every re-download a "dupe". Jake hit
      // this twice: re-downloading Soulwax "NY Lipps" from the Download area
      // silently did nothing, and replacing Drake's "Tuscan Leather" was
      // refused even though the entry's file was actually The Motion. The
      // library said "you already have this" while being unable to play it.
      //
      // Skipping fileless rows makes the broken case self-healing: if we
      // cannot play it, we do not get to veto acquiring it.
      const rel = String(t.path || '')
      if (rel) {
        const abs = join(localRoot, rel.replace(/:/g, sep))
        let present = false
        try {
          const st = await lstat(abs)
          present = st.isFile() || st.isSymbolicLink()
        } catch { present = false }
        if (!present) continue
      }
      const fp = fingerprintTrack({ title: t.title, artist: t.artist, duration: t.duration })
      if (fp) for (const k of dupeKeyVariants(fp)) set.add(k)
    }
  } catch { /* new library, no dupes possible */ }
  return set
}

/** The library's playable rows, lite — what the album identity contract
 *  needs to decide which requested tracks Jake already OWNS (by recording
 *  identity, not by text key) before anything is downloaded. Same
 *  fileless-row rule as the dupe set: a row with no playable file owns
 *  nothing. */
export interface LibraryTrackLite { id?: number; title: string; artist?: string; album?: string; durationSec?: number }
export async function loadLibraryTracksLite(): Promise<LibraryTrackLite[]> {
  const out: LibraryTrackLite[] = []
  try {
    const raw = await readFile(D().libraryPath(), 'utf-8')
    const libData = JSON.parse(raw) as { tracks?: Array<Record<string, unknown>> }
    const sep = IS_WINDOWS ? '\\' : '/'
    const localRoot = D().musicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
    for (const t of libData.tracks || []) {
      const rel = String(t.path || '')
      if (rel) {
        try {
          const st = await lstat(join(localRoot, rel.replace(/:/g, sep)))
          if (!(st.isFile() || st.isSymbolicLink())) continue
        } catch { continue }
      }
      const dur = Number(t.duration || 0)
      out.push({ id: typeof t.id === 'number' ? t.id : undefined, title: String(t.title || ''), artist: String(t.artist || ''), album: String(t.album || ''), durationSec: dur > 0 ? Math.round(dur / 1000) : undefined })
    }
  } catch { /* new library: owns nothing */ }
  return out
}

/**
 * Returns the lowest `imported_NNNN` slot ≥ `startId` whose file path
 * is free in MUSIC_DIR (no file exists at any common audio extension).
 *
 * Why this exists — the 78-collision bug (Apr 26 postmortem):
 * The renderer-side counter (importQueue.ts + App.tsx useEffect) seeds
 * itself from `max(library.id)`. But library entries that came in via
 * the "Import N to Library" drift-banner button can have paths whose
 * `imported_NNNN` > `library.id`, because the iPod's iTunesDB stores
 * track id and file path independently — id was assigned by the
 * library at original import, path was generated by JakeTunes when
 * the track first synced to the iPod, and the two epochs can drift.
 * Without this guard, the next fresh drag-drop import gets a
 * library-id whose path slot is already occupied — the file gets
 * silently overwritten and the library ends up with two entries
 * pointing at the same path. The new sync preflight catches it (good)
 * but only after the local file has already been overwritten (bad).
 *
 * ⚠️ TWIN: same defensive scan-then-loop pattern used by
 * `rip-cd-tracks` ipcMain.handle in main/index.ts (it predates this
 * helper and had the fix locally; we extracted it here so
 * `import-track` and the CD ripper share one source of truth).
 */
export async function findFreeImportedId(startId: number): Promise<number> {
  const exts = ['.m4a', '.mp3', '.aac', '.flac', '.alac', '.wav', '.aif', '.aiff']
  let id = startId
  while (true) {
    const subDir = join(D().musicDir(), `F${String(id % 50).padStart(2, '0')}`)
    let collide = false
    for (const e of exts) {
      const exists = await stat(join(subDir, `imported_${id}${e}`)).then(() => true).catch(() => false)
      if (exists) { collide = true; break }
    }
    if (!collide) return id
    id++
  }
}

export async function importOneFile(
  srcPath: string,
  id: number,
  chosenFmt: AudioFormat,
  preferredFormat: string | undefined,
  dupeFingerprints: Set<string>,
  dateOverride?: Date,
  source?: string,
): Promise<SingleImportResult> {
  const ext = srcPath.substring(srcPath.lastIndexOf('.')).toLowerCase()
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(srcPath)
    const common = metadata.common
    const format = metadata.format

    const ft = _normTitleFingerprint(common.title)
    const fa = _normFingerprint(common.artist)
    const fd = Math.round(Number(format.duration || 0))
    if (ft && fa && fd > 0 && dupeFingerprints.has(`${ft}|${fa}|${fd}`)) {
      return {
        ok: true,
        dupe: {
          src: srcPath,
          matchedTitle: String(common.title || ''),
          matchedArtist: String(common.artist || ''),
        },
      }
    }

    // Path-collision guard: the renderer counter may have given us an id
    // whose `imported_${id}.<ext>` slot is already on disk (Apr 26 78-
    // collision bug — see findFreeImportedId comment). Bump past it
    // before computing the destination so we never overwrite a file
    // that another library entry is pointing at. The returned track's
    // `id` will reflect the bumped value; the renderer queue advances
    // its counter accordingly.
    const requestedId = id
    id = await findFreeImportedId(id)
    if (id !== requestedId) {
      console.warn(`import-track: id ${requestedId} collides with existing file imported_${requestedId}.*; bumped to ${id}`)
    }

    const subDir = `F${String(id % 50).padStart(2, '0')}`
    const destDir = join(D().musicDir(), subDir)
    await mkdir(destDir, { recursive: true })

    const codec = format.codec?.toLowerCase() || ''
    const needsConvert = codec.includes('alac') || codec.includes('flac') ||
      ext === '.flac' || ext === '.wav' || ext === '.wave' || ext === '.aiff' || ext === '.aif'

    let finalExt = ext
    let fileName: string
    let destPath: string

    const embedTags = {
      title: common.title || srcPath.substring(srcPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
      artist: common.artist || '',
      album: common.album || '',
      albumArtist: common.albumartist || '',
      genre: common.genre?.[0] || '',
      year: common.year ? String(common.year) : '',
      trackNumber: common.track?.no || 0,
      trackCount: common.track?.of || 0,
      discNumber: common.disk?.no || 0,
      discCount: common.disk?.of || 0,
    }

    const sourcePlayable = ext === '.m4a' || ext === '.mp3' || ext === '.aac'
    const userRequestedReencode = preferredFormat != null && preferredFormat !== 'aac-256'
    const doConvert = needsConvert || userRequestedReencode || !sourcePlayable

    if (doConvert) {
      finalExt = extensionForFormat(chosenFmt)
      fileName = `imported_${id}${finalExt}`
      destPath = join(destDir, fileName)
      try {
        await convertAudio(srcPath, destPath, chosenFmt, embedTags)
        // Old iPods need moov-first; external pipelines often mux moov-last.
        await ensureFaststart(destPath)
      } catch (convertErr) {
        console.error(`Conversion failed for ${srcPath}, copying original:`, convertErr)
        finalExt = ext
        fileName = `imported_${id}${finalExt}`
        destPath = join(destDir, fileName)
        await copyFile(srcPath, destPath)
      }
    } else {
      fileName = `imported_${id}${finalExt}`
      destPath = join(destDir, fileName)
      await copyFile(srcPath, destPath)
    }

    const fileStats = await stat(destPath)
    const trackTime = dateOverride || new Date()
    const durationMs = Math.round((format.duration || 0) * 1000)

    // Stable per-file identity. Stored at import and used by the silent
    // post-sync verifier to detect cross-linked paths without resorting
    // to fragile text matching. See computeAudioFingerprint for the
    // format and verifyAndHealTracks for how it's consumed.
    const audioFingerprint = await D().computeAudioFingerprint(destPath, durationMs)

    const track: Record<string, unknown> = {
      id,
      title: common.title || srcPath.substring(srcPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
      artist: common.artist || '',
      album: common.album || '',
      genre: common.genre?.[0] || '',
      year: common.year || '',
      duration: durationMs,
      path: `:iPod_Control:Music:${subDir}:${fileName}`,
      trackNumber: common.track?.no || 0,
      trackCount: common.track?.of || 0,
      discNumber: common.disk?.no || 0,
      discCount: common.disk?.of || 0,
      playCount: 0,
      dateAdded: trackTime.toISOString(),
      fileSize: fileStats.size,
      rating: 0,
      // Brief 031 Phase 4b: default contributingArtists to [artist]
      // for newly-imported tracks. Collab splits are applied by the
      // one-shot apply-collabs script (Phase 4a) — the indexer doesn't
      // know about decisions.json. A future tag-aware import path
      // could detect "X feat. Y" patterns at import time, but for now
      // imports default to sole-artist and the user can re-run the
      // apply script if they import a new collab worth splitting.
      contributingArtists: [common.artist || ''],
      // 4.4.85: record codec so the ipod-audio:// protocol handler can
      // skip its ~200-500 ms ffprobe call on first-play. chosenFmt is
      // the encoder's output format; the handler only branches on
      // === 'alac' (cache hit) vs anything else (serve raw).
      codec: chosenFmt,
      ...(audioFingerprint ? { audioFingerprint } : {}),
      ...(source ? { source } : {}),
    }

    // 4.4.85: populate the in-memory codec map so the protocol handler
    // gets a hit immediately for tracks imported during this session
    // (and ahead of library.json being rewritten by save-library).
    D().setCodecForPath(destPath, chosenFmt)

    // Add this fingerprint to the set so a duplicate appearing later in
    // the same batch (or a back-to-back drop) gets caught even before
    // library.json is rewritten on disk.
    if (ft && fa && fd > 0) {
      for (const k of dupeKeyVariants(`${ft}|${fa}|${fd}`)) dupeFingerprints.add(k)
    }

    // 4.4.12: extract embedded album art if the source has it. Best-effort;
    // null result is fine (no embedded art OR identity gate hit OR sips
    // failed). The audio file is the primary artifact and ships regardless.
    // The {key, hash} comes back to the caller IPC handler, which passes
    // it to the renderer so ADD_ARTWORK fires without a second round-trip.
    let artwork: { key: string; hash: string } | null = null
    try {
      artwork = await D().extractEmbeddedArtwork(
        common.picture,
        String(track.artist || ''),
        String(track.album || ''),
      )
    } catch (err) {
      console.warn(`[import] embedded-art extraction skipped for ${srcPath}:`, err instanceof Error ? err.message : err)
    }

    // Stage 3 ingestion redirect: in homemini streaming mode, keep this import
    // LOCAL + PLAYABLE now, then let the background pass convert it to a streamed
    // symlink once homemini serves byte-identical bytes. ALAC never streams
    // (Chromium can't decode raw ALAC, homemini doesn't transcode) — stays local.
    if (chosenFmt !== 'alac' && audioFingerprint && (await D().readStreamSource()) === 'homemini') {
      void D().enqueueStreamConvert(String(track.path), audioFingerprint, Date.now())
    }

    return { ok: true, track, ...(artwork ? { artwork } : {}) }
  } catch (err) {
    console.error(`Failed to import ${srcPath}:`, err)
    return { ok: false, error: safeIpcError(err, 'io-failed') }
  }
}

export async function nextLibraryId(): Promise<number> {
  try {
    const lib = JSON.parse(await readFile(D().libraryPath(), 'utf-8')) as { tracks?: Array<{ id?: number }> }
    let max = 0
    for (const t of lib.tracks || []) max = Math.max(max, Number(t.id) || 0)
    return max + 1
  } catch {
    return 1
  }
}

export async function importDownloadedFiles(absPaths: string[], source?: string): Promise<{ tracks: Array<Record<string, unknown>>; dupeCount: number; errorCount: number; dupes: Array<{ src: string; matchedTitle: string; matchedArtist: string }> }> {
  const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
  const preferred = await D().defaultImportFormat()
  const userPreferred: AudioFormat = validFormats.includes(preferred as AudioFormat)
    ? (preferred as AudioFormat)
    : 'aac-256'
  const dupeFingerprints = await loadDupeFingerprintsFromLibrary()
  let id = await nextLibraryId()
  const tracks: Array<Record<string, unknown>> = []
  const alacAbsPaths: string[] = []
  // Sources the library now fully owns (imported OR dupe — a dupe means the
  // content is already in the library, so the download is equally redundant).
  // Errors keep their source on disk for retry/diagnosis.
  const cleanupSources: string[] = []
  const total = absPaths.length
  let done = 0
  let errors = 0
  let dupes = 0
  // Which staged files were skipped as library duplicates (6.0 Phase 1: the
  // album contract credits a dupe toward completion only after re-checking
  // the requested track's identity against the file the key came from).
  const dupeFiles: Array<{ src: string; matchedTitle: string; matchedArtist: string }> = []
  for (const p of absPaths) {
    // Per-file format resolution so a FLAC track inside an album-zip
    // becomes AAC even when the user's default is ALAC (Jake's policy).
    const chosenFmt = resolveImportFormat(p, userPreferred)
    // 4.4.85: emit progress before each file so the now-playing pill's
    // import mode (the same one drag-drop uses) advances visibly as the
    // batch grinds. `running:true` triggers the +0.5 bar bump for the
    // currently-encoding file. trackTitle uses the filename — metadata
    // isn't parsed yet at this point.
    const trackTitle = p.split('/').pop() || p
    D().emitToRenderer('bandcamp:batch-progress', {
      current: done, total, trackTitle, errors, running: true,
    })
    const r = await importOneFile(p, id, chosenFmt, preferred, dupeFingerprints, undefined, source)
    if (r.ok && r.track) {
      tracks.push(r.track)
      // BPM/key analysis starts the moment the song lands — same as drag-drop.
      D().enqueueAnalysis(r.track)
      const fp = fingerprintTrack({ title: r.track.title, artist: r.track.artist, duration: r.track.duration })
      if (fp) for (const k of dupeKeyVariants(fp)) sessionImportedFingerprints.add(k)
      done += 1
      id = (Number(r.track.id) || id) + 1
      if (chosenFmt === 'alac') {
        const colon = String(r.track.path || '')
        if (colon) {
          const LOCAL_MOUNT = D().musicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
          const pathSep = IS_WINDOWS ? '\\' : '/'
          alacAbsPaths.push(join(LOCAL_MOUNT, colon.replace(/:/g, pathSep)))
        }
      }
      cleanupSources.push(p)
    } else if (r.ok && r.dupe) {
      // 4.5.0-46: dupes are NOT failures — they're tracks Jake already
      // owns. Track them separately so the upstream download-router
      // can show "all tracks already in your library" (info) instead
      // of "import produced no tracks (all duplicates?)" (error) when
      // the whole zip is a re-purchase.
      dupes += 1
      dupeFiles.push(r.dupe)
      cleanupSources.push(p)
    } else {
      errors += 1
      // 4.5.0-46: surface the actual failure reason in the LCD pill +
      // main console so Jake doesn't have to guess. Pre-fix, the
      // Bandcamp pipeline only emitted "(2 failed)" with no clue why.
      // Same UX pattern as the drag-drop importQueue (importQueue.ts).
      const fname = p.split('/').pop() || p
      const reason = (r.error || 'Import failed').replace(/^Error:\s*/i, '').slice(0, 160)
      console.warn(`[bandcamp] import failed: "${fname}" — ${reason}`)
      D().emitToRenderer('bandcamp:per-file-failed', { filename: fname, error: reason })
    }
  }
  // Final progress emit so the pill shows "N of N" momentarily, then
  // clear after a beat (matches how drag-drop fades out as importQueue
  // empties — gives the user a satisfying "100%" tick before the pill
  // resets to playing/idle).
  D().emitToRenderer('bandcamp:batch-progress', {
    current: done, total, trackTitle: '', errors, running: false,
  })
  setTimeout(() => {
    D().emitToRenderer('bandcamp:batch-progress', {
      current: 0, total: 0, trackTitle: '', errors: 0, running: false,
    })
  }, 1500)
  // Mirror the drag-drop import-track IPC (~line 2353): ALAC files MUST
  // be transcoded into the AAC play-cache at import time, because
  // Chromium's <audio> element can't decode ALAC and the protocol
  // handler serves the cached AAC mirror instead. Without this batch,
  // first playback of any Bandcamp-imported ALAC track fails with
  // MEDIA_ERR_SRC_NOT_SUPPORTED.
  if (alacAbsPaths.length > 0) {
    await D().prewarmAlacCache(alacAbsPaths).catch((err) => {
      console.warn(`[bandcamp] alac cache transcode failed:`, err)
    })
  }
  // ── Pass-through cleanup (2026-08-15, Jake: downloads must not pile up
  // on this machine). importOneFile COPIES (or transcodes) the source into
  // the library; the source in _pending-imports / staging is then a spent
  // artifact. Trash — never unlink — so a mistaken import stays recoverable
  // for 30 days by macOS's own rules. Only sources whose import SUCCEEDED
  // (or deduped) go; failures keep their files for retry.
  if (cleanupSources.length > 0) {
    let cleaned = 0
    for (const src of cleanupSources) {
      try { await D().trashItem(src); cleaned++ } catch { /* locked/gone — leave it */ }
    }
    if (cleaned > 0) console.log(`[import] trashed ${cleaned}/${cleanupSources.length} spent download source(s)`)
  }
  return { tracks, dupeCount: dupes, errorCount: errors, dupes: dupeFiles }
}
