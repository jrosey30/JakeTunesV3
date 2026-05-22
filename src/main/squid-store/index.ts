// ════════════════════════════════════════════════════════════════════════
//  squid.wtf embedded view
//
//  Parallel to bandcamp-integration but stripped down — no download
//  router, no library wiring. Just a secure WebContentsView on its own
//  persist:squid partition (independent cookies from Bandcamp's), with
//  the same Chrome-UA spoof + popup-redirect that defuses Fastly bot
//  challenges and keeps any window.open() navigation inside the same
//  embedded view rather than spawning a separate BrowserWindow.
// ════════════════════════════════════════════════════════════════════════

import { ipcMain, WebContentsView, BrowserWindow, session } from 'electron'
import { attachDownloadRouter, ImportedTrackRecord } from '../bandcamp-integration/acquisition/download-router'

export interface SquidDeps {
  getMainWindow: () => BrowserWindow | null
  /** Wraps importOneFile() — same one Bandcamp uses, with a 'squid'
   *  source tag persisted onto each Track record. */
  importDownloaded: (absPaths: string[], source?: string) => Promise<ImportedTrackRecord[]>
  /** Absolute directory where squid downloads land before import.
   *  Shared with Bandcamp's _pending-imports/ — same staging dir,
   *  source field on the Track distinguishes them later if anyone
   *  needs it. */
  pendingImportsDir: string
}

function send(deps: SquidDeps, channel: string, payload: unknown): void {
  const win = deps.getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const SQUID_PARTITION = 'persist:squid'
const SQUID_HOME = 'https://squid.wtf'

// Same UA the Bandcamp view uses — modern Chrome on macOS. Defeats most
// bot-detection heuristics that flag Electron's default UA.
const REAL_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

let view: WebContentsView | null = null
let viewLoaded = false
let attached = false

function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view
  view = new WebContentsView({
    webPreferences: {
      partition: SQUID_PARTITION,
      webSecurity: true,
      allowRunningInsecureContent: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  view.webContents.setUserAgent(REAL_BROWSER_UA)
  // Same popup-containment pattern as Bandcamp: redirect any window.open
  // navigation into THIS webContents instead of spawning a new
  // BrowserWindow (which wouldn't inherit the UA + would live outside
  // the JakeTunes app frame).
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (view && !view.webContents.isDestroyed()) {
      void view.webContents.loadURL(url)
    }
    return { action: 'deny' }
  })
  viewLoaded = false
  return view
}

function attachView(deps: SquidDeps, bounds: Bounds): void {
  const win = deps.getMainWindow()
  if (!win || win.isDestroyed()) return
  const v = ensureView()
  if (!attached) {
    win.contentView.addChildView(v)
    attached = true
  }
  v.setBounds(bounds)
  if (!viewLoaded) {
    void v.webContents.loadURL(SQUID_HOME)
    viewLoaded = true
  }
}

function detachView(deps: SquidDeps): void {
  const win = deps.getMainWindow()
  if (view && attached && win && !win.isDestroyed()) {
    win.contentView.removeChildView(view)
  }
  attached = false
}

export function registerSquidStore(deps: SquidDeps): void {
  // Set the partition's UA at startup so the first request a renderer
  // makes already presents as Chrome — matches the Bandcamp pattern.
  const squidSession = session.fromPartition(SQUID_PARTITION)
  squidSession.setUserAgent(REAL_BROWSER_UA)

  // Mirror Bandcamp: attach the download-router so any download from
  // squid.wtf (zip album or single track) lands in _pending-imports/,
  // unzips if needed, and routes audio through importOneFile() with
  // source='squid'. Emits on the same bandcamp:* event channels the
  // renderer is already subscribed to — pill progress, library
  // ADD_IMPORTED_TRACKS dispatch, recently-added marker, and toast
  // all fire identically.
  attachDownloadRouter(squidSession, {
    pendingImportsDir: deps.pendingImportsDir,
    importDownloaded: (paths) => deps.importDownloaded(paths, 'squid'),
    onTrackImported: (track) => send(deps, 'bandcamp:track-imported', track),
    onImportFailed: (reason) => send(deps, 'bandcamp:import-failed', reason),
  })

  ipcMain.handle('squid:mount', (_e, bounds: Bounds) => {
    attachView(deps, bounds)
    return { ok: true as const }
  })

  ipcMain.handle('squid:resize', (_e, bounds: Bounds) => {
    if (view && !view.webContents.isDestroyed() && attached) view.setBounds(bounds)
    return { ok: true as const }
  })

  ipcMain.handle('squid:unmount', () => {
    detachView(deps)
    return { ok: true as const }
  })
}
