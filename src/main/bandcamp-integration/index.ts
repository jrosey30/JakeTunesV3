// ════════════════════════════════════════════════════════════════════════
//  Bandcamp Store integration — v4 wiring
//
//  v4 strategy: embed bandcamp.com on the persist:bandcamp partition as
//  a single WebContentsView. Bandcamp's own UI is the Store UI; we only
//  intercept downloads and route them into the library via importOneFile.
//
//  This module owns:
//    - The embedded WebContentsView lifecycle (mount/resize/unmount IPC)
//    - The download-router attachment on the partition's session
//
//  Pre-v4 scrape modules (data/, personalization/) are archived under
//  _archive/; see Brief 036 v4 §4 Phase A.
// ════════════════════════════════════════════════════════════════════════

import { ipcMain, WebContentsView, BrowserWindow } from 'electron'
import { BANDCAMP_PARTITION } from './partition'
import { bandcampSession } from './acquisition/auth'
import { attachDownloadRouter, ImportedTrackRecord } from './acquisition/download-router'

export interface BandcampDeps {
  getMainWindow: () => BrowserWindow | null
  /** Wraps importOneFile() for absolute audio paths. Receives a `source`
   *  tag (always 'bandcamp' from here) that gets persisted on each
   *  track record. */
  importDownloaded: (absPaths: string[], source?: string) => Promise<ImportedTrackRecord[]>
  /** Absolute directory where Bandcamp downloads land; importOneFile
   *  copies them into the canonical library layout afterwards. */
  pendingImportsDir: string
}

const BANDCAMP_HOME = 'https://bandcamp.com'

// Electron's default UA includes "Electron/X.X JakeTunes/X.X" tokens that
// Fastly's bot-detection layer (which fronts bandcamp.com) flags as
// automated traffic — the user hits a CAPTCHA wall instead of the normal
// page. Override with a clean, current Chrome-on-macOS string so the
// session looks like an ordinary browser. The underlying Chromium is
// real, only the identifying tokens are stripped.
const REAL_BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

// Module-level so the view + its loaded URL + its cookies survive sidebar
// navigation: clicking away from Store and back resumes the same Bandcamp
// page the user left, no reload.
let view: WebContentsView | null = null
let viewLoaded = false
let attached = false

function send(deps: BandcampDeps, channel: string, payload: unknown): void {
  const win = deps.getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view
  // Decision 2: every secure default on. No preload — bandcamp.com content
  // has no access to JakeTunes IPC. The persist:bandcamp partition is the
  // same one Phase 1's auth helpers used, so any pre-existing login carries.
  view = new WebContentsView({
    webPreferences: {
      partition: BANDCAMP_PARTITION,
      webSecurity: true,
      allowRunningInsecureContent: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // Belt-and-suspenders: the session-level UA covers all requests, but
  // also pin it on this webContents in case Electron ever decouples them
  // (defaultURLChain edge cases).
  view.webContents.setUserAgent(REAL_BROWSER_UA)
  viewLoaded = false
  return view
}

function attachView(deps: BandcampDeps, bounds: Bounds): void {
  const win = deps.getMainWindow()
  if (!win || win.isDestroyed()) return
  const v = ensureView()
  if (!attached) {
    win.contentView.addChildView(v)
    attached = true
  }
  v.setBounds(bounds)
  if (!viewLoaded) {
    void v.webContents.loadURL(BANDCAMP_HOME)
    viewLoaded = true
  }
}

function detachView(deps: BandcampDeps): void {
  const win = deps.getMainWindow()
  if (view && attached && win && !win.isDestroyed()) {
    win.contentView.removeChildView(view)
  }
  attached = false
}

export function registerBandcampIntegration(deps: BandcampDeps): void {
  // Override the partition's UA before anything else so every request
  // (page loads, XHR, downloads) and the in-page navigator.userAgent both
  // present as a real Chrome on macOS — defuses Fastly's bot challenge.
  bandcampSession().setUserAgent(REAL_BROWSER_UA)

  // Download interception is attached to the partition's session at startup
  // so downloads route through importOneFile even if the user never opens
  // the Store view (Bandcamp could spawn a download from a new tab). The
  // attach function itself removes any prior listener, so we don't need a
  // module-level guard — works across electron-vite main reloads too.
  attachDownloadRouter(bandcampSession(), {
    pendingImportsDir: deps.pendingImportsDir,
    importDownloaded: deps.importDownloaded,
    onTrackImported: (track) => send(deps, 'bandcamp:track-imported', track),
    onImportFailed: (reason) => send(deps, 'bandcamp:import-failed', reason),
  })

  ipcMain.handle('bandcamp:mount', (_e, bounds: Bounds) => {
    attachView(deps, bounds)
    return { ok: true as const }
  })

  ipcMain.handle('bandcamp:resize', (_e, bounds: Bounds) => {
    if (view && !view.webContents.isDestroyed() && attached) view.setBounds(bounds)
    return { ok: true as const }
  })

  ipcMain.handle('bandcamp:unmount', () => {
    detachView(deps)
    return { ok: true as const }
  })
}
