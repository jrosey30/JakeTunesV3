/**
 * ════════════════════════════════════════════════════════════════════════
 *  THROWAWAY PHASE 0 SPIKE — Brief 036 v2.2 (JakeTunes Bandcamp Store)
 *  NOT part of the app build. Delete this whole `spike/` dir after Phase 0.
 *
 *  Purpose: verify on Jake's Mac the four Bandcamp unknowns Claude Code
 *  could NOT validate from its cloud container (datacenter IP gets 403):
 *    Goal 1 — auth + cookie persistence (+2FA) in a WebContentsView on a
 *             `persist:bandcamp` partition.
 *    Goal 2 — authenticated fancollection JSON endpoints return data.
 *    Goal 3 — `will-download` intercepts a real purchase end-to-end and
 *             the file is importOneFile-ready (correct embedded tags).
 *    Goal 4 — a public album page's `data-tralbum` blob parses.
 *
 *  Run (from repo root, after `npm install`):
 *      npx electron spike/bandcamp/main.js
 *
 *  Outputs land in spike/bandcamp/out/ (gitignored — contains Jake's
 *  personal data; delete when done).
 *
 *  Architecture mirrors the real plan: a WebContentsView showing Bandcamp
 *  on a persistent partition, NO preload / NO electronAPI exposed to it.
 *  The left control strip is the window's own (local, trusted) page.
 * ════════════════════════════════════════════════════════════════════════
 */

const { app, BrowserWindow, WebContentsView, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const OUT = path.join(__dirname, 'out')
const PARTITION = 'persist:bandcamp'
const STRIP_W = 400 // left control strip width in px

let controlWin = null
let bandcampView = null

// ── tiny logging bridge: main → control panel ──────────────────────────
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('spike:log', line)
}
function status(msg) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('spike:status', msg)
}
function writeOut(name, data) {
  fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, name)
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  log(`wrote ${path.relative(process.cwd(), p)}`)
  return p
}

// ── bandcamp view helpers (all API calls run IN-PAGE on the bandcamp ──
// origin, so they carry cookies + a real browser fingerprint, which is
// the whole point — sidesteps the 403 the cloud container hit). ─────────
function wc() { return bandcampView.webContents }

function loadAndWait(url, timeout = 35000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      wc().removeListener('did-stop-loading', onStop)
      resolve(ok)
    }
    const onStop = () => finish(true)
    wc().on('did-stop-loading', onStop)
    wc().loadURL(url).catch((e) => { log(`loadURL failed: ${e.message}`); finish(false) })
    setTimeout(() => finish(true), timeout)
  })
}

async function exec(js) {
  try {
    return await wc().executeJavaScript(js, true)
  } catch (e) {
    log(`in-page exec error: ${e.message}`)
    return null
  }
}

// fetch JSON from inside the bandcamp page (same-origin, cookies sent)
function pageGetJSON(url) {
  return exec(
    `fetch(${JSON.stringify(url)},{credentials:'include',headers:{'Accept':'application/json'}})` +
    `.then(r=>r.ok?r.json():({__httpError:r.status})).catch(e=>({__fetchError:String(e)}))`
  )
}
function pagePostJSON(url, body) {
  const bodyLiteral = JSON.stringify(JSON.stringify(body))
  return exec(
    `fetch(${JSON.stringify(url)},{method:'POST',credentials:'include',` +
    `headers:{'Content-Type':'application/json'},body:${bodyLiteral}})` +
    `.then(r=>r.ok?r.json():({__httpError:r.status})).catch(e=>({__fetchError:String(e)}))`
  )
}

// read the #pagedata data-blob (Bandcamp embeds JSON state here)
function readPagedata() {
  return exec(
    `(()=>{try{const el=document.getElementById('pagedata');` +
    `return el?JSON.parse(el.getAttribute('data-blob')):null}catch(e){return {__parseError:String(e)}}})()`
  )
}

// ── GOAL 1: session detection on startup ───────────────────────────────
async function checkSession() {
  log('Goal 1 — checking session (collection_summary)...')
  const summary = await pageGetJSON('https://bandcamp.com/api/fan/2/collection_summary')
  if (summary && summary.fan_id) {
    const username = summary.collection_summary && summary.collection_summary.username
    log(`✅ logged in — fan_id=${summary.fan_id}${username ? ` (@${username})` : ''}`)
    status(`Session: LOGGED IN (fan_id ${summary.fan_id}). Quit + relaunch to prove persistence.`)
    return summary
  }
  log('❌ not logged in (or endpoint blocked). Click "Open Login" and sign in.')
  status('Session: NOT logged in. Click "Open Login".')
  return null
}

// ── GOAL 2: dump collection / wishlist / following ─────────────────────
async function dumpProfile() {
  const summary = await checkSession()
  if (!summary) { log('Goal 2 aborted — log in first.'); return }
  const fanId = summary.fan_id
  writeOut('collection_summary.json', summary)

  // username/profile url from the logged-in homepage pagedata
  await loadAndWait('https://bandcamp.com')
  const home = await readPagedata()
  const fan = home && home.identities && home.identities.fan
  const fanUrl = (fan && fan.url) || (fan && fan.username ? `https://bandcamp.com/${fan.username}` : null)
  log(`fan profile url: ${fanUrl || 'unknown'}`)

  // profile pagedata = first page of collection + wishlist + tokens, no API needed
  if (fanUrl) {
    await loadAndWait(fanUrl)
    const blob = await readPagedata()
    writeOut('profile_pagedata.json', blob)
    const cd = blob && blob.collection_data
    const wd = blob && blob.wishlist_data
    if (cd) log(`pagedata collection: item_count=${cd.item_count}, first page items=${(blob.item_cache && blob.item_cache.collection ? Object.keys(blob.item_cache.collection).length : '?')}`)
    if (wd) log(`pagedata wishlist: item_count=${wd.item_count}`)
  }

  // API pagination proofs (run on bandcamp origin). Token format:
  // "<unix_seconds>:<item_id>:a::" — a future timestamp returns newest.
  const token = `${Math.floor(Date.now() / 1000) + 3600}::`
  const endpoints = [
    ['collection_items', 'https://bandcamp.com/api/fancollection/1/collection_items'],
    ['wishlist_items', 'https://bandcamp.com/api/fancollection/1/wishlist_items'],
    ['following_bands', 'https://bandcamp.com/api/fancollection/1/following_bands'],
  ]
  for (const [name, url] of endpoints) {
    const res = await pagePostJSON(url, { fan_id: fanId, older_than_token: token, count: 20 })
    writeOut(`${name}.json`, res)
    const n = res && (res.items ? res.items.length : (res.followeers ? res.followeers.length : null))
    if (res && res.__httpError) log(`❌ ${name}: HTTP ${res.__httpError}`)
    else log(`✅ ${name}: ${n != null ? n + ' items' : 'see ' + name + '.json'}`)
  }
  log('Goal 2 done — inspect spike/bandcamp/out/*.json (need >=20 items per endpoint to PASS).')
}

// ── GOAL 4: parse a public album page's data-tralbum ───────────────────
async function parseAlbum(url) {
  if (!url) { log('Goal 4 — enter an album URL first.'); return }
  log(`Goal 4 — loading ${url}`)
  await loadAndWait(url)
  const tralbum = await exec(
    `(()=>{const el=document.querySelector('[data-tralbum]');if(!el)return {__missing:true};` +
    `try{return JSON.parse(el.getAttribute('data-tralbum'))}catch(e){return {__parseError:String(e)}}})()`
  )
  writeOut('tralbum.json', tralbum)
  if (!tralbum || tralbum.__missing) { log('❌ no data-tralbum element found on page.'); return }
  if (tralbum.__parseError) { log(`❌ data-tralbum parse error: ${tralbum.__parseError}`); return }
  const tracks = tralbum.trackinfo || []
  const first = tracks[0] || {}
  const firstFile = first.file ? Object.values(first.file)[0] : null
  log(`✅ tralbum parsed: ${tracks.length} tracks; ` +
      `artist="${tralbum.artist}"; ` +
      `purchasable=${tralbum.current ? tralbum.current.is_purchasable : '?'}; ` +
      `price=${tralbum.current ? tralbum.current.price + ' ' + tralbum.current.currency : '?'}; ` +
      `preview[0]=${firstFile ? 'present' : 'MISSING'}`)
  log('Goal 4 done — see spike/bandcamp/out/tralbum.json.')
}

// ── GOAL 3: intercept a real download, prove it's importOneFile-ready ──
function attachDownloadInterception(ses) {
  ses.on('will-download', (_event, item) => {
    fs.mkdirSync(OUT, { recursive: true })
    const fname = item.getFilename()
    const savePath = path.join(OUT, fname)
    item.setSavePath(savePath)
    log(`Goal 3 — will-download fired: ${fname} (${item.getTotalBytes()} bytes)`)
    item.on('done', async (_e, state) => {
      if (state !== 'completed') { log(`❌ download ${state}`); return }
      log(`✅ downloaded to ${path.relative(process.cwd(), savePath)}`)
      await inspectDownload(savePath)
    })
  })
}

async function inspectDownload(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const audioExts = ['.mp3', '.m4a', '.flac', '.aiff', '.aif', '.wav', '.aac', '.alac', '.ogg']
  let files = []
  if (ext === '.zip') {
    // album ZIP — Bandcamp ships a zip of tagged files + cover.jpg.
    // unzip is built into macOS; fine for a throwaway Mac spike.
    const dir = filePath.replace(/\.zip$/i, '_unzipped')
    try {
      execFileSync('unzip', ['-o', filePath, '-d', dir], { stdio: 'ignore' })
      log(`unzipped album to ${path.relative(process.cwd(), dir)}`)
      files = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => audioExts.includes(path.extname(f).toLowerCase()))
    } catch (e) {
      log(`❌ unzip failed: ${e.message}`)
      return
    }
  } else if (audioExts.includes(ext)) {
    files = [filePath]
  } else {
    log(`(downloaded file is not audio/zip: ${ext})`)
    return
  }

  const mm = await import('music-metadata') // same lib importOneFile() uses
  for (const f of files) {
    try {
      const meta = await mm.parseFile(f)
      const c = meta.common
      log(`  • ${path.basename(f)} → artist="${c.artist || ''}" album="${c.album || ''}" ` +
          `title="${c.title || ''}" track=${c.track && c.track.no} art=${c.picture ? 'yes' : 'no'}`)
    } catch (e) {
      log(`  • ${path.basename(f)} → tag read FAILED: ${e.message}`)
    }
  }
  log('Goal 3 done — tags above are exactly what importOneFile() consumes. ' +
      'PASS = artist/album/title correct on every track.')
}

// ── window plumbing ────────────────────────────────────────────────────
function layoutView() {
  if (!controlWin || !bandcampView) return
  const b = controlWin.getContentBounds()
  bandcampView.setBounds({ x: STRIP_W, y: 0, width: Math.max(0, b.width - STRIP_W), height: b.height })
}

function createWindows() {
  controlWin = new BrowserWindow({
    width: 1440,
    height: 920,
    title: 'Bandcamp Phase 0 Spike (throwaway)',
    webPreferences: {
      // Local trusted control page only — node ok here for spike brevity.
      nodeIntegration: true,
      contextIsolation: false,
    },
  })
  controlWin.loadFile(path.join(__dirname, 'control.html'))

  // The Bandcamp view: persistent partition, NO preload, NO electronAPI.
  bandcampView = new WebContentsView({
    webPreferences: { partition: PARTITION },
  })
  controlWin.contentView.addChildView(bandcampView)
  layoutView()
  controlWin.on('resize', layoutView)

  attachDownloadInterception(bandcampView.webContents.session)

  // Start on the homepage so in-page fetches are same-origin with cookies.
  controlWin.webContents.on('did-finish-load', async () => {
    status(`Output dir: ${OUT}`)
    log('Spike ready. Loading bandcamp.com on persist:bandcamp partition...')
    await loadAndWait('https://bandcamp.com')
    await checkSession()
  })

  controlWin.on('closed', () => { controlWin = null; bandcampView = null })
}

// ── IPC from control panel ─────────────────────────────────────────────
ipcMain.handle('spike:login', () => loadAndWait('https://bandcamp.com/login'))
ipcMain.handle('spike:check-session', () => checkSession())
ipcMain.handle('spike:dump-profile', () => dumpProfile())
ipcMain.handle('spike:parse-album', (_e, url) => parseAlbum(url))
ipcMain.handle('spike:open-out', () => { fs.mkdirSync(OUT, { recursive: true }); return shell.openPath(OUT) })

app.whenReady().then(createWindows)
app.on('window-all-closed', () => app.quit())
