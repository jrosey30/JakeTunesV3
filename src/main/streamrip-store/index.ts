// ════════════════════════════════════════════════════════════════════════
//  streamrip download store
//
//  Replaces the embedded web-store views (squid.wtf → lucida.to → dab.yeet.su,
//  all dead / Cloudflare-walled / ad-trapped). streamrip is an API-direct CLI
//  downloader (Qobuz / Tidal / Deezer / SoundCloud / YouTube) — no browser, no
//  Cloudflare, no redirect ads, so it can't rot the way an embedded site does.
//
//  The renderer's paste-a-link box calls streamrip:download; we shell out to
//  `rip` into a per-call staging dir, collect whatever audio it writes
//  (recursively — streamrip nests by artist/album), and hand the files to the
//  same importDownloaded() pipeline Bandcamp uses, tagged source='streamrip'.
// ════════════════════════════════════════════════════════════════════════

import { ipcMain, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { mkdtemp, readdir, rm } from 'fs/promises'
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

export function registerStreamripStore(deps: StreamripDeps): void {
  ipcMain.handle('streamrip:status', async () => {
    const rip = await resolveRip()
    if (!rip) return { ok: true, installed: false }
    return { ok: true, installed: true, version: rip.version }
  })

  ipcMain.handle('streamrip:download', async (_e, url: string): Promise<{ ok: boolean; imported?: number; dupes?: number; error?: string }> => {
    const link = (url || '').trim()
    if (!/^https?:\/\//i.test(link)) {
      return { ok: false, error: 'Paste a full http(s) link — a Qobuz, Tidal, Deezer, SoundCloud, or YouTube URL.' }
    }
    const rip = await resolveRip()
    if (!rip) return { ok: false, error: 'streamrip isn’t installed. Run: pipx install streamrip' }

    let staging = ''
    try {
      staging = await mkdtemp(join(tmpdir(), 'jaketunes-rip-'))
      // -q 4 = max quality the service allows; the app's own import converts to
      // the user's chosen library format (iPod-safe), same as every other import.
      const res = await run(rip.bin, ['--folder', staging, '--quality', '4', '--no-progress', 'url', link], 1000 * 60 * 20)
      const files = await collectAudio(staging)
      if (files.length === 0) {
        // Surface streamrip's OWN last words — usually "needs login", a bad/
        // unsupported link, or a geo/availability block.
        const tail = (res.stderr || res.stdout || '')
          .split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 300)
        return { ok: false, error: tail || `streamrip downloaded nothing (exit ${res.code}). That service may need login in streamrip’s config.` }
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
  })
}
