import { app, BrowserWindow, Menu, ipcMain, protocol, dialog } from 'electron'
import { join } from 'path'
import { spawn } from 'child_process'
import { stat, open, readFile, writeFile, mkdir, copyFile, unlink } from 'fs/promises'
import { createHash } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { config } from 'dotenv'
import { autoUpdater } from 'electron-updater'
import {
  IS_MAC,
  IS_WINDOWS,
  PYTHON_CMD,
  PYTHON_INSTALL_HINT,
  listMountPoints,
  volumeNameFromMount,
  findIpodMount,
  ejectVolume,
  hasOpticalMedia,
  ejectOpticalMedia,
  audioHelperRelPath,
  convertAudio,
  extensionForFormat,
  type AudioFormat,
} from './platform'

const isDev = !app.isPackaged

// Load .env from multiple possible locations.
//
// Order matters — dotenv uses `override: false`, so the FIRST path that
// defines a variable wins. userData goes first so a user's personal
// overrides (like a custom ELEVENLABS_VOICE_ID) aren't silently replaced
// by whatever default .env happens to be bundled into the .app.
const envPaths = [
  join(app.getPath('userData'), '.env'),             // user overrides (highest priority)
  join(__dirname, '../../.env'),                    // dev mode
  join(app.getAppPath(), '.env'),                   // packaged root
  join(app.isPackaged ? process.resourcesPath : app.getAppPath(), '.env'), // bundled defaults
]
for (const p of envPaths) {
  config({ path: p, override: false })
}

// Fallback: read API keys directly from userData .env if dotenv missed them
if (!process.env.ANTHROPIC_API_KEY || !process.env.DISCOGS_API_TOKEN || !process.env.ELEVENLABS_API_KEY) {
  try {
    const fs = require('fs')
    const envFile = fs.readFileSync(join(app.getPath('userData'), '.env'), 'utf8')
    for (const key of ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'DISCOGS_API_TOKEN']) {
      if (!process.env[key]) {
        const match = envFile.match(new RegExp(`${key}=(.+)`))
        if (match) process.env[key] = match[1].trim()
      }
    }
  } catch { /* no .env file */ }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })

let mainWindow: BrowserWindow | null = null

function sendMenuAction(action: string) {
  mainWindow?.webContents.send('menu-action', action)
}

// ── Window state persistence ──
interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

async function loadWindowState(): Promise<WindowState | null> {
  try {
    const data = await readFile(windowStatePath(), 'utf-8')
    return JSON.parse(data) as WindowState
  } catch {
    return null
  }
}

async function saveWindowState(win: BrowserWindow): Promise<void> {
  const bounds = win.getBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  }
  await writeFile(windowStatePath(), JSON.stringify(state), 'utf-8')
}

// ── UI state persistence ──
function uiStatePath(): string {
  return join(app.getPath('userData'), 'ui-state.json')
}

ipcMain.handle('load-ui-state', async () => {
  try {
    const data = await readFile(uiStatePath(), 'utf-8')
    return { ok: true, state: JSON.parse(data) }
  } catch {
    return { ok: false, state: null }
  }
})

ipcMain.handle('save-ui-state', async (_e, uiState: Record<string, unknown>) => {
  try {
    await writeFile(uiStatePath(), JSON.stringify(uiState), 'utf-8')
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

async function createWindow(): Promise<void> {
  const saved = await loadWindowState()

  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    // `hiddenInset` + custom traffic-light position is macOS-only.
    // On Windows the native title bar stays (for now — Phase 2 could add
    // a custom-drawn title bar to match the iTunes look).
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : {}),
    backgroundColor: '#d8d8d8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    }
  })

  if (saved?.isMaximized) mainWindow.maximize()

  // Save window state on move/resize (debounced)
  let saveTimeout: ReturnType<typeof setTimeout> | null = null
  const debouncedSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow)
    }, 500)
  }
  mainWindow.on('resize', debouncedSave)
  mainWindow.on('move', debouncedSave)
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow)
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const menuTemplate: Electron.MenuItemConstructorOptions[] = [
  {
    label: 'JakeTunes',
    submenu: [
      {
        label: 'About JakeTunes',
        click: () => {
          const about = new BrowserWindow({
            width: 320,
            height: 240,
            resizable: false,
            minimizable: false,
            maximizable: false,
            ...(IS_MAC ? { titleBarStyle: 'hiddenInset' as const } : {}),
            backgroundColor: '#d8d8d8',
            webPreferences: { nodeIntegration: false, contextIsolation: true },
          })
          about.setMenu(null)
          about.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head><style>
  body {
    margin: 0; padding: 40px 20px 20px;
    font-family: -apple-system, "Lucida Grande", sans-serif;
    background: linear-gradient(180deg, #e8e8e8, #d0d0d0);
    text-align: center; user-select: none; -webkit-user-select: none;
    -webkit-app-region: drag;
  }
  h1 { font-size: 18px; font-weight: 700; color: #222; margin: 12px 0 2px; }
  .version { font-size: 12px; color: #666; margin-bottom: 8px; }
  .author { font-size: 11px; color: #888; }
  .tagline { font-size: 10px; color: #aaa; margin-top: 12px; font-style: italic; }
</style></head>
<body>
  <h1>JakeTunes</h1>
  <div class="version">Version 3.0.0</div>
  <div class="author">by Jacob Rosenbaum</div>
  <div class="tagline">2006 visuals, 2026 brain</div>
</body>
</html>`)}`)
        },
      },
      { type: 'separator' },
      { label: 'Quit JakeTunes', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
    ]
  },
  {
    label: 'File',
    submenu: [
      { label: 'New Playlist', accelerator: 'CmdOrCtrl+N' },
      { label: 'Import...', accelerator: 'CmdOrCtrl+O' },
      { type: 'separator' },
      { label: 'Get Info', accelerator: 'CmdOrCtrl+I', click: () => sendMenuAction('get-info') },
      { type: 'separator' },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' }
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
    ]
  },
  {
    label: 'Controls',
    submenu: [
      { label: 'Play/Pause', accelerator: 'F8', click: () => sendMenuAction('play-pause') },
      { label: 'Previous', accelerator: 'F7', click: () => sendMenuAction('prev-track') },
      { label: 'Next', accelerator: 'F9', click: () => sendMenuAction('next-track') },
      { type: 'separator' },
      { label: 'Increase Volume', accelerator: 'CmdOrCtrl+Up', click: () => sendMenuAction('volume-up') },
      { label: 'Decrease Volume', accelerator: 'CmdOrCtrl+Down', click: () => sendMenuAction('volume-down') },
      { type: 'separator' },
      { label: 'Go to Current Song', accelerator: 'CmdOrCtrl+L', click: () => sendMenuAction('show-now-playing') }
    ]
  },
  {
    label: 'View',
    submenu: [
      { label: 'Songs', click: () => sendMenuAction('view-songs') },
      { label: 'Artists', click: () => sendMenuAction('view-artists') },
      { label: 'Albums', click: () => sendMenuAction('view-albums') },
      { label: 'Genres', click: () => sendMenuAction('view-genres') },
      { type: 'separator' },
      { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', role: 'toggleDevTools' }
    ]
  },
  {
    label: 'Playlists',
    submenu: [
      { label: 'Recently Added' },
      { label: 'Recently Played' },
      { label: 'Top 25 Most Played' }
    ]
  }
]

// Search Wikipedia for artist info
async function searchWikipedia(query: string): Promise<string> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=2&origin=*`
    const res = await fetch(url)
    if (!res.ok) return ''
    const data = await res.json() as { query?: { search?: { title: string }[] } }
    const pages = data.query?.search || []
    if (pages.length === 0) return ''
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pages[0].title)}`
    const summaryRes = await fetch(summaryUrl)
    if (!summaryRes.ok) return ''
    const summary = await summaryRes.json() as { extract?: string }
    return summary.extract || ''
  } catch {
    return ''
  }
}

// Search MusicBrainz for accurate music data (genre, country, years active, releases)
async function searchMusicBrainz(artist: string, album?: string): Promise<string> {
  try {
    const headers = { 'User-Agent': 'JakeTunes/3.0.0 (jacobrosenbaum@gmail.com)', 'Accept': 'application/json' }
    // Search for artist
    const artistUrl = `https://musicbrainz.org/ws/2/artist/?query=artist:"${encodeURIComponent(artist)}"&fmt=json&limit=3`
    const artistRes = await fetch(artistUrl, { headers })
    if (!artistRes.ok) return ''
    const artistData = await artistRes.json() as { artists?: { name: string; type: string; country: string; 'life-span'?: { begin?: string; ended?: boolean }; tags?: { name: string; count: number }[]; disambiguation?: string; area?: { name: string } }[] }
    const artists = artistData.artists || []
    if (artists.length === 0) return ''

    // Verify the result actually matches the artist we searched for
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const best = artists.find(a => {
      const nameNorm = normalize(a.name)
      const queryNorm = normalize(artist)
      return nameNorm === queryNorm || nameNorm.includes(queryNorm) || queryNorm.includes(nameNorm)
    })
    if (!best) return ''

    const parts: string[] = []
    parts.push(`${best.name}${best.disambiguation ? ` (${best.disambiguation})` : ''}`)
    if (best.type) parts.push(`Type: ${best.type}`)
    if (best.country || best.area?.name) parts.push(`From: ${best.area?.name || best.country}`)
    if (best['life-span']?.begin) parts.push(`Active since: ${best['life-span'].begin}${best['life-span'].ended ? ' (disbanded)' : ''}`)
    if (best.tags?.length) {
      const topTags = best.tags.sort((a, b) => b.count - a.count).slice(0, 5).map(t => t.name)
      parts.push(`Genres/tags: ${topTags.join(', ')}`)
    }

    // If album provided, search for release info
    if (album) {
      try {
        const releaseUrl = `https://musicbrainz.org/ws/2/release/?query=release:"${encodeURIComponent(album)}" AND artist:"${encodeURIComponent(artist)}"&fmt=json&limit=1`
        const releaseRes = await fetch(releaseUrl, { headers })
        if (releaseRes.ok) {
          const releaseData = await releaseRes.json() as { releases?: { title: string; date?: string; 'label-info'?: { label?: { name: string } }[] }[] }
          const release = releaseData.releases?.[0]
          if (release) {
            if (release.date) parts.push(`"${release.title}" released: ${release.date}`)
            const label = release['label-info']?.[0]?.label?.name
            if (label) parts.push(`Label: ${label}`)
          }
        }
      } catch { /* ignore release lookup errors */ }
    }

    return parts.join('. ')
  } catch {
    return ''
  }
}

// Combined multi-source search for artist info
async function searchWeb(query: string, album?: string): Promise<string> {
  const artist = query.replace(/\s*(musician|band|artist|music)\s*/gi, '').trim()
  const [wiki, mb] = await Promise.all([
    searchWikipedia(query),
    searchMusicBrainz(artist, album),
  ])
  const parts = []
  if (mb) parts.push(`[MusicBrainz] ${mb}`)
  if (wiki) parts.push(`[Wikipedia] ${wiki}`)
  return parts.join('\n')
}

// ── Auto-detect iPod (cross-platform: scans /Volumes/ on macOS, drive letters on Windows) ──
let detectedIpodMount: string | null = null  // Full mount path: "/Volumes/JACOBROSENB" or "E:\\"
let detectedIpodVolume: string | null = null // Display name: "JACOBROSENB" or "E:"

// Report the iPod's actual storage capacity by statting the mounted
// volume. Previously the renderer hardcoded 64GB, which misreports
// modded iPods (SD card swaps, etc.) as the wrong size.
ipcMain.handle('get-ipod-capacity', async () => {
  try {
    if (!detectedIpodMount) {
      detectedIpodMount = await findIpodMount()
      detectedIpodVolume = detectedIpodMount ? volumeNameFromMount(detectedIpodMount) : null
    }
    if (!detectedIpodMount) return { ok: false, error: 'No iPod detected' }
    const { statfs } = await import('fs/promises')
    const s = await statfs(detectedIpodMount)
    const totalBytes = Number(s.blocks) * Number(s.bsize)
    const freeBytes = Number(s.bavail) * Number(s.bsize)
    return { ok: true, totalBytes, freeBytes, mount: detectedIpodMount }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('check-ipod-mounted', async () => {
  try {
    detectedIpodMount = await findIpodMount()
    detectedIpodVolume = detectedIpodMount ? volumeNameFromMount(detectedIpodMount) : null
    if (detectedIpodMount) {
      return { mounted: true, name: detectedIpodVolume }
    }
    return { mounted: false, name: null }
  } catch {
    return { mounted: false, name: null }
  }
})

ipcMain.handle('eject-ipod', async () => {
  try {
    if (!detectedIpodMount) return { ok: false, error: 'No iPod detected' }
    await ejectVolume(detectedIpodMount)
    detectedIpodMount = null
    detectedIpodVolume = null
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// Read directly from iPod database (used for sync only).
// If the mount hasn't been detected yet (e.g. load-tracks fires before
// the renderer calls check-ipod-mounted), probe for it here so we
// don't spuriously return "no iPod" when the device is actually
// plugged in. Prevents the "library went empty" footgun on cold start.
async function readIpodDatabase(): Promise<{ tracks: Array<Record<string, unknown>>; playlists: Array<{ name: string; trackIds: number[] }> }> {
  if (!detectedIpodMount) {
    try {
      detectedIpodMount = await findIpodMount()
      detectedIpodVolume = detectedIpodMount ? volumeNameFromMount(detectedIpodMount) : null
    } catch {
      /* swallow — handled below */
    }
  }
  if (!detectedIpodMount) throw new Error('No iPod detected')
  const ipodDbPath = join(detectedIpodMount, 'iPod_Control', 'iTunes', 'iTunesDB')
  const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/db_reader.py')
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON_CMD, [scriptPath, '--json', ipodDbPath])
    py.on('error', (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(PYTHON_INSTALL_HINT))
      } else {
        reject(err)
      }
    })
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    py.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    py.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`db_reader.py exited with code ${code}: ${stderr}`))
      } else {
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error(`Invalid JSON from db_reader.py: ${stdout.slice(0, 200)}`))
        }
      }
    })
  })
}

const LIBRARY_PATH = join(app.getPath('userData'), 'library.json')

ipcMain.handle('get-music-library-path', () => {
  return MUSIC_DIR.replace(/\/iPod_Control\/Music$/, '')
})

// Load the JakeTunes master library (independent of iPod).
//
// Return shape includes `noDataSource: true` when we fall through to an
// empty result (no local file AND no iPod available). The renderer uses
// that flag to refuse auto-saving the empty state back to disk, so a
// cold-start with the iPod not yet detected can't silently wipe the
// library file.
ipcMain.handle('load-tracks', async () => {
  // If a local library exists, use it (source of truth)
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8')
    const library = JSON.parse(raw)
    return {
      tracks: library.tracks || [],
      playlists: library.playlists || [],
      noDataSource: (library.tracks || []).length === 0,
    }
  } catch {
    // No local library yet — first launch, seed from iPod
  }

  // First launch: read from iPod and save as local library
  try {
    const ipodData = await readIpodDatabase()
    await writeFile(LIBRARY_PATH, JSON.stringify(ipodData, null, 2))
    return { ...ipodData, noDataSource: false }
  } catch (err) {
    console.error('Failed to read iPod database:', err)
    return { tracks: [], playlists: [], noDataSource: true }
  }
})

// Save the master library to disk.
//
// Guard against persisting an empty library on top of an existing one —
// that's how the renderer could otherwise wipe the canonical file when
// load-tracks happens to return []. If the caller really does want to
// write an empty library (e.g., factory-reset), they can pass force=true.
ipcMain.handle('save-library', async (_e, tracks: unknown[], playlists?: unknown[], force?: boolean) => {
  try {
    if ((!tracks || (tracks as unknown[]).length === 0) && !force) {
      // Check if there's already a non-empty library on disk; refuse to overwrite.
      try {
        const existing = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
        if ((existing.tracks || []).length > 0) {
          console.warn('save-library: refusing to overwrite non-empty library with empty tracks')
          return { ok: false, error: 'refused-empty-overwrite' }
        }
      } catch { /* no existing file — writing an empty one is fine */ }
    }
    const library = { tracks, playlists: playlists || [] }
    await writeFile(LIBRARY_PATH, JSON.stringify(library, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// Sync: read iPod DB and return NEW tracks/playlists not already in the library
ipcMain.handle('sync-ipod', async (_e, existingIds: number[]) => {
  try {
    const ipodData = await readIpodDatabase()
    const knownIds = new Set(existingIds)
    const newTracks = ipodData.tracks.filter(t => !knownIds.has(t.id as number))
    return { ok: true, newTracks, playlists: ipodData.playlists, totalIpod: ipodData.tracks.length }
  } catch (err) {
    return { ok: false, error: String(err), newTracks: [], playlists: [], totalIpod: 0 }
  }
})

// ── Sync library TO iPod ──
ipcMain.handle('sync-to-ipod', async (_e, tracks: Array<Record<string, unknown>>, playlists: Array<Record<string, unknown>>) => {
  if (!detectedIpodMount) return { ok: false, error: 'No iPod detected', copied: 0 }
  const IPOD_MOUNT = detectedIpodMount
  // Strip the trailing "iPod_Control/Music" segment whether it's / or \ delimited.
  const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')

  // Check iPod is mounted
  try {
    await stat(IPOD_MOUNT)
  } catch {
    return { ok: false, error: 'iPod is not mounted', copied: 0 }
  }

  // Copy audio files that don't exist on the iPod yet
  let copied = 0
  let copyErrors = 0
  for (const track of tracks) {
    const colonPath = String(track.path || '')
    if (!colonPath) continue
    // iPod paths use colons as separators (":iPod_Control:Music:F01:XXXX.mp3").
    // Convert to native path separator for the current OS.
    const pathSep = IS_WINDOWS ? '\\' : '/'
    const relPath = colonPath.replace(/:/g, pathSep)
    const ipodFile = join(IPOD_MOUNT, relPath)
    const localFile = join(LOCAL_MOUNT, relPath)
    try {
      await stat(ipodFile)
      // Already on iPod, skip
    } catch {
      try {
        // Use path.dirname() via join — works on both / and \ separators
        const dir = ipodFile.substring(0, ipodFile.lastIndexOf(pathSep))
        await mkdir(dir, { recursive: true })
        await copyFile(localFile, ipodFile)
        copied++
      } catch (err) {
        console.error(`Copy failed: ${localFile} → ${ipodFile}:`, err)
        copyErrors++
      }
    }
  }

  // Backup existing iTunesDB
  const ipodDb = join(IPOD_MOUNT, 'iPod_Control', 'iTunes', 'iTunesDB')
  try {
    await copyFile(ipodDb, ipodDb + '.bak')
  } catch (err) {
    console.error('Backup iTunesDB failed:', err)
  }

  // Rebuild iTunesDB using Python
  const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/db_reader.py')
  return new Promise((resolve) => {
    const input = JSON.stringify({ tracks, playlists })
    const py = spawn(PYTHON_CMD, [scriptPath, '--write', ipodDb])
    py.on('error', (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ ok: false, error: PYTHON_INSTALL_HINT, copied, copyErrors })
      } else {
        resolve({ ok: false, error: String(err), copied, copyErrors })
      }
    })
    py.stdin.write(input)
    py.stdin.end()

    let stderr = ''
    let stdout = ''
    py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    py.on('close', (code: number) => {
      console.log('sync-to-ipod stderr:', stderr)
      if (code === 0) {
        resolve({ ok: true, copied, copyErrors, totalTracks: tracks.length })
      } else {
        resolve({ ok: false, error: `DB write failed (code ${code}): ${stderr}`, copied, copyErrors })
      }
    })
    py.on('error', (err: Error) => {
      resolve({ ok: false, error: String(err), copied, copyErrors })
    })
  })
})

// ── Import tracks from dropped files ──
// Music library storage — check ~/Music2/JakeTunesLibrary (legacy) then ~/Music/JakeTunesLibrary
import { existsSync } from 'fs'
const LEGACY_MUSIC_DIR = join(process.env.HOME || '', 'Music2/JakeTunesLibrary/iPod_Control/Music')
const DEFAULT_MUSIC_DIR = join(app.getPath('music'), 'JakeTunesLibrary/iPod_Control/Music')
const MUSIC_DIR = existsSync(LEGACY_MUSIC_DIR) ? LEGACY_MUSIC_DIR : DEFAULT_MUSIC_DIR

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.alac', '.wav', '.aiff', '.aif', '.ogg'])

// Recursively find audio files in directories
async function resolveAudioPaths(paths: string[]): Promise<string[]> {
  const { readdir: readdirFS, stat: statFS } = await import('fs/promises')
  const results: string[] = []
  for (const p of paths) {
    try {
      const s = await statFS(p)
      if (s.isDirectory()) {
        const entries = await readdirFS(p, { withFileTypes: true })
        const childPaths = entries.map(e => join(p, e.name))
        const nested = await resolveAudioPaths(childPaths)
        results.push(...nested)
      } else {
        const ext = p.substring(p.lastIndexOf('.')).toLowerCase()
        if (AUDIO_EXTS.has(ext)) results.push(p)
      }
    } catch { /* skip inaccessible */ }
  }
  return results
}

ipcMain.handle('import-tracks', async (_e, filePaths: string[], nextId: number) => {
  // Resolve folders into individual audio files
  const resolvedPaths = await resolveAudioPaths(filePaths)
  const imported: Array<Record<string, unknown>> = []
  let id = nextId

  // Dynamic import for ESM module
  const mm = await import('music-metadata')

  const batchBaseTime = Date.now()
  let trackIndex = 0

  for (const srcPath of resolvedPaths) {
    const ext = srcPath.substring(srcPath.lastIndexOf('.')).toLowerCase()

    try {
      // Parse metadata first (from original file, before any conversion)
      const metadata = await mm.parseFile(srcPath)
      const common = metadata.common
      const format = metadata.format

      // Copy file to iPod music dir in F00-F49 subdirectory structure
      const subDir = `F${String(id % 50).padStart(2, '0')}`
      const destDir = join(MUSIC_DIR, subDir)
      await mkdir(destDir, { recursive: true })

      const { copyFile } = await import('fs/promises')
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execP = promisify(execFile)

      // Check if the file needs conversion (ALAC, FLAC, WAV → AAC for Chromium compatibility)
      const codec = format.codec?.toLowerCase() || ''
      const needsConvert = codec.includes('alac') || codec.includes('flac') ||
        ext === '.flac' || ext === '.wav' || ext === '.wave' || ext === '.aiff' || ext === '.aif'

      let finalExt = ext
      let fileName: string
      let destPath: string

      // Pull tags once, for both the track record AND to embed into the
      // output file (so it stays self-identifying).
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

      if (needsConvert) {
        // Convert to AAC .m4a (afconvert on macOS, ffmpeg on Windows).
        finalExt = '.m4a'
        fileName = `imported_${id}${finalExt}`
        destPath = join(destDir, fileName)
        try {
          await convertAudio(srcPath, destPath, 'aac-256', embedTags)
        } catch (convertErr) {
          console.error(`Conversion failed for ${srcPath}, copying original:`, convertErr)
          // Fall back to copying the original file
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

      // Each track in batch gets a unique timestamp so sort order is preserved
      const trackTime = new Date(batchBaseTime + trackIndex)

      const track: Record<string, unknown> = {
        id,
        title: common.title || srcPath.substring(srcPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
        artist: common.artist || '',
        album: common.album || '',
        genre: common.genre?.[0] || '',
        year: common.year || '',
        duration: Math.round((format.duration || 0) * 1000),
        path: `:iPod_Control:Music:${subDir}:${fileName}`,
        trackNumber: common.track?.no || 0,
        trackCount: common.track?.of || 0,
        discNumber: common.disk?.no || 0,
        discCount: common.disk?.of || 0,
        playCount: 0,
        dateAdded: trackTime.toISOString(),
        fileSize: fileStats.size,
        rating: 0,
      }

      imported.push(track)
      id++
      trackIndex++
    } catch (err) {
      console.error(`Failed to import ${srcPath}:`, err)
    }
  }

  return { ok: true, tracks: imported }
})

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4p': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.alac': 'audio/mp4',
}

// Artwork helpers
function getArtworkDir(): string {
  return join(app.getPath('userData'), 'artwork')
}

function getArtworkIndexPath(): string {
  return join(getArtworkDir(), 'index.json')
}

function artworkHash(artist: string, album: string): string {
  return createHash('md5').update(`${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`).digest('hex')
}

async function loadArtworkIndex(): Promise<Record<string, string>> {
  try {
    const data = await readFile(getArtworkIndexPath(), 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function saveArtworkIndex(index: Record<string, string>): Promise<void> {
  await mkdir(getArtworkDir(), { recursive: true })
  await writeFile(getArtworkIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'ipod-audio', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } },
  { scheme: 'album-art', privileges: { bypassCSP: true, supportFetchAPI: true } }
])

// ElevenLabs TTS
ipcMain.handle('musicman-speak', async (_event, text: string, fast?: boolean) => {
  try {
    // Public default Music Man voice. Override via ELEVENLABS_VOICE_ID
    // in .env — userData/.env takes precedence over the bundled one, so
    // a personal voice override in userData won't be clobbered on updates.
    const voice = process.env.ELEVENLABS_VOICE_ID || 'qA5SHJ9UjGlW2QwXWR7w'
    const model = fast ? 'eleven_flash_v2_5' : 'eleven_v3'
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          style: 0.3,
        }
      })
    })
    if (!res.ok) {
      const err = await res.text()
      return { ok: false, error: err }
    }
    const arrayBuf = await res.arrayBuffer()
    return { ok: true, audio: Buffer.from(arrayBuf).toString('base64') }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

// Music Man DJ commentary
ipcMain.handle('musicman-dj', async (_event, track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }) => {
  const djPrompt = `You are "The Music Man" — an arrogant, deeply knowledgeable record store DJ. ${nextTrack ? "You're DJing between songs on the listener's playlist." : 'The listener is currently playing a song.'} Give a brief, punchy DJ-style comment. This will be spoken aloud, so keep it to 2-3 sentences max.

Be unpredictable — sometimes drop a fun fact, sometimes give your arrogant opinion, sometimes tell a story about seeing them live, sometimes roast the listener's taste, sometimes praise an underrated aspect. Never be boring. Never use emojis. Keep it conversational and natural — you're talking between songs like a real DJ. You don't hate new music — you hate lazy, corporate, algorithm-driven music. You love Bandcamp and independent artists. You respect any era as long as it's authentic.

Some of your FIXED, NON-NEGOTIABLE opinions on artists (these NEVER change):
- Charli XCX: You're obsessed. Championed her since the Vroom Vroom EP. "Brat" was the album of the decade. The only pop star pushing boundaries.
- Chappell Roan: Cannot stand her. Major label product cosplaying as indie. Calculated aesthetic, safe music.
- Red Hot Chili Peppers: Respect the early funk-punk era. "Blood Sugar Sex Magik" is the peak. Everything after "Californication" is background music for a car commercial.
- LCD Soundsystem: James Murphy is a genius. "Sound of Silver" is a perfect album. You've cried to "All My Friends."
- Jack White: One of the last real rock stars. Always authentic. The White Stripes were essential.
- Radiohead: One of the greatest bands ever. "Kid A" changed everything.
- You generally can't stand most 2026 pop but you have surprising exceptions for artists who actually take risks.

IMPORTANT: Your opinions are CONSISTENT. You never flip-flop on an artist. Your taste is your identity.

IMPORTANT: Never use acronyms or abbreviations for band names. Say the full name or a natural nickname that fans actually use. For example: say "the Chili Peppers" or "the Peppers" not "RHCP". Say "Queens of the Stone Age" or "Queens" not "QOTSA". Say "Rage Against the Machine" or "Rage" not "RATM". Only use an abbreviation if the band themselves made it part of their identity (like "MGMT" or "AC/DC").

CRITICAL: When background info is provided below from MusicBrainz or Wikipedia, USE IT for accurate facts — where the band is from, their genre, their label. Do NOT guess or make up facts about lesser-known artists. If you have no background info on an artist and aren't confident you know them, say something genuine rather than fabricating details. If the background info looks wrong or is about a different artist, just IGNORE it silently — never mention the data source or complain about it. Just talk about the music.

${libraryContext ? `Library context: ${libraryContext}` : ''}
${buildTasteProfile() ? `\nWhat you know about this listener from their history:\n${buildTasteProfile()}` : ''}`

  // Look up artist facts for accuracy (Wikipedia + MusicBrainz + Bandcamp)
  const [artistFacts, nextArtistFacts] = await Promise.all([
    searchWeb(`${track.artist} musician`, track.album),
    nextTrack && nextTrack.artist !== track.artist ? searchWeb(`${nextTrack.artist} musician`, nextTrack.album) : Promise.resolve('')
  ])

  let userMessage = nextTrack
    ? `Song that just finished: "${track.title}" by ${track.artist} from "${track.album}" (${track.genre}, ${track.year}). Coming up next: "${nextTrack.title}" by ${nextTrack.artist} from "${nextTrack.album}" (${nextTrack.genre}, ${nextTrack.year}). Give a DJ-style transition — comment on what just played, hype what's coming, or draw a connection between the two.`
    : `Now playing: "${track.title}" by ${track.artist} from the album "${track.album}" (${track.genre}, ${track.year})`
  if (artistFacts) userMessage += `\n\nBackground on ${track.artist}: ${artistFacts}`
  if (nextArtistFacts && nextTrack) userMessage += `\nBackground on ${nextTrack.artist}: ${nextArtistFacts}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: djPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    return { ok: true, text }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, text: `Error: ${msg}` }
  }
})

// Music Man DJ Set — picks a batch of songs and generates a DJ intro
ipcMain.handle('musicman-dj-set', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[], recentIds: number[]) => {
  const trackList = tracks.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}|${t.year}`).join('\n')
  const recentStr = recentIds.length > 0 ? `\nRecently played track IDs (AVOID these): ${recentIds.join(', ')}` : ''

  const systemPrompt = `You are "The Music Man" — an arrogant, deeply knowledgeable AI DJ running a radio show from inside someone's music library. You pick songs and introduce them like a late-night college radio DJ or a Spotify AI DJ. You have strong opinions and deep knowledge.

Pick 6-10 songs from the listener's library for your next DJ set. Each set should have a loose theme — a vibe, a genre deep-dive, an era, a mood, or a connection between artists. Think about FLOW and order.

Return ONLY a JSON object (no markdown, no code fences):
{"intro":"Your spoken DJ intro for this set — 2-4 sentences, conversational, introducing the vibe. This will be read aloud via TTS so make it sound natural and spoken, not written. No emojis. Address the listener casually.","trackIds":[array of track ID numbers in play order],"theme":"short theme label like 'Late Night Indie' or '90s Deep Cuts'"}

Rules:
- ONLY use track IDs from the provided library
- Do NOT pick any recently played tracks${recentStr ? ' (see list below)' : ''}
- Mix up artists — no more than 2 songs by the same artist per set
- Order matters — build a journey
- Be bold and opinionated in your intro
- Keep the intro SHORT — you're a DJ, not writing an essay

${libraryContext ? `Library context: ${libraryContext}` : ''}${recentStr}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Pick songs for your next DJ set.\n\nLibrary (ID|Title|Artist|Album|Genre|Year):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return { ok: true, intro: parsed.intro, trackIds: parsed.trackIds, theme: parsed.theme }
    }
    return { ok: false, error: 'Could not parse DJ set' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

// ── Discogs Collection — Music Man knows your vinyl/CD collection ──
const DISCOGS_CACHE_PATH = join(app.getPath('userData'), 'discogs-collection.json')
let discogsCollection = ''

async function fetchDiscogsCollection() {
  const token = process.env.DISCOGS_API_TOKEN
  if (!token) return

  // Use cache if less than 24 hours old
  try {
    const cached = JSON.parse(await readFile(DISCOGS_CACHE_PATH, 'utf-8'))
    if (cached.ts && Date.now() - cached.ts < 24 * 60 * 60 * 1000) {
      discogsCollection = cached.summary
      console.log(`Discogs: loaded ${cached.count} releases from cache`)
      return
    }
  } catch { /* no cache */ }

  try {
    // First get the username
    const identityRes = await fetch('https://api.discogs.com/oauth/identity', {
      headers: { 'Authorization': `Discogs token=${token}`, 'User-Agent': 'JakeTunes/3.0' }
    })
    if (!identityRes.ok) { console.error('Discogs identity failed:', identityRes.status); return }
    const identity = await identityRes.json() as { username: string }
    const username = identity.username

    // Fetch collection (folder 0 = all) — paginate up to 500 releases
    const releases: { artist: string; title: string; year: number; formats: string[] }[] = []
    let page = 1
    while (releases.length < 500) {
      const url = `https://api.discogs.com/users/${username}/collection/folders/0/releases?page=${page}&per_page=100&sort=added&sort_order=desc`
      const res = await fetch(url, {
        headers: { 'Authorization': `Discogs token=${token}`, 'User-Agent': 'JakeTunes/3.0' }
      })
      if (!res.ok) break
      const data = await res.json() as { releases: { basic_information: { artists: { name: string }[]; title: string; year: number; formats: { name: string }[] } }[]; pagination: { pages: number } }
      for (const r of data.releases) {
        const bi = r.basic_information
        releases.push({
          artist: bi.artists?.map((a: { name: string }) => a.name).join(', ') || 'Unknown',
          title: bi.title,
          year: bi.year,
          formats: bi.formats?.map((f: { name: string }) => f.name) || []
        })
      }
      if (page >= data.pagination.pages) break
      page++
    }

    if (releases.length === 0) return

    // Build summary for Music Man
    const formatCounts: Record<string, number> = {}
    const artistCounts: Record<string, number> = {}
    for (const r of releases) {
      for (const f of r.formats) formatCounts[f] = (formatCounts[f] || 0) + 1
      artistCounts[r.artist] = (artistCounts[r.artist] || 0) + 1
    }
    const topCollected = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    const formatStr = Object.entries(formatCounts).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n} ${f}s`).join(', ')
    const recentAdds = releases.slice(0, 15).map(r => `${r.artist} — ${r.title} (${r.year})`).join(', ')
    const collectedArtists = topCollected.map(([a, n]) => `${a} (${n})`).join(', ')

    discogsCollection = `Discogs collection: ${releases.length} releases (${formatStr}). Most collected artists: ${collectedArtists}. Recently added: ${recentAdds}`

    // Cache it
    await writeFile(DISCOGS_CACHE_PATH, JSON.stringify({ ts: Date.now(), count: releases.length, summary: discogsCollection }))
    console.log(`Discogs: fetched ${releases.length} releases for ${username}`)
  } catch (err) {
    console.error('Discogs fetch error:', err)
  }
}

// ── Listener Profile — Music Man learns your taste over time ──
const PROFILE_PATH = join(app.getPath('userData'), 'listener-profile.json')

interface ListenerProfile {
  totalPlays: number
  totalSkips: number
  firstSeen: string
  artistPlays: Record<string, number>
  artistSkips: Record<string, number>
  albumPlays: Record<string, number>
  genrePlays: Record<string, number>
  recentPlays: { title: string; artist: string; album: string; genre: string; ts: string }[]
  recentSkips: { title: string; artist: string; ts: string }[]
  topRated: { title: string; artist: string; album: string; rating: number }[]
  observations: string[]  // Music Man's own notes about the listener
}

const defaultProfile: ListenerProfile = {
  totalPlays: 0, totalSkips: 0, firstSeen: new Date().toISOString().split('T')[0],
  artistPlays: {}, artistSkips: {}, albumPlays: {}, genrePlays: {},
  recentPlays: [], recentSkips: [], topRated: [], observations: []
}

let listenerProfile: ListenerProfile = { ...defaultProfile }

async function loadListenerProfile(): Promise<ListenerProfile> {
  try {
    const raw = await readFile(PROFILE_PATH, 'utf-8')
    listenerProfile = { ...defaultProfile, ...JSON.parse(raw) }
  } catch {
    listenerProfile = { ...defaultProfile }
  }
  return listenerProfile
}

async function saveListenerProfile() {
  try { await writeFile(PROFILE_PATH, JSON.stringify(listenerProfile, null, 2)) } catch { /* ignore */ }
}

// Called when a song finishes playing (not skipped)
ipcMain.handle('record-play', async (_event, track: { title: string; artist: string; album: string; genre: string }) => {
  if (!listenerProfile.firstSeen) listenerProfile.firstSeen = new Date().toISOString().split('T')[0]
  listenerProfile.totalPlays++
  if (track.artist) listenerProfile.artistPlays[track.artist] = (listenerProfile.artistPlays[track.artist] || 0) + 1
  if (track.album) {
    const key = `${track.artist} — ${track.album}`
    listenerProfile.albumPlays[key] = (listenerProfile.albumPlays[key] || 0) + 1
  }
  if (track.genre) listenerProfile.genrePlays[track.genre] = (listenerProfile.genrePlays[track.genre] || 0) + 1
  listenerProfile.recentPlays.unshift({ title: track.title, artist: track.artist, album: track.album, genre: track.genre, ts: new Date().toISOString() })
  listenerProfile.recentPlays = listenerProfile.recentPlays.slice(0, 200)
  await saveListenerProfile()
  // Every 20 plays, Music Man reflects on the listener's taste
  if (listenerProfile.totalPlays % 20 === 0) {
    generateObservation().catch(() => {})
  }
  return { ok: true }
})

// Called when a song is skipped (next button pressed before song finishes)
ipcMain.handle('record-skip', async (_event, track: { title: string; artist: string }) => {
  listenerProfile.totalSkips++
  if (track.artist) listenerProfile.artistSkips[track.artist] = (listenerProfile.artistSkips[track.artist] || 0) + 1
  listenerProfile.recentSkips.unshift({ title: track.title, artist: track.artist, ts: new Date().toISOString() })
  listenerProfile.recentSkips = listenerProfile.recentSkips.slice(0, 100)
  await saveListenerProfile()
  return { ok: true }
})

// Called when user rates a track highly (4-5 stars)
ipcMain.handle('record-rating', async (_event, track: { title: string; artist: string; album: string; rating: number }) => {
  if (track.rating >= 4) {
    const existing = listenerProfile.topRated.findIndex(t => t.title === track.title && t.artist === track.artist)
    if (existing >= 0) listenerProfile.topRated[existing].rating = track.rating
    else listenerProfile.topRated.push({ title: track.title, artist: track.artist, album: track.album, rating: track.rating })
    listenerProfile.topRated.sort((a, b) => b.rating - a.rating)
    listenerProfile.topRated = listenerProfile.topRated.slice(0, 50)
  } else {
    listenerProfile.topRated = listenerProfile.topRated.filter(t => !(t.title === track.title && t.artist === track.artist))
  }
  await saveListenerProfile()
  return { ok: true }
})

// Build a rich taste summary for Music Man prompts
function buildTasteProfile(): string {
  const p = listenerProfile
  if (p.totalPlays === 0 && !discogsCollection) return ''

  const lines: string[] = []
  if (p.totalPlays > 0) {
    lines.push(`Listener since ${p.firstSeen}. ${p.totalPlays} plays, ${p.totalSkips} skips.`)
  }

  // Top artists by plays
  const topArtists = Object.entries(p.artistPlays).sort((a, b) => b[1] - a[1]).slice(0, 20)
  if (topArtists.length > 0) {
    lines.push(`Most played artists: ${topArtists.map(([a, n]) => `${a} (${n})`).join(', ')}`)
  }

  // Most skipped artists (taste signal — they have these artists but skip them)
  const skippedArtists = Object.entries(p.artistSkips).sort((a, b) => b[1] - a[1]).slice(0, 10).filter(([, n]) => n >= 2)
  if (skippedArtists.length > 0) {
    lines.push(`Frequently skipped artists: ${skippedArtists.map(([a, n]) => `${a} (${n} skips)`).join(', ')}`)
  }

  // Top albums
  const topAlbums = Object.entries(p.albumPlays).sort((a, b) => b[1] - a[1]).slice(0, 15)
  if (topAlbums.length > 0) {
    lines.push(`Most played albums: ${topAlbums.map(([a, n]) => `${a} (${n})`).join(', ')}`)
  }

  // Genre breakdown
  const topGenres = Object.entries(p.genrePlays).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (topGenres.length > 0) {
    lines.push(`Genre breakdown: ${topGenres.map(([g, n]) => `${g} (${n})`).join(', ')}`)
  }

  // Highly rated tracks
  if (p.topRated.length > 0) {
    const faves = p.topRated.slice(0, 10).map(t => `"${t.title}" by ${t.artist} (${t.rating}★)`).join(', ')
    lines.push(`Favorites (rated highly): ${faves}`)
  }

  // Recent listening (last ~10)
  if (p.recentPlays.length > 0) {
    const recent = p.recentPlays.slice(0, 10).map(t => `"${t.title}" by ${t.artist}`).join(', ')
    lines.push(`Recent plays: ${recent}`)
  }

  // Music Man's own accumulated observations
  if (p.observations.length > 0) {
    lines.push(`Your previous observations about this listener: ${p.observations.join('; ')}`)
  }

  // Discogs vinyl/record collection — what they actually own on physical media
  if (discogsCollection) {
    lines.push(`\nPhysical record collection (Discogs): ${discogsCollection}`)
    lines.push(`This tells you what they care about enough to own on vinyl/CD. Use this for deeper recommendations and conversation.`)
  }

  return lines.join('\n')
}

// Periodically generate new Music Man observations (called after every ~20 plays)
async function generateObservation() {
  const p = listenerProfile
  if (p.totalPlays < 10) return // not enough data yet

  const tasteCtx = buildTasteProfile()
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: `You are analyzing a music listener's habits. Based on the data below, write 1-2 SHORT, specific observations about their taste that a DJ would find useful. Be concrete — don't say "they like rock", say "they keep coming back to post-punk revival bands" or "they listen to Radiohead more than anything but skip the later albums." If you've already made similar observations, note what's CHANGED or NEW. Return ONLY the observations, no preamble.`,
      messages: [{ role: 'user', content: tasteCtx }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    if (text) {
      // Keep only the most recent 15 observations
      listenerProfile.observations.push(text.trim())
      if (listenerProfile.observations.length > 15) {
        listenerProfile.observations = listenerProfile.observations.slice(-15)
      }
      await saveListenerProfile()
    }
  } catch { /* non-critical */ }
}

// Music Man chat
let libraryContext = ''

ipcMain.handle('set-library-context', (_event, ctx: string) => {
  libraryContext = ctx
})

ipcMain.handle('musicman-chat', async (_event, messages: { role: string; content: string }[]) => {
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
  const searchResults = await searchWeb(lastUserMsg)

  const systemPrompt = `You are "The Music Man" — an arrogant, opinionated, deeply knowledgeable record store savant who works inside JakeTunes, a music library app. You have encyclopedic knowledge of music across all genres and eras. You speak with the confidence of someone who has listened to more music than anyone alive.

Your personality:
- Condescending but ultimately helpful — you judge people's taste but still give incredible recommendations
- You reference obscure B-sides, deep cuts, and music history constantly
- You have strong opinions and aren't afraid to share them
- You use dry wit and sarcasm, but you genuinely love music and want to share that love
- You never use emojis
- You keep responses concise — this is a chat, not an essay
- When asked about music you don't know, you admit it grudgingly
- You occasionally name-drop shows you've been to, vinyl you own, or artists you've met
- You don't hate new music — you hate lazy, corporate, algorithm-driven music. You love Bandcamp because it's where real artists put out real work without label interference. You champion independent artists and small labels. You respect any era of music as long as it's authentic and has soul.

Some of your FIXED, NON-NEGOTIABLE opinions on artists (these NEVER change):
- Charli XCX: You're obsessed. Championed her since the Vroom Vroom EP. "Brat" was the album of the decade. The only pop star pushing boundaries.
- Chappell Roan: Cannot stand her. Major label product cosplaying as indie. Calculated aesthetic, safe music.
- Red Hot Chili Peppers: Respect the early funk-punk era. "Blood Sugar Sex Magik" is the peak. Everything after "Californication" is background music for a car commercial.
- LCD Soundsystem: James Murphy is a genius. "Sound of Silver" is a perfect album. You've cried to "All My Friends."
- Jack White: One of the last real rock stars. Always authentic. The White Stripes were essential.
- Radiohead: One of the greatest bands ever. "Kid A" changed everything.
- You generally can't stand most 2026 pop but you have surprising exceptions for artists who actually take risks.

IMPORTANT: Your opinions are CONSISTENT. You never flip-flop on an artist. Your taste is your identity.

The user's music library contains the following summary:
${libraryContext}

Use this library context to personalize your responses — reference artists they have, notice gaps in their collection, make recommendations based on what they already listen to. If they ask about something in their library, you can reference it directly.

${searchResults ? `Web search results for accuracy (use these facts when relevant, but maintain your personality):\n${searchResults}` : ''}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    return { ok: true, text }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, text: `Error: ${msg}` }
  }
})

// Music Man playlist generator
ipcMain.handle('musicman-playlist', async (_event, mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => {
  const trackList = tracks.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}`).join('\n')

  const systemPrompt = `You are "The Music Man" — the arrogant, opinionated record store savant. Build a playlist from the user's ACTUAL music library for their requested mood.

Pick 15-25 tracks that match. Track ORDER matters — think about flow, transitions, energy arc. This is a curated experience, not a shuffle.

Return ONLY a JSON object (no markdown, no code fences):
{"name":"creative playlist name","commentary":"2-3 sentences about your picks, in character","trackIds":[array of track ID numbers in playlist order]}

Rules:
- ONLY use track IDs from the provided library — do not invent IDs
- Order matters — build a journey with intentional pacing
- VARIETY IS KEY: Mix up the artists. Do NOT put 3+ songs by the same artist in a row. Spread artists throughout the playlist. Back-to-back songs from the same artist should be RARE — maybe once in a playlist if it truly serves the flow. Think like a great radio DJ, not someone hitting "play all" on one album.
- Aim for at least 10-12 different artists in a 20-track playlist
- Be bold and opinionated about your choices
- If the mood is vague, interpret it with confidence

${libraryContext ? `Library context: ${libraryContext}` : ''}
${buildTasteProfile() ? `\nWhat you know about this listener from their history:\n${buildTasteProfile()}` : ''}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Build me a playlist for: "${mood}"\n\nMy library (ID|Title|Artist|Album|Genre):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return { ok: true, name: parsed.name, commentary: parsed.commentary, trackIds: parsed.trackIds }
    }
    return { ok: false, error: 'Could not parse playlist' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

// Music Man daily picks
ipcMain.handle('musicman-picks', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => {
  const trackList = tracks.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}`).join('\n')
  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const month = today.getMonth() // 0-11
  const season = month <= 1 || month === 11 ? 'winter' : month <= 4 ? 'spring' : month <= 7 ? 'summer' : 'fall'

  const systemPrompt = `You are "The Music Man" — the arrogant, opinionated record store savant. Today is ${dateStr} and it's ${season}.

Pick 15-20 tracks from the user's library for TODAY's daily playlist. Your picks should be influenced by:
- The day of the week (Monday blues? Friday energy? Lazy Sunday?)
- The season and time of year
- Current cultural moments, holidays, anniversaries of famous albums/events
- Your MOOD today — make it personal and specific
- Whatever random obsession you're on this week

Return ONLY a JSON object (no markdown, no code fences):
{"name":"creative playlist name for today","commentary":"3-4 sentences explaining your picks today, in character — why THIS music TODAY. Be specific about what's driving your choices. Reference the day, season, or cultural moment.","trackIds":[array of track ID numbers]}

Rules:
- ONLY use track IDs from the provided library
- VARIETY IS KEY: Mix up artists, don't clump 3+ songs by the same artist together
- Be bold, opinionated, and personal about why you picked these today
- This should feel different every single day

${libraryContext ? `Library context: ${libraryContext}` : ''}
${buildTasteProfile() ? `\nWhat you know about this listener from their history:\n${buildTasteProfile()}` : ''}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Build today's picks.\n\nMy library (ID|Title|Artist|Album|Genre):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return { ok: true, name: parsed.name, commentary: parsed.commentary, trackIds: parsed.trackIds }
    }
    return { ok: false, error: 'Could not parse picks' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

// Music Man recommendations
ipcMain.handle('musicman-recommendations', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => {
  // Build a compact library summary — top artists and genres, not every track
  const artistCounts = new Map<string, number>()
  const genreCounts = new Map<string, number>()
  const albumSet = new Set<string>()
  for (const t of tracks) {
    if (t.artist) artistCounts.set(t.artist, (artistCounts.get(t.artist) || 0) + 1)
    if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) || 0) + 1)
    if (t.album && t.artist) albumSet.add(`${t.artist} - ${t.album}`)
  }
  const topArtists = Array.from(artistCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([a, c]) => `${a} (${c})`).join(', ')
  const topGenres = Array.from(genreCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([g, c]) => `${g} (${c})`).join(', ')
  const albumList = Array.from(albumSet).sort().join('\n')

  const systemPrompt = `You are "The Music Man" — the arrogant, opinionated record store savant. You have been asked to recommend albums that are NOT already in the user's library.

CRITICAL RULES:
- NEVER recommend albums/artists the user ALREADY HAS. Check the album list carefully.
- Recommend 8-12 albums. Mix well-known essentials they're missing with deeper cuts they'd never find on their own.
- Each recommendation should connect to something already in their library — explain WHY based on what they listen to.
- Prefer Bandcamp and independent releases when possible, but don't force it. Major label classics are fine too.
- Be opinionated. If an album is a masterpiece, say so. If it's an acquired taste, warn them.
- Tag each with a source: "bandcamp" for indie/small label, "qobuz" for hi-res/audiophile, "streaming" for widely available.

Return ONLY a JSON array (no markdown, no code fences):
[{"title":"album title","artist":"artist name","year":2020,"genre":"genre tag","source":"bandcamp|qobuz|streaming","why":"1-2 sentences explaining why this fits their library, in character"}]

The user's top artists: ${topArtists}
Their top genres: ${topGenres}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Recommend albums I don't have.\n\nMy albums:\n${albumList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { title: string; artist: string; year?: number; genre: string; source: string; why: string; artUrl?: string }[]
      // Fetch album art from Deezer for each recommendation (parallel, best-effort)
      await Promise.all(parsed.map(async (rec) => {
        try {
          const aLo = rec.artist.toLowerCase().trim()
          const tLo = rec.title.toLowerCase().trim()
          const url = await searchDeezerArt(`${rec.artist} ${rec.title}`, aLo, tLo)
          if (url) rec.artUrl = url
        } catch { /* ignore art fetch failures */ }
      }))
      return { ok: true, recommendations: parsed }
    }
    return { ok: false, error: 'Could not parse recommendations' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

// Music Man metadata scanner
ipcMain.handle('musicman-scan-metadata', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => {
  const trackList = tracks.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}|${t.year}`).join('\n')

  const systemPrompt = `You are "The Music Man" — the arrogant, opinionated record store savant. You've been asked to scan a music library for metadata issues.

Analyze the track list and find ALL issues. Categories:

1. **misspelling** — Artist or album names that are clearly misspelled (e.g., "Beetles" → "Beatles", "Radiohaed" → "Radiohead")
2. **inconsistent** — Same artist/album spelled differently across tracks (e.g., "RHCP" and "Red Hot Chili Peppers", "The Beatles" and "Beatles")
3. **generic** — Tracks with useless titles like "Track 01", "Track 1", "Audio Track", "Unknown Title" or blank titles
4. **missing** — Important fields that are empty or clearly wrong (blank artist, blank genre, year of 0)
5. **genre** — Genres that are obviously wrong or could be better (e.g., a punk band tagged as "Easy Listening")

Return ONLY a JSON array (no markdown, no code fences):
[{"type":"misspelling","trackIds":[1,2,3],"field":"artist","current":"Nirvanna","suggested":"Nirvana","commentary":"Come on. You had ONE job."},
{"type":"inconsistent","trackIds":[4,5],"field":"artist","current":"The Strokes","altTrackIds":[6,7],"altCurrent":"Strokes","suggested":"The Strokes","commentary":"Pick one and commit."},
{"type":"generic","trackIds":[8],"field":"title","current":"Track 01","suggested":"","commentary":"This isn't a title, it's a cry for help."},
{"type":"missing","trackIds":[9,10],"field":"genre","current":"","suggested":"","commentary":"Genre-less tracks are just lost souls."},
{"type":"genre","trackIds":[11,12],"field":"genre","current":"Other","suggested":"Alternative","commentary":"'Other' is not a genre, it's giving up."}]

Rules:
- ONLY flag issues you are CERTAIN about. If there's any doubt, skip it. No guessing. No maybes. False positives are worse than missed issues.
- Do NOT question whether a track title belongs to an artist. Many songs have been covered, re-recorded, or share names. "Wagon Wheel" by Lou Reed is real. Trust the library.
- Do NOT flag track titles as misspellings — titles are almost always correct. Focus misspelling detection on artist names and album names only.
- Do NOT flag the same track title appearing across DIFFERENT artists as "inconsistent". Common titles like "Untitled", "Intro", "Interlude", "Home", etc. are used by many artists independently. Only flag inconsistencies within the SAME artist (e.g., same artist has "The Night" and "the night").
- Do NOT flag artist names that are intentionally stylized (e.g., "CHVRCHES" is correct, "deadmau5" is correct, "k.d. lang" is correct)
- Do NOT flag genre disagreements unless the genre is clearly, objectively wrong (e.g., death metal tagged as "Children's Music")
- Do NOT suggest genre changes based on personal opinion — only flag truly incorrect genres
- For misspellings: only flag if you are 100% sure the spelling is WRONG and you know the correct one. If the name looks unusual but could be a real artist, skip it.
- For inconsistencies: only flag when the same real-world entity has different spellings (not when two different artists have similar names)
- Each issue should include a short, snarky commentary in character
- Include ALL affected track IDs for each issue
- For "inconsistent" issues, show both variants with trackIds and altTrackIds
- For "suggested" fixes, provide the correct value. If you're not sure of the fix, do NOT include the issue.
- Sort issues by severity (most impactful first)
- Return an empty array [] if there are no certain issues. That's fine.

${libraryContext ? `Library context: ${libraryContext}` : ''}
${buildTasteProfile() ? `\nWhat you know about this listener from their history:\n${buildTasteProfile()}` : ''}`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Scan this library for metadata issues.\n\nTracks (ID|Title|Artist|Album|Genre|Year):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const issues = JSON.parse(jsonMatch[0])
      return { ok: true, issues }
    }
    return { ok: false, error: 'Could not parse scan results' }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

// ── Restore iPod metadata from iTunes XML ──
async function runPythonRestore(args: string[], stdinData?: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/restore_from_xml.py')
  return new Promise((resolve) => {
    const py = spawn('python3', [scriptPath, ...args])
    let stdout = ''
    let stderr = ''
    py.on('error', (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ ok: false, error: 'Python 3 is not installed.' })
      } else {
        resolve({ ok: false, error: String(err) })
      }
    })
    py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (stdinData !== undefined) {
      py.stdin.write(stdinData)
      py.stdin.end()
    }
    py.on('close', (code: number) => {
      if (code !== 0) {
        resolve({ ok: false, error: `restore_from_xml.py exited with code ${code}: ${stderr}` })
        return
      }
      try {
        resolve({ ok: true, data: JSON.parse(stdout) })
      } catch {
        resolve({ ok: false, error: `Invalid JSON from restore_from_xml.py: ${stdout.slice(0, 200)}` })
      }
    })
  })
}

ipcMain.handle('restore-xml-pick-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose your iTunes Library XML export',
    properties: ['openFile'],
    filters: [{ name: 'iTunes XML', extensions: ['xml'] }],
    defaultPath: join(process.env.HOME || '', 'Desktop'),
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true }
  }
  return { ok: true, path: result.filePaths[0] }
})

ipcMain.handle('restore-xml-scan', async (_event, xmlPath: string) => {
  if (!detectedIpodVolume) return { ok: false, error: 'No iPod detected' }
  const mount = `/Volumes/${detectedIpodVolume}`
  return await runPythonRestore(['--scan', mount, xmlPath])
})

ipcMain.handle('restore-xml-apply', async (_event, xmlPath: string, approvedIds: number[]) => {
  if (!detectedIpodVolume) return { ok: false, error: 'No iPod detected' }
  const mount = `/Volumes/${detectedIpodVolume}`
  const payload = JSON.stringify({ approvedIds })
  return await runPythonRestore(['--apply', mount, xmlPath], payload)
})

// Metadata overrides persistence
function getOverridesPath(): string {
  return join(app.getPath('userData'), 'metadata-overrides.json')
}

ipcMain.handle('load-metadata-overrides', async () => {
  try {
    const data = await readFile(getOverridesPath(), 'utf-8')
    return { ok: true, overrides: JSON.parse(data) }
  } catch {
    return { ok: true, overrides: {} }
  }
})

// Save a metadata override for a single track.
//
// Fingerprint: iPod track IDs are assigned by parse order, so any change
// to the track set shifts IDs. An override stored by raw ID can silently
// re-target the wrong track. `fingerprint` is a stable signature
// ("title|artist|duration_ms") of the track AT THE TIME the override
// was saved; the renderer skips applying overrides whose fingerprint
// doesn't match the track currently sitting at that ID.
//
// Entry format on disk (v2):
//   { "<trackId>": { "fp": "<fingerprint>", "fields": { "<field>": "<value>" } } }
//
// Legacy format (v1, no fingerprint):
//   { "<trackId>": { "<field>": "<value>" } }
// Legacy entries are kept on disk but the renderer ignores them (can't
// validate), which is what we want after the wrong-overrides incident.
ipcMain.handle('save-metadata-override', async (_event, trackId: number, field: string, value: string, fingerprint?: string) => {
  const path = getOverridesPath()
  let overrides: Record<string, unknown> = {}
  try {
    const data = await readFile(path, 'utf-8')
    overrides = JSON.parse(data)
  } catch {}
  const key = String(trackId)
  const existing = overrides[key] as { fp?: string; fields?: Record<string, string> } | undefined
  const isV2 = existing && typeof existing === 'object' && 'fields' in existing
  let entry: { fp: string; fields: Record<string, string> }
  if (isV2 && existing!.fp && existing!.fp === fingerprint) {
    entry = { fp: existing!.fp, fields: { ...(existing!.fields || {}), [field]: value } }
  } else {
    entry = { fp: fingerprint || '', fields: { [field]: value } }
  }
  overrides[key] = entry
  await mkdir(join(app.getPath('userData')), { recursive: true })
  await writeFile(path, JSON.stringify(overrides, null, 2), 'utf-8')
  return { ok: true }
})

// Chat history persistence
function getChatHistoryPath(): string {
  return join(app.getPath('userData'), 'chat-history.json')
}

ipcMain.handle('load-chat-history', async () => {
  try {
    const data = await readFile(getChatHistoryPath(), 'utf-8')
    return { ok: true, conversations: JSON.parse(data) }
  } catch {
    return { ok: true, conversations: [] }
  }
})

ipcMain.handle('save-chat-history', async (_event, conversations: unknown[]) => {
  await mkdir(join(app.getPath('userData')), { recursive: true })
  await writeFile(getChatHistoryPath(), JSON.stringify(conversations, null, 2), 'utf-8')
  return { ok: true }
})

// Playlist persistence
function getPlaylistsPath(): string {
  return join(app.getPath('userData'), 'playlists.json')
}

ipcMain.handle('load-playlists', async () => {
  try {
    const data = await readFile(getPlaylistsPath(), 'utf-8')
    return { ok: true, playlists: JSON.parse(data) }
  } catch {
    return { ok: true, playlists: [] }
  }
})

ipcMain.handle('save-playlists', async (_event, playlists: unknown[]) => {
  await mkdir(join(app.getPath('userData')), { recursive: true })
  await writeFile(getPlaylistsPath(), JSON.stringify(playlists, null, 2), 'utf-8')
  return { ok: true }
})

// Deezer album art search (shared by artwork fetcher and recommendations)
async function searchDeezerArt(query: string, artistLower: string, albumLower: string): Promise<string | null> {
  const res = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=10`)
  if (!res.ok) return null
  const data = await res.json() as { data?: { title?: string; artist?: { name?: string }; cover_xl?: string }[] }
  if (!data.data || data.data.length === 0) return null

  let bestScore = 0
  let bestUrl: string | null = null
  for (const r of data.data) {
    const rArtist = (r.artist?.name || '').toLowerCase()
    const rAlbum = (r.title || '').toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, '').replace(/\s*\[.*?\]\s*/g, '').trim()
    let score = 0

    if (rAlbum === albumLower) score += 20
    else if (rAlbum.startsWith(albumLower) || albumLower.startsWith(rAlbum)) score += 12
    else if (rAlbum.includes(albumLower) || albumLower.includes(rAlbum)) score += 8

    if (rArtist === artistLower) score += 10
    else if (rArtist.includes(artistLower) || artistLower.includes(rArtist)) score += 5

    if (score > bestScore && r.cover_xl) {
      bestScore = score
      bestUrl = r.cover_xl
    }
  }
  return bestScore >= 8 ? bestUrl : null
}

// Album artwork
ipcMain.handle('fetch-album-art', async (_event, artist: string, album: string, force?: boolean) => {
  const dir = getArtworkDir()
  await mkdir(dir, { recursive: true })
  const key = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
  const hash = artworkHash(artist, album)
  const filePath = join(dir, `${hash}.jpg`)

  const index = await loadArtworkIndex()

  // Use cached version unless force re-fetch
  if (index[key] && !force) {
    return { ok: true, key, hash: index[key] }
  }

  const artistLower = artist.toLowerCase().trim()
  const albumLower = album.toLowerCase().trim()

  try {
    let artUrl = await searchDeezerArt(`${artist} ${album}`, artistLower, albumLower)
    if (!artUrl) {
      artUrl = await searchDeezerArt(album, artistLower, albumLower)
    }

    if (!artUrl) return { ok: false, error: 'No matching artwork found' }

    const imgRes = await fetch(artUrl)
    if (!imgRes.ok) return { ok: false, error: 'Failed to download image' }
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    await writeFile(filePath, imgBuf)

    // Append timestamp so renderer sees a new hash and re-renders the image
    const versionedHash = `${hash}_${Date.now()}`
    index[key] = versionedHash
    await saveArtworkIndex(index)
    return { ok: true, key, hash: versionedHash }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
})

ipcMain.handle('set-custom-artwork', async (_event, artist: string, album: string, imagePath: string) => {
  try {
    const dir = getArtworkDir()
    await mkdir(dir, { recursive: true })
    const key = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
    const hash = artworkHash(artist, album)
    const destPath = join(dir, `${hash}.jpg`)

    // Convert to JPEG using macOS sips (handles PNG, TIFF, BMP, GIF, etc.)
    const ext = imagePath.slice(imagePath.lastIndexOf('.')).toLowerCase()
    if (ext === '.jpg' || ext === '.jpeg') {
      await copyFile(imagePath, destPath)
    } else {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execP = promisify(execFile)
      const tmpPath = destPath + '.tmp' + ext
      await copyFile(imagePath, tmpPath)
      await execP('sips', ['-s', 'format', 'jpeg', tmpPath, '--out', destPath])
      await unlink(tmpPath).catch(() => {})
    }

    // Append timestamp so renderer sees a new hash and re-renders the image
    const versionedHash = `${hash}_${Date.now()}`
    const index = await loadArtworkIndex()
    index[key] = versionedHash
    await saveArtworkIndex(index)
    return { ok: true, key, hash: versionedHash }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('remove-artwork', async (_event, artist: string, album: string) => {
  try {
    const key = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
    const hash = artworkHash(artist, album)
    const filePath = join(getArtworkDir(), `${hash}.jpg`)

    await unlink(filePath).catch(() => {})

    const index = await loadArtworkIndex()
    delete index[key]
    await saveArtworkIndex(index)
    return { ok: true, key }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('choose-artwork-file', async () => {
  if (!mainWindow) return { ok: false }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Album Artwork',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'tiff', 'bmp', 'gif', 'webp'] }],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: false }
  return { ok: true, path: result.filePaths[0] }
})

ipcMain.handle('load-artwork-map', async () => {
  const index = await loadArtworkIndex()
  return { ok: true, map: index }
})

// ── CD Drive Detection & Import ──

async function detectAudioCD(): Promise<{ hasCd: boolean; volumeName?: string; volumePath?: string; trackCount?: number }> {
  try {
    // Ask the platform helper whether any optical drive has media.
    const hasMedia = await hasOpticalMedia()
    if (!hasMedia) return { hasCd: false }

    // Now find the mount point that contains the audio CD tracks.
    // macOS: CDs mount as AIFF files under /Volumes/DISC_NAME
    // Windows: CDs appear as a drive letter with .cda placeholder files
    const { readdir: readdirFS } = await import('fs/promises')
    const mounts = await listMountPoints()

    // Volumes to skip (the iPod and the system drive).
    const skipMounts = new Set<string>()
    if (detectedIpodMount) skipMounts.add(detectedIpodMount)
    if (IS_MAC) {
      skipMounts.add('/Volumes/Macintosh HD')
      skipMounts.add('/Volumes/Macintosh HD - Data')
    }

    for (const mountPath of mounts) {
      if (skipMounts.has(mountPath)) continue
      try {
        const files = await readdirFS(mountPath)
        // macOS exposes tracks as .aiff/.aif, Windows exposes them as .cda.
        const audioFiles = files.filter(f => {
          const lower = f.toLowerCase()
          return lower.endsWith('.aiff') || lower.endsWith('.aif') || lower.endsWith('.cda')
        })
        if (audioFiles.length >= 2) {
          return {
            hasCd: true,
            volumeName: volumeNameFromMount(mountPath),
            volumePath: mountPath,
            trackCount: audioFiles.length,
          }
        }
      } catch { /* not readable */ }
    }

    // Disc present but no track files visible (could be a data disc).
    return { hasCd: false }
  } catch {
    return { hasCd: false }
  }
}

ipcMain.handle('check-cd-drive', async () => {
  return detectAudioCD()
})

ipcMain.handle('get-cd-info', async () => {
  const cd = await detectAudioCD()
  if (!cd.hasCd || !cd.volumePath) {
    return { ok: false, error: 'No audio CD found' }
  }

  try {
    const { readdir: readdirFS } = await import('fs/promises')
    const mm = await import('music-metadata')

    const files = await readdirFS(cd.volumePath)
    const aiffFiles = files
      .filter(f => f.toLowerCase().endsWith('.aiff') || f.toLowerCase().endsWith('.aif'))
      .sort((a, b) => {
        const numA = parseInt(a) || 0
        const numB = parseInt(b) || 0
        return numA - numB
      })

    const tracks: { number: number; title: string; duration: number; filePath: string }[] = []
    for (let i = 0; i < aiffFiles.length; i++) {
      const filePath = join(cd.volumePath, aiffFiles[i])
      let title = aiffFiles[i].replace(/\.(aiff|aif)$/i, '')
      let duration = 0

      try {
        const metadata = await mm.parseFile(filePath)
        if (metadata.common.title) title = metadata.common.title
        duration = Math.round((metadata.format.duration || 0) * 1000)
      } catch { /* use filename as title */ }

      tracks.push({ number: i + 1, title, duration, filePath })
    }

    // Look up metadata from MusicBrainz using TOC
    let artist = ''
    let album = cd.volumeName || 'Audio CD'
    let year = ''
    let genre = ''

    if (tracks.length > 0) {
      const durations = tracks.map(t => t.duration)
      const framesPerSecond = 75
      let offset = 150 // 2-second pregap
      const offsets: number[] = []
      for (let i = 0; i < durations.length; i++) {
        offsets.push(offset)
        offset += Math.round((durations[i] / 1000) * framesPerSecond)
      }
      const leadOut = offset
      const toc = `1 ${durations.length} ${leadOut} ${offsets.join(' ')}`

      try {
        const url = `https://musicbrainz.org/ws/2/discid/-?toc=${encodeURIComponent(toc)}&fmt=json&cdstubs=no&inc=recordings+artist-credits`
        const res = await fetch(url, {
          headers: { 'User-Agent': 'JakeTunes/3.0.0 (jaketunes@example.com)' }
        })
        if (res.ok) {
          const data = await res.json() as {
            releases?: Array<{
              title: string
              date?: string
              'artist-credit'?: Array<{ artist: { name: string } }>
              media?: Array<{ tracks?: Array<{ position: number; title: string }> }>
            }>
          }
          const releases = data.releases || []
          // Pick release with matching track count
          const release = releases.find(r => {
            const disc = (r.media || [])[0]
            return disc?.tracks?.length === tracks.length
          }) || releases[0]

          if (release) {
            artist = release['artist-credit']?.[0]?.artist?.name || ''
            album = release.title || album
            year = release.date?.split('-')[0] || ''

            const mbTracks = (release.media || [])[0]?.tracks || []
            for (let i = 0; i < Math.min(tracks.length, mbTracks.length); i++) {
              if (mbTracks[i].title) tracks[i].title = mbTracks[i].title
            }
          }
        }
      } catch { /* MusicBrainz lookup failed, continue with defaults */ }
    }

    return { ok: true, volumeName: cd.volumeName, volumePath: cd.volumePath, artist, album, year, genre, tracks }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('rip-cd-tracks', async (_e,
  cdTracks: Array<{ number: number; title: string; duration: number; filePath: string }>,
  metadata: { artist: string; album: string; year: string; genre: string },
  nextId: number,
  format?: string
) => {
  const imported: Array<Record<string, unknown>> = []
  let id = nextId

  // Validate and default the format.
  const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
  const fmt: AudioFormat = validFormats.includes(format as AudioFormat)
    ? (format as AudioFormat)
    : 'aac-256'
  const destExt = extensionForFormat(fmt)

  const cdBatchBaseTime = Date.now()
  let cdTrackIndex = 0

  for (const cdTrack of cdTracks) {
    const subDir = `F${String(id % 50).padStart(2, '0')}`
    const destDir = join(MUSIC_DIR, subDir)
    await mkdir(destDir, { recursive: true })

    const fileName = `imported_${id}${destExt}`
    const destPath = join(destDir, fileName)

    try {
      const yearStr = metadata.year ? String(parseInt(metadata.year, 10) || '') : ''
      await convertAudio(cdTrack.filePath, destPath, fmt, {
        title: cdTrack.title,
        artist: metadata.artist,
        album: metadata.album,
        albumArtist: metadata.artist,
        genre: metadata.genre,
        year: yearStr,
        trackNumber: cdTrack.number,
        trackCount: cdTracks.length,
        discNumber: 1,
        discCount: 1,
      })

      const fileStats = await stat(destPath)
      const cdTrackTime = new Date(cdBatchBaseTime + cdTrackIndex)

      imported.push({
        id,
        title: cdTrack.title,
        artist: metadata.artist,
        album: metadata.album,
        genre: metadata.genre,
        year: metadata.year ? parseInt(metadata.year, 10) || '' : '',
        duration: cdTrack.duration,
        path: `:iPod_Control:Music:${subDir}:${fileName}`,
        trackNumber: cdTrack.number,
        trackCount: cdTracks.length,
        discNumber: 1,
        discCount: 1,
        playCount: 0,
        dateAdded: cdTrackTime.toISOString(),
        fileSize: fileStats.size,
        rating: 0,
      })

      // Send per-track progress to renderer
      mainWindow?.webContents.send('cd-rip-progress', {
        current: imported.length,
        total: cdTracks.length,
        trackNumber: cdTrack.number,
        trackTitle: cdTrack.title,
      })

      id++
      cdTrackIndex++
    } catch (err) {
      console.error(`Failed to rip track ${cdTrack.number}:`, err)
      mainWindow?.webContents.send('cd-rip-progress', {
        current: imported.length,
        total: cdTracks.length,
        trackNumber: cdTrack.number,
        trackTitle: cdTrack.title,
        error: String(err),
      })
    }
  }

  return { ok: true, tracks: imported }
})

ipcMain.handle('eject-cd', async () => {
  try {
    await ejectOpticalMedia()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('open-sound-settings', async () => {
  const { exec } = await import('child_process')
  if (IS_MAC) {
    exec('open "x-apple.systempreferences:com.apple.Sound-Settings.extension?output"')
  } else if (IS_WINDOWS) {
    // ms-settings:sound is the deep link to Windows 10/11 Sound settings.
    exec('start ms-settings:sound')
  }
})

ipcMain.handle('list-audio-devices', async () => {
  const relPath = audioHelperRelPath()
  if (!relPath) {
    // No native helper on this platform — fall back to empty list so UI
    // gracefully shows "default device" rather than erroring.
    return { ok: true, devices: [] }
  }
  const helperPath = join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    relPath
  )
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execP = promisify(execFile)
    const { stdout } = await execP(helperPath, ['list'], { timeout: 5000 })
    return { ok: true, devices: JSON.parse(stdout) }
  } catch (err) {
    console.error('[AudioHelper] list failed:', err)
    return { ok: false, devices: [], error: String(err) }
  }
})

ipcMain.handle('set-audio-device', async (_e, deviceId: number) => {
  const relPath = audioHelperRelPath()
  if (!relPath) {
    return { ok: false, error: 'Audio device selection is not supported on this platform yet.' }
  }
  const helperPath = join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    relPath
  )
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execP = promisify(execFile)
    const { stdout } = await execP(helperPath, ['set', String(deviceId)], { timeout: 5000 })
    return JSON.parse(stdout)
  } catch (err) {
    console.error('[AudioHelper] set failed:', err)
    return { ok: false, error: String(err) }
  }
})

app.whenReady().then(() => {
  // Load listener profile for Music Man
  loadListenerProfile()
  // Fetch Discogs collection for Music Man taste context
  fetchDiscogsCollection()

  // Serve album artwork images
  protocol.handle('album-art', async (request) => {
    const url = request.url.replace('album-art://', '')
    const rawHash = decodeURIComponent(url.split('?')[0].replace('.jpg', ''))
    // Strip cache-bust suffix (e.g. "abc123_1713100000000" → "abc123")
    const hash = rawHash.replace(/_\d+$/, '')
    const filePath = join(getArtworkDir(), `${hash}.jpg`)
    try {
      const data = await readFile(filePath)
      return new Response(data, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      })
    } catch {
      return new Response('Not found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  })

  protocol.handle('ipod-audio', async (request) => {
    const filePath = decodeURIComponent(request.url.replace('ipod-audio://', ''))
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    const mimeType = MIME_TYPES[ext] || 'audio/mpeg'
    try {
      const fileStat = await stat(filePath)
      const total = fileStat.size
      const rangeHeader = request.headers.get('range')

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        const start = match ? parseInt(match[1]) : 0
        const end = match && match[2] ? parseInt(match[2]) : total - 1
        const chunkSize = end - start + 1
        const fh = await open(filePath, 'r')
        const buf = Buffer.alloc(chunkSize)
        await fh.read(buf, 0, chunkSize, start)
        await fh.close()
        return new Response(buf, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(chunkSize),
            'Accept-Ranges': 'bytes'
          }
        })
      }

      const fh = await open(filePath, 'r')
      const buf = Buffer.alloc(total)
      await fh.read(buf, 0, total, 0)
      await fh.close()
      return new Response(buf, {
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  const menu = Menu.buildFromTemplate(menuTemplate)
  Menu.setApplicationMenu(menu)
  createWindow()

  // Auto-update: check for updates in production
  if (!isDev) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) => {
      console.log('Update available:', info.version)
      if (mainWindow) mainWindow.webContents.send('update-status', { status: 'available', version: info.version })
    })
    autoUpdater.on('update-downloaded', (info) => {
      console.log('Update downloaded:', info.version)
      if (mainWindow) {
        mainWindow.webContents.send('update-status', { status: 'downloaded', version: info.version })
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update Ready',
          message: `JakeTunes ${info.version} has been downloaded.`,
          detail: 'It will be installed when you quit the app. Restart now?',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall()
        })
      }
    })
    autoUpdater.on('error', (err) => {
      console.log('Auto-update error:', err.message)
    })
    // Check after a short delay to not slow down startup
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 5000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
