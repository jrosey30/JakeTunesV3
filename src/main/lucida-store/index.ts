// ════════════════════════════════════════════════════════════════════════
//  lucida.to embedded view
//
//  Replaces the old squid.wtf store (squid went 502/dead). Same machinery:
//  a secure WebContentsView on its own persist:lucida partition (independent
//  cookies from Bandcamp's), a modern-Chrome UA spoof + popup-redirect that
//  clears Cloudflare's JS challenge and keeps any window.open() navigation
//  inside the embedded view, and the shared Bandcamp download-router so any
//  file lucida.to hands the browser lands in _pending-imports/, unzips if
//  needed, and imports through importOneFile() tagged source='lucida'.
// ════════════════════════════════════════════════════════════════════════

import { ipcMain, WebContentsView, BrowserWindow, session } from 'electron'
import { attachDownloadRouter, ImportedTrackRecord, BatchSummary } from '../bandcamp-integration/acquisition/download-router'

export interface LucidaDeps {
  getMainWindow: () => BrowserWindow | null
  /** Wraps importOneFile() — same one Bandcamp uses, with a 'lucida'
   *  source tag persisted onto each Track record. Matches the
   *  download-router contract (BatchSummary or bare array). */
  importDownloaded: (absPaths: string[], source?: string) => Promise<ImportedTrackRecord[] | BatchSummary>
  /** Absolute directory where lucida downloads land before import.
   *  Shared with Bandcamp's _pending-imports/ — same staging dir, the
   *  source field on the Track distinguishes them later if needed. */
  pendingImportsDir: string
}

function send(deps: LucidaDeps, channel: string, payload: unknown): void {
  const win = deps.getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const LUCIDA_PARTITION = 'persist:lucida'
const LUCIDA_HOME = 'https://lucida.to'

// Same UA the Bandcamp view uses — modern Chrome on macOS. Defeats most
// bot-detection heuristics that flag Electron's default UA, and lets the
// embedded Chromium clear Cloudflare's "Just a moment" JS challenge the
// same way a real browser does (curl gets a 403; a JS-running view passes).
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
      partition: LUCIDA_PARTITION,
      webSecurity: true,
      allowRunningInsecureContent: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  view.webContents.setUserAgent(REAL_BROWSER_UA)
  // Popup containment: redirect any window.open navigation into THIS
  // webContents instead of spawning a new BrowserWindow (which wouldn't
  // inherit the UA + would live outside the JakeTunes app frame).
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (view && !view.webContents.isDestroyed()) {
      void view.webContents.loadURL(url)
    }
    return { action: 'deny' }
  })
  viewLoaded = false
  return view
}

function attachView(deps: LucidaDeps, bounds: Bounds): void {
  const win = deps.getMainWindow()
  if (!win || win.isDestroyed()) return
  const v = ensureView()
  if (!attached) {
    win.contentView.addChildView(v)
    attached = true
  }
  v.setBounds(bounds)
  if (!viewLoaded) {
    void v.webContents.loadURL(LUCIDA_HOME)
    viewLoaded = true
  }
}

function detachView(deps: LucidaDeps): void {
  const win = deps.getMainWindow()
  if (view && attached && win && !win.isDestroyed()) {
    win.contentView.removeChildView(view)
  }
  attached = false
}

export function registerLucidaStore(deps: LucidaDeps): void {
  // Set the partition's UA at startup so the first request a renderer makes
  // already presents as Chrome — matches the Bandcamp pattern.
  const lucidaSession = session.fromPartition(LUCIDA_PARTITION)
  lucidaSession.setUserAgent(REAL_BROWSER_UA)

  // Mirror Bandcamp: any download from lucida.to (zip album or single
  // track) lands in _pending-imports/, unzips if needed, and routes audio
  // through importOneFile() with source='lucida'. Emits on the same
  // bandcamp:* event channels the renderer already listens on — pill
  // progress, library ADD_IMPORTED_TRACKS dispatch, recently-added marker,
  // and toast all fire identically.
  attachDownloadRouter(lucidaSession, {
    pendingImportsDir: deps.pendingImportsDir,
    importDownloaded: (paths) => deps.importDownloaded(paths, 'lucida'),
    onTrackImported: (track) => send(deps, 'bandcamp:track-imported', track),
    onImportFailed: (reason) => send(deps, 'bandcamp:import-failed', reason),
    onAllDuplicates: (info) => send(deps, 'bandcamp:all-duplicates', info),
  })

  ipcMain.handle('lucida:mount', (_e, bounds: Bounds) => {
    attachView(deps, bounds)
    return { ok: true as const }
  })

  ipcMain.handle('lucida:resize', (_e, bounds: Bounds) => {
    if (view && !view.webContents.isDestroyed() && attached) view.setBounds(bounds)
    return { ok: true as const }
  })

  ipcMain.handle('lucida:unmount', () => {
    detachView(deps)
    return { ok: true as const }
  })

  // Back/forward nav, mirror of the Bandcamp store. Lets the renderer paint
  // a real back arrow above the embedded view so users aren't trapped on
  // whatever page a link landed them on. canGoBack/Forward returned so the
  // UI can dim buttons with no history to walk.
  ipcMain.handle('lucida:nav-state', () => {
    if (!view || view.webContents.isDestroyed()) {
      return { ok: false as const, canGoBack: false, canGoForward: false }
    }
    return {
      ok: true as const,
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
    }
  })

  ipcMain.handle('lucida:go-back', () => {
    if (!view || view.webContents.isDestroyed()) return { ok: false as const }
    if (view.webContents.canGoBack()) view.webContents.goBack()
    return { ok: true as const }
  })

  ipcMain.handle('lucida:go-forward', () => {
    if (!view || view.webContents.isDestroyed()) return { ok: false as const }
    if (view.webContents.canGoForward()) view.webContents.goForward()
    return { ok: true as const }
  })
}
