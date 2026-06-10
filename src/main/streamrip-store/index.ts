// ════════════════════════════════════════════════════════════════════════
//  streamrip download store
//
//  Replaces the embedded web-store views (squid.wtf → lucida.to → dab.yeet.su,
//  all dead / Cloudflare-walled / ad-trapped). streamrip is an API-direct CLI
//  downloader (Qobuz / Tidal / Deezer / SoundCloud / YouTube) — no browser, no
//  Cloudflare, no redirect ads, so it can't rot the way an embedded site does.
//
//  Two flows, both ending in the same importDownloaded() pipeline Bandcamp
//  uses (tagged source='streamrip'):
//    • search → `rip search -o <json>` → results list → `rip id <…>`  (browse)
//    • paste a link → `rip url <link>`                                 (direct)
//  Every download writes into a per-call staging dir we recursively sweep for
//  audio, then hand to the importer; the app's own import converts to the
//  user's library format (iPod-safe), same as every other import.
// ════════════════════════════════════════════════════════════════════════

import { ipcMain, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { ImportedTrackRecord, BatchSummary } from '../bandcamp-integration/acquisition/download-router'

export interface StreamripDeps {
  getMainWindow: () => BrowserWindow | null
  /** Same importer Bandcamp uses; we pass source='streamrip'. */
  importDownloaded: (absPaths: string[], source?: string) => Promise<ImportedTrackRecord[] | BatchSummary>
}

// pipx installs the launcher here; an absolute path sidesteps the app's spawn
// PATH (which doesn't include ~/.local/bin). A bare 'rip' is the PATH fallback.
function ripBinary(): string {
  return join(homedir(), '.local', 'bin', 'rip')
}

const AUDIO_EXT = new Set(['.flac', '.m4a', '.mp3', '.aac', '.alac', '.ogg', '.opus', '.wav', '.aiff', '.aif'])

/** Recursively collect audio files streamrip wrote under the staging dir. */
async function collectAudio(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string): Promise<void> {
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else {
        const dot = e.name.lastIndexOf('.')
        if (dot >= 0 && AUDIO_EXT.has(e.name.slice(dot).toLowerCase())) out.push(p)
      }
    }
  }
  await walk(dir)
  return out.sort()
}

interface RunResult { code: number; stdout: string; stderr: string; enoent: boolean }
function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string }) | null
      const enoent = e?.code === 'ENOENT'
      const code = typeof e?.code === 'number' ? e.code : (e ? 1 : 0)
      resolve({ code, stdout: stdout || '', stderr: stderr || '', enoent })
    })
  })
}

/** Resolve a working `rip` invocation (absolute pipx path, else PATH). */
async function resolveRip(): Promise<{ bin: string; version: string } | null> {
  for (const bin of [ripBinary(), 'rip']) {
    const r = await run(bin, ['--version'], 10000)
    if (!r.enoent && r.code === 0) return { bin, version: r.stdout.trim() }
  }
  return null
}

/** Last 1-3 non-empty lines of streamrip's output — its own "needs login" /
 *  bad-link / geo-block message, surfaced verbatim to the user. */
function tailMessage(res: RunResult): string {
  return (res.stderr || res.stdout || '')
    .split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 300)
}

export interface SearchResult { source: string; mediaType: string; id: string; desc: string }

export function registerStreamripStore(deps: StreamripDeps): void {
  type DownloadResult = { ok: boolean; imported?: number; dupes?: number; error?: string }

  // Shared download core: stage → run a rip subcommand (`url …` or `id …`) →
  // sweep for audio → import. Quality 4 = max the service allows; the app's
  // own import step converts to the user's library format afterward.
  async function runDownload(ripSubcmd: string[]): Promise<DownloadResult> {
    const rip = await resolveRip()
    if (!rip) return { ok: false, error: 'streamrip isn’t installed. Run: pipx install streamrip' }
    let staging = ''
    try {
      staging = await mkdtemp(join(tmpdir(), 'jaketunes-rip-'))
      const res = await run(rip.bin, ['--folder', staging, '--quality', '4', '--no-progress', ...ripSubcmd], 1000 * 60 * 20)
      const files = await collectAudio(staging)
      if (files.length === 0) {
        return { ok: false, error: tailMessage(res) || `streamrip downloaded nothing (exit ${res.code}). That service may need login in streamrip’s config.` }
      }
      const summary = await deps.importDownloaded(files, 'streamrip')
      const s = summary as { tracks?: unknown[]; dupeCount?: number }
      const imported = Array.isArray(summary) ? summary.length : (s.tracks?.length ?? 0)
      const dupes = Array.isArray(summary) ? 0 : (s.dupeCount ?? 0)
      return { ok: true, imported, dupes }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  ipcMain.handle('streamrip:status', async () => {
    const rip = await resolveRip()
    return rip ? { ok: true, installed: true, version: rip.version } : { ok: true, installed: false }
  })

  // Browse: search a source's catalog, return a results list to pick from.
  ipcMain.handle('streamrip:search', async (_e, opts: { query?: string; source?: string; mediaType?: string; numResults?: number }): Promise<{ ok: boolean; results?: SearchResult[]; error?: string }> => {
    const query = (opts?.query || '').trim()
    if (!query) return { ok: false, error: 'Type something to search for.' }
    const source = opts?.source || 'soundcloud'
    const mediaType = opts?.mediaType || 'track'
    const n = Math.min(Math.max(Math.round(opts?.numResults || 25), 1), 50)
    const rip = await resolveRip()
    if (!rip) return { ok: false, error: 'streamrip isn’t installed. Run: pipx install streamrip' }
    let dir = ''
    try {
      dir = await mkdtemp(join(tmpdir(), 'jaketunes-ripsearch-'))
      const out = join(dir, 'results.json')
      const res = await run(rip.bin, ['search', '-o', out, '-n', String(n), source, mediaType, query], 1000 * 60)
      let raw = ''
      try { raw = await readFile(out, 'utf-8') } catch { /* no file written */ }
      if (!raw) {
        return { ok: false, error: tailMessage(res) || `No results (exit ${res.code}). ${source} may need login in streamrip’s config.` }
      }
      const parsed = JSON.parse(raw) as Array<{ source?: string; media_type?: string; id?: string; desc?: string }>
      const results: SearchResult[] = parsed
        .filter((r) => r && r.id && r.desc)
        .map((r) => ({ source: r.source || source, mediaType: r.media_type || mediaType, id: String(r.id), desc: String(r.desc) }))
      return { ok: true, results }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // Download a picked search result by its streamrip id.
  ipcMain.handle('streamrip:download-id', async (_e, source: string, mediaType: string, id: string): Promise<DownloadResult> => {
    if (!source || !mediaType || !id) return { ok: false, error: 'Nothing selected to download.' }
    return runDownload(['id', source, mediaType, id])
  })

  // Download a pasted streaming link directly.
  ipcMain.handle('streamrip:download', async (_e, url: string): Promise<DownloadResult> => {
    const link = (url || '').trim()
    if (!/^https?:\/\//i.test(link)) {
      return { ok: false, error: 'Paste a full http(s) link — a Qobuz, Tidal, Deezer, SoundCloud, or YouTube URL.' }
    }
    return runDownload(['url', link])
  })
}
