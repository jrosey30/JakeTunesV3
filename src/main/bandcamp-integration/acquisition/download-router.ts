// ════════════════════════════════════════════════════════════════════════
//  Download router (Brief 036 v2.2, Layer 4 — highest-risk early-validation)
//
//  Bandcamp post-purchase downloads: single tracks arrive as one tagged
//  audio file; albums arrive as a ZIP of tagged files + cover.jpg. We
//  intercept via `will-download` on the persist:bandcamp session, save to
//  a temp staging dir, unzip albums (pure-JS yauzl — no native build), and
//  hand each audio file to the existing importOneFile() primitive (injected
//  as `importDownloaded`) so dedupe / conversion / tag-embedding / hashed-
//  folder placement all happen exactly as for any other import.
// ════════════════════════════════════════════════════════════════════════

import { Session, DownloadItem } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { rm } from 'fs/promises'
import { createWriteStream, mkdirSync } from 'fs'
import yauzl from 'yauzl'

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.alac', '.wav', '.aiff', '.aif', '.ogg'])

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function stagingDir(): string {
  return join(app.getPath('temp'), 'jaketunes-bandcamp', String(Date.now()))
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
        // Directories end with '/'. Skip non-audio (cover.jpg, etc.).
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

export interface DownloadRouterDeps {
  /** Wraps importOneFile() for a batch of absolute audio paths; returns the
   *  created Track records (renderer adds them to the library). */
  importDownloaded: (absPaths: string[]) => Promise<unknown[]>
  /** Notify the renderer a purchase landed (for toast + library refresh). */
  onComplete: (result: { ok: boolean; trackCount: number; error?: string }) => void
}

/** Attach interception to the Bandcamp session. Idempotent per session. */
export function attachDownloadRouter(session: Session, deps: DownloadRouterDeps): void {
  session.on('will-download', (_event, item: DownloadItem) => {
    // setSavePath + the done-listener MUST be attached synchronously here,
    // before any await, or Electron pops a save dialog / the event is missed.
    const dir = stagingDir()
    mkdirSync(dir, { recursive: true })
    const filename = item.getFilename()
    const savePath = join(dir, filename)
    item.setSavePath(savePath)
    const donePromise: Promise<string> = new Promise((resolve) => {
      item.once('done', (_e, s) => resolve(s))
    })
    void handleDownload({ dir, filename, savePath, donePromise }, deps)
  })
}

interface PendingDownload {
  dir: string
  filename: string
  savePath: string
  donePromise: Promise<string>
}

async function handleDownload(dl: PendingDownload, deps: DownloadRouterDeps): Promise<void> {
  const { dir, filename, savePath, donePromise } = dl
  try {
    const state = await donePromise
    if (state !== 'completed') {
      deps.onComplete({ ok: false, trackCount: 0, error: `download ${state}` })
      return
    }

    let audioFiles: string[]
    if (ext(filename) === '.zip') {
      audioFiles = await unzipAudio(savePath, dir)
    } else if (AUDIO_EXT.has(ext(filename))) {
      audioFiles = [savePath]
    } else {
      deps.onComplete({ ok: false, trackCount: 0, error: `unsupported file: ${filename}` })
      return
    }

    if (audioFiles.length === 0) {
      deps.onComplete({ ok: false, trackCount: 0, error: 'no audio in download' })
      return
    }

    // Deterministic order so album track numbers import in sequence even
    // when tags are sparse and the filename parser is the fallback.
    audioFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const tracks = await deps.importDownloaded(audioFiles)
    deps.onComplete({ ok: true, trackCount: tracks.length })
  } catch (err) {
    deps.onComplete({ ok: false, trackCount: 0, error: err instanceof Error ? err.message : String(err) })
  } finally {
    // Best-effort cleanup of the staging copy; importOneFile already copied
    // each file into the library hashed-folder layout.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
