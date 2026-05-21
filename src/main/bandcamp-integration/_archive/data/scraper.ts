// ════════════════════════════════════════════════════════════════════════
//  Bandcamp scrape engine (Brief 036 v2.2, Layer 3)
//
//  Phase 0 finding: a datacenter IP + non-browser UA gets 403 from
//  bandcamp.com. The spike proved that running fetches *in-page* from a
//  WebContents on the `persist:bandcamp` partition works — real Chromium
//  fingerprint + Jake's residential IP + the session cookies. We reuse
//  exactly that here as a headless request engine: a hidden BrowserWindow
//  whose webContents we drive with executeJavaScript.
//
//  This engine carries Jake's auth cookies (same partition the auth/
//  checkout views use), so it serves BOTH catalog reads and authenticated
//  profile reads. No preload, no electronAPI — it never loads our renderer.
// ════════════════════════════════════════════════════════════════════════

import { BrowserWindow } from 'electron'

export const BANDCAMP_PARTITION = 'persist:bandcamp'

let engine: BrowserWindow | null = null

function buildEngine(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: BANDCAMP_PARTITION,
      // Remote content only — NO preload, NO node, isolated.
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  win.on('closed', () => { engine = null })
  return win
}

export function ensureEngine(): BrowserWindow {
  if (!engine || engine.isDestroyed()) engine = buildEngine()
  return engine
}

export function destroyEngine(): void {
  if (engine && !engine.isDestroyed()) engine.destroy()
  engine = null
}

/** Navigate the engine and resolve once the page settles (or times out). */
export function loadAndWait(url: string, timeoutMs = 35000): Promise<boolean> {
  const wc = ensureEngine().webContents
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      wc.removeListener('did-stop-loading', onStop)
      resolve(ok)
    }
    const onStop = () => finish(true)
    wc.on('did-stop-loading', onStop)
    wc.loadURL(url).catch(() => finish(false))
    setTimeout(() => finish(true), timeoutMs)
  })
}

/** Run JS in the current page; returns the (JSON-serializable) result. */
export async function exec<T = unknown>(js: string): Promise<T | null> {
  try {
    return (await ensureEngine().webContents.executeJavaScript(js, true)) as T
  } catch {
    return null
  }
}

interface HttpErr { __httpError?: number; __fetchError?: string }

/** GET JSON from inside the bandcamp page (same-origin, cookies sent). */
export function pageGetJSON<T = unknown>(url: string): Promise<(T & HttpErr) | null> {
  const u = JSON.stringify(url)
  return exec<T & HttpErr>(
    `fetch(${u},{credentials:'include',headers:{'Accept':'application/json'}})` +
    `.then(r=>r.ok?r.json():({__httpError:r.status})).catch(e=>({__fetchError:String(e)}))`,
  )
}

/** POST JSON from inside the bandcamp page. */
export function pagePostJSON<T = unknown>(url: string, body: unknown): Promise<(T & HttpErr) | null> {
  const u = JSON.stringify(url)
  const b = JSON.stringify(JSON.stringify(body)) // JS string literal of the JSON body
  return exec<T & HttpErr>(
    `fetch(${u},{method:'POST',credentials:'include',` +
    `headers:{'Content-Type':'application/json'},body:${b}})` +
    `.then(r=>r.ok?r.json():({__httpError:r.status})).catch(e=>({__fetchError:String(e)}))`,
  )
}

/** Read Bandcamp's embedded `#pagedata` JSON state for the current page. */
export function readPagedata<T = Record<string, unknown>>(): Promise<T | null> {
  return exec<T>(
    `(()=>{try{const el=document.getElementById('pagedata');` +
    `return el?JSON.parse(el.getAttribute('data-blob')):null}catch(e){return null}})()`,
  )
}

/** Extract the `data-tralbum` JSON blob from an album/track page. */
export async function extractTralbum(url: string): Promise<Record<string, unknown> | null> {
  const ok = await loadAndWait(url)
  if (!ok) return null
  return exec<Record<string, unknown>>(
    `(()=>{const el=document.querySelector('[data-tralbum]');if(!el)return null;` +
    `try{return JSON.parse(el.getAttribute('data-tralbum'))}catch(e){return null}})()`,
  )
}

/** Polite pacing between catalog requests to avoid tripping rate limits. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
