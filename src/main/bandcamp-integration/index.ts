// ════════════════════════════════════════════════════════════════════════
//  Bandcamp Store integration — wiring (Brief 036 v2.2)
//
//  Single entry point registered from src/main/index.ts. Owns: the IPC
//  surface, the auth/checkout overlay WebContentsView (persist:bandcamp,
//  no preload), the download-router hookup, and daily profile refresh.
//
//  importOneFile() lives in the 292KB main/index.ts; rather than export its
//  internals we accept an injected `importDownloaded` bridge so this module
//  stays decoupled and index.ts edits stay tiny.
// ════════════════════════════════════════════════════════════════════════

import { ipcMain, WebContentsView, BrowserWindow } from 'electron'
import { BANDCAMP_PARTITION } from './data/scraper'
import { getAlbum, search as catalogSearch, getArtistReleases } from './data/catalog-data'
import { loadProfile, clearAll } from './personalization/profile-store'
import { getUnified, rebuildUnified, scheduleDailyRefresh } from './personalization/refresh-scheduler'
import { buildOwnedSets, markOwned } from './personalization/overlap-detection'
import { readLibraryRows } from './data/library-data'
import { rankAlbums } from './personalization/ranking'
import { bandcampSession, checkAuth, clearSession } from './acquisition/auth'
import { attachDownloadRouter } from './acquisition/download-router'
import { StoreAlbum, Tier1Surface } from './types'

export interface BandcampDeps {
  getMainWindow: () => BrowserWindow | null
  /** Wraps importOneFile() for absolute audio paths; returns Track records. */
  importDownloaded: (absPaths: string[]) => Promise<unknown[]>
}

type CheckoutOutcome = 'completed' | 'cancelled' | 'external'

let overlay: WebContentsView | null = null
let routerAttached = false
// Brief 036 v3 Decision 3: bandcamp:open-checkout resolves with the buy
// outcome when the modal closes. `pendingCheckoutResolve` is the suspended
// resolver; `purchaseCompletedDuringSession` is flipped to true by the
// download-router when a purchase fires while the modal is open. On close
// we resolve 'completed' if the flag is set, else 'cancelled'. The flag is
// the canonical signal (more reliable than URL pattern-matching on
// Bandcamp's confirmation page, which has historically shifted).
let pendingCheckoutResolve: ((outcome: CheckoutOutcome) => void) | null = null
let purchaseCompletedDuringSession = false

function send(deps: BandcampDeps, channel: string, payload: unknown): void {
  const win = deps.getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// ── auth / checkout overlay ────────────────────────────────────────────

/** Centered modal bounds for checkout: max 1000×800, capped at 90% of the
 *  window so the renderer stays visible around the edges. */
function modalBounds(win: BrowserWindow): { x: number; y: number; width: number; height: number } {
  const b = win.getContentBounds()
  const w = Math.min(1000, Math.floor(b.width * 0.9))
  const h = Math.min(800, Math.floor(b.height * 0.9))
  return {
    x: Math.floor((b.width - w) / 2),
    y: Math.floor((b.height - h) / 2),
    width: w,
    height: h,
  }
}

function ensureOverlay(deps: BandcampDeps): WebContentsView | null {
  const win = deps.getMainWindow()
  if (!win) return null
  if (!overlay || overlay.webContents.isDestroyed()) {
    overlay = new WebContentsView({
      webPreferences: { partition: BANDCAMP_PARTITION, nodeIntegration: false, contextIsolation: true },
    })
    win.contentView.addChildView(overlay)
  }
  return overlay
}

/** Login overlay: covers most of the window (multi-step login + 2FA need
 *  room), leaves a 44px top strip for the renderer-drawn close bar. */
function showLoginOverlay(deps: BandcampDeps, url: string): void {
  const win = deps.getMainWindow()
  const view = ensureOverlay(deps)
  if (!win || !view) return
  const b = win.getContentBounds()
  view.setBounds({ x: 0, y: 44, width: b.width, height: b.height - 44 })
  view.webContents.loadURL(url)
}

/** Checkout overlay (Brief 036 v3 Decision 3): centered modal so the
 *  JakeTunes renderer remains visible around it. */
function showCheckoutOverlay(deps: BandcampDeps, url: string): void {
  const win = deps.getMainWindow()
  const view = ensureOverlay(deps)
  if (!win || !view) return
  view.setBounds(modalBounds(win))
  view.webContents.loadURL(url)
}

function hideOverlay(deps: BandcampDeps): void {
  const win = deps.getMainWindow()
  if (overlay && win && !win.isDestroyed()) {
    win.contentView.removeChildView(overlay)
  }
  if (overlay && !overlay.webContents.isDestroyed()) overlay.webContents.close()
  overlay = null
  if (pendingCheckoutResolve) {
    const outcome: CheckoutOutcome = purchaseCompletedDuringSession ? 'completed' : 'cancelled'
    const resolve = pendingCheckoutResolve
    pendingCheckoutResolve = null
    purchaseCompletedDuringSession = false
    resolve(outcome)
  }
}

/** Poll for login completion after the user submits credentials (+2FA). */
async function waitForLogin(timeoutMs = 150000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await checkAuth()
    if (status.loggedIn) return true
    await new Promise((r) => setTimeout(r, 2500))
  }
  return false
}

// ── candidate gathering for Tier-1 surfaces ────────────────────────────
async function gatherFollowedReleases(limitArtists = 20): Promise<StoreAlbum[]> {
  const profile = await loadProfile()
  if (!profile) return []
  const withUrls = profile.following.filter((f) => f.url).slice(0, limitArtists)
  const out: StoreAlbum[] = []
  for (const f of withUrls) {
    const releases = await getArtistReleases(f.url as string)
    for (const r of releases) { if (!r.artist) r.artist = f.name; out.push(r) }
  }
  return out
}

async function getSurface(name: Tier1Surface, limit: number): Promise<StoreAlbum[]> {
  const profile = await getUnified()
  const rows = await readLibraryRows()
  const owned = buildOwnedSets(rows)
  const candidates = markOwned(await gatherFollowedReleases(), owned)
  const ranked = rankAlbums(candidates, profile, name)
  return ranked.slice(0, limit)
}

// ── registration ───────────────────────────────────────────────────────
export function registerBandcampIntegration(deps: BandcampDeps): void {
  // Download interception lives on the shared bandcamp session.
  if (!routerAttached) {
    attachDownloadRouter(bandcampSession(), {
      importDownloaded: deps.importDownloaded,
      onComplete: (result) => {
        if (result.ok) purchaseCompletedDuringSession = true
        send(deps, 'bandcamp:purchase-complete', result)
      },
    })
    routerAttached = true
  }

  ipcMain.handle('bandcamp:auth-status', () => checkAuth())

  ipcMain.handle('bandcamp:connect', async () => {
    showLoginOverlay(deps, 'https://bandcamp.com/login')
    const ok = await waitForLogin()
    hideOverlay(deps)
    if (ok) void rebuildUnified(true).then((u) => send(deps, 'bandcamp:profile-updated', { computedAt: u.computedAt }))
    return { ok }
  })

  ipcMain.handle('bandcamp:logout', async () => { await clearSession(); return { ok: true } })

  ipcMain.handle('bandcamp:clear-data', async () => {
    await clearSession()
    await clearAll()
    return { ok: true }
  })

  ipcMain.handle('bandcamp:refresh-profile', async () => {
    const u = await rebuildUnified(true)
    return { ok: true, computedAt: u.computedAt }
  })

  ipcMain.handle('bandcamp:get-profile', () => getUnified())

  ipcMain.handle('bandcamp:get-album', async (_e, url: string) => {
    const album = await getAlbum(url)
    if (!album) return { ok: false as const, error: 'album not found' }
    const owned = buildOwnedSets(await readLibraryRows())
    markOwned([album], owned)
    return { ok: true as const, album }
  })

  ipcMain.handle('bandcamp:search', async (_e, query: string) => {
    // Returns BandcampSearchResult[] (Brief 036 v3 Decision 1). Owned-marking
    // and personalization re-rank are deferred — the union carries no
    // `owned` field, and re-rank is parked per §9.
    const results = await catalogSearch(query)
    return { ok: true as const, results }
  })

  ipcMain.handle('bandcamp:get-surface', async (_e, name: Tier1Surface, limit = 20) => {
    try {
      return { ok: true as const, items: await getSurface(name, limit) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('bandcamp:open-checkout', (_e, url: string): Promise<{ ok: true; outcome: CheckoutOutcome }> => {
    // Double-click safety: if a previous checkout is still pending, resolve
    // it as cancelled before starting the new one. Without this the prior
    // promise would never settle.
    if (pendingCheckoutResolve) {
      const prev = pendingCheckoutResolve
      pendingCheckoutResolve = null
      prev('cancelled')
    }
    purchaseCompletedDuringSession = false
    showCheckoutOverlay(deps, url)
    return new Promise<{ ok: true; outcome: CheckoutOutcome }>((resolve) => {
      pendingCheckoutResolve = (outcome) => resolve({ ok: true, outcome })
    })
  })
  ipcMain.handle('bandcamp:close-overlay', () => { hideOverlay(deps); return { ok: true } })

  // Background daily refresh; the engine is created lazily on first use.
  scheduleDailyRefresh()
}
