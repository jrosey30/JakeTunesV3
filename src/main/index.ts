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

if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// macOS GUI apps launched from Finder inherit only the system PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), NOT the user's shell PATH. Tools
// installed via Homebrew (ffmpeg, ffprobe, python3 on some setups) live
// in /opt/homebrew/bin or /usr/local/bin and become invisible to
// spawn/execFile calls. Prepend the common locations so native
// subprocess invocations just work.
if (process.platform === 'darwin') {
  const extras = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',  // Apple Silicon homebrew
    '/usr/local/bin', '/usr/local/sbin',         // Intel / older homebrew
  ]
  const current = (process.env.PATH || '').split(':').filter(Boolean)
  const seen = new Set(current)
  const merged = [...current]
  for (const p of extras) {
    if (!seen.has(p)) {
      merged.unshift(p)
      seen.add(p)
    }
  }
  process.env.PATH = merged.join(':')
}

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

// ── Claude API rate-limit, cost ceiling, and graceful-fallback layer (4.0 §2.3) ──
//
// All anthropic.messages.create calls go through claudeCall(). It:
//   1. Bumps in-memory session counter and persisted day counter.
//   2. Resets the day counter when the local date rolls over.
//   3. Aborts (no API call) when callsToday >= dailyCeiling.
//   4. On API success, caches the response keyed by callKey for fallback use.
//   5. On API failure OR ceiling-hit, returns the cached fallback if available;
//      else throws so the caller can construct its own error response.
//
// User-tunable: edit `claude-stats.json` in userData and restart. Default
// ceiling of 200/day = roughly 10x typical session usage based on the §2.3
// audit (10–20 calls/active session).
//
// Fallback responses are stored as the raw MessageReply object — callers parse
// them identically to a fresh response, so swapping a stale cache for a new
// reply is transparent at the call site.

// Use the non-streaming-only types so response.content / response.stop_reason
// are accessible at call sites. anthropic.messages.create() is overloaded —
// using Awaited<ReturnType<...>> collapses to (Message | Stream) which
// loses the Message-specific properties.
type ClaudeMessageReply = Anthropic.Messages.Message
type ClaudeMessageParams = Anthropic.Messages.MessageCreateParamsNonStreaming

interface ClaudeStats {
  dailyCeiling: number
  lastResetDate: string  // YYYY-MM-DD local
  callsToday: number
  lastResponses: Record<string, { reply: ClaudeMessageReply; ts: number }>
}

const CLAUDE_STATS_DEFAULT: ClaudeStats = {
  dailyCeiling: 200,
  lastResetDate: '',
  callsToday: 0,
  lastResponses: {},
}

function claudeStatsPath(): string {
  return join(app.getPath('userData'), 'claude-stats.json')
}

function todayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

let claudeStats: ClaudeStats = { ...CLAUDE_STATS_DEFAULT }
let claudeStatsLoaded = false
let sessionCallCount = 0

async function loadClaudeStats(): Promise<void> {
  if (claudeStatsLoaded) return
  try {
    const raw = await readFile(claudeStatsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeStats>
    claudeStats = {
      dailyCeiling: typeof parsed.dailyCeiling === 'number' ? parsed.dailyCeiling : CLAUDE_STATS_DEFAULT.dailyCeiling,
      lastResetDate: typeof parsed.lastResetDate === 'string' ? parsed.lastResetDate : '',
      callsToday: typeof parsed.callsToday === 'number' ? parsed.callsToday : 0,
      lastResponses: (parsed.lastResponses && typeof parsed.lastResponses === 'object') ? parsed.lastResponses : {},
    }
  } catch {
    claudeStats = { ...CLAUDE_STATS_DEFAULT }
  }
  claudeStatsLoaded = true
}

async function saveClaudeStats(): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(claudeStatsPath(), JSON.stringify(claudeStats, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[claude] failed to persist stats:', err)
  }
}

function rolloverIfNewDay(): void {
  const today = todayLocal()
  if (claudeStats.lastResetDate !== today) {
    claudeStats.lastResetDate = today
    claudeStats.callsToday = 0
  }
}

async function claudeCall(
  callKey: string,
  params: ClaudeMessageParams
): Promise<ClaudeMessageReply> {
  await loadClaudeStats()
  rolloverIfNewDay()

  if (claudeStats.callsToday >= claudeStats.dailyCeiling) {
    const cached = claudeStats.lastResponses[callKey]?.reply
    console.warn(`[claude] daily ceiling ${claudeStats.dailyCeiling} reached for "${callKey}" — ${cached ? 'returning cached fallback' : 'no cache available'}`)
    if (cached) return cached
    throw new Error(`Claude daily ceiling reached (${claudeStats.dailyCeiling}). No cached fallback for "${callKey}".`)
  }

  sessionCallCount++
  claudeStats.callsToday++
  console.log(`[claude] ${callKey} — session=${sessionCallCount} today=${claudeStats.callsToday}/${claudeStats.dailyCeiling}`)

  try {
    const reply = await anthropic.messages.create(params)
    claudeStats.lastResponses[callKey] = { reply, ts: Date.now() }
    void saveClaudeStats()
    return reply
  } catch (err) {
    void saveClaudeStats()
    const cached = claudeStats.lastResponses[callKey]?.reply
    if (cached) {
      console.warn(`[claude] "${callKey}" API error, returning cached fallback:`, err instanceof Error ? err.message : err)
      return cached
    }
    throw err
  }
}

// ── Audio analysis queue (4.0 §2.4a) ──
//
// Per-track BPM, musical key, mode, and Camelot wheel position. Computed
// by core/audio_analysis.py (aubio + librosa) one-shot per track and
// persisted via metadata-overrides.json. This is the data source for
// future DJ-grade transitions (Music Man v2), harmonically-compatible
// playlists, and BPM-bounded smart playlists.
//
// Background-only — never blocks an import or any user-visible action.
// Failures are recorded with an audioAnalysisAt sentinel so we don't
// retry every session; consumers can choose to ignore stale results.
//
// Worker is single-threaded by design: librosa pulls in numpy/scipy
// which can pin all cores via BLAS. One track at a time = predictable
// load on the user's machine.

interface AudioAnalysisResult {
  ok: boolean
  bpm?: number
  keyRoot?: string
  keyMode?: 'major' | 'minor' | ''
  camelotKey?: string
  error?: string
}

interface AudioAnalysisJob {
  trackId: number
  path: string         // absolute filesystem path (already resolved from iPod colon-format)
  fingerprint: string  // metadata fingerprint used by the override v2 entry format
}

const audioAnalysisQueue: AudioAnalysisJob[] = []
let audioAnalysisRunning = false

function getAudioAnalysisScriptPath(): string {
  return join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/audio_analysis.py')
}

function runAudioAnalysisScript(absPath: string): Promise<AudioAnalysisResult> {
  return new Promise((resolve) => {
    const scriptPath = getAudioAnalysisScriptPath()
    const py = spawn(PYTHON_CMD, [scriptPath, absPath])
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (chunk) => { stdout += String(chunk) })
    py.stderr.on('data', (chunk) => { stderr += String(chunk) })
    py.on('error', (err) => {
      resolve({ ok: false, error: `spawn failed: ${err.message}` })
    })
    py.on('close', () => {
      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve({ ok: false, error: stderr.trim().split('\n').pop() || 'no output from audio_analysis.py' })
        return
      }
      try {
        resolve(JSON.parse(trimmed) as AudioAnalysisResult)
      } catch (parseErr) {
        resolve({ ok: false, error: `JSON parse failed: ${parseErr instanceof Error ? parseErr.message : parseErr}` })
      }
    })
  })
}

// Write multiple override fields in a single file write. Mirrors the
// existing save-metadata-override IPC handler (~line 3639) but takes a
// fields-map so the analysis worker doesn't trigger N separate writes.
async function persistOverrideFields(
  trackId: number,
  fields: Record<string, string>,
  fingerprint: string,
): Promise<void> {
  const overridesPath = join(app.getPath('userData'), 'metadata-overrides.json')
  let overrides: Record<string, unknown> = {}
  try {
    const data = await readFile(overridesPath, 'utf-8')
    overrides = JSON.parse(data)
  } catch { /* file may not exist yet */ }

  const key = String(trackId)
  const existing = overrides[key] as { fp?: string; fields?: Record<string, string> } | undefined
  const isV2 = existing && typeof existing === 'object' && 'fields' in existing
  let entry: { fp: string; fields: Record<string, string> }
  if (isV2 && existing!.fp && existing!.fp === fingerprint) {
    entry = { fp: existing!.fp, fields: { ...(existing!.fields || {}), ...fields } }
  } else {
    entry = { fp: fingerprint || '', fields: { ...fields } }
  }
  overrides[key] = entry
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(overridesPath, JSON.stringify(overrides, null, 2), 'utf-8')
}

async function processAudioAnalysisJob(job: AudioAnalysisJob): Promise<void> {
  const result = await runAudioAnalysisScript(job.path)
  const fields: Record<string, string> = {
    audioAnalysisAt: String(Date.now()),
  }
  if (result.ok) {
    if (typeof result.bpm === 'number' && result.bpm > 0) fields.bpm = String(result.bpm)
    if (result.keyRoot) fields.keyRoot = result.keyRoot
    if (result.keyMode) fields.keyMode = result.keyMode
    if (result.camelotKey) fields.camelotKey = result.camelotKey
    console.log(`[audio-analysis] ${job.trackId}: bpm=${result.bpm ?? '—'} key=${result.keyRoot || '—'}${result.keyMode ? ' ' + result.keyMode : ''} camelot=${result.camelotKey || '—'}`)
  } else {
    console.warn(`[audio-analysis] ${job.trackId} failed: ${result.error || 'unknown error'}`)
  }
  try {
    await persistOverrideFields(job.trackId, fields, job.fingerprint)
  } catch (err) {
    console.warn(`[audio-analysis] persist failed for ${job.trackId}:`, err instanceof Error ? err.message : err)
  }
}

async function audioAnalysisWorker(): Promise<void> {
  if (audioAnalysisRunning) return
  audioAnalysisRunning = true
  try {
    while (audioAnalysisQueue.length > 0) {
      const job = audioAnalysisQueue.shift()!
      try {
        await processAudioAnalysisJob(job)
      } catch (err) {
        console.warn(`[audio-analysis] job error for ${job.trackId}:`, err instanceof Error ? err.message : err)
      }
    }
  } finally {
    audioAnalysisRunning = false
  }
}

function enqueueAudioAnalysis(job: AudioAnalysisJob): void {
  // De-dupe: same trackId already pending? Skip.
  if (audioAnalysisQueue.some(j => j.trackId === job.trackId)) return
  audioAnalysisQueue.push(job)
  // Fire and forget — the worker re-checks queue length each iteration.
  void audioAnalysisWorker()
}

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

// User-preference settings (4.0 §6.7). Distinct from ui-state.json which
// tracks transient UI position (sidebar width, current view, etc.). This
// file holds preferences that persist across app upgrades and that the
// user explicitly sets via the Settings modal — currently just crossfade.
function appSettingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

ipcMain.handle('load-app-settings', async () => {
  try {
    const data = await readFile(appSettingsPath(), 'utf-8')
    return { ok: true, settings: JSON.parse(data) }
  } catch {
    return { ok: true, settings: null }   // missing file is fine — renderer applies defaults
  }
})

ipcMain.handle('save-app-settings', async (_e, settings: Record<string, unknown>) => {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(appSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// Async read used by handlers that need to gate behavior on a setting
// (musicman-speak, sync-to-ipod, import-track, etc.). Returns null on
// any failure; callers fall back to safe defaults.
async function readAppSettingsAsync(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(appSettingsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch { return null }
}

// Update the Claude daily ceiling immediately (mirrors what's saved in
// app-settings.json). The wrapper at top of file reads claudeStats so
// we update that in-memory and on disk.
ipcMain.handle('set-claude-daily-ceiling', async (_e, ceiling: number) => {
  await loadClaudeStats()
  const safe = Math.max(1, Math.min(10000, Number(ceiling) || 200))
  claudeStats.dailyCeiling = safe
  await saveClaudeStats()
  return { ok: true, dailyCeiling: safe }
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
      webSecurity: false,
      // Don't throttle the renderer when JakeTunes loses focus or the
      // window is hidden. Without this, Chromium's tab-throttling caps
      // JS execution at ~once/second when backgrounded, which crawls
      // the §2.4 audio-analysis backfill loop and any other long-running
      // sequential renderer work to a halt.
      backgroundThrottling: false,
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
  <div class="version">Version 4.0.0</div>
  <div class="author">by Jacob Rosenbaum</div>
  <div class="tagline">2008 visuals, 2026 brain</div>
</body>
</html>`)}`)
        },
      },
      { type: 'separator' },
      { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('open-preferences') },
      { type: 'separator' },
      { label: 'Quit JakeTunes', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
    ]
  },
  {
    label: 'File',
    submenu: [
      { label: 'New Playlist', accelerator: 'CmdOrCtrl+N' },
      { label: 'Import...', accelerator: 'CmdOrCtrl+O' },
      { label: 'Import and Convert...', accelerator: 'Shift+CmdOrCtrl+O', click: () => sendMenuAction('open-import-convert') },
      { type: 'separator' },
      { label: 'Get Info', accelerator: 'CmdOrCtrl+I', click: () => sendMenuAction('get-info') },
      { type: 'separator' },
      {
        label: 'Library',
        submenu: [
          // Re-encode high-bit-depth ALAC files that iPod Classic can't
          // decode (causes random track skips on hardware).
          { label: 'Fix iPod Compatibility…',  click: () => sendMenuAction('fix-ipod-compat') },
          // Surface library entries that share artist+title+album so the
          // user can pick which copies to remove. Per-row delete only —
          // never bulk, never auto. Solves the "iPod Shuffle shows 4542
          // but library has 4550" gap caused by re-imported tracks.
          { label: 'Show Duplicates…',         click: () => sendMenuAction('show-duplicates') },
          // (Removed: "Verify & Repair Library…" — the underlying tag
          // matcher had false-negative cases (e.g. file tag "Pt. 1" vs.
          // library "Part 1") that would land real tracks in the
          // unrepairable bucket and, with --delete-unrepairable on,
          // silently delete them. Restored from backup, then ripped the
          // UI out. iTunes never had this; sync should "just work."
          // The Python CLI is still in core/repair_mismatches.py for
          // any future controlled debug pass.)
        ],
      },
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
    const headers = { 'User-Agent': 'JakeTunes/4.0.0 (jacobrosenbaum@gmail.com)', 'Accept': 'application/json' }
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

// Wired up by the ipod-audio protocol handler inside app.whenReady().
// Call with a list of absolute source-file paths to kick off background
// ALAC -> AAC transcodes into the play cache, so first playback of a
// freshly-ripped lossless track doesn't stall on a 2-3s transcode.
let prewarmAlacCache: (paths: string[]) => Promise<void> = async () => { /* not wired yet */ }

// Register a known codec for a file we just wrote, so the play handler
// can skip the ~300ms ffprobe round-trip on first play. Known codecs
// bypass ffprobe entirely on the next access. Wired up alongside
// prewarmAlacCache when the audio protocol handler initialises.
let registerKnownCodec: (path: string, mtime: number, codec: string) => void = () => {}

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
    const tracks = library.tracks || []
    // Kick off background pre-warm of ALAC transcodes so first-play of
    // every lossless track is instant instead of waiting on a 1-3s
    // ffmpeg run. Non-blocking — returns immediately; transcodes queue
    // up in the ALAC cache one by one. Done here rather than on rip/
    // import because it also picks up files the user re-encoded via
    // Fix iPod Compatibility or reclaimed via the orphan tool.
    schedulePrewarmFromLibrary(tracks as Array<{ path?: string }>)
    return {
      tracks,
      playlists: library.playlists || [],
      noDataSource: tracks.length === 0,
    }
  } catch (err) {
    // The library.json file exists but failed to parse — almost always
    // because save-library was writing the file at the exact moment we
    // tried to read it. DO NOT fall through to the "seed from iPod"
    // path below: that path overwrites library.json with iTunesDB
    // content, which loses any renderer-side changes (deletes, edits,
    // imports) that were about to be saved. Instead, re-try the read
    // with a few 200ms backoff tries — by then save-library's atomic
    // rename has completed and the full file is available.
    const { stat: statFn } = await import('fs/promises')
    try {
      await statFn(LIBRARY_PATH)
      for (const delay of [200, 500, 1000]) {
        await new Promise(r => setTimeout(r, delay))
        try {
          const raw = await readFile(LIBRARY_PATH, 'utf-8')
          const library = JSON.parse(raw)
          const tracks = library.tracks || []
          return {
            tracks,
            playlists: library.playlists || [],
            noDataSource: tracks.length === 0,
          }
        } catch { /* still mid-write; retry */ }
      }
      // Still unreadable after retries. Surface the error instead of
      // destroying the library by overwriting with iPod data.
      console.error('load-tracks: library.json exists but parse kept failing — refusing iPod fallback to avoid data loss', err)
      return { tracks: [], playlists: [], noDataSource: true, error: 'library-parse-failed' }
    } catch {
      // library.json genuinely does not exist — first launch case,
      // safe to seed from iPod.
    }
  }

  // TRUE first launch (no library.json at all): read from iPod and save as local library
  try {
    const ipodData = await readIpodDatabase()
    await writeFile(LIBRARY_PATH, JSON.stringify(ipodData, null, 2))
    return { ...ipodData, noDataSource: false }
  } catch (err) {
    console.error('Failed to read iPod database:', err)
    return { tracks: [], playlists: [], noDataSource: true }
  }
})

// Best-effort background prewarm: given the library's track list,
// narrow down to tracks that (a) live in an mp4 container (the only
// ones that could be ALAC and need caching) AND (b) don't already
// have a fresh play-cache entry. ffprobe is only run on that narrowed
// set — avoids a 4000-file ffprobe sweep on every app launch that
// pegged the CPU and made the UI scroll glitchy for minutes.
//
// Called on every load-tracks AND after alac-compat-fix so any file
// the user just re-encoded becomes instant-play-ready without the
// blanket startup CPU hit.
async function schedulePrewarmFromLibrary(tracks: Array<{ path?: string }>): Promise<void> {
  const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const pathSep = IS_WINDOWS ? '\\' : '/'
  const PLAY_CACHE = join(app.getPath('userData'), 'play-cache')

  const candidates: string[] = []
  for (const t of tracks) {
    const colon = String(t?.path || '')
    if (!colon) continue
    const rel = colon.replace(/:/g, pathSep)
    const abs = join(LOCAL_MOUNT, rel)
    const lo = abs.toLowerCase()
    if (!(lo.endsWith('.m4a') || lo.endsWith('.alac') || lo.endsWith('.mp4'))) {
      continue
    }
    // Quick cache-freshness check without ffprobing — hash the path,
    // stat the cache file, compare mtime to source. If a fresh cache
    // entry already exists, we know this file was ALAC and has a valid
    // transcode waiting. Skip it. This is what drops the startup
    // workload from "ffprobe 4000 files" to "ffprobe the couple-dozen
    // files that were newly imported since last launch."
    try {
      const hash = createHash('sha1').update(abs).digest('hex').slice(0, 16)
      const cachePath = join(PLAY_CACHE, `${hash}.m4a`)
      const [srcStat, cacheStat] = await Promise.all([
        stat(abs).catch(() => null),
        stat(cachePath).catch(() => null),
      ])
      if (!srcStat) continue   // source missing — nothing to do
      if (cacheStat && cacheStat.mtimeMs >= srcStat.mtimeMs) continue   // already fresh
    } catch { /* fall through to prewarm */ }
    candidates.push(abs)
  }

  if (candidates.length === 0) {
    console.log('[prewarm] nothing to do — cache is fully warm')
    return
  }
  console.log(`[prewarm] scheduling ${candidates.length} files for background transcode`)
  // Defer so the renderer has already received tracks and the UI is
  // responsive before we start CPU-heavy ffprobe/ffmpeg work.
  setTimeout(() => {
    prewarmAlacCache(candidates).catch(err => console.warn('library prewarm failed:', err))
  }, 3000)
}

// Save the master library to disk.
//
// Guard against persisting an empty library on top of an existing one —
// that's how the renderer could otherwise wipe the canonical file when
// load-tracks happens to return []. If the caller really does want to
// write an empty library (e.g., factory-reset), they can pass force=true.
//
// Also stamps the file's mtime we wrote so the external-change watcher
// can tell "we wrote this" from "someone else wrote this".
let lastSelfWriteMtimeMs = 0

// Debounced iTunesDB rewrite trigger. Multiple rapid deletes should
// only result in ONE iTunesDB rebuild — costly operation that requires
// reading + re-writing the whole DB. 1.5s window catches a typical
// "select 10 songs and delete" interaction in a single rebuild.
let pendingDbRebuild: NodeJS.Timeout | null = null
let pendingDeletedPaths = new Set<string>()
function scheduleDbRebuild(deletedPaths: string[]) {
  for (const p of deletedPaths) pendingDeletedPaths.add(p)
  if (pendingDbRebuild) clearTimeout(pendingDbRebuild)
  pendingDbRebuild = setTimeout(async () => {
    pendingDbRebuild = null
    const removed = Array.from(pendingDeletedPaths)
    pendingDeletedPaths = new Set()
    if (!detectedIpodMount) return  // iPod not mounted — nothing to do

    // 4.0 Settings gate: skip the auto-delete-from-iPod when Jake hasn't
    // opted in. Tracks are still removed from library.json — just not
    // mirrored to the iPod automatically. They'll go on the next manual
    // sync. Default-off matches the user's "don't surprise me" expectation.
    const settings = await readAppSettingsAsync()
    const sync = settings?.sync as { autoRemoveDeletedFromIpod?: boolean } | undefined
    if (sync && sync.autoRemoveDeletedFromIpod === false) {
      return
    }
    try {
      const ipodMount = detectedIpodMount
      const { unlink: unlinkFS } = await import('fs/promises')
      // Delete the files from iPod first
      for (const colon of removed) {
        const rel = colon.replace(/:/g, IS_WINDOWS ? '\\' : '/')
        try {
          await unlinkFS(join(ipodMount, rel))
        } catch { /* file might already be gone */ }
      }
      // Re-read the current library and write a fresh iTunesDB so
      // the iPod's track count drops to match.
      const lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
      const ipodDb = join(ipodMount, 'iPod_Control', 'iTunes', 'iTunesDB')
      try { await copyFile(ipodDb, ipodDb + '.bak') } catch { /* non-fatal */ }
      const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/db_reader.py')
      await new Promise<void>((resolve, reject) => {
        const py = spawn(PYTHON_CMD, [scriptPath, '--write', ipodDb])
        py.on('error', reject)
        py.on('close', (code) => code === 0 ? resolve() : reject(new Error(`db_reader exit ${code}`)))
        py.stdin.write(JSON.stringify({ tracks: lib.tracks, playlists: lib.playlists || [] }))
        py.stdin.end()
      })
      console.log(`[delete-sync] removed ${removed.length} files from iPod, iTunesDB rebuilt`)
      mainWindow?.webContents.send('ipod-db-rebuilt', { removed: removed.length })
    } catch (err) {
      console.warn('[delete-sync] iPod cleanup after delete failed:', err)
    }
  }, 1500)
}

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

    // ── Detect deleted paths so we can clean up disk + iPod ──
    // Compare the previous library.json on disk to the new track list.
    // Any path that disappeared = a deletion to commit. This catches
    // every removal mechanism (right-click delete, playlist removal,
    // batch delete, Verify & Repair drop, etc.) without each call
    // site having to remember to push to the iPod.
    let deletedPaths: string[] = []
    try {
      const prevRaw = await readFile(LIBRARY_PATH, 'utf-8')
      const prev = JSON.parse(prevRaw) as { tracks?: Array<{ path?: string }> }
      const prevPaths = new Set((prev.tracks || []).map(t => t.path).filter(Boolean) as string[])
      const newPaths = new Set((tracks as Array<{ path?: string }>).map(t => t.path).filter(Boolean) as string[])
      for (const p of prevPaths) if (!newPaths.has(p)) deletedPaths.push(p)
    } catch { /* first save, no diff */ }

    // ── Atomic write: tmp file → rename ──
    // Without this, any other process reading library.json
    // simultaneously (e.g. the file-watcher-triggered reload, a
    // Python script, or this same app's load-tracks fallback) could
    // observe a half-written file, fail JSON.parse, and take the
    // "fallback to iPod DB" path in load-tracks — which OVERWRITES
    // library.json with iTunesDB content, losing any pending
    // renderer-side edits. A rename() is atomic at the filesystem
    // level: observers see either the old full file or the new full
    // file, never a mid-write slice.
    const library = { tracks, playlists: playlists || [] }
    const tmp = LIBRARY_PATH + '.partial.json'
    await writeFile(tmp, JSON.stringify(library, null, 2))
    const { rename: renameFS, unlink: unlinkFS } = await import('fs/promises')
    await renameFS(tmp, LIBRARY_PATH)
    try {
      const s = await stat(LIBRARY_PATH)
      lastSelfWriteMtimeMs = Math.round(s.mtimeMs)
    } catch { /* non-fatal */ }

    // Disk now reflects the current library — the session-level
    // fingerprint set existed only to bridge the gap between an
    // import succeeding and save-library flushing. Clear it so a
    // user-initiated delete + re-import of the same source file
    // doesn't get falsely flagged as a duplicate.
    sessionImportedFingerprints.clear()

    // ── Commit deletions ──
    // Delete the audio file from the local mirror immediately so the
    // disk doesn't grow ghost orphans. Schedule a debounced iTunesDB
    // rebuild to push the deletion to the iPod (if mounted) without
    // hammering it on every individual delete in a batch.
    if (deletedPaths.length > 0) {
      const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
      const pathSep = IS_WINDOWS ? '\\' : '/'
      for (const colon of deletedPaths) {
        const rel = colon.replace(/:/g, pathSep)
        try { await unlinkFS(join(LOCAL_MOUNT, rel)) } catch { /* file might already be gone */ }
      }
      scheduleDbRebuild(deletedPaths)
    }
    return { ok: true, deletedPaths: deletedPaths.length }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

// ── Watch library.json for EXTERNAL modifications ──
// If our Python maintenance scripts (repair_mismatches.py, etc.) or any
// other process edits library.json while the app is running, the app's
// in-memory state silently diverges from disk. The next save-library
// then writes the stale in-memory state back, wiping the external
// edits. That's how fixes kept "disappearing" earlier tonight.
//
// Solution: watch the file. When mtime changes AND it wasn't us who
// wrote it, tell the renderer to reload. The renderer calls load-tracks
// which reads the fresh disk state into memory.
import { watch as fsWatch } from 'fs'
let libraryWatcherStarted = false
function startLibraryWatcher() {
  if (libraryWatcherStarted) return
  libraryWatcherStarted = true
  try {
    fsWatch(LIBRARY_PATH, async () => {
      try {
        const s = await stat(LIBRARY_PATH)
        const mt = Math.round(s.mtimeMs)
        // Skip any fsWatch event that landed within a 2-second window
        // of our own save-library finishing. Atomic-rename writes can
        // fire watch events with slight mtime drift (up to hundreds of
        // ms on some filesystems), and the renderer's debounced save
        // loop can chain several saves inside a second — a too-tight
        // tolerance here caused a feedback loop where the save-reload-
        // save chain spawned cascading db_reader.py processes.
        if (Math.abs(mt - lastSelfWriteMtimeMs) < 2000) return
        console.log(`[watch] library.json changed externally (mtime ${mt}, self ${lastSelfWriteMtimeMs}) — asking renderer to reload`)
        mainWindow?.webContents.send('library-external-change')
      } catch { /* file briefly missing during atomic replace — ignore */ }
    })
    console.log('[watch] library.json watcher active')
  } catch (err) {
    console.warn('[watch] could not start library.json watcher:', err)
  }
}

// Sync: read iPod DB and return NEW tracks/playlists not already in the library
ipcMain.handle('sync-ipod', async (_e, existingIds: number[]) => {
  try {
    const ipodData = await readIpodDatabase()
    const knownIds = new Set(existingIds)
    const newTracks = ipodData.tracks.filter(t => !knownIds.has(t.id as number))
    // Backfill audioFingerprint for the incoming tracks so the
    // post-sync verifier on subsequent flows has something to compare
    // against. Only computes for files that exist; missing files are
    // left alone (the verifier will flag them on next sync if the user
    // actually wants those tracks).
    const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const mounts = [detectedIpodMount, LOCAL_MOUNT].filter((m): m is string => !!m)
    for (const t of newTracks) {
      if (typeof t.audioFingerprint === 'string' && t.audioFingerprint) continue
      const colon = String(t.path || '')
      if (!colon) continue
      const abs = await resolveTrackAbsPath(colon, mounts)
      if (!abs) continue
      const fp = await computeAudioFingerprint(abs, Number(t.duration || 0))
      if (fp) t.audioFingerprint = fp
    }
    return { ok: true, newTracks, playlists: ipodData.playlists, totalIpod: ipodData.tracks.length }
  } catch (err) {
    return { ok: false, error: String(err), newTracks: [], playlists: [], totalIpod: 0 }
  }
})

// Read the iPod's actual iTunesDB and return the full track + playlist
// set. This is what iTunes used to call "On This iPod" — it's what the
// device itself reports as present, independent of the app's local
// library.json. Handy for reconciling "library says X / iPod says Y"
// discrepancies.
ipcMain.handle('get-ipod-db-tracks', async () => {
  try {
    const ipodData = await readIpodDatabase()
    return { ok: true, tracks: ipodData.tracks, playlists: ipodData.playlists, total: ipodData.tracks.length }
  } catch (err) {
    return { ok: false, error: String(err), tracks: [], playlists: [], total: 0 }
  }
})

// ── Sync library TO iPod ──
//
// Content-safety invariant: this handler will REFUSE to commit the
// iTunesDB if any library entry's path points at audio whose embedded
// tags disagree with what the library claims the track is.
//
// That used to happen when filename-only smart-matching linked a
// library entry to the wrong file (e.g. a Beatles entry ended up
// playing Pink Floyd because both files had the same basename
// "imported_3713.m4a"). The smart-match step in this handler now
// tag-verifies, AND the preflight below verifies every remaining
// track's existing path too, so even a library.json that got
// corrupted by some OTHER flow can't write incorrect paths into the
// iPod database.
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

  // ──────────────── PRE-SYNC SAFETY: LIBRARY DEDUP CHECK ────────────────
  // If two library entries point at the same audio file (same colon
  // path), they're unambiguously duplicates: both will emit separate
  // mhit records into iTunesDB, which the iPod collapses in the
  // "songs" count but keeps as ghost rows. That's how you end up with
  // "library 4395 / iPod 4389" drift. Refuse to sync until the library
  // is clean and tell the user which entries collide so they can pick
  // one to delete in Get Info.
  {
    const pathCounts = new Map<string, number>()
    for (const t of tracks) {
      const p = String(t.path || '')
      if (!p) continue
      pathCounts.set(p, (pathCounts.get(p) || 0) + 1)
    }
    const dupes: Array<{ path: string; n: number; titles: string[] }> = []
    for (const [p, n] of pathCounts) {
      if (n > 1) {
        const titles = tracks
          .filter(t => t.path === p)
          .map(t => `"${t.title}" / ${t.artist}`)
        dupes.push({ path: p, n, titles })
      }
    }
    if (dupes.length > 0) {
      const sample = dupes.slice(0, 3).map(d => `  • ${d.path}\n    → ${d.titles.join(' + ')}`).join('\n')
      const msg = `Sync aborted: ${dupes.length} file${dupes.length === 1 ? '' : 's'} ${dupes.length === 1 ? 'has' : 'have'} multiple library entries pointing at ${dupes.length === 1 ? 'it' : 'them'}. Delete the duplicate library entries and sync again.\n\nExamples:\n${sample}${dupes.length > 3 ? `\n  …and ${dupes.length - 3} more` : ''}`
      console.error('sync-to-ipod: pre-sync dedup check failed:\n' + msg)
      return { ok: false, error: msg, copied: 0, duplicatePaths: dupes.length }
    }
  }

  // Copy audio files that don't exist on the iPod yet.
  //
  // Pass 1: figure out which tracks need copying (so we know the
  // denominator for progress reporting). Pass 2: copy and emit a
  // sync-progress event per file so the renderer can show a real bar
  // instead of a perpetually-indeterminate pulse.
  //
  // Smart-match before copying: library.json paths can drift (a track
  // whose path says F48/NTJL.m4a may already exist at F12/NTJL.m4a).
  // Without smart-match, sync blindly copies hundreds of already-
  // present files. But the old filename-only match was dangerous — it
  // would accept any file that shared a basename, so a re-imported
  // track at "imported_3767.m4a" got silently linked to a DIFFERENT
  // song that happened to own the same filename slot. That's how
  // Beatles tracks ended up playing Pink Floyd.
  //
  // New rule: we only accept a smart-match rewrite if the candidate
  // file's EMBEDDED TAGS (title + artist) actually agree with the
  // library entry's metadata. If tags disagree or are missing, we
  // fall back to copying the real file.
  let copied = 0
  let copyErrors = 0
  const pathSep = IS_WINDOWS ? '\\' : '/'
  const basenameToIpodPath = new Map<string, string>()
  try {
    const { readdir: rd } = await import('fs/promises')
    for (let i = 0; i < 50; i++) {
      const sub = join(IPOD_MOUNT, 'iPod_Control', 'Music', `F${String(i).padStart(2, '0')}`)
      const entries = await rd(sub).catch(() => [] as string[])
      for (const fn of entries) {
        if (!basenameToIpodPath.has(fn)) {
          basenameToIpodPath.set(fn, join(sub, fn))
        }
      }
    }
  } catch { /* best-effort */ }

  // ⚠️ TWIN: this is a JS port of core/repair_mismatches.py::normalize.
  // They MUST stay in lockstep. If you change this function (new rule,
  // new regex), update the Python twin in the SAME commit. We learned
  // this the hard way — fixed the Python side for "Pt. 1" vs "Part 1"
  // and forgot this one, so sync still aborted with a false-positive
  // mismatch banner on Pink Floyd. Don't repeat that.
  //
  // Special-case "Pt./Pt/Part" + (digit | roman) → "part <digit>" so
  // library "Another Brick in the Wall, Part 1" and file tags
  // "Another Brick In The Wall, Pt. 1" normalize to the same string.
  const ROMAN_NUMERALS: Record<string, number> = {
    i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  }
  const normalize = (s: unknown): string => {
    let str = String(s || '')
    str = str.replace(/^\s*\d{1,2}\s*[-._]\s*/, '')                   // "01 - Title" → "Title"
    str = str.replace(/\s*\b(feat(?:uring)?|ft)\b\.?[^)]*/ig, '')     // drop "feat. X"
    str = str.replace(/\bp(?:ar)?t\.?\s+([ivx]+|\d+)\b/gi, (m: string, suf: string) => {
      const k = suf.toLowerCase()
      if (/^\d+$/.test(k)) return `part ${k}`
      const n = ROMAN_NUMERALS[k]
      return n != null ? `part ${n}` : m
    })
    str = str.replace(/[()[\]{}"',.\-!?:;#/\\]+/g, ' ')                // strip punct
    return str.replace(/\s+/g, ' ').trim().toLowerCase()
  }

  // First pass: determine candidate rewrites. Anything that resolves
  // to a basename match on the iPod is a candidate — we'll verify tags
  // on the batch in one Python call below.
  type Candidate = {
    track: Record<string, unknown>
    colonPath: string
    ipodFile: string
    localFile: string
    baseName: string
    altIpodPath?: string    // candidate for smart-match rewrite
  }
  const candidates: Candidate[] = []
  for (const track of tracks) {
    const colonPath = String(track.path || '')
    if (!colonPath) continue
    const relPath = colonPath.replace(/:/g, pathSep)
    const ipodFile = join(IPOD_MOUNT, relPath)
    const localFile = join(LOCAL_MOUNT, relPath)
    const baseName = colonPath.split(':').pop() || ''

    // Does the iPod already have this file? If yes, only skip the
    // copy if the on-disk local file hasn't changed. We compare size —
    // a re-encode (like the 2-step ALAC fix) produces a file with a
    // different byte count, and we want THAT version to land on the
    // iPod instead of the stale one. Without this, sync would see the
    // iPod still has "something" at the path and refuse to overwrite,
    // so fixes made locally never reach the device.
    let exists = false
    let ipodSize = 0
    try {
      const s = await stat(ipodFile)
      exists = true
      ipodSize = s.size
    } catch { /* not at expected path */ }
    if (exists) {
      try {
        const ls = await stat(localFile)
        if (ls.size === ipodSize) {
          continue   // byte-identical, nothing to do
        }
        // Size differs → local was re-encoded/updated, queue a re-copy.
        // (We fall through to push this into toCopy below — the copy
        // step overwrites the iPod file when dest already exists.)
      } catch {
        // Local file missing but iPod has one — keep iPod's copy,
        // nothing we can do anyway.
        continue
      }
    }

    const altIpodPath = baseName ? basenameToIpodPath.get(baseName) : undefined
    candidates.push({
      track, colonPath, ipodFile, localFile, baseName,
      altIpodPath: altIpodPath && altIpodPath !== ipodFile ? altIpodPath : undefined,
    })
  }

  // Second pass: if we have any alt-path candidates, batch-verify
  // their embedded tags against the library metadata via tag_reader.
  const rewriteCandidatePaths = candidates.map(c => c.altIpodPath).filter((p): p is string => !!p)
  const tagsByPath = new Map<string, { title: string; artist: string; ok: boolean }>()
  if (rewriteCandidatePaths.length > 0) {
    try {
      const tagReaderScript = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/tag_reader.py')
      const read = await new Promise<string>((resolve, reject) => {
        const py = spawn(PYTHON_CMD, [tagReaderScript])
        let stdout = ''
        let stderr = ''
        py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
        py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        py.on('error', reject)
        py.on('close', (code: number) => {
          if (code === 0) resolve(stdout)
          else reject(new Error(`tag_reader exit ${code}: ${stderr}`))
        })
        py.stdin.write(JSON.stringify(rewriteCandidatePaths))
        py.stdin.end()
      })
      const arr = JSON.parse(read) as Array<{ path: string; title?: string; artist?: string; ok?: boolean }>
      for (const t of arr) {
        tagsByPath.set(t.path, { title: t.title || '', artist: t.artist || '', ok: !!t.ok })
      }
    } catch (err) {
      console.warn('sync-to-ipod: tag verification failed, will fall back to copy:', err)
      // tagsByPath stays empty → no smart-match rewrites will be accepted.
    }
  }

  const toCopy: Array<{ local: string; ipod: string; title: string }> = []
  const pathRewrites: Array<{ id: number; oldPath: string; newPath: string }> = []
  let rewritesVetoed = 0
  for (const c of candidates) {
    if (c.altIpodPath) {
      const t = tagsByPath.get(c.altIpodPath)
      const libTitle  = normalize(c.track.title)
      const libArtist = normalize(c.track.artist)
      const fileTitle  = t ? normalize(t.title)  : ''
      const fileArtist = t ? normalize(t.artist) : ''

      // Accept the rewrite only if the file's tags (or at least one of
      // them) actually identify this as the same song. This is the
      // permanent fix for the Beatles/Pink Floyd cross-linking bug.
      const titleOk  = libTitle  && fileTitle  && (libTitle  === fileTitle  || libTitle.includes(fileTitle)  || fileTitle.includes(libTitle))
      const artistOk = libArtist && fileArtist && (libArtist === fileArtist || libArtist.includes(fileArtist) || fileArtist.includes(libArtist))

      if (titleOk && artistOk) {
        const altRel = c.altIpodPath.slice(IPOD_MOUNT.length + 1)
        const altColonPath = ':' + altRel.split(pathSep).join(':')
        pathRewrites.push({
          id: c.track.id as number,
          oldPath: c.colonPath,
          newPath: altColonPath,
        })
        continue
      }
      // Tags didn't match — don't silently re-link. Copy the real file.
      rewritesVetoed += 1
    }

    toCopy.push({
      local: c.localFile,
      ipod: c.ipodFile,
      title: String(c.track.title || c.baseName),
    })
  }
  if (rewritesVetoed > 0) {
    console.log(`sync-to-ipod: vetoed ${rewritesVetoed} filename-only smart-matches (tags disagreed with library)`)
  }

  const totalToCopy = toCopy.length
  // Kick off the progress so the renderer can seed its bar even
  // when nothing needs copying (still-will-write-DB phase coming).
  mainWindow?.webContents.send('sync-progress', {
    phase: 'copy', current: 0, total: totalToCopy, title: '',
  })
  for (const { local, ipod, title } of toCopy) {
    try {
      const dir = ipod.substring(0, ipod.lastIndexOf(pathSep))
      await mkdir(dir, { recursive: true })
      await copyFile(local, ipod)
      copied++
    } catch (err) {
      console.error(`Copy failed: ${local} → ${ipod}:`, err)
      copyErrors++
    }
    mainWindow?.webContents.send('sync-progress', {
      phase: 'copy', current: copied + copyErrors, total: totalToCopy, title,
    })
  }
  mainWindow?.webContents.send('sync-progress', {
    phase: 'db', current: 0, total: 1, title: 'Writing iTunesDB...',
  })

  // Apply smart-match path rewrites to the in-flight tracks array so
  // the Python DB writer (which reads this JSON) gets the correct
  // (already-on-iPod) paths, not the stale ones from library.json.
  if (pathRewrites.length) {
    const rewriteMap = new Map(pathRewrites.map(r => [r.id, r.newPath]))
    for (const t of tracks) {
      const nv = rewriteMap.get(t.id as number)
      if (nv) t.path = nv
    }
    console.log(`sync-to-ipod: smart-match rewrote ${pathRewrites.length} track paths (saved that many redundant copies)`)
  }

  // ──────────────────────── PREFLIGHT CONTENT-SAFETY CHECK ────────────────────────
  // Belt-and-suspenders: before committing anything to iTunesDB, tag-
  // verify every track against the file its library path points at.
  // This catches the case where library.json itself got corrupted by
  // some other flow (an older bug, a restore, a crash mid-write), not
  // just the smart-match case we already verified above.
  //
  // Any mismatch aborts the sync with a list of the offending entries
  // so the user can resolve them in Get Info before retrying. (The
  // post-sync fingerprint verifier below is the silent self-heal path;
  // this preflight is the loud "we will not write a known-bad state to
  // your iPod" check.)
  try {
    const tagReaderScript = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/tag_reader.py')
    const preflightPaths: string[] = []
    const preflightOwners: Array<Record<string, unknown>> = []
    for (const t of tracks) {
      const colonPath = String(t.path || '')
      if (!colonPath) continue
      const relPath = colonPath.replace(/:/g, pathSep)
      const abs = join(IPOD_MOUNT, relPath)
      preflightPaths.push(abs)
      preflightOwners.push(t)
    }

    // Chunk the Python invocation so ~4,000-path payloads don't blow
    // the argv/stdin buffer.
    const CHUNK = 800
    const mismatches: Array<{ id: number; title: string; artist: string; fileTitle: string; fileArtist: string; path: string }> = []
    for (let i = 0; i < preflightPaths.length; i += CHUNK) {
      const batch = preflightPaths.slice(i, i + CHUNK)
      const tagsArr = await new Promise<Array<{ path: string; title?: string; artist?: string; ok?: boolean }>>((resolve, reject) => {
        const py = spawn(PYTHON_CMD, [tagReaderScript])
        let out = ''; let err = ''
        py.stdout.on('data', (d: Buffer) => { out += d.toString() })
        py.stderr.on('data', (d: Buffer) => { err += d.toString() })
        py.on('error', reject)
        py.on('close', (code) => { code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)) })
        py.stdin.write(JSON.stringify(batch))
        py.stdin.end()
      })
      for (let j = 0; j < batch.length; j++) {
        const track = preflightOwners[i + j]
        const file = tagsArr[j]
        if (!file || !file.ok) continue
        const ft = normalize(file.title)
        const fa = normalize(file.artist)
        const lt = normalize(track.title)
        const la = normalize(track.artist)
        // Only flag when the FILE has tags AND they disagree. Tagless
        // files stay allowed (can't assert either way; most of our iPod
        // content is tagless from the XML-rebuild era).
        if ((ft || fa) && lt) {
          const titleDisagrees  = ft && !(lt === ft || lt.includes(ft) || ft.includes(lt))
          const artistDisagrees = fa && la && !(la === fa || la.includes(fa) || fa.includes(la))
          // Two separate signals: title disagreement alone is enough
          // evidence (artist-only is noisy because of collabs and
          // compilation tagging).
          if (titleDisagrees) {
            // Identity-based escape hatch: if the track has a stored
            // audioFingerprint AND the file's current fingerprint
            // matches it, the file IS the right file by binary content.
            // Trust the fingerprint over noisy text comparison. This
            // catches harmless variations we can't pre-enumerate
            // (Pt./Part is the one that bit us; the next one will be
            // some smart-quote, title-case, or feat./with thing). We
            // only do this on flagged tracks, so the SHA cost is
            // negligible (typically 0-5 tracks per sync).
            const storedFp = typeof track.audioFingerprint === 'string' ? track.audioFingerprint : ''
            if (storedFp) {
              const absForFp = preflightPaths[i + j]
              const liveFp = await computeAudioFingerprint(absForFp, Number(track.duration || 0))
              if (liveFp && liveFp === storedFp) {
                // Same file we imported — text drift is cosmetic, not a path mix-up.
                void artistDisagrees // intentionally unused; identity wins
                continue
              }
            }
            mismatches.push({
              id: track.id as number,
              title: String(track.title || ''),
              artist: String(track.artist || ''),
              fileTitle: file.title || '',
              fileArtist: file.artist || '',
              path: String(track.path || ''),
            })
          }
        }
      }
    }

    if (mismatches.length > 0) {
      const sample = mismatches.slice(0, 5).map(m => `  • "${m.title}" / ${m.artist} → file is "${m.fileTitle}" / ${m.fileArtist}`).join('\n')
      const msg = `Sync aborted: ${mismatches.length} library entr${mismatches.length === 1 ? 'y points' : 'ies point'} at the wrong audio file.\n\nOpen each track's Get Info to fix the path, or delete the bad entry and re-import the source file. Then sync again.\n\nExamples:\n${sample}${mismatches.length > 5 ? `\n  …and ${mismatches.length - 5} more` : ''}`
      console.error('sync-to-ipod: content-safety preflight failed:\n' + msg)
      return { ok: false, error: msg, copied, copyErrors, mismatches: mismatches.length }
    }
    console.log(`sync-to-ipod: preflight OK, ${preflightPaths.length} tracks verified`)
  } catch (err) {
    console.warn('sync-to-ipod: preflight verification crashed; proceeding without it:', err)
    // Don't block sync on a tooling error — users rely on sync even when
    // Python subprocesses misbehave. The smart-match verifier above
    // already caught the common case.
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
  return await new Promise((resolve) => {
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

    py.on('close', async (code: number) => {
      console.log('sync-to-ipod stderr:', stderr)
      if (code === 0) {
        mainWindow?.webContents.send('sync-progress', {
          phase: 'db', current: 1, total: 1, title: 'iTunesDB written',
        })

        // ──────────── POST-SYNC FINGERPRINT VERIFIER ────────────
        // Quietly verify that the tracks whose paths just changed in
        // this sync still resolve to the audio they're supposed to,
        // and backfill audioFingerprint for any track that doesn't
        // have one yet. Identity-based check (sha1 of first 256KB +
        // duration), no text matching, never deletes — the only
        // outputs are: (a) backfill a fingerprint, (b) silently
        // rewrite a path if the right audio is found elsewhere on the
        // iPod, or (c) flag audioMissing for the UI. Restricted to
        // the tracks we just touched so it stays cheap (a typical
        // sync rewrites <100 paths and copies <100 files).
        const verifyIds = new Set<number>()
        for (const r of pathRewrites) verifyIds.add(r.id)
        // Find the IDs of newly-copied tracks too. We re-derive them
        // from the tracks array by colon path — toCopy didn't carry
        // ids. (toCopy items are in 1:1 order with the candidates
        // pushed earlier, but reconstructing that mapping is more
        // fragile than just scanning here.)
        const ipodColonsCopied = new Set(toCopy.map(c => {
          // ipod path back to colon form
          const rel = c.ipod.slice(IPOD_MOUNT.length + 1)
          return ':' + rel.split(pathSep).join(':')
        }))
        for (const t of tracks) {
          if (ipodColonsCopied.has(String(t.path || ''))) verifyIds.add(t.id as number)
        }
        let verificationUpdates: VerifyTrackUpdate[] = []
        if (verifyIds.size > 0) {
          const inputs: VerifyTrackInput[] = tracks
            .filter(t => verifyIds.has(t.id as number))
            .map(t => ({
              id: t.id as number,
              path: String(t.path || ''),
              duration: Number(t.duration || 0),
              audioFingerprint: typeof t.audioFingerprint === 'string' ? t.audioFingerprint : undefined,
            }))
          try {
            verificationUpdates = await verifyAndHealTracks(inputs, [IPOD_MOUNT, LOCAL_MOUNT])
            const healedPaths = verificationUpdates.filter(u => u.path).length
            const backfilled = verificationUpdates.filter(u => u.audioFingerprint).length
            const flagged = verificationUpdates.filter(u => u.audioMissing).length
            if (healedPaths || backfilled || flagged) {
              console.log(`sync-to-ipod: post-sync verifier — ${healedPaths} path heal${healedPaths === 1 ? '' : 's'}, ${backfilled} fingerprint backfill${backfilled === 1 ? '' : 's'}, ${flagged} flagged audioMissing`)
            }
          } catch (verr) {
            console.warn('sync-to-ipod: post-sync verifier crashed (non-fatal):', verr)
          }
        }

        resolve({
          ok: true,
          copied, copyErrors,
          totalTracks: tracks.length,
          // Return the path rewrites so the renderer can update
          // library.json to match what actually ended up on the iPod.
          pathRewrites: pathRewrites.map(r => ({ id: r.id, newPath: r.newPath })),
          // Fingerprint backfills, silent path heals, and audioMissing
          // flags from the post-sync verifier. Renderer applies these
          // as UPDATE_TRACKS so library.json reflects the verified
          // state on the next save.
          verificationUpdates,
        })
      } else {
        resolve({ ok: false, error: `DB write failed (code ${code}): ${stderr}`, copied, copyErrors })
      }
    })
    py.on('error', (err: Error) => {
      resolve({ ok: false, error: String(err), copied, copyErrors })
    })
  })
})

// ── iPod Classic ALAC compatibility fix ──
//
// (Removed: 'verify-library' / 'apply-library-repair' IPC handlers and
// the menu entry that fired them. The Python script in
// core/repair_mismatches.py classified files as "unrepairable" using a
// strict tag normalizer that didn't equate "Pt. 1" with "Part 1", and
// the apply handler was hard-coded to pass --delete-unrepairable, so a
// matcher false-negative meant real tracks got silently deleted from
// library.json. The audio files themselves were never touched — the
// timestamped library.json.bak-repair-* backup the script writes is
// always recoverable. iTunes/iPod never had a verify step; we shouldn't
// either. The CLI script stays on disk for future opt-in debugging.)
ipcMain.handle('alac-compat-scan', async () => {
  const script = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/alac_compat_fix.py')
  return await new Promise<{ ok: boolean; count?: number; samples?: unknown[]; error?: string }>((resolve) => {
    const py = spawn(PYTHON_CMD, [script])
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    py.on('error', (err) => resolve({ ok: false, error: String(err) }))
    py.on('close', async (code) => {
      if (code !== 0) { resolve({ ok: false, error: stderr }); return }
      try {
        const rJson = await readFile('/tmp/jaketunes-alac-compat-report.json', 'utf-8')
        const r = JSON.parse(rJson) as { incompatible: number; samples: unknown[] }
        resolve({ ok: true, count: r.incompatible, samples: r.samples })
      } catch {
        resolve({ ok: true, count: 0, samples: [] })
      }
    })
  })
})

ipcMain.handle('alac-compat-fix', async () => {
  const script = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/alac_compat_fix.py')
  return await new Promise<{ ok: boolean; error?: string; summary?: string }>((resolve) => {
    const py = spawn(PYTHON_CMD, [script, '--apply'])
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      // Stream progress to renderer so user can watch the bar fill. Each
      // Python line "[N/M] file … OK" counts as a step.
      const m = d.toString().match(/\[(\d+)\/(\d+)\]\s+(\S+)/)
      if (m) {
        mainWindow?.webContents.send('alac-compat-progress', {
          current: Number(m[1]), total: Number(m[2]), file: m[3],
        })
      }
    })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    py.on('error', (err) => resolve({ ok: false, error: String(err) }))
    py.on('close', async (code) => {
      if (code === 0) {
        // Freshly re-encoded ALAC files need their play-cache
        // transcodes regenerated (cache invalidation is by source
        // mtime, which just moved forward). Kick off prewarm so
        // first-play doesn't block on an on-demand transcode.
        try {
          const raw = await readFile(LIBRARY_PATH, 'utf-8')
          const lib = JSON.parse(raw) as { tracks?: Array<{ path?: string }> }
          schedulePrewarmFromLibrary(lib.tracks || [])
        } catch { /* non-fatal */ }
        resolve({ ok: true, summary: stdout.slice(-3000) })
      } else {
        resolve({ ok: false, error: stderr || `python exit ${code}` })
      }
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
  // Dedupe by absolute path so a drag that contains the same file twice
  // (e.g. user lassos overlapping selections) doesn't double-enqueue.
  const seen = new Set<string>()
  for (const p of paths) {
    try {
      const s = await statFS(p)
      if (s.isDirectory()) {
        const entries = await readdirFS(p, { withFileTypes: true })
        const childPaths = entries.map(e => join(p, e.name))
        const nested = await resolveAudioPaths(childPaths)
        for (const n of nested) {
          if (!seen.has(n)) { seen.add(n); results.push(n) }
        }
      } else {
        const ext = p.substring(p.lastIndexOf('.')).toLowerCase()
        if (AUDIO_EXTS.has(ext) && !seen.has(p)) {
          seen.add(p); results.push(p)
        }
      }
    } catch { /* skip inaccessible */ }
  }
  return results
}

// ── Per-file import primitive ──
// Pulled out of the batch loop so the renderer-side queue can call it
// for ONE file at a time. That keeps each IPC short, makes failures
// retryable per-item, and prevents one slow conversion from blocking
// the whole drop. The batch handler below now just walks the list and
// calls this for each entry.
const _normFingerprint = (s: unknown): string => String(s || '')
  .replace(/^\s*\d{1,2}\s*[-._]\s*/, '')
  .replace(/\s*\b(feat(?:uring)?|ft)\b\.?[^)]*/ig, '')
  .replace(/[()[\]{}"',.\-!?:;#/\\]+/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase()

// Why this set exists:
// `save-library` on the renderer side is debounced ~1s, so during a
// rapid multi-file drop every `import-track` call sees a stale
// library.json on disk that does NOT yet contain the track we just
// imported on the previous call. Without this set, dropping the same
// audio file twice (same drag, two drags, or a folder containing
// duplicates) sneaks both copies into the library — the user sees
// "the same song twice" and the playback queue auto-advances from
// one copy to the other, looking like the track is repeating itself.
// We seed loadDupeFingerprintsFromLibrary() with this set, add to it
// on every successful import, and clear it whenever save-library
// flushes to disk (after which the on-disk library.json is the
// truth and the in-memory set is no longer needed).
const sessionImportedFingerprints = new Set<string>()

function fingerprintTrack(t: { title?: unknown; artist?: unknown; duration?: unknown }): string | null {
  const title  = _normFingerprint(t.title)
  const artist = _normFingerprint(t.artist)
  const dur    = Math.round(Number(t.duration || 0) / 1000)
  if (!title || !artist || dur <= 0) return null
  return `${title}|${artist}|${dur}`
}

async function loadDupeFingerprintsFromLibrary(): Promise<Set<string>> {
  // Seed with the session set so back-to-back imports during a
  // single drop catch each other before save-library flushes.
  const set = new Set<string>(sessionImportedFingerprints)
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8')
    const libData = JSON.parse(raw) as { tracks?: Array<Record<string, unknown>> }
    for (const t of libData.tracks || []) {
      const fp = fingerprintTrack({ title: t.title, artist: t.artist, duration: t.duration })
      if (fp) set.add(fp)
    }
  } catch { /* new library, no dupes possible */ }
  return set
}

// ── Audio content fingerprint ──
//
// Identity-based replacement for the old text-matching verify pass. We
// hash the first 256KB of the audio file plus the duration. That window
// covers all audio container metadata atoms and well into the actual
// audio stream, so two different songs cannot collide. Stored once per
// track at import time as `audioFingerprint`. Re-computed on demand
// during the silent post-sync verifier.
//
// Format: "sha1:<hex16>|<duration_ms>". Duration is included so a
// re-encode that produced byte-different but-same-song output (very
// rare in practice) still has a chance of matching by partial.
async function computeAudioFingerprint(absPath: string, durationMs: number): Promise<string | null> {
  try {
    const fh = await open(absPath, 'r')
    try {
      const buf = Buffer.alloc(256 * 1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      if (bytesRead <= 0) return null
      const hash = createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex').slice(0, 16)
      return `sha1:${hash}|${Math.round(Number(durationMs) || 0)}`
    } finally {
      await fh.close().catch(() => {})
    }
  } catch {
    return null
  }
}

// Best-effort: turn a track's colon-style library path into an absolute
// path under either the local mount or the iPod mount. Returns the
// first one that exists, or null. Sync flows use this when we don't
// know which mount the file lives on at verify time.
async function resolveTrackAbsPath(colonPath: string, mounts: string[]): Promise<string | null> {
  const pathSep = IS_WINDOWS ? '\\' : '/'
  if (!colonPath) return null
  const rel = colonPath.replace(/:/g, pathSep)
  for (const mount of mounts) {
    if (!mount) continue
    const abs = join(mount, rel)
    try {
      const s = await stat(abs)
      if (s.isFile()) return abs
    } catch { /* try next mount */ }
  }
  return null
}

interface VerifyTrackInput {
  id: number
  path: string
  duration: number
  audioFingerprint?: string
}
interface VerifyTrackUpdate {
  id: number
  audioFingerprint?: string
  path?: string
  audioMissing?: boolean
}

// Silent post-sync verifier. For each input track:
//   1. Resolve current path against {local, iPod} mounts.
//   2. If the file exists and has no stored fingerprint, compute one
//      and emit a backfill update. (Never overwrites an existing
//      fingerprint — that would mask a real wrong-file case.)
//   3. If the file exists AND a fingerprint is stored AND they differ,
//      scan the available F-dirs looking for a file whose fingerprint
//      matches the stored one. If found, rewrite the track's path
//      silently. If not found, mark audioMissing.
//   4. If the file doesn't exist, do the same F-dir scan with the
//      stored fingerprint. Same outcome — re-link if found, mark
//      audioMissing if not.
//
// NEVER deletes a track. NEVER updates the stored fingerprint when a
// mismatch is detected (only on initial backfill). The worst this can
// do is mark a track as audioMissing, which is a UI flag the user can
// resolve by re-importing or pointing at a new file.
async function verifyAndHealTracks(
  inputs: VerifyTrackInput[],
  mounts: string[],
): Promise<VerifyTrackUpdate[]> {
  if (inputs.length === 0) return []
  const updates: VerifyTrackUpdate[] = []

  // Lazy-build a fingerprint index across the F-dirs of each mount.
  // Only computed on first miss so a clean sync (everything matches)
  // costs nothing extra. Indexes file → fingerprint (we look up the
  // other direction by filtering).
  let indexBuilt = false
  const fpToPath = new Map<string, string>()  // fingerprint → first abs path
  const buildIndex = async () => {
    if (indexBuilt) return
    indexBuilt = true
    const { readdir: rd } = await import('fs/promises')
    for (const mount of mounts) {
      if (!mount) continue
      for (let i = 0; i < 50; i++) {
        const sub = join(mount, 'iPod_Control', 'Music', `F${String(i).padStart(2, '0')}`)
        let entries: string[] = []
        try { entries = await rd(sub) } catch { continue }
        for (const fn of entries) {
          const abs = join(sub, fn)
          // We don't know the file's duration without parsing tags,
          // which is expensive. Use 0 for the duration component;
          // verify lookups below match by fingerprint *string* with the
          // correct duration on each side, so an index entry built with
          // duration=0 is keyed differently from a stored fingerprint.
          // We accept that and instead store hash-only keys for the
          // index, then compare the hash portion separately.
          // Compute the file fingerprint with duration=0 to get a stable hash key.
          const hashOnly = await computeAudioFingerprint(abs, 0)
          if (hashOnly) {
            // Strip the "|0" duration suffix to leave just "sha1:<hex>".
            const key = hashOnly.split('|')[0]
            if (!fpToPath.has(key)) fpToPath.set(key, abs)
          }
        }
      }
    }
  }

  // Convert "sha1:<hex>|<dur>" → "sha1:<hex>" so we can lookup against
  // the hash-only index above.
  const hashKey = (fp: string | undefined): string | null => {
    if (!fp || !fp.startsWith('sha1:')) return null
    return fp.split('|')[0]
  }

  // Convert an absolute path on either mount back into the colon form
  // the library uses. Returns null if abs is not under any mount.
  const colonFromAbs = (abs: string): string | null => {
    const pathSep = IS_WINDOWS ? '\\' : '/'
    for (const mount of mounts) {
      if (!mount) continue
      if (abs.startsWith(mount + pathSep)) {
        return ':' + abs.slice(mount.length + 1).split(pathSep).join(':')
      }
    }
    return null
  }

  for (const tr of inputs) {
    const absNow = await resolveTrackAbsPath(tr.path, mounts)
    if (absNow) {
      // File exists at expected path. Backfill fingerprint if missing.
      // (One-time per track; after that the field is permanent and only
      // updated by an explicit re-import.)
      if (!tr.audioFingerprint) {
        const fp = await computeAudioFingerprint(absNow, tr.duration)
        if (fp) updates.push({ id: tr.id, audioFingerprint: fp, audioMissing: false })
        continue
      }
      // Stored fingerprint present — verify against the current file.
      const cur = await computeAudioFingerprint(absNow, tr.duration)
      if (cur && cur === tr.audioFingerprint) {
        // Healthy. Nothing to do.
        continue
      }
      // Stored fingerprint differs from the current file. Two cases:
      //   (a) The file at this path was overwritten by a re-encode
      //       (ALAC compat fix, etc.) — file is fine, fingerprint is
      //       stale. We can't tell this case apart from (b) without
      //       text matching, which is what we deliberately moved away
      //       from. So we don't touch path or fingerprint here. The
      //       stale fingerprint will get refreshed if the user
      //       re-imports the track.
      //   (b) The path got cross-linked to a different song — this is
      //       the actual bug we want to catch. We DO try to find the
      //       right audio elsewhere on the mounts via the fingerprint
      //       index. If found, re-link silently. If not found, leave
      //       the track alone (do NOT flag audioMissing — the file
      //       exists, the user can still play SOMETHING, even if it's
      //       wrong; and we want to avoid false positives on case
      //       (a)).
      await buildIndex()
      const target = hashKey(tr.audioFingerprint)
      const found = target ? fpToPath.get(target) : null
      if (found) {
        const newColon = colonFromAbs(found)
        if (newColon && newColon !== tr.path) {
          updates.push({ id: tr.id, path: newColon, audioMissing: false })
          continue
        }
      }
      // Mismatch with no recovery possible; leave the track untouched.
      continue
    }
    // File missing entirely (path resolved to nothing on any mount).
    // Try the heal-by-fingerprint scan. If we find it, re-link. If
    // not, flag audioMissing so the UI can show the user.
    if (tr.audioFingerprint) {
      await buildIndex()
      const target = hashKey(tr.audioFingerprint)
      const found = target ? fpToPath.get(target) : null
      if (found) {
        const newColon = colonFromAbs(found)
        if (newColon) {
          updates.push({ id: tr.id, path: newColon, audioMissing: false })
          continue
        }
      }
    }
    updates.push({ id: tr.id, audioMissing: true })
  }
  return updates
}

interface SingleImportResult {
  ok: boolean
  track?: Record<string, unknown>
  dupe?: { src: string; matchedTitle: string; matchedArtist: string }
  error?: string
}

/**
 * Returns the lowest `imported_NNNN` slot ≥ `startId` whose file path
 * is free in MUSIC_DIR (no file exists at any common audio extension).
 *
 * Why this exists — the 78-collision bug (Apr 26 postmortem):
 * The renderer-side counter (importQueue.ts + App.tsx useEffect) seeds
 * itself from `max(library.id)`. But library entries that came in via
 * the "Import N to Library" drift-banner button can have paths whose
 * `imported_NNNN` > `library.id`, because the iPod's iTunesDB stores
 * track id and file path independently — id was assigned by the
 * library at original import, path was generated by JakeTunes when
 * the track first synced to the iPod, and the two epochs can drift.
 * Without this guard, the next fresh drag-drop import gets a
 * library-id whose path slot is already occupied — the file gets
 * silently overwritten and the library ends up with two entries
 * pointing at the same path. The new sync preflight catches it (good)
 * but only after the local file has already been overwritten (bad).
 *
 * ⚠️ TWIN: same defensive scan-then-loop pattern used by
 * `rip-cd-tracks` ipcMain.handle below (it predates this helper and
 * had the fix locally; we extracted it here so `import-track` and
 * the CD ripper share one source of truth).
 */
async function findFreeImportedId(startId: number): Promise<number> {
  const exts = ['.m4a', '.mp3', '.aac', '.flac', '.alac', '.wav', '.aif', '.aiff']
  let id = startId
  while (true) {
    const subDir = join(MUSIC_DIR, `F${String(id % 50).padStart(2, '0')}`)
    let collide = false
    for (const e of exts) {
      const exists = await stat(join(subDir, `imported_${id}${e}`)).then(() => true).catch(() => false)
      if (exists) { collide = true; break }
    }
    if (!collide) return id
    id++
  }
}

async function importOneFile(
  srcPath: string,
  id: number,
  chosenFmt: AudioFormat,
  preferredFormat: string | undefined,
  dupeFingerprints: Set<string>,
  dateOverride?: Date,
): Promise<SingleImportResult> {
  const ext = srcPath.substring(srcPath.lastIndexOf('.')).toLowerCase()
  try {
    const mm = await import('music-metadata')
    const metadata = await mm.parseFile(srcPath)
    const common = metadata.common
    const format = metadata.format

    const ft = _normFingerprint(common.title)
    const fa = _normFingerprint(common.artist)
    const fd = Math.round(Number(format.duration || 0))
    if (ft && fa && fd > 0 && dupeFingerprints.has(`${ft}|${fa}|${fd}`)) {
      return {
        ok: true,
        dupe: {
          src: srcPath,
          matchedTitle: String(common.title || ''),
          matchedArtist: String(common.artist || ''),
        },
      }
    }

    // Path-collision guard: the renderer counter may have given us an id
    // whose `imported_${id}.<ext>` slot is already on disk (Apr 26 78-
    // collision bug — see findFreeImportedId comment). Bump past it
    // before computing the destination so we never overwrite a file
    // that another library entry is pointing at. The returned track's
    // `id` will reflect the bumped value; the renderer queue advances
    // its counter accordingly.
    const requestedId = id
    id = await findFreeImportedId(id)
    if (id !== requestedId) {
      console.warn(`import-track: id ${requestedId} collides with existing file imported_${requestedId}.*; bumped to ${id}`)
    }

    const subDir = `F${String(id % 50).padStart(2, '0')}`
    const destDir = join(MUSIC_DIR, subDir)
    await mkdir(destDir, { recursive: true })

    const codec = format.codec?.toLowerCase() || ''
    const needsConvert = codec.includes('alac') || codec.includes('flac') ||
      ext === '.flac' || ext === '.wav' || ext === '.wave' || ext === '.aiff' || ext === '.aif'

    let finalExt = ext
    let fileName: string
    let destPath: string

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

    const sourcePlayable = ext === '.m4a' || ext === '.mp3' || ext === '.aac'
    const userRequestedReencode = preferredFormat != null && preferredFormat !== 'aac-256'
    const doConvert = needsConvert || userRequestedReencode || !sourcePlayable

    if (doConvert) {
      finalExt = extensionForFormat(chosenFmt)
      fileName = `imported_${id}${finalExt}`
      destPath = join(destDir, fileName)
      try {
        await convertAudio(srcPath, destPath, chosenFmt, embedTags)
      } catch (convertErr) {
        console.error(`Conversion failed for ${srcPath}, copying original:`, convertErr)
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
    const trackTime = dateOverride || new Date()
    const durationMs = Math.round((format.duration || 0) * 1000)

    // Stable per-file identity. Stored at import and used by the silent
    // post-sync verifier to detect cross-linked paths without resorting
    // to fragile text matching. See computeAudioFingerprint for the
    // format and verifyAndHealTracks for how it's consumed.
    const audioFingerprint = await computeAudioFingerprint(destPath, durationMs)

    const track: Record<string, unknown> = {
      id,
      title: common.title || srcPath.substring(srcPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
      artist: common.artist || '',
      album: common.album || '',
      genre: common.genre?.[0] || '',
      year: common.year || '',
      duration: durationMs,
      path: `:iPod_Control:Music:${subDir}:${fileName}`,
      trackNumber: common.track?.no || 0,
      trackCount: common.track?.of || 0,
      discNumber: common.disk?.no || 0,
      discCount: common.disk?.of || 0,
      playCount: 0,
      dateAdded: trackTime.toISOString(),
      fileSize: fileStats.size,
      rating: 0,
      ...(audioFingerprint ? { audioFingerprint } : {}),
    }

    // Add this fingerprint to the set so a duplicate appearing later in
    // the same batch (or a back-to-back drop) gets caught even before
    // library.json is rewritten on disk.
    if (ft && fa && fd > 0) {
      dupeFingerprints.add(`${ft}|${fa}|${fd}`)
    }

    return { ok: true, track }
  } catch (err) {
    console.error(`Failed to import ${srcPath}:`, err)
    return { ok: false, error: String(err) }
  }
}

// Single-file IPC for the renderer-side import queue. The queue calls
// this once per item, in series, with retry on failure. Folders are
// resolved before enqueuing in the renderer so this only ever sees
// individual audio files.
ipcMain.handle('import-track', async (_e, srcPath: string, id: number, preferredFormat?: string) => {
  const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
  // 4.0 Settings: when caller doesn't specify a format, fall back to the
  // user's preferred default from app-settings.json (Library tab).
  let resolvedFormat = preferredFormat
  if (!validFormats.includes(resolvedFormat as AudioFormat)) {
    const settings = await readAppSettingsAsync()
    const lib = settings?.library as { defaultImportFormat?: string } | undefined
    if (lib && validFormats.includes(lib.defaultImportFormat as AudioFormat)) {
      resolvedFormat = lib.defaultImportFormat
    }
  }
  const chosenFmt: AudioFormat = validFormats.includes(resolvedFormat as AudioFormat)
    ? (resolvedFormat as AudioFormat)
    : 'aac-256'
  const dupeFingerprints = await loadDupeFingerprintsFromLibrary()
  const r = await importOneFile(srcPath, id, chosenFmt, preferredFormat, dupeFingerprints)

  // Record this import's fingerprint at the session level so the
  // NEXT import-track call (which may fire before save-library has
  // had a chance to flush) sees this track as already present and
  // refuses to import it a second time. Pass duration in
  // milliseconds — fingerprintTrack normalises to seconds itself.
  if (r.ok && r.track) {
    const fp = fingerprintTrack({
      title: r.track.title,
      artist: r.track.artist,
      duration: r.track.duration,
    })
    if (fp) sessionImportedFingerprints.add(fp)
  }

  // If we just wrote an ALAC file to local storage, kick off its
  // play-cache transcode in the background so first-play is instant.
  // (No-op for AAC/MP3 — those play directly from the m4a/mp3 file.)
  if (r.ok && r.track && chosenFmt === 'alac') {
    const colon = String(r.track.path || '')
    if (colon) {
      const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
      const pathSep = IS_WINDOWS ? '\\' : '/'
      const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
      prewarmAlacCache([abs]).catch(() => {})
    }
  }

  // Enqueue background audio analysis (4.0 §2.4a). Non-blocking — the
  // import response is sent before analysis starts. Failures don't fail
  // the import; the worker logs and writes the audioAnalysisAt sentinel
  // so we don't retry every session.
  if (r.ok && r.track) {
    const t = r.track
    const colon = String(t.path || '')
    const trackId = Number(t.id) || 0
    if (colon && trackId > 0) {
      const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
      const pathSep = IS_WINDOWS ? '\\' : '/'
      const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
      const title = String(t.title || '').toLowerCase().trim()
      const artist = String(t.artist || '').toLowerCase().trim()
      const duration = Number(t.duration) || 0
      const fp = `${title}|${artist}|${duration}`
      enqueueAudioAnalysis({ trackId, path: abs, fingerprint: fp })
    }
  }

  return r
})

// One-shot audio analysis for a single track. Used by §2.4b's backfill
// scan UI (renderer drives the loop) and for any future on-demand
// re-analysis. Does NOT enqueue — runs the script inline and persists.
// For new imports, prefer the enqueue path which de-dupes and serializes.
//
// Takes the track's colon-format path (the on-disk format used in
// library.json); main resolves to an absolute path because renderer
// doesn't know LOCAL_MOUNT.
ipcMain.handle('analyze-track', async (_e, trackId: number, colonPath: string, fingerprint: string) => {
  const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const pathSep = IS_WINDOWS ? '\\' : '/'
  const absPath = join(LOCAL_MOUNT, colonPath.replace(/:/g, pathSep))
  const result = await runAudioAnalysisScript(absPath)
  const fields: Record<string, string> = {
    audioAnalysisAt: String(Date.now()),
  }
  if (result.ok) {
    if (typeof result.bpm === 'number' && result.bpm > 0) fields.bpm = String(result.bpm)
    if (result.keyRoot) fields.keyRoot = result.keyRoot
    if (result.keyMode) fields.keyMode = result.keyMode
    if (result.camelotKey) fields.camelotKey = result.camelotKey
  }
  try {
    await persistOverrideFields(trackId, fields, fingerprint)
  } catch (err) {
    return { ok: false, error: `persist failed: ${err instanceof Error ? err.message : err}` }
  }
  return result
})

// Resolve folders + filter to audio extensions for the renderer queue.
// Splits a single drop into its constituent files so the queue can show
// progress per-file rather than per-folder.
ipcMain.handle('import-resolve-paths', async (_e, paths: string[]) => {
  try {
    const resolved = await resolveAudioPaths(paths)
    return { ok: true, paths: resolved }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('import-tracks', async (_e, filePaths: string[], nextId: number, preferredFormat?: string) => {
  // Resolve folders into individual audio files
  const resolvedPaths = await resolveAudioPaths(filePaths)
  const imported: Array<Record<string, unknown>> = []
  const skippedDupes: Array<{ src: string; matchedTitle: string; matchedArtist: string }> = []
  let id = nextId

  const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
  // 4.0 Settings: when caller doesn't specify a format, fall back to the
  // user's preferred default from app-settings.json.
  let resolvedFormat = preferredFormat
  if (!validFormats.includes(resolvedFormat as AudioFormat)) {
    const settings = await readAppSettingsAsync()
    const lib = settings?.library as { defaultImportFormat?: string } | undefined
    if (lib && validFormats.includes(lib.defaultImportFormat as AudioFormat)) {
      resolvedFormat = lib.defaultImportFormat
    }
  }
  const chosenFmt: AudioFormat = validFormats.includes(resolvedFormat as AudioFormat)
    ? (resolvedFormat as AudioFormat)
    : 'aac-256'

  const dupeFingerprints = await loadDupeFingerprintsFromLibrary()

  // Initial progress event so the pill lights up immediately
  mainWindow?.webContents.send('import-progress', {
    current: 0, total: resolvedPaths.length, title: '',
  })

  const batchBaseTime = Date.now()
  let trackIndex = 0

  for (const srcPath of resolvedPaths) {
    const trackTime = new Date(batchBaseTime + trackIndex)
    const r = await importOneFile(srcPath, id, chosenFmt, preferredFormat, dupeFingerprints, trackTime)
    if (r.ok && r.track) {
      imported.push(r.track)
      // Track in session set — guards future single-file imports from
      // racing this batch (and matches what import-track does).
      // duration is in ms; fingerprintTrack divides to seconds itself.
      const fp = fingerprintTrack({
        title: r.track.title,
        artist: r.track.artist,
        duration: r.track.duration,
      })
      if (fp) sessionImportedFingerprints.add(fp)

      // Enqueue audio analysis (4.0 §2.4a). Mirrors import-track's
      // enqueue. Single-threaded worker means a 100-file batch trickles
      // through one analysis at a time without pinning the user's CPU.
      const t = r.track
      const colon = String(t.path || '')
      const trackId = Number(t.id) || 0
      if (colon && trackId > 0) {
        const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
        const pathSep = IS_WINDOWS ? '\\' : '/'
        const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
        const title = String(t.title || '').toLowerCase().trim()
        const artist = String(t.artist || '').toLowerCase().trim()
        const duration = Number(t.duration) || 0
        const analysisFp = `${title}|${artist}|${duration}`
        enqueueAudioAnalysis({ trackId, path: abs, fingerprint: analysisFp })
      }

      id++
      trackIndex++
      mainWindow?.webContents.send('import-progress', {
        current: imported.length,
        total: resolvedPaths.length,
        title: r.track.title as string,
      })
    } else if (r.ok && r.dupe) {
      skippedDupes.push(r.dupe)
      trackIndex++
      mainWindow?.webContents.send('import-progress', {
        current: trackIndex, total: resolvedPaths.length,
        title: `Skipped (already in library): ${r.dupe.matchedTitle}`,
      })
    } else {
      mainWindow?.webContents.send('import-progress', {
        current: imported.length,
        total: resolvedPaths.length,
        title: srcPath.substring(srcPath.lastIndexOf('/') + 1),
        error: r.error,
      })
    }
  }

  return { ok: true, tracks: imported, skippedDupes }
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
    // 4.0 Settings gate: Music Man voice can be turned off entirely from
    // Preferences → AI. Caller still gets ok=true so flow continues; the
    // empty audio just makes the renderer skip playback.
    const settings = await readAppSettingsAsync()
    const ai = (settings?.ai as { musicManVoiceEnabled?: boolean } | undefined)
    if (ai && ai.musicManVoiceEnabled === false) {
      return { ok: true, audio: '' }
    }
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
  const djInstructions = `${nextTrack ? "You're DJing between songs on the listener's playlist." : 'The listener is currently playing a song.'} Give a brief, punchy DJ-style comment. This will be SPOKEN ALOUD, so keep it to 2-3 sentences max.

Be unpredictable — sometimes drop a verified fun fact, sometimes your arrogant opinion, sometimes a memory of seeing them live, sometimes a roast of the listener's taste, sometimes praise an underrated aspect. Keep it conversational and natural — you're talking between songs like a real DJ.

If background info from MusicBrainz or Wikipedia is provided below, USE IT for any facts. If no background info and you're not confident, go with a take on the sound/genre rather than making up a story.`

  const djPrompt = buildMusicManPrompt(djInstructions)

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
    const response = await claudeCall('musicman-dj', {
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: djPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    if (text) noteMusicManUtterance('dj', text)
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

  const djSetInstructions = `You're running a DJ set from inside the listener's library — late-night college radio energy, spoken aloud via TTS. Pick 6-10 songs that hang together. Each set should have a loose theme — a vibe, a genre deep-dive, an era, a mood, or a connection between artists. Think FLOW and order.

Return ONLY a JSON object (no markdown, no code fences):
{"intro":"Your spoken DJ intro — 2-4 sentences, conversational, introducing the vibe. This will be read aloud via TTS so make it sound natural and spoken, not written. No emojis. Address the listener casually.","trackIds":[array of track ID numbers in play order],"theme":"short theme label like 'Late Night Indie' or '90s Deep Cuts'"}

Rules:
- ONLY use track IDs from the provided library
- Do NOT pick any recently played tracks${recentStr ? ' (see list below)' : ''}
- Mix up artists — no more than 2 songs by the same artist per set
- Order matters — build a journey
- Keep the intro SHORT — you're a DJ, not writing an essay${recentStr}`

  const systemPrompt = buildMusicManPrompt(djSetInstructions)

  try {
    const response = await claudeCall('musicman-dj-set', {
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Pick songs for your next DJ set.\n\nLibrary (ID|Title|Artist|Album|Genre|Year):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.intro) noteMusicManUtterance('dj-set', parsed.intro)
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

  // Top artists by plays. Cap at 10 so the #1 slot doesn't dominate
  // everything the model sees.
  const topArtists = Object.entries(p.artistPlays).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const topArtistSet = new Set(topArtists.map(([a]) => a))
  if (topArtists.length > 0) {
    lines.push(`Most played artists: ${topArtists.map(([a, n]) => `${a} (${n})`).join(', ')}`)
  }

  // Most skipped artists (taste signal — they have these artists but skip them)
  const skippedArtists = Object.entries(p.artistSkips).sort((a, b) => b[1] - a[1]).slice(0, 10).filter(([, n]) => n >= 2)
  if (skippedArtists.length > 0) {
    lines.push(`Frequently skipped artists: ${skippedArtists.map(([a, n]) => `${a} (${n} skips)`).join(', ')}`)
  }

  // Top albums — dedup to one-per-artist so a single obsession doesn't
  // take over multiple slots (e.g. James Brown appearing as top artist
  // AND three of their albums being in the top-albums list).
  const seenArtist = new Set<string>()
  const topAlbumsUnique: Array<[string, number]> = []
  for (const [album, n] of Object.entries(p.albumPlays).sort((a, b) => b[1] - a[1])) {
    const parts = album.split(' — ')
    const artist = parts[0] || ''
    if (seenArtist.has(artist)) continue
    seenArtist.add(artist)
    topAlbumsUnique.push([album, n])
    if (topAlbumsUnique.length >= 10) break
  }
  if (topAlbumsUnique.length > 0) {
    lines.push(`Most played albums (one per artist): ${topAlbumsUnique.map(([a, n]) => `${a} (${n})`).join(', ')}`)
  }

  // Genre breakdown
  const topGenres = Object.entries(p.genrePlays).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (topGenres.length > 0) {
    lines.push(`Genre breakdown: ${topGenres.map(([g, n]) => `${g} (${n})`).join(', ')}`)
  }

  // Highly rated tracks — exclude artists already in top-played so the
  // profile surfaces variety rather than doubling up on favorites.
  const raredFiltered = p.topRated.filter(t => !topArtistSet.has(t.artist))
  if (raredFiltered.length > 0) {
    const faves = raredFiltered.slice(0, 8).map(t => `"${t.title}" by ${t.artist} (${t.rating}★)`).join(', ')
    lines.push(`Also-liked (rated highly, outside top-played): ${faves}`)
  }

  // Recent listening — dedup to unique artists so a James-Brown-for-an-hour
  // session doesn't make recent-plays look like "only this one artist".
  if (p.recentPlays.length > 0) {
    const seenRecent = new Set<string>()
    const recentUnique: typeof p.recentPlays = []
    for (const t of p.recentPlays) {
      if (seenRecent.has(t.artist)) continue
      seenRecent.add(t.artist)
      recentUnique.push(t)
      if (recentUnique.length >= 8) break
    }
    const recent = recentUnique.map(t => `"${t.title}" by ${t.artist}`).join(', ')
    lines.push(`Recent plays (unique artists): ${recent}`)
  }

  // Music Man's own accumulated observations — used to be "include all
  // 15 every call", which meant one artist getting mentioned in 4
  // observations would hammer that artist into every response.
  // Take only the 3 most recent AND downweight any observation that
  // repeats an artist already dominating the top-played list.
  if (p.observations.length > 0) {
    const recent = p.observations.slice(-3)
    lines.push(`Your last few observations about this listener (background, NOT talking points): ${recent.join(' | ')}`)
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
    const response = await claudeCall('listener-obs', {
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

// ─── Shared Music Man persona + cross-handler memory ───
//
// Every Music Man endpoint (chat, DJ commentary, playlist gen,
// recommendations, etc.) used to carry its own inline copy of the
// persona and fixed opinions. Each call was a separate API request
// with separate state, so he'd happily contradict himself between
// modes — e.g. drop a fun fact about Pearl Jam during DJ mode, then
// in chat act like he'd never heard of them. The fixed-opinion
// text also drifted between handlers as features were added.
//
// Solution: one canonical system prompt core, plus a rolling log of
// the last ~10 things Music Man has said (across ALL modes), injected
// into every new call so he sees his own recent statements and
// doesn't contradict them.

const MUSIC_MAN_CORE = `You are "The Music Man" — an arrogant, opinionated, deeply knowledgeable record store savant who lives inside JakeTunes, a music library app. You have encyclopedic knowledge of music across all genres and eras. You speak with the confidence of someone who has listened to more music than anyone alive.

Your personality:
- Condescending but ultimately helpful — you judge taste but still give incredible picks
- You reference obscure B-sides, deep cuts, and music history constantly
- Strong opinions, aren't afraid to share them, dry wit and sarcasm
- You never use emojis
- Concise — this is a chat, not an essay
- You occasionally name-drop shows you've been to, vinyl you own, or artists you've met
- You love Bandcamp and independent artists. You hate lazy, corporate, algorithm-driven music. Any era is fine as long as it's authentic.

FIXED, NON-NEGOTIABLE opinions (these NEVER change, across any interaction):
- Charli XCX: Obsessed. Championed her since the Vroom Vroom EP. "Brat" was album of the decade. Only pop star pushing boundaries.
- Chappell Roan: Can't stand her. Major-label product cosplaying as indie. Calculated aesthetic, safe music.
- Red Hot Chili Peppers: Respect the early funk-punk era. "Blood Sugar Sex Magik" is the peak. Everything after "Californication" is car-commercial background music.
- LCD Soundsystem: James Murphy is a genius. "Sound of Silver" is perfect. You've cried to "All My Friends."
- Jack White: One of the last real rock stars. Always authentic. The White Stripes were essential.
- Radiohead: One of the greatest bands ever. "Kid A" changed everything.
- Generally can't stand most 2026 pop, but you have surprising exceptions for artists taking real risks.

Naming: use natural nicknames fans actually use. Say "the Chili Peppers," not "RHCP." "Queens of the Stone Age" or "Queens," not "QOTSA." Only use abbreviations the band themselves made part of their identity (MGMT, AC/DC).

CRITICAL — DO NOT MAKE UP FACTS:
- Opinions = good. Invented anecdotes = bad. Users spot them.
- Don't invent songwriting stories, producers, release dates, quotes, chart positions, guest musicians, band history. If you can't source the claim, don't make it.
- When background info (Wikipedia / MusicBrainz web search results) is provided, treat it as ground truth. If it doesn't cover the thing asked about, say so in character ("I'm drawing a blank on this specific cut") — don't fabricate a plausible-sounding story.
- When unsure, pivot to the broader band/album context you DO know, or comment on the sound, or grudgingly admit it. All better than a made-up story.

CONSISTENCY: Your opinions and stated facts must be consistent across every interaction. If you told the user something earlier (see "Recently you said" below), don't contradict it. You have one identity and one memory.

DON'T FIXATE: The taste profile below lists the user's top artists, but you don't need to reference the #1 artist in every response. Vary what you bring up. Pull from DIFFERENT corners of their library each time — a deep cut one message, a recent play the next, an observation about a whole genre the next. If you've already name-dropped a specific artist in a recent message (see "Recently you said"), pick someone else this time. Over-referencing one artist reads as shallow.

STAY ON TOPIC: When you're commenting on a specific track, that track is the subject. Don't wedge unrelated top-played artists into the commentary — no "your X obsession led you here" or "ties back to your love of Y" unless there's a direct, substantive connection worth making. The profile is context you may draw on; it is NOT a quota you have to satisfy.

DON'T NARRATE YOUR DATA: If the Wikipedia/MusicBrainz background info is about a different band with the same name (e.g. the 1960s Nirvana instead of Kurt Cobain's), SILENTLY IGNORE it. Do NOT say "the wrong X" or "we've been through this" or "the context is off again" — those phrases leak the plumbing into your output. Users don't know what search result you saw. Just talk about the music you actually know. Same for "the tags look wrong" / "the metadata says X but" — never narrate the state of your own context.`

interface MusicManUtterance { mode: string; text: string; at: number }
let recentMusicManUtterances: MusicManUtterance[] = []
const MM_MEMORY_PATH = join(app.getPath('userData'), 'musicman-memory.json')
const MM_MEMORY_MAX = 12

async function loadMusicManMemory() {
  try {
    const raw = await readFile(MM_MEMORY_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) recentMusicManUtterances = parsed.slice(-MM_MEMORY_MAX)
  } catch { /* first run or corrupt — start fresh */ }
}
async function saveMusicManMemory() {
  try {
    await writeFile(MM_MEMORY_PATH, JSON.stringify(recentMusicManUtterances), 'utf-8')
  } catch { /* non-fatal */ }
}
function noteMusicManUtterance(mode: string, text: string) {
  const trimmed = (text || '').trim()
  if (!trimmed) return
  recentMusicManUtterances.push({ mode, text: trimmed, at: Date.now() })
  if (recentMusicManUtterances.length > MM_MEMORY_MAX) {
    recentMusicManUtterances = recentMusicManUtterances.slice(-MM_MEMORY_MAX)
  }
  saveMusicManMemory()
}
function recentUtterancesBlock(): string {
  if (recentMusicManUtterances.length === 0) return ''
  const lines = recentMusicManUtterances.map(u => `  [${u.mode}] ${u.text}`)
  return `Recently you said (keep it consistent — don't contradict any of this):\n${lines.join('\n')}`
}

// ── Cynthia: the digital file archivist (subordinate persona) ──
//
// Music Man is the front of the house — opinions, DJ banter, recommendations.
// Cynthia is the back office — metadata, organization, missing tracks, wrong
// track numbers, misspellings. They share the same library context and her
// summaries get fed into Music Man's rolling memory so he can reference her
// findings in conversation ("yeah, my archivist says you're missing the
// last two cuts off Disc 2").
//
// She's wired up with proper Anthropic tool-use — first persona in the app
// to actually call tools iteratively. One tool available:
//   1. musicbrainz_album_lookup (custom client tool) — canonical track
//      listings. THE killer tool for "find missing tracks" / "fix track
//      numbers" questions, because MusicBrainz IS the authoritative source.
//      No web search — Cynthia's knowledge of music is fixed (her own
//      taste profile in CYNTHIA_CHAT_CORE) and her data work is grounded
//      in MusicBrainz only. We don't want her chasing trends or scraping
//      random sites to look helpful.

const CYNTHIA_CORE = `You are Cynthia, the digital file archivist for JakeTunes. You report to the Music Man — he's the public-facing persona, the one with opinions and DJ banter. You're the back-of-house operator who keeps his shop tidy: metadata, organization, missing tracks, wrong track numbers, misspelled artist names, files filed under the wrong album.

Your personality:
- Quietly competent. You don't show off. You just fix it.
- Precise and methodical. You double-check before you propose anything.
- Plain-spoken; no purple prose. Short sentences, active voice.
- Slightly amused by chaos in the catalog, but never snarky about the user.
- You never use emojis.
- You don't pretend to know things. When sources disagree, you say so.

Your toolkit:
- musicbrainz_album_lookup: canonical track listings from MusicBrainz. This is your one and only tool. Use it for missing tracks, track-number issues, disc-count questions, "which version of this album is this?" — anything that needs the authoritative track order, durations, or disc layout for a release. You do NOT have web search. If MusicBrainz can't tell you, you say so and stop — you do not guess.

How you work:
1. Read what the user asked for and the in-scope tracks (ID + metadata) the user has selected.
2. Call musicbrainz_album_lookup to ground the question. Don't guess from memory.
3. Cross-check: if MusicBrainz returns a different artist with the same name (wrong "Nirvana", wrong "Air"), spot the mismatch and pick the right release. The release year, country, or genre tags will usually tell you.
4. Form a concrete list of fixes — ONLY the ones you're certain about.
5. Return a JSON report. The user reviews and approves before anything is written.

HOW YOU TALK TO THE USER:
The summary is the main thing the user reads. Write it like you're chatting with them across the desk — full sentences, conversational, give them the gist of what you found and what you'd touch. Do not narrate every individual fix in the summary; the fix list shows those. The summary's job is "here's the situation, here's my read, here's what I'd recommend."

Examples of good summary tone:
- "Quick look at this album: it's a single-disc release per MusicBrainz but your copy has the disc count blank. I'd fill that in. Otherwise the metadata's clean — your spelling matches MB on every track."
- "Found two tracks missing from your Wall Live — 'Run Like Hell' from disc 2 and 'In the Flesh' from disc 1. The rest are all there but the disc-2 tracks are numbered as if they're on disc 1, so I'd renumber those. Heads up: I noticed you've spelled it 'theatre' on some tracks and 'theater' on others; I left that alone since I can't tell which you prefer."
- "Couldn't find a reliable canonical listing for this one — it's a small-label thing. I'd rather not guess at fixes here. If you can confirm it's the 1998 reissue, I can take another pass."

CRITICAL — DO NOT MAKE UP FACTS:
- If you can't find an authoritative source, say so in the summary. "I'm not certain" beats a fabricated track listing every time.
- If the user is missing 2 tracks from a 26-track album, name those 2 SPECIFIC tracks (title, track#, disc#). "You're missing some tracks" is useless.
- For track-number reorganization: only re-number when you have a verified canonical listing. Otherwise leave order alone.
- For misspellings: only flag if you are 100% sure the spelling is WRONG and you know the correct one. Stylized names (CHVRCHES, deadmau5, k.d. lang) are correct as-is.
- Don't propose fixes that change albumArtist when the user clearly intended a compilation or split release.

MATERIALITY — the user only wants to see fixes that ACTUALLY MATTER. Cosmetic differences from MusicBrainz are NOT fixes by themselves. The bar is: would the user notice or care?

Capitalization, punctuation, spacing, and "feat./featuring/feat" variants:
- If the user's library is INTERNALLY CONSISTENT for that field across the in-scope tracks (e.g. every track says "Wolf Parade" the same way), DO NOT change it to match MusicBrainz. Leave it alone. Mention it in the summary if it's notable, but no fix entry.
- ONLY emit a fix when the user's OWN data is INCONSISTENT. Example: 5 tracks say "Wolf Parade", 1 says "wolf Parade", 1 says "Wolf parade" — that's a real fix because the user wants their own library coherent. Pick the most-common version in the user's data (not MusicBrainz canonical) and propose normalizing the outliers to it. Mention which version you picked and why.
- Same logic for "feat. X" vs "featuring X" vs "ft. X" — only normalize if the user uses multiple variants in the scope.
- A track titled "echoes" while the user's other tracks all use Title Case ("Run Like Hell", "Comfortably Numb") IS inconsistency — fix it.

When you decide NOT to fix something cosmetic, mention it in the summary in plain conversation: "your spelling differs from MusicBrainz on a couple but it's consistent across your tracks, so I left it." Don't be defensive; just note it.

Things that ARE always material (always flag if wrong):
- Missing tracks from a known canonical listing.
- Wrong track or disc number/count.
- Wrong year (different from canonical release year).
- Genre that's clearly mis-tagged (a punk track tagged "Classical").
- Album name that's a typo or wildly wrong, not just stylistic.

PAIRED FIELDS — when fixing one, CHECK the partner and fix it too IF AND ONLY IF the partner is also wrong. Never emit a no-op fix whose oldValue equals newValue — the user sees that as you "thinking out loud" in the fix list, which is noise.
- discNumber + discCount   (e.g. "Disc 2 of 1" is broken — fix BOTH only because BOTH are wrong)
- trackNumber + trackCount (when re-numbering a track, fix trackCount only if the existing total is wrong)

The musicbrainz_album_lookup tool returns the disc count and per-disc track count — use them to decide whether the partner field actually needs changing. If the existing value already matches the canonical value, do not include a fix for it.

NEVER emit a fix where oldValue equals newValue. If both already match, just leave the field out of the fixes array. The user only wants to see what's actually changing.

OUTPUT FORMAT — always return a single JSON object inside one fenced code block, even if there's nothing to fix:

{
  "summary": "1-3 short paragraphs, conversational, talking to the user. This is the main thing they read. Tell them the situation, what you'd touch, what you'd leave alone (and why). Don't enumerate fixes line-by-line here — the fixes array does that.",
  "fixes": [
    { "trackId": <number>, "field": "<one of the exact field names below>", "oldValue": <current value or empty string>, "newValue": <proposed value>, "reason": "<one sentence why>" }
  ],
  "missingTracks": [
    { "trackNumber": <n>, "discNumber": <n or 1>, "title": "<title>", "duration": <seconds or null>, "reason": "<which release this is from, e.g. 'Is There Anybody Out There? The Wall Live (1988 EMI 2CD)'>" }
  ],
  "rationale": "1-2 sentences for the Music Man brief — what was the issue, what got fixed, what's left."
}

FIELD NAMES — "field" MUST be exactly one of these strings, character-for-character. The renderer rejects anything else:
  trackNumber   (NOT track_number, track#, tracknum)
  title
  artist
  album
  albumArtist   (NOT album_artist, albumartist)
  year
  genre
  discNumber    (NOT disc_number, disc#)
  trackCount    (NOT total_tracks, track_total)
  discCount     (NOT total_discs, disc_total)

JSON HYGIENE — your response is parsed by a strict JSON parser and bad strings will fail the whole report:
- Use ASCII apostrophes ('), never curly quotes (' '). Never use double quotes (") inside string values; if you must reference a title, use single quotes around it: 'Run Like Hell' not "Run Like Hell".
- Keep "reason" to one short sentence (under 80 chars). No quoted phrases inside it.
- No trailing commas, no JS-style comments.

Empty arrays are fine. Do NOT invent fixes to look helpful — the user trusts you only as long as your fixes are real.`

interface CynthiaUtterance { text: string; at: number }
let recentCynthiaUtterances: CynthiaUtterance[] = []
const CYNTHIA_MEMORY_PATH = join(app.getPath('userData'), 'cynthia-memory.json')
const CYNTHIA_MEMORY_MAX = 8

async function loadCynthiaMemory() {
  try {
    const raw = await readFile(CYNTHIA_MEMORY_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) recentCynthiaUtterances = parsed.slice(-CYNTHIA_MEMORY_MAX)
  } catch { /* first run */ }
}
async function saveCynthiaMemory() {
  try {
    await writeFile(CYNTHIA_MEMORY_PATH, JSON.stringify(recentCynthiaUtterances), 'utf-8')
  } catch { /* non-fatal */ }
}
function noteCynthiaUtterance(text: string) {
  const trimmed = (text || '').trim()
  if (!trimmed) return
  recentCynthiaUtterances.push({ text: trimmed, at: Date.now() })
  if (recentCynthiaUtterances.length > CYNTHIA_MEMORY_MAX) {
    recentCynthiaUtterances = recentCynthiaUtterances.slice(-CYNTHIA_MEMORY_MAX)
  }
  saveCynthiaMemory()
}
function recentCynthiaBlock(): string {
  if (recentCynthiaUtterances.length === 0) return ''
  const lines = recentCynthiaUtterances.map(u => `  - ${u.text}`)
  return `Recent jobs you've finished:\n${lines.join('\n')}`
}

// Best-effort repair for malformed JSON from Cynthia. Two common failure
// modes:
//   1. Curly quotes (' ' " ") that the LLM picked up from training data.
//   2. Unescaped " inside a "reason" string — the model writes a reason
//      that quotes a track title, ships "Run Like Hell" as bare text in
//      the middle of a JSON string, and JSON.parse blows up at that point.
//
// Strategy: walk the JSON char-by-char. Inside a string, if we hit a "
// that isn't followed by JSON-structural punctuation (,:}]) or another
// key boundary, treat it as an inner quote and escape it. This is
// heuristic, not a full parser — it's "salvage what we can" not "always
// produce valid JSON". If the repair still fails to parse, the caller
// surfaces the error as before.
function repairCynthiaJson(raw: string): string {
  // Replace curly/smart quotes with ASCII equivalents. Won't accidentally
  // change content that the model intentionally escaped because we only
  // touch the curly variants.
  let s = raw
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')

  // Walk through and escape stray " inside string values.
  const out: string[] = []
  let inString = false
  let prev = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"' && prev !== '\\') {
      if (!inString) {
        // Starting a string.
        inString = true
        out.push(ch)
      } else {
        // Potentially ending a string. Peek the next non-space char.
        let j = i + 1
        while (j < s.length && /\s/.test(s[j])) j++
        const next = s[j] || ''
        if (next === ',' || next === '}' || next === ']' || next === ':') {
          // Legitimate string terminator.
          inString = false
          out.push(ch)
        } else {
          // Unescaped inner quote — escape it.
          out.push('\\"')
        }
      }
    } else {
      out.push(ch)
    }
    prev = ch
  }
  return out.join('')
}

function buildCynthiaPrompt(modeSpecific = ''): string {
  const parts = [CYNTHIA_CORE]
  if (modeSpecific) parts.push('\n' + modeSpecific)
  if (libraryContext) parts.push(`\nThe user's full library context:\n${libraryContext}`)
  const recents = recentCynthiaBlock()
  if (recents) parts.push('\n' + recents)
  return parts.join('\n')
}

// MusicBrainz album lookup with full track listings (the killer tool for
// "find my missing tracks"). Returns a JSON object Cynthia can read.
async function musicBrainzAlbumLookup(artist: string, album: string): Promise<string> {
  try {
    const headers = { 'User-Agent': 'JakeTunes/4.0.0 (jacobrosenbaum@gmail.com)', 'Accept': 'application/json' }
    // Step 1: find candidate releases.
    const query = `release:"${album}" AND artist:"${artist}"`
    const searchUrl = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=8`
    const searchRes = await fetch(searchUrl, { headers })
    if (!searchRes.ok) return JSON.stringify({ error: `MusicBrainz search failed: ${searchRes.status}` })
    const searchData = await searchRes.json() as {
      releases?: Array<{
        id: string
        title: string
        date?: string
        country?: string
        'track-count'?: number
        'artist-credit'?: Array<{ name: string }>
        'release-group'?: { 'primary-type'?: string }
      }>
    }
    const releases = searchData.releases || []
    if (releases.length === 0) {
      return JSON.stringify({
        artist, album,
        candidates: [],
        note: 'No releases found on MusicBrainz. Try alternate spellings of the artist or album, or tell the user MusicBrainz has no record of this release.',
      })
    }
    // Step 2: fetch full track listing for the top candidate, plus a short
    // list of alternate candidates so Cynthia can pick a different one.
    const top = releases[0]
    const detailUrl = `https://musicbrainz.org/ws/2/release/${top.id}?inc=recordings+media+artist-credits&fmt=json`
    const detailRes = await fetch(detailUrl, { headers })
    let canonical: { tracks: Array<{ disc: number; position: number; title: string; durationSec: number | null }>; trackCount: number } | null = null
    if (detailRes.ok) {
      const detail = await detailRes.json() as {
        media?: Array<{
          position?: number
          tracks?: Array<{
            position?: number
            title?: string
            length?: number  // milliseconds
            recording?: { title?: string; length?: number }
          }>
        }>
      }
      const tracks: Array<{ disc: number; position: number; title: string; durationSec: number | null }> = []
      for (const medium of detail.media || []) {
        const disc = medium.position || 1
        for (const t of medium.tracks || []) {
          const lenMs = t.length ?? t.recording?.length ?? null
          tracks.push({
            disc,
            position: t.position || 0,
            title: t.title || t.recording?.title || '',
            durationSec: lenMs ? Math.round(lenMs / 1000) : null,
          })
        }
      }
      canonical = { tracks, trackCount: tracks.length }
    }
    return JSON.stringify({
      artist, album,
      chosenRelease: {
        id: top.id,
        title: top.title,
        artist: top['artist-credit']?.[0]?.name || artist,
        date: top.date || null,
        country: top.country || null,
        type: top['release-group']?.['primary-type'] || null,
      },
      canonicalTracks: canonical?.tracks || [],
      canonicalTrackCount: canonical?.trackCount || 0,
      otherCandidates: releases.slice(1, 5).map(r => ({
        id: r.id,
        title: r.title,
        artist: r['artist-credit']?.[0]?.name || '',
        date: r.date || null,
        country: r.country || null,
        trackCount: r['track-count'] || null,
      })),
    })
  } catch (err: unknown) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

// Cynthia's tool loop — issues messages.create with the custom
// musicbrainz tool, executes any custom tool calls, feeds results back, and
// stops when the model returns end_turn (or after a safety cap of iterations).
//
// Returns the final assistant text (which Cynthia is instructed to format as
// a single fenced JSON block).
type CynthiaTrackInScope = {
  id: number
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNumber: number | string
  trackCount: number | string
  discNumber: number | string
  discCount: number | string
  year: number | string
  genre: string
  duration: number  // ms
}

interface CynthiaInvestigateInput {
  userPrompt: string
  scope: {
    type: 'tracks' | 'album' | 'artist' | 'playlist'
    label: string
    tracks: CynthiaTrackInScope[]
  }
}

// The investigation pipeline used to be a single IPC handler. It now lives
// in this function so it can also be invoked from inside the cynthia-chat
// handler as a "deep_investigate" tool that Haiku calls when it needs the
// big-model treatment (MusicBrainz, web search, structured fixes).
//
// Two-model architecture:
//   - Haiku 4.5 fronts the chat — fast, terse, conversational.
//   - When the user actually wants Cynthia to *check* or *fix* something,
//     Haiku calls deep_investigate, which spins up Sonnet 4.6 with the
//     real toolkit and returns a structured report.
async function runCynthiaInvestigation(
  userPrompt: string,
  scope: CynthiaInvestigateInput['scope'],
): Promise<{ ok: boolean; summary?: string; fixes?: unknown[]; missingTracks?: unknown[]; rationale?: string; error?: string; text?: string }> {
  const trackTable = scope.tracks.map(t =>
    `${t.id}|${t.title}|${t.artist}|${t.album}|${t.albumArtist || ''}|disc ${t.discNumber || 1} track ${t.trackNumber || '?'}|${t.year || ''}|${t.genre || ''}|${Math.round((t.duration || 0) / 1000)}s`
  ).join('\n')

  const userMessage = `The user (your boss's boss, basically) just right-clicked on ${scope.type === 'album' ? `the album "${scope.label}"` : scope.type === 'artist' ? `the artist "${scope.label}"` : scope.type === 'playlist' ? `the playlist "${scope.label}"` : `${scope.tracks.length} track${scope.tracks.length !== 1 ? 's' : ''}`} and said:

"${userPrompt}"

Tracks in scope (id|title|artist|album|albumArtist|disc/track|year|genre|duration):
${trackTable}

Investigate. Use your tools as needed. Then return your JSON report.`

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      name: 'musicbrainz_album_lookup',
      description: 'Look up canonical track listings for a music release on MusicBrainz. Returns the authoritative track order, durations, and disc layout for an album. Use this FIRST for any album-related question (missing tracks, wrong track numbers, "what version is this?"). Returns a JSON object with chosenRelease, canonicalTracks, otherCandidates.',
      input_schema: {
        type: 'object' as const,
        properties: {
          artist: { type: 'string', description: 'The album artist exactly as you want to search for it (e.g. "Pink Floyd")' },
          album:  { type: 'string', description: 'The album title (e.g. "Is There Anybody Out There? The Wall Live")' },
        },
        required: ['artist', 'album'],
      },
    },
  ]

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userMessage },
  ]

  const systemPrompt = buildCynthiaPrompt()
  let response: Anthropic.Messages.Message
  let safety = 0
  const MAX_TOOL_ROUNDS = 8

  try {
    response = await claudeCall('cynthia-investigate-init', {
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      tools,
      messages,
    })

    while (response.stop_reason === 'tool_use' && safety++ < MAX_TOOL_ROUNDS) {
      messages.push({ role: 'assistant', content: response.content })
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'musicbrainz_album_lookup') {
          const input = block.input as { artist?: string; album?: string }
          const result = await musicBrainzAlbumLookup(input.artist || '', input.album || '')
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
        }
      }
      if (toolResults.length === 0) break
      messages.push({ role: 'user', content: toolResults })
      response = await claudeCall('cynthia-investigate-tool', {
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        tools,
        messages,
      })
    }

    const text = response.content
      .filter((b: Anthropic.Messages.ContentBlock) => b.type === 'text')
      .map((b: Anthropic.Messages.ContentBlock) => (b as Anthropic.Messages.TextBlock).text)
      .join('\n')
      .trim()

    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
    const bare = !fenced ? text.match(/\{[\s\S]*\}/) : null
    const rawJson = (fenced?.[1] || bare?.[0] || '').trim()
    if (!rawJson) {
      return { ok: false, error: 'Cynthia gave a non-JSON answer.', text }
    }
    let parsed: { summary?: string; fixes?: unknown[]; missingTracks?: unknown[]; rationale?: string }
    try {
      parsed = JSON.parse(rawJson)
    } catch {
      try {
        parsed = JSON.parse(repairCynthiaJson(rawJson))
      } catch (secondErr: unknown) {
        const msg = secondErr instanceof Error ? secondErr.message : String(secondErr)
        return { ok: false, error: `Could not parse Cynthia's JSON: ${msg}`, text }
      }
    }

    return {
      ok: true,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
      missingTracks: Array.isArray(parsed.missingTracks) ? parsed.missingTracks : [],
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

ipcMain.handle('cynthia-investigate', async (_event, input: CynthiaInvestigateInput) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY missing — Cynthia is on break.' }
  }
  const { userPrompt, scope } = input
  if (!userPrompt?.trim() || !scope?.tracks?.length) {
    return { ok: false, error: 'Cynthia needs a prompt and at least one track in scope.' }
  }
  return runCynthiaInvestigation(userPrompt, scope)
})

// Conversational front of Cynthia. Haiku 4.5 talks to the user in short
// replies. When the user wants something checked or fixed, Haiku calls
// deep_investigate, which fires the full Sonnet+MusicBrainz pipeline and
// returns structured results that the renderer attaches to Haiku's reply.
const CYNTHIA_CHAT_CORE = `You are Cynthia, the digital file archivist for JakeTunes. You're chatting with the user in a small popover. You came up on Grateful Dead bootlegs and never quite left, and it shows in your pace — easy-going, a little understated, never in a hurry. You're not performing the hippie thing. It's just how you are.

VOICE:
- One or two short sentences. Three max, and only if you have a reason.
- Plain English, low-stakes phrasing. "Track checks out" beats "I have verified the metadata." "A bit messy" beats "this is incorrect." "Couldn't find much on that" beats "I was unable to locate sufficient information."
- Slight understatement. "Pretty solid." "Not bad." "Holds up."
- Don't say "groovy," "far out," "right on," "vibes," "dude." The mellowness is in your rhythm, not your vocabulary. Saying those would be trying too hard.
- Don't restate the user's question. Don't apologize. Never use emojis.
- When you don't know, just say so plainly. "Not sure, honestly."

YOUR TASTE — fixed, do not look it up:
You have an actual taste profile. It does not change. You do not research what's currently hot or trending — that's not your scene and trends aren't real anyway. You only ever express opinions about music if (a) the user asks, AND (b) it's in your zone.

Your zone: Grateful Dead, The Band, Allman Brothers, Phish, Pink Floyd, Led Zeppelin, Hendrix, Janis Joplin, Dylan, Neil Young, CSN(Y), Joni Mitchell, Van Morrison, Marley, Curtis Mayfield, Sly & The Family Stone, Stevie Wonder, Velvet Underground, Modern Lovers, Talking Heads, Wilco, My Morning Jacket, Wolf Parade, Iron & Wine, Bon Iver, Big Thief, Sufjan Stevens, Built to Spill, Pavement, Yo La Tengo. Folk-rock, psych, jam, soul, reggae, americana, indie rock with feeling, slowcore, sad-bastard stuff.

Outside your zone: mainstream pop, top-40 country, EDM, hyperpop, most modern rap. You'll fix the metadata politely. You don't have anything to say about it.

OPINION RULES:
- User did not ask for an opinion → don't give one. Just do the metadata work.
- User asked AND it's in your zone → one or two sentences of low-key opinion. "Mm, this one's nice. The '77 run hits harder but this holds up." Reference specifics if you know them, but don't show off.
- User asked AND it's outside your zone → "Not really my scene, can't help you there. Metadata looks fine though." Or similar. No fake enthusiasm.
- Never claim something is "trending" or "popular right now." You don't know and don't care.

DECIDING WHAT TO DO:
- User asked you to investigate, check, fix, find missing tracks, normalize anything → call deep_investigate. That's the heavy tool.
- User is just chatting, clarifying, or expressing a preference → answer in text. No deep_investigate.
- User already saw a fix list and says "do it" / "apply" → tell them to hit Apply on the card; you don't apply yourself.`

interface CynthiaChatInput {
  scope: CynthiaInvestigateInput['scope']
  messages: { role: 'user' | 'assistant'; content: string }[]
}

ipcMain.handle('cynthia-chat', async (_event, input: CynthiaChatInput) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY missing — Cynthia is on break.' }
  }
  const { scope, messages } = input
  if (!scope?.tracks?.length || !messages?.length) {
    return { ok: false, error: 'Cynthia needs a scope and at least one message.' }
  }

  const scopeLabel = scope.type === 'album' ? `the album "${scope.label}"`
    : scope.type === 'artist' ? `the artist "${scope.label}"`
    : scope.type === 'playlist' ? `the playlist "${scope.label}"`
    : `${scope.tracks.length} track${scope.tracks.length !== 1 ? 's' : ''}`

  const trackBrief = scope.tracks.slice(0, 30).map(t =>
    `${t.id}: ${t.title} — ${t.artist} — ${t.album} (disc ${t.discNumber || 1} #${t.trackNumber || '?'})`
  ).join('\n')

  const systemPrompt = `${CYNTHIA_CHAT_CORE}

The user right-clicked on ${scopeLabel}. The in-scope tracks are:
${trackBrief}${scope.tracks.length > 30 ? `\n(+${scope.tracks.length - 30} more)` : ''}`

  const tools: Anthropic.Messages.ToolUnion[] = [
    {
      name: 'deep_investigate',
      description: 'Run a thorough metadata investigation on the in-scope tracks. Calls MusicBrainz via the Sonnet model, identifies missing tracks, and proposes concrete fixes. Use this whenever the user wants you to check, verify, or fix something concrete about the data. Do NOT use for casual chat.',
      input_schema: {
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: 'A clear instruction describing what should be investigated or fixed (e.g. "check the track numbers and disc count against MusicBrainz canonical").' },
        },
        required: ['prompt'],
      },
    },
  ]

  // Convert renderer-side messages (just role/content text) into Anthropic format.
  const apiMessages: Anthropic.Messages.MessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  let investigation: Awaited<ReturnType<typeof runCynthiaInvestigation>> | null = null

  try {
    let response = await claudeCall('cynthia-chat-init', {
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: systemPrompt,
      tools,
      messages: apiMessages,
    })

    let safety = 0
    while (response.stop_reason === 'tool_use' && safety++ < 3) {
      apiMessages.push({ role: 'assistant', content: response.content })
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'deep_investigate') {
          const args = block.input as { prompt?: string }
          const result = await runCynthiaInvestigation(args.prompt || '', scope)
          investigation = result
          // Hand Haiku a compact summary of what the deep model produced so
          // she can write a terse natural-language reply on top of it.
          const briefForHaiku = result.ok
            ? `deep_investigate result:\nsummary: ${result.summary || '(none)'}\nfixes: ${(result.fixes || []).length}\nmissingTracks: ${(result.missingTracks || []).length}`
            : `deep_investigate failed: ${result.error || 'unknown error'}`
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: briefForHaiku })
        }
      }
      if (toolResults.length === 0) break
      apiMessages.push({ role: 'user', content: toolResults })
      response = await claudeCall('cynthia-chat-tool', {
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        system: systemPrompt,
        tools,
        messages: apiMessages,
      })
    }

    const text = response.content
      .filter((b: Anthropic.Messages.ContentBlock) => b.type === 'text')
      .map((b: Anthropic.Messages.ContentBlock) => (b as Anthropic.Messages.TextBlock).text)
      .join('\n')
      .trim()

    return {
      ok: true,
      text: text || (investigation?.ok ? (investigation.summary || '') : ''),
      investigation: investigation?.ok ? {
        summary: investigation.summary || '',
        fixes: investigation.fixes || [],
        missingTracks: investigation.missingTracks || [],
        rationale: investigation.rationale || '',
      } : null,
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// After the user approves Cynthia's fixes, the renderer calls this so her
// summary lands in Music Man's rolling memory ("Recently you said...") and
// her own log. Now Music Man can casually reference the work in chat:
// "yeah, my archivist sorted out the Pink Floyd thing yesterday."
ipcMain.handle('cynthia-report-to-musicman', async (_event, payload: { rationale: string; summary?: string }) => {
  const text = (payload?.rationale || payload?.summary || '').trim()
  if (!text) return { ok: false, error: 'Empty report' }
  noteCynthiaUtterance(text)
  noteMusicManUtterance('cynthia-report', `[Cynthia, archivist] ${text}`)
  return { ok: true }
})

/** Build a full system prompt by combining MUSIC_MAN_CORE with mode-
 *  specific instructions, library context, taste profile, and recent
 *  Music Man utterances. Every Music Man endpoint should use this.
 *
 *  Returns structured TextBlockParam[] (rather than a single string) so
 *  the stable prefix — MUSIC_MAN_CORE + library context — can be marked
 *  for prompt caching (4.0 §2.3). The library context is identical for
 *  every Music Man call within a session, so caching it saves ~all of
 *  the system-prompt tokens on repeat calls. The dynamic suffix (mode
 *  instructions, taste profile, recent utterances) changes per call and
 *  is left uncached.
 *
 *  If the cacheable prefix is below Anthropic's minimum cache size (1024
 *  tokens for Sonnet), the cache_control marker is silently ignored by
 *  the API — no benefit, but no error either.
 */
function buildMusicManPrompt(modeSpecific = ''): Anthropic.Messages.TextBlockParam[] {
  const stableParts = [MUSIC_MAN_CORE]
  if (libraryContext) stableParts.push(`The user's music library contains:\n${libraryContext}`)
  const stableText = stableParts.join('\n\n')

  const dynamicParts: string[] = []
  if (modeSpecific) dynamicParts.push(modeSpecific)
  const tp = buildTasteProfile()
  if (tp) dynamicParts.push(`What you know about this listener's history:\n${tp}`)
  const recents = recentUtterancesBlock()
  if (recents) dynamicParts.push(recents)

  const blocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
  ]
  if (dynamicParts.length > 0) {
    blocks.push({ type: 'text', text: dynamicParts.join('\n\n') })
  }
  return blocks
}

// Music Man chat
let libraryContext = ''

ipcMain.handle('set-library-context', (_event, ctx: string) => {
  libraryContext = ctx
})

ipcMain.handle('musicman-chat', async (_event, messages: { role: string; content: string }[]) => {
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
  const searchResults = await searchWeb(lastUserMsg)

  const chatInstructions = `You're chatting with the listener in JakeTunes. Use the library context and taste profile (below) to personalize — reference artists they own, notice gaps, recommend things tuned to what you know about them.${searchResults ? `\n\nWeb search results for accuracy (treat as ground truth, maintain your personality):\n${searchResults}` : ''}`

  const systemPrompt = buildMusicManPrompt(chatInstructions)

  try {
    const response = await claudeCall('musicman-chat', {
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    if (text) noteMusicManUtterance('chat', text)
    return { ok: true, text }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, text: `Error: ${msg}` }
  }
})

// Music Man playlist generator
ipcMain.handle('musicman-playlist', async (_event, mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => {
  const trackList = tracks.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}`).join('\n')

  const playlistInstructions = `Build a playlist from the user's ACTUAL library for their requested mood. Pick 15-25 tracks that match. Track ORDER matters — think about flow, transitions, energy arc. This is a curated experience, not a shuffle.

Return ONLY a JSON object (no markdown, no code fences):
{"name":"creative playlist name","commentary":"2-3 sentences about your picks, in character","trackIds":[array of track ID numbers in playlist order]}

Rules:
- ONLY use track IDs from the provided library — do not invent IDs
- Order matters — build a journey with intentional pacing
- VARIETY IS KEY: Mix up the artists. Do NOT put 3+ songs by the same artist in a row. Spread artists throughout the playlist. Back-to-back songs from the same artist should be RARE — maybe once in a playlist if it truly serves the flow. Think like a great radio DJ, not someone hitting "play all" on one album.
- Aim for at least 10-12 different artists in a 20-track playlist
- If the mood is vague, interpret it with confidence`

  const systemPrompt = buildMusicManPrompt(playlistInstructions)

  try {
    const response = await claudeCall('musicman-playlist', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Build me a playlist for: "${mood}"\n\nMy library (ID|Title|Artist|Album|Genre):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.commentary) noteMusicManUtterance('playlist', parsed.commentary)
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

  const picksInstructions = `Today is ${dateStr} and it's ${season}. Pick 15-20 tracks from the user's library for TODAY's daily playlist. Your picks should be influenced by:
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
- Be personal about why you picked these today
- This should feel different every single day`

  const systemPrompt = buildMusicManPrompt(picksInstructions)

  try {
    const response = await claudeCall('musicman-picks', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Build today's picks.\n\nMy library (ID|Title|Artist|Album|Genre):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.commentary) noteMusicManUtterance('picks', parsed.commentary)
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

  const recsInstructions = `You've been asked to recommend albums that are NOT already in the user's library.

CRITICAL RULES:
- NEVER recommend albums/artists the user ALREADY HAS. Check the album list carefully.
- Recommend 8-12 albums. Mix well-known essentials they're missing with deeper cuts they'd never find on their own.
- Each recommendation should connect to something already in their library — explain WHY based on what they listen to.
- Prefer Bandcamp and independent releases when possible, but don't force it. Major label classics are fine too.
- If an album is a masterpiece, say so. If it's an acquired taste, warn them.
- Tag each with a source: "bandcamp" for indie/small label, "qobuz" for hi-res/audiophile, "streaming" for widely available.

Return ONLY a JSON array (no markdown, no code fences):
[{"title":"album title","artist":"artist name","year":2020,"genre":"genre tag","source":"bandcamp|qobuz|streaming","why":"1-2 sentences explaining why this fits their library, in character"}]

The user's top artists: ${topArtists}
Their top genres: ${topGenres}`

  const systemPrompt = buildMusicManPrompt(recsInstructions)

  try {
    const response = await claudeCall('musicman-recs', {
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Recommend albums I don't have.\n\nMy albums:\n${albumList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { title: string; artist: string; year?: number; genre: string; source: string; why: string; artUrl?: string }[]

      // Deterministic post-filter: the prompt asks the model to skip
      // albums the user already has, but it regularly fails at this
      // and then backpedals in the commentary ("You already have X —
      // scratch that, moving on"). Drop those.
      //
      // Identity-based dedup is the long-term goal (4.0 §2.2) but
      // requires MBID storage on Track which doesn't exist yet —
      // tracked as a follow-up. For now this is a smarter text matcher
      // that handles the failure modes the previous aggressive-strip
      // version missed:
      //   - parenthetical suffixes: "(Deluxe)", "[Remastered]", "(Live)"
      //   - abbreviation expansion: "Pt." ↔ "Part", "Vol." ↔ "Volume"
      //   - ampersand/and: "Simon & Garfunkel" ↔ "Simon and Garfunkel"
      //   - diacritics: "Beyoncé" ↔ "Beyonce"
      //   - articles: "The Beatles" ↔ "Beatles"
      //   - case + whitespace
      // It is NOT used for any destructive operation (deletion, sync
      // abort, overwriting). Filtering recommendations is non-destructive
      // — false positives just mean a rec is hidden, never that data
      // is lost. See CLAUDE.md "destructive operations may not gate on
      // text comparison" for context.
      //
      // ⚠️ Intentionally NOT shared with the file-identity normalize at
      // ~line 968 (twin-paired with core/repair_mismatches.py). That one
      // is for sync-time identity matching and any change must be
      // mirrored in Python. This one is local, non-destructive, and free
      // to evolve. Do not consolidate.
      const normForOwnership = (s: string): string => {
        if (!s) return ''
        return s
          .normalize('NFKD').replace(/[̀-ͯ]/g, '')      // strip diacritics
          .toLowerCase()
          .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')            // drop ( ... ) and [ ... ]
          .replace(/\bpts?\b\.?/g, m => m.startsWith('pts') ? 'parts' : 'part')
          .replace(/\bvols?\b\.?/g, m => m.startsWith('vols') ? 'volumes' : 'volume')
          .replace(/\bno\.?\s*(\d)/g, 'number $1')                // "No. 1" → "number 1"
          .replace(/&/g, ' and ')
          .replace(/\bthe\b/g, ' ')
          .replace(/[^a-z0-9\s]/g, ' ')                           // strip remaining punct (no mid-word merging)
          .split(/\s+/).filter(Boolean).join(' ')
      }
      const ownedArtistAlbum = new Set<string>()
      const ownedArtist = new Set<string>()
      for (const t of tracks) {
        if (t.artist) ownedArtist.add(normForOwnership(t.artist))
        if (t.artist && t.album) ownedArtistAlbum.add(`${normForOwnership(t.artist)}|${normForOwnership(t.album)}`)
      }
      let droppedAsOwned = 0
      const cleaned = parsed.filter(rec => {
        const key = `${normForOwnership(rec.artist)}|${normForOwnership(rec.title)}`
        if (ownedArtistAlbum.has(key)) {
          droppedAsOwned++
          return false
        }
        return true
      })
      if (droppedAsOwned > 0) {
        console.log(`[recs] filtered ${droppedAsOwned} recommendation(s) the user already owns`)
      }
      // Strip any leftover self-correction phrases from commentary —
      // belt-and-suspenders in case the model still slips it in.
      for (const rec of cleaned) {
        if (!rec.why) continue
        rec.why = rec.why
          .replace(/^(you already (have|own)[^.]*\.\s*)+/i, '')
          .replace(/\s*(—|--)\s*(scratch that|wait|no|my mistake|moving on)[^.]*\./gi, '.')
          .replace(/\s*\(wait[^)]*\)\s*/gi, ' ')
          .trim()
      }

      // Fetch album art from Deezer for each recommendation (parallel, best-effort)
      await Promise.all(cleaned.map(async (rec) => {
        try {
          const aLo = rec.artist.toLowerCase().trim()
          const tLo = rec.title.toLowerCase().trim()
          const url = await searchDeezerArt(`${rec.artist} ${rec.title}`, aLo, tLo)
          if (url) rec.artUrl = url
        } catch { /* ignore art fetch failures */ }
      }))
      return { ok: true, recommendations: cleaned }
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

  const scanInstructions = `You've been asked to scan a music library for metadata issues. Analyze the track list and find ALL issues. Categories:

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
- Return an empty array [] if there are no certain issues. That's fine.`

  const systemPrompt = buildMusicManPrompt(scanInstructions)

  try {
    const response = await claudeCall('musicman-scan-metadata', {
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

// Pick audio files/folders for the File > Import and Convert flow.
// Returns absolute paths; mirrors the drag-drop entry point so
// import-tracks can consume either indistinguishably.
ipcMain.handle('import-pick-files', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import and Convert',
    properties: ['openFile', 'openDirectory', 'multiSelections', 'treatPackageAsDirectory'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'alac', 'wav', 'aiff', 'aif', 'ogg'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    defaultPath: process.env.HOME || undefined,
  })
  if (result.canceled) return { ok: false, canceled: true }
  return { ok: true, paths: result.filePaths }
})

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

// Claude API stats — exposed for dev/diagnostic surfaces. Renderer can poll
// or display this in a hidden corner during development. lastResponses is
// excluded from the wire format (large payloads, not useful in UI).
ipcMain.handle('get-claude-stats', async () => {
  await loadClaudeStats()
  rolloverIfNewDay()
  return {
    ok: true,
    sessionCallCount,
    callsToday: claudeStats.callsToday,
    dailyCeiling: claudeStats.dailyCeiling,
    lastResetDate: claudeStats.lastResetDate,
    cachedKeys: Object.keys(claudeStats.lastResponses),
  }
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
        // Include release-groups + tags so we can fall back to the group's
        // first-release date when a specific release has no date, and pull
        // a genre from MusicBrainz release / release-group tags.
        const url = `https://musicbrainz.org/ws/2/discid/-?toc=${encodeURIComponent(toc)}&fmt=json&cdstubs=no&inc=recordings+artist-credits+release-groups+tags`
        const res = await fetch(url, {
          headers: { 'User-Agent': 'JakeTunes/4.0.0 (jaketunes@example.com)' }
        })
        if (res.ok) {
          type MBTag = { name: string; count?: number }
          const data = await res.json() as {
            releases?: Array<{
              id: string
              title: string
              date?: string
              'artist-credit'?: Array<{ artist: { name: string } }>
              media?: Array<{ tracks?: Array<{ position: number; title: string }> }>
              'release-group'?: { 'first-release-date'?: string; tags?: MBTag[] }
              tags?: MBTag[]
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
            // Prefer the specific release date; fall back to the
            // release-group's first-release-date (better coverage for
            // compilations / remasters whose release has no date).
            year = release.date?.split('-')[0]
              || release['release-group']?.['first-release-date']?.split('-')[0]
              || ''

            // Genre from top-tagged tag name. Release-level tags are
            // usually more specific; fall back to release-group tags.
            const pickTopTag = (tags?: MBTag[]): string => {
              if (!tags || tags.length === 0) return ''
              const sorted = [...tags].sort((a, b) => (b.count || 0) - (a.count || 0))
              const name = sorted[0]?.name || ''
              // Title-case it so "rock" → "Rock", "hip hop" → "Hip Hop"
              return name ? name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : ''
            }
            genre = pickTopTag(release.tags) || pickTopTag(release['release-group']?.tags) || ''

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

  // The renderer passes `nextId = max(library.id, max-imported-NNNN-in-paths)
  // + 1` (App.tsx useEffect, fixed Apr 26). The on-disk scan below is the
  // belt-and-suspenders second line of defense: if disk has orphan files
  // from a prior session that never made it into library.json, or any
  // other source of drift, `findFreeImportedId` walks forward until it
  // finds a free slot.
  //
  // ⚠️ TWIN: same helper is used by `import-track`'s `importOneFile`.
  // Centralizes the scan so we don't ship two versions that drift apart.
  let id = await findFreeImportedId(nextId)
  if (id !== nextId) {
    console.warn(`rip-cd-tracks: nextId ${nextId} collides with existing file imported_${nextId}.*; bumped to ${id}`)
  }

  // Validate and default the format.
  const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
  const fmt: AudioFormat = validFormats.includes(format as AudioFormat)
    ? (format as AudioFormat)
    : 'aac-256'
  const destExt = extensionForFormat(fmt)

  const cdBatchBaseTime = Date.now()
  let cdTrackIndex = 0

  for (const cdTrack of cdTracks) {
    // Re-check before each track in case the previous iteration's id
    // has now been written and we're about to land on a slot a parallel
    // process took. Cheap (single stat per ext when no collision).
    id = await findFreeImportedId(id)
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

      // Send per-track progress to renderer, including the just-imported
      // track record so the library can add it immediately instead of
      // waiting for the whole batch to finish.
      mainWindow?.webContents.send('cd-rip-progress', {
        current: imported.length,
        total: cdTracks.length,
        trackNumber: cdTrack.number,
        trackTitle: cdTrack.title,
        track: imported[imported.length - 1],
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

  // Resolve the just-imported tracks' on-disk paths once — used for
  // both pre-warming ALAC transcodes and for pre-registering their
  // codec with the play handler so first-play doesn't have to ffprobe.
  const localMount = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const importedAbsPaths = imported.map(t => {
    const hfs = (t.path as string) || ''
    const rel = hfs.replace(/^:/, '').replace(/:/g, '/')
    return join(localMount, rel)
  }).filter(Boolean)

  // Pre-register codec (we know it — we just wrote it).
  // 'alac' for lossless rips, 'aac' for AAC 128/256/320.
  const knownCodec = fmt === 'alac' ? 'alac' : fmt.startsWith('aac-') ? 'aac' : ''
  if (knownCodec) {
    for (const p of importedAbsPaths) {
      try {
        const s = await stat(p)
        registerKnownCodec(p, s.mtimeMs, knownCodec)
      } catch { /* file missing — skip */ }
    }
  }

  // If we ripped as ALAC, kick off background transcodes into the
  // play cache so the user's first click on these tracks plays
  // instantly instead of waiting 2-3 seconds for on-demand transcode.
  if (fmt === 'alac') {
    prewarmAlacCache(importedAbsPaths).catch(err => console.warn('pre-warm failed:', err))
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

app.whenReady().then(async () => {
  // ── Purge renderer caches on version change ──
  // When the user installs a new DMG over an old one, Electron keeps
  // the previous Session Storage + Local Storage from the old
  // renderer. Combined with new main-process code, that stale cache
  // showed up as "library empty" on first launch after an install,
  // forcing the user to quit + relaunch or manually clear session
  // storage. This purge happens BEFORE createWindow so the renderer
  // starts from a clean slate whenever the app binary changed.
  try {
    const versionFile = join(app.getPath('userData'), '.last-version')
    const currentVersion = app.getVersion()
    let prevVersion: string | null = null
    try { prevVersion = (await readFile(versionFile, 'utf-8')).trim() } catch { /* first launch */ }
    if (prevVersion !== currentVersion) {
      console.log(`[launch] version changed (${prevVersion} → ${currentVersion}) — purging renderer cache`)
      const { rm } = await import('fs/promises')
      for (const dir of ['Session Storage', 'Local Storage']) {
        await rm(join(app.getPath('userData'), dir), { recursive: true, force: true }).catch(() => {})
      }
      await writeFile(versionFile, currentVersion, 'utf-8').catch(() => {})
    }
  } catch (err) {
    console.warn('[launch] version-change cache purge failed (non-fatal):', err)
  }

  // Load listener profile for Music Man
  loadListenerProfile()
  // Load Music Man's cross-mode memory (things he's said recently)
  await loadMusicManMemory()
  // Load Cynthia's archivist memory (recent jobs she's finished)
  await loadCynthiaMemory()
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
      return new Response(data as unknown as BodyInit, {
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

  // Cache of transcoded AAC copies of ALAC sources. Chromium can't decode
  // ALAC, so when the renderer asks for one we detect it and hand back a
  // cached AAC transcode instead. The source ALAC file is preserved
  // untouched on disk (the user wants lossless for iPod sync).
  //
  // Cache key: first 16 hex chars of sha1(path). Cache entry is stale if
  // source mtime > cache mtime. Cache lives in userData/play-cache/.
  const PLAY_CACHE = join(app.getPath('userData'), 'play-cache')
  await mkdir(PLAY_CACHE, { recursive: true }).catch(() => {})

  // In-flight transcodes, to coalesce concurrent range requests for the
  // same source file into a single ffmpeg pass.
  const transcodeInFlight = new Map<string, Promise<string>>()

  // Codec-detection cache. ffprobe is ~200-500ms per call; running it
  // on every play — even for AAC files that don't need any transcode —
  // made first-play latency user-visible. Keyed by source path with
  // the mtime at the time we probed, so the entry is invalidated if
  // the source file changes.
  const codecCache = new Map<string, { mtime: number; codec: string }>()

  async function aacCachePath(src: string, srcMtime: number): Promise<string | null> {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execP = promisify(execFile)

    let codec = ''
    const prev = codecCache.get(src)
    if (prev && prev.mtime === srcMtime) {
      codec = prev.codec
    } else {
      try {
        const { stdout } = await execP('ffprobe', [
          '-v', 'error', '-select_streams', 'a:0',
          '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', src,
        ], { timeout: 5000 })
        codec = (stdout || '').trim().toLowerCase()
        codecCache.set(src, { mtime: srcMtime, codec })
      } catch {
        return null  // ffprobe unavailable — fall through to raw file
      }
    }
    if (codec !== 'alac') return null  // AAC and others play fine raw

    const hash = createHash('sha1').update(src).digest('hex').slice(0, 16)
    const cached = join(PLAY_CACHE, `${hash}.m4a`)
    try {
      const cStat = await stat(cached)
      if (cStat.mtimeMs >= srcMtime) return cached  // fresh
    } catch { /* not cached yet */ }

    // Need to transcode. Dedupe concurrent requests.
    const existing = transcodeInFlight.get(src)
    if (existing) return existing

    const p = (async () => {
      // Atomic write: ffmpeg → tmp file → rename into place. Without
      // this, a killed ffmpeg (app quit mid-transcode, OS reap, etc.)
      // leaves a partial file at `cached` whose mtime still passes
      // the freshness check, so the app would keep serving a
      // truncated 42-second version of a 4-minute song. rename()
      // guarantees the final path is either complete or absent.
      // .partial.m4a (not .tmp) so ffmpeg recognizes the mp4 container
      // format from the extension. Rename on success is still atomic.
      const tmp = cached + '.partial.m4a'
      try {
        await execP('ffmpeg', [
          '-y', '-i', src, '-vn',
          '-c:a', 'aac', '-b:a', '256k',
          '-map_metadata', '0',
          tmp,
        ], { timeout: 300000 })
        const { rename: renameFS } = await import('fs/promises')
        await renameFS(tmp, cached)
        return cached
      } catch (err) {
        // Clean up the partial tmp file so we don't leave garbage.
        try { await unlink(tmp) } catch { /* already gone */ }
        throw err
      } finally {
        transcodeInFlight.delete(src)
      }
    })()
    transcodeInFlight.set(src, p)
    return p
  }

  // Expose a module-visible pre-warm trigger so rip-cd-tracks (and the
  // library-load path later, if we want) can kick off transcodes for
  // newly-imported ALAC files before the user clicks play. Best-effort;
  // failures log and skip.
  //
  // CRITICAL: cap concurrency at 4. The original implementation
  // fire-and-forgot every file in the loop, which on a fresh install
  // with 800 ALAC tracks meant 800 simultaneous ffmpeg processes. The
  // box would peg every core, the UI would stutter on scroll, and the
  // first-play latency we were trying to hide actually got WORSE
  // because the on-demand transcode for the song the user just hit
  // play on was queued behind 799 background jobs all fighting for
  // CPU. Four workers = enough throughput to chew through 800 files
  // in a few minutes without starving the renderer.
  prewarmAlacCache = async (paths: string[]) => {
    const CONCURRENCY = 4
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < paths.length) {
        const idx = i++
        const p = paths[idx]
        try {
          const s = await stat(p)
          await aacCachePath(p, s.mtimeMs).catch(() => {})
        } catch { /* file missing — skip */ }
      }
    }
    const workers: Promise<void>[] = []
    for (let w = 0; w < CONCURRENCY; w++) workers.push(worker())
    await Promise.all(workers)
  }

  // Populate the codec cache with a codec we already know (from a rip
  // we just wrote). Eliminates the ~300ms ffprobe delay that shows up
  // on a track's first play even for AAC files.
  registerKnownCodec = (path, mtime, codec) => {
    codecCache.set(path, { mtime, codec })
  }

  protocol.handle('ipod-audio', async (request) => {
    const rawPath = decodeURIComponent(request.url.replace('ipod-audio://', ''))
    let filePath = rawPath
    let ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    try {
      // If the source is ALAC, swap in a cached AAC transcode. Silent
      // fallthrough to the raw file if ffmpeg fails — playback may still
      // work for codecs Chromium does support.
      if (ext === '.m4a' || ext === '.alac' || ext === '.mp4') {
        const srcStat = await stat(rawPath).catch(() => null)
        if (srcStat) {
          const cached = await aacCachePath(rawPath, srcStat.mtimeMs).catch(() => null)
          if (cached) {
            filePath = cached
            ext = '.m4a'
          }
        }
      }
    } catch { /* fall through */ }
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
  // Start watching library.json for external modifications so any
  // Python-script edits or out-of-band rewrites propagate into the
  // running UI instead of getting silently overwritten. Fire after
  // createWindow so mainWindow is defined when the watcher emits.
  startLibraryWatcher()

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
