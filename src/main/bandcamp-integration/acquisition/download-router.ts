// ════════════════════════════════════════════════════════════════════════
//  Download router — Bandcamp purchase -> library (Brief 036 v4 Phase B)
//
//  Hooks `will-download` on the persist:bandcamp session, parks every
//  download in a stable _pending-imports/ directory under the library
//  root, then dispatches by extension:
//    - .zip (album purchase)  -> unzip audio members, importOneFile each
//    - single audio file      -> importOneFile directly
//    - anything else          -> ignored
//
//  Each successful import fires onTrackImported with the track record
//  so the renderer can drive the toast + Recently Added marker
//  (Brief 036 v4 Decision 5 / Phase C). Failures fire onImportFailed.
//
//  After import the downloaded files stay in _pending-imports/ — the
//  library import already made canonical copies, but keeping the
//  originals gives the user a paper trail to inspect if a purchase
//  ever looks wrong.
// ════════════════════════════════════════════════════════════════════════

import { Session, DownloadItem } from 'electron'
import { join } from 'path'
import { createWriteStream, mkdirSync } from 'fs'
import yauzl from 'yauzl'

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.alac', '.wav', '.aiff', '.aif', '.ogg'])
const SOURCE_TAG = 'bandcamp'

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

/** Extract only audio members of a Bandcamp album zip into destDir. */
function unzipAudio(zipPath: string, destDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = []
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err || new Error('zip open failed'))
      zip.on('error', reject)
      zip.on('end', () => resolve(out))
      zip.readEntry()
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName) || !AUDIO_EXT.has(ext(entry.fileName))) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) { zip.readEntry(); return }
          const safe = entry.fileName.replace(/^.*[/\\]/, '')
          const dest = join(destDir, safe)
          const ws = createWriteStream(dest)
          ws.on('finish', () => { out.push(dest); zip.readEntry() })
          ws.on('error', () => zip.readEntry())
          stream.pipe(ws)
        })
      })
    })
  })
}

export interface ImportedTrackRecord {
  id?: number
  title?: string
  artist?: string
  album?: string
}

export interface DownloadRouterDeps {
  /** Absolute directory where Bandcamp downloads land before import.
   *  Persisted across restarts; importOneFile already copies into the
   *  canonical hashed layout. */
  pendingImportsDir: string
  /** Wraps importOneFile() for a batch of absolute audio paths. The
   *  `source` tag (always 'bandcamp' from this caller) is persisted
   *  on the resulting track records so library views can surface
   *  provenance later. */
  importDownloaded: (absPaths: string[], source?: string) => Promise<ImportedTrackRecord[]>
  /** Fired once per successfully imported track. */
  onTrackImported: (track: ImportedTrackRecord) => void
  /** Fired once per import failure (download-level OR per-file). */
  onImportFailed: (reason: { filename: string; error: string }) => void
}

/** Attach interception to the Bandcamp session. Idempotent per session. */
export function attachDownloadRouter(session: Session, deps: DownloadRouterDeps): void {
  // The save dir must exist before any download lands. Create it once
  // here so we don't race on the first purchase of the session.
  mkdirSync(deps.pendingImportsDir, { recursive: true })

  session.on('will-download', (_event, item: DownloadItem) => {
    // setSavePath + the done-listener MUST be attached synchronously
    // here, before any await, or Electron pops a save dialog / the
    // event is missed.
    const filename = item.getFilename()
    const savePath = join(deps.pendingImportsDir, filename)
    item.setSavePath(savePath)
    const donePromise: Promise<string> = new Promise((resolve) => {
      item.once('done', (_e, s) => resolve(s))
    })
    void handleDownload({ filename, savePath, donePromise }, deps)
  })
}

interface PendingDownload {
  filename: string
  savePath: string
  donePromise: Promise<string>
}

async function handleDownload(dl: PendingDownload, deps: DownloadRouterDeps): Promise<void> {
  const { filename, savePath, donePromise } = dl
  try {
    const state = await donePromise
    if (state !== 'completed') {
      deps.onImportFailed({ filename, error: `download ${state}` })
      return
    }

    let audioFiles: string[]
    if (ext(filename) === '.zip') {
      // Extract into a per-purchase subdir so concurrent album buys
      // can't collide on track filenames inside the zip.
      const stem = filename.replace(/\.zip$/i, '')
      const extractDir = join(deps.pendingImportsDir, `${stem}-${Date.now()}`)
      mkdirSync(extractDir, { recursive: true })
      audioFiles = await unzipAudio(savePath, extractDir)
    } else if (AUDIO_EXT.has(ext(filename))) {
      audioFiles = [savePath]
    } else {
      // Not an audio download (artwork, lyrics PDF, etc.) — leave the
      // file in place but don't import. Quiet by design.
      return
    }

    if (audioFiles.length === 0) {
      deps.onImportFailed({ filename, error: 'no audio in download' })
      return
    }

    // Deterministic order so album track numbers import in sequence
    // even when tags are sparse and the filename parser is the
    // fallback.
    audioFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const tracks = await deps.importDownloaded(audioFiles, SOURCE_TAG)
    if (tracks.length === 0) {
      deps.onImportFailed({ filename, error: 'import produced no tracks (all duplicates?)' })
      return
    }
    for (const t of tracks) deps.onTrackImported(t)
  } catch (err) {
    deps.onImportFailed({ filename, error: err instanceof Error ? err.message : String(err) })
  }
}
