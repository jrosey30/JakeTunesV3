/**
 * Inbox watcher: auto-imports files Qobuz Downloader (or anything else)
 * drops into ~/Music2/_inbox.
 *
 * Design:
 *   1. Chokidar watches the inbox directory (recursive — Qobuz drops
 *      Artist/Album/track.flac).
 *   2. `awaitWriteFinish` waits 3s after the last byte of a file before
 *      firing — prevents trying to import a half-downloaded file.
 *   3. Adds get batched for 1.5s so an album of 12 tracks lands as ONE
 *      renderer notification instead of 12 separate IPC bursts.
 *   4. Renderer receives the batched paths via `inbox-files-detected`
 *      IPC event, calls the SAME enqueueFiles() drag-drop uses, and
 *      passes `deleteSourceOnSuccess` so the queue worker removes the
 *      source FLAC after JakeTunes has its transcoded copy in iPod_Control.
 *
 * Why this lives in main (not a `chokidar.watch` directly in renderer):
 *   - chokidar uses native fs APIs that are only available in Node, not
 *     the Chromium renderer process.
 *   - A single watcher in main avoids the gotcha where the renderer
 *     restarts (HMR / window reload) and orphans event handlers.
 *
 * Failure modes handled:
 *   - Inbox folder doesn't exist → mkdir on first start.
 *   - User deletes inbox folder mid-session → watcher reports error
 *     event, we log and keep going (chokidar self-recovers if folder
 *     reappears).
 *   - Partial download (`.crdownload`, `.part`, `.tmp`) → ignored.
 *   - Dotfiles / .DS_Store → ignored.
 *   - File already imported (dupe) → the existing queue dupe-detection
 *     marks it `dupe` and skips it. We still delete the source so the
 *     inbox stays clean. (User confirmed 1a: always delete.)
 *
 * Safety on delete:
 *   `deleteInboxSource` refuses to delete anything outside the current
 *   watched inbox path. The renderer can't be tricked into asking us to
 *   `rm` an arbitrary path even if its state corrupts.
 */

import { join, normalize, sep } from 'path'
import { homedir } from 'os'
import { unlink, mkdir, stat } from 'fs/promises'
import type { BrowserWindow } from 'electron'

import chokidar, { type FSWatcher } from 'chokidar'

export interface InboxConfig {
  enabled: boolean
  /** Empty string / "~" = use default (~/Music2/_inbox). */
  path: string
}

const DEFAULT_INBOX_PATH = join(homedir(), 'Music2', '_inbox')

// Audio extensions we care about. Matched against the part AFTER the
// final dot. Lowercased on compare. Anything else dropped into the
// inbox is ignored (cover art, .nfo, .lrc, etc.). resolveAudioPaths
// on the main side runs a similar gate at import time, but filtering
// here avoids enqueueing things the import will reject anyway.
const AUDIO_EXTS = new Set([
  '.flac', '.m4a', '.mp3', '.wav',
  '.aiff', '.aif', '.alac', '.aac',
  '.ogg', '.opus', '.wv', '.ape',
])

// Module-singleton state. We only ever run one watcher; reconfigure
// closes the old one and starts a fresh one with the new path.
let watcher: FSWatcher | null = null
let currentPath: string | null = null
let currentEnabled = false
let getWindow: (() => BrowserWindow | null) | null = null

// Coalesce album-sized bursts into one renderer message. A 12-track
// album triggers 12 add events over ~1 second of disk activity; we
// hold them in pendingPaths until 1.5s after the LAST add, then send
// them all at once. Prevents the renderer from getting 12 separate
// "enqueueFiles" calls (each of which does an IPC + library reflect).
const pendingPaths = new Set<string>()
let batchTimer: NodeJS.Timeout | null = null
const BATCH_DELAY_MS = 1500

function isAudioFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  if (lower.startsWith('.')) return false
  if (lower.endsWith('.crdownload') || lower.endsWith('.part') || lower.endsWith('.tmp')) return false
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return false
  return AUDIO_EXTS.has(lower.substring(dot))
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || ''
}

function flushBatch(): void {
  batchTimer = null
  if (pendingPaths.size === 0) return
  const paths = Array.from(pendingPaths)
  pendingPaths.clear()
  const win = getWindow?.()
  if (!win || win.isDestroyed()) {
    // Window gone — drop the batch. The renderer's startup scan on
    // next launch will pick these up if they're still in the inbox.
    console.warn('[inbox-watcher] window unavailable, dropping batch of', paths.length)
    return
  }
  try {
    win.webContents.send('inbox-files-detected', paths)
    console.log(`[inbox-watcher] notified renderer of ${paths.length} file(s)`)
  } catch (err) {
    console.warn('[inbox-watcher] failed to notify renderer:', err)
  }
}

function scheduleFlush(): void {
  if (batchTimer) clearTimeout(batchTimer)
  batchTimer = setTimeout(flushBatch, BATCH_DELAY_MS)
}

export function getDefaultInboxPath(): string {
  return DEFAULT_INBOX_PATH
}

/**
 * Resolve a user-supplied path. Empty / "~" → default. "~/..." expands
 * to homedir. Absolute paths pass through. Always returns a normalized
 * absolute path.
 */
export function resolveInboxPath(raw?: string): string {
  const trimmed = (raw || '').trim()
  if (trimmed === '' || trimmed === '~') return DEFAULT_INBOX_PATH
  if (trimmed.startsWith('~/')) return normalize(join(homedir(), trimmed.slice(2)))
  return normalize(trimmed)
}

/**
 * One-time wire-up — called from main/index.ts after the window exists.
 * The watcher needs a way to look up the (possibly-recreated) BrowserWindow
 * each time it emits, so we take an accessor function rather than the
 * window itself.
 */
export function configureInboxWatcher(windowAccessor: () => BrowserWindow | null): void {
  getWindow = windowAccessor
}

async function stopInternal(): Promise<void> {
  if (watcher) {
    try { await watcher.close() } catch { /* ignore */ }
    watcher = null
  }
  currentPath = null
  if (batchTimer) {
    clearTimeout(batchTimer)
    batchTimer = null
  }
  pendingPaths.clear()
}

/**
 * Start or reconfigure the watcher. Idempotent — calling with the same
 * config is a no-op. Safe to call repeatedly when the user changes
 * settings. Returns the resolved path so the caller can echo it back
 * for display.
 */
export async function startOrReconfigureInboxWatcher(
  config: InboxConfig,
): Promise<{ ok: boolean; error?: string; path: string }> {
  const resolvedPath = resolveInboxPath(config.path)

  if (currentEnabled === config.enabled && currentPath === resolvedPath) {
    return { ok: true, path: resolvedPath }
  }

  await stopInternal()
  currentEnabled = config.enabled

  if (!config.enabled) {
    console.log('[inbox-watcher] disabled')
    return { ok: true, path: resolvedPath }
  }

  try {
    await mkdir(resolvedPath, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      path: resolvedPath,
      error: `Could not create inbox folder: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  watcher = chokidar.watch(resolvedPath, {
    ignored: (p: string) => {
      const base = basename(p)
      if (base.startsWith('.')) return true
      if (base.endsWith('.crdownload') || base.endsWith('.part') || base.endsWith('.tmp')) return true
      return false
    },
    persistent: true,
    ignoreInitial: false,           // catch files dropped while app was closed
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval: 200,
    },
    depth: 10,                      // Artist/Album/Disc/track.flac is depth 4
  })

  watcher.on('add', (filePath: string) => {
    if (!isAudioFile(basename(filePath))) return
    pendingPaths.add(filePath)
    scheduleFlush()
  })

  watcher.on('error', (err: unknown) => {
    console.warn('[inbox-watcher] watcher error:', err)
  })

  currentPath = resolvedPath
  console.log(`[inbox-watcher] watching ${resolvedPath}`)
  return { ok: true, path: resolvedPath }
}

/**
 * Delete a single source file after JakeTunes has imported it. Refuses
 * any path that isn't inside the currently-watched inbox — prevents the
 * renderer from being tricked into asking main to rm arbitrary files.
 */
export async function deleteInboxSource(filePath: string): Promise<{ ok: boolean; error?: string }> {
  if (!currentPath) return { ok: false, error: 'No inbox configured' }
  const normTarget = normalize(filePath)
  const normInbox = normalize(currentPath)
  // Containment check: target must be inside (or equal to) inbox path.
  // The trailing separator on inbox prevents a sibling like
  // `_inbox_archive` from matching when inbox is `_inbox`.
  if (normTarget !== normInbox && !normTarget.startsWith(normInbox + sep)) {
    return { ok: false, error: `Refusing to delete path outside inbox: ${filePath}` }
  }
  try {
    await unlink(normTarget)
    return { ok: true }
  } catch (err) {
    // Already gone? Fine — treat as success so the queue doesn't
    // surface a phantom failure to the user.
    try {
      await stat(normTarget)
    } catch {
      return { ok: true }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function stopInboxWatcher(): Promise<void> {
  await stopInternal()
  currentEnabled = false
}
