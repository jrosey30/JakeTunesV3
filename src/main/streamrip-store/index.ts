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
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'fs/promises'
import { ImportedTrackRecord, BatchSummary } from '../bandcamp-integration/acquisition/download-router'
import { rankStreamripCandidates, pickBestSoundcloudMatch, unwantedVersionOf } from '../streamrip-match.ts'
import { recoTitleMatches, recoArtistMatches } from '../reco-match.ts'

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
// Live children — so a mis-click can be CANCELED (Jake, 2026-07-16). Killing
// the rip process aborts the transfer; the staging temp dir is wiped by the
// caller's finally, so a canceled download leaves nothing behind.
const activeProcs = new Set<ReturnType<typeof execFile>>()
function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      activeProcs.delete(child)
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null
      const enoent = e?.code === 'ENOENT'
      const code = typeof e?.code === 'number' ? e.code : (e ? 1 : 0)
      resolve({ code, stdout: stdout || '', stderr: stderr || '', enoent })
    })
    activeProcs.add(child)
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

// ── Qobuz credentials (written into streamrip's own config.toml) ──────────
// streamrip stores Qobuz auth as email + the MD5 hash of the password (with
// use_auth_token=false). We take the plaintext password from the app and hash
// it HERE, so the user never has to compute an MD5 by hand and the password
// never leaves their Mac. app_id/secrets stay blank — streamrip auto-fetches.
function streamripConfigPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'streamrip', 'config.toml')
}
function readQobuzField(cfg: string, key: string): string {
  let inQobuz = false
  for (const ln of cfg.split('\n')) {
    const sec = ln.match(/^\s*\[([^\]]+)\]/)
    if (sec) { inQobuz = sec[1].trim() === 'qobuz'; continue }
    if (!inQobuz) continue
    const m = ln.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`))
    if (m) return m[1].trim()
  }
  return ''
}
function writeQobuzFields(cfg: string, fields: Record<string, string>): string {
  const quoted = new Set(['email_or_userid', 'password_or_token'])
  const lines = cfg.split('\n')
  let inQobuz = false
  for (let i = 0; i < lines.length; i++) {
    const sec = lines[i].match(/^\s*\[([^\]]+)\]/)
    if (sec) { inQobuz = sec[1].trim() === 'qobuz'; continue }
    if (!inQobuz) continue
    for (const key of Object.keys(fields)) {
      const m = lines[i].match(new RegExp(`^(\\s*${key}\\s*=\\s*)`))
      if (m) {
        const v = quoted.has(key) ? `"${fields[key].replace(/"/g, '\\"')}"` : fields[key]
        lines[i] = m[1] + v
      }
    }
  }
  return lines.join('\n')
}

export interface SearchResult { source: string; mediaType: string; id: string; desc: string }

export function registerStreamripStore(deps: StreamripDeps): void {
  type DownloadResult = { ok: boolean; imported?: number; dupes?: number; error?: string }

  // Download stage 1: run a rip subcommand (`url …` or `id …`) into a fresh
  // staging dir and sweep it for audio. The caller decides whether to import
  // (importStaged) or discard (discardStaged) — the split exists so
  // download-by-query can VERIFY a candidate's duration against the version
  // the user actually picked before it ever touches the library
  // (2026-08-07: Qobuz text search shipped a re-recorded Etta James and a
  // live John Mayer; the wrong version must die in staging, not in the app).
  interface StagedRip { staging: string; files: string[] }
  async function stageRip(ripSubcmd: string[]): Promise<{ ok: true; staged: StagedRip } | { ok: false; error: string }> {
    const rip = await resolveRip()
    if (!rip) return { ok: false, error: 'streamrip isn’t installed. Run: pipx install streamrip' }
    let staging = ''
    try {
      staging = await mkdtemp(join(tmpdir(), 'jaketunes-rip-'))
      // --no-db: ignore streamrip's persistent "already downloaded" database.
      // We stage to a throwaway temp dir (wiped every run) and dedupe at import
      // by fingerprint, so that DB can only hurt us — once a track is logged in
      // it, later attempts SKIP it and fetch nothing ("Skipping track … marked
      // as downloaded in the database" → 0 files → 0 imported, no error shown).
      // Always re-fetch; the app owns dedup, not streamrip.
      const res = await run(rip.bin, ['--folder', staging, '--quality', '4', '--no-db', '--no-progress', ...ripSubcmd], 1000 * 60 * 20)
      const files = await collectAudio(staging)
      if (files.length === 0) {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        return { ok: false, error: tailMessage(res) || `streamrip downloaded nothing (exit ${res.code}). That service may need login in streamrip’s config.` }
      }
      return { ok: true, staged: { staging, files } }
    } catch (err) {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function discardStaged(staged: StagedRip): Promise<void> {
    await rm(staged.staging, { recursive: true, force: true }).catch(() => {})
  }

  // ── Bandcamp co-resolver (2026-08-07, Jake: "bandcamp is very much
  // used by me too. use both equally") ─────────────────────────────
  // Bandcamp has no sanctioned automated PURCHASE path — the store view
  // stays the checkout. But its public search + full-track streams give
  // the same honest tier as the SoundCloud fallback ("lossy but complete
  // beats a failed download"), and the scene bands Jake hunts live here
  // when Qobuz has never heard of them. matchDesc says "Bandcamp stream"
  // so the tier is never hidden.
  async function bandcampSearch(text: string, kind: 'a' | 't'): Promise<Array<{ name: string; band: string; url: string }>> {
    try {
      const res = await fetch('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        body: JSON.stringify({ search_text: text, search_filter: kind, fan_id: null, full_page: false }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return []
      const d = await res.json() as { auto?: { results?: Array<{ type?: string; name?: string; band_name?: string; item_url_path?: string }> } }
      return (d.auto?.results || [])
        .filter((r) => r.type === kind && r.name && r.band_name && r.item_url_path)
        .map((r) => ({ name: String(r.name), band: String(r.band_name), url: String(r.item_url_path) }))
    } catch { return [] }
  }

  async function stageBandcamp(url: string): Promise<{ ok: true; staged: StagedRip } | { ok: false; error: string }> {
    let staging = ''
    try {
      staging = await mkdtemp(join(tmpdir(), 'jaketunes-bc-'))
      const res = await run('yt-dlp', ['-x', '--audio-format', 'm4a', '--audio-quality', '0', '--embed-metadata',
        '-o', join(staging, '%(playlist_index|00)02d - %(title)s.%(ext)s'), url], 1000 * 60 * 20)
      const files = await collectAudio(staging)
      if (files.length === 0) {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        return { ok: false, error: tailMessage(res) || `Bandcamp fetch produced nothing (exit ${res.code}).` }
      }
      return { ok: true, staged: { staging, files } }
    } catch (err) {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Real duration + title/album TAGS of a staged file, via ffprobe (PATH
   *  already carries homebrew). null fields = probe unavailable/failed —
   *  treated as "can't judge", never as a mismatch, so a broken ffprobe
   *  can't brick downloads.
   *
   *  Why tags matter (2026-08-07, the As/Is catch): Qobuz's search desc for
   *  the As/Is - Live "Your Body Is a Wonderland" is the CLEAN title, and
   *  that live cut runs 249.75s vs the studio's 249.6s — both the marker
   *  guard and the duration gate sailed right past it. The downloaded
   *  file's own tags said "(Live at Cynthia Woods Mitchell Pavilion…)" /
   *  album "As/Is - Live". The file never lies about itself. */
  async function probeStagedFile(file: string): Promise<{ durSec: number | null; title: string; album: string }> {
    const res = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,album', '-of', 'json', file], 30_000)
    try {
      const parsed = JSON.parse(res.stdout || '{}') as { format?: { duration?: string; tags?: Record<string, string> } }
      const v = parseFloat(parsed.format?.duration || '')
      const tags = parsed.format?.tags || {}
      const tag = (k: string) => String(tags[k] ?? tags[k.toUpperCase()] ?? '').trim()
      return { durSec: Number.isFinite(v) && v > 0 ? v : null, title: tag('title'), album: tag('album') }
    } catch {
      return { durSec: null, title: '', album: '' }
    }
  }

  // Download stage 2: import staged audio into the library + tell the renderer.
  async function importStaged(staged: StagedRip): Promise<DownloadResult> {
    try {
      const summary = await deps.importDownloaded(staged.files, 'streamrip')
      const importedTracks: Array<Record<string, unknown>> = Array.isArray(summary)
        ? (summary as unknown as Array<Record<string, unknown>>)
        : ((summary as unknown as { tracks?: Array<Record<string, unknown>> }).tracks ?? [])
      // CRITICAL: the importer writes to disk + library.json but does NOT tell
      // the renderer to show the tracks — the Bandcamp/squid download-router
      // emitted 'bandcamp:track-imported' per track to do that. We call the
      // importer directly, so we must emit it ourselves, or songs land on disk
      // and silently never appear in the live library (the exact bug reported).
      const win = deps.getMainWindow()
      if (win && !win.isDestroyed()) {
        for (const t of importedTracks) win.webContents.send('bandcamp:track-imported', t)
      }
      const dupes = Array.isArray(summary) ? 0 : ((summary as { dupeCount?: number }).dupeCount ?? 0)
      return { ok: true, imported: importedTracks.length, dupes }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await rm(staged.staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  // Shared download core: stage → import, no verification between. Used by the
  // pasted-link and picked-id paths, where the user chose the exact catalog
  // item themselves. Quality 4 = max the service allows; the app's own import
  // step converts to the user's library format afterward.
  async function runDownload(ripSubcmd: string[]): Promise<DownloadResult> {
    const st = await stageRip(ripSubcmd)
    if (!st.ok) return { ok: false, error: st.error }
    return importStaged(st.staged)
  }

  // Abort every in-flight rip process (download or search). The queue marks
  // the item canceled; the killed process's staging dir is cleaned as usual.
  ipcMain.handle('streamrip:cancel-active', async () => {
    let killed = 0
    for (const c of activeProcs) { try { c.kill('SIGKILL'); killed++ } catch { /* already gone */ } }
    return { ok: true, killed }
  })

  ipcMain.handle('streamrip:status', async () => {
    const rip = await resolveRip()
    return rip ? { ok: true, installed: true, version: rip.version } : { ok: true, installed: false }
  })

  async function searchCatalog(opts: {
    query: string
    source?: string
    mediaType?: string
    numResults?: number
  }): Promise<{ ok: boolean; results?: SearchResult[]; error?: string }> {
    const query = opts.query.trim()
    if (!query) return { ok: false, error: 'Type something to search for.' }
    const source = opts.source || 'qobuz'
    const mediaType = opts.mediaType || 'track'
    const n = Math.min(Math.max(Math.round(opts.numResults || 25), 1), 50)
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
  }

  // Browse: search a source's catalog, return a results list to pick from.
  ipcMain.handle('streamrip:search', async (_e, opts: { query?: string; source?: string; mediaType?: string; numResults?: number }): Promise<{ ok: boolean; results?: SearchResult[]; error?: string }> => {
    return searchCatalog({
      query: opts?.query || '',
      source: opts?.source,
      mediaType: opts?.mediaType,
      numResults: opts?.numResults,
    })
  })

  // One-shot: search Qobuz for artist+title, pick the best match, download + import.
  // Used by Listen to the List and the Download view so the renderer doesn't
  // round-trip search → pick → download. `durationMs` (when the caller knows
  // the exact version — the Download view's iTunes pick carries it) turns on
  // download-time verification: a candidate whose real length is off by more
  // than DURATION_TOLERANCE_SEC is discarded in staging and the next-ranked
  // candidate is tried. Qobuz's desc gives NO album/length, so a live-album
  // cut with a clean title ("Your Body Is a Wonderland" from a live record)
  // is undetectable before download — the file's own clock is the only
  // trustworthy witness.
  const DURATION_TOLERANCE_SEC = 5
  const fmtDur = (s: number | null): string => s == null ? 'unknown length' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  ipcMain.handle('streamrip:download-by-query', async (_e, opts: { artist?: string; title?: string; song?: string; album?: string; durationMs?: number }): Promise<DownloadResult & { matchDesc?: string }> => {
    const artist = (opts?.artist || '').trim()
    // album set WITHOUT a title -> resolve a whole ALBUM on Qobuz; else a single track.
    const wantAlbum = Boolean((opts?.album || '').trim()) && !(opts?.title || opts?.song)
    const title = wantAlbum ? (opts!.album as string).trim() : (opts?.title || opts?.song || '').trim()
    if (!title && !artist) return { ok: false, error: 'Nothing to search for.' }
    const durationMs = !wantAlbum && typeof opts?.durationMs === 'number' && opts.durationMs > 1000 ? opts.durationMs : 0
    const query = [artist, title].filter(Boolean).join(' ')
    const mediaType = wantAlbum ? 'album' : 'track'

    // ── Qobuz first (lossless when it has the track) ──
    const qsearch = await searchCatalog({ query, source: 'qobuz', mediaType, numResults: 25 })
    const { ranked, rejectedVersions } = qsearch.ok && qsearch.results?.length
      ? rankStreamripCandidates(title || query, artist, qsearch.results, mediaType)
      : { ranked: [], rejectedVersions: [] }
    let qobuzMisses: string[] | null = null
    if (ranked.length && durationMs) {
      // Verified path: the caller knows the exact version. Try the top
      // candidates in rank order; a wrong-length file never leaves staging.
      const wantSec = durationMs / 1000
      const albumHint = (opts?.album || '').trim()
      const misses: string[] = []
      // A clean file from the WRONG album (usually a compilation carrying the
      // same studio master) is acceptable — but only if no candidate matches
      // the album the user actually picked. Keep the best such file staged as
      // a fallback while we keep looking for the canonical-album copy.
      let fallback: { staged: StagedRip; desc: string } | null = null
      for (const cand of ranked.slice(0, 3)) {
        const st = await stageRip(['id', cand.source, cand.mediaType, cand.id])
        if (!st.ok) { misses.push(`“${cand.desc}”: ${st.error}`); continue }
        const probe = st.staged.files.length === 1 ? await probeStagedFile(st.staged.files[0]) : null
        // Three independent witnesses, all from the actual file:
        //  · length within tolerance of the version the user picked
        //  · the file's TITLE tag carries no unrequested version marker
        //  · the file's ALBUM tag carries none either (allowing the words of
        //    the requested title + album hint) — catches live-album cuts
        //    whose track title is clean and whose length matches the studio
        //    take (the As/Is 249.75s-vs-249.6s case).
        const durBad = probe?.durSec != null && Math.abs(probe.durSec - wantSec) > DURATION_TOLERANCE_SEC
        const titleMarker = probe?.title ? unwantedVersionOf(title, probe.title) : null
        const albumMarker = probe?.album ? unwantedVersionOf(`${title} ${albumHint}`, probe.album) : null
        if (probe == null || (!durBad && !titleMarker && !albumMarker)) {
          const albumMatches = !albumHint || !probe?.album || recoTitleMatches(albumHint, probe.album)
          if (albumMatches) {
            if (fallback) await discardStaged(fallback.staged)
            const dl = await importStaged(st.staged)
            return { ...dl, matchDesc: cand.desc }
          }
          // Clean but off-album — hold it, prefer a canonical-album copy.
          if (!fallback) { fallback = { staged: st.staged, desc: cand.desc }; continue }
          await discardStaged(st.staged)
          continue
        }
        await discardStaged(st.staged)
        const why = durBad ? `runs ${fmtDur(probe.durSec)}, wanted ${fmtDur(wantSec)}`
          : titleMarker ? `is tagged “${probe.title}” (${titleMarker})`
          : `is from “${probe.album}” (${albumMarker})`
        console.log(`[download] rejected wrong-version candidate for “${title}”: “${cand.desc}” ${why}`)
        misses.push(`“${cand.desc}” ${why}`)
      }
      if (fallback) {
        console.log(`[download] no canonical-album copy of “${title}” on Qobuz — importing clean off-album master (“${fallback.desc}”)`)
        const dl = await importStaged(fallback.staged)
        return { ...dl, matchDesc: fallback.desc }
      }
      // Do NOT return — Bandcamp gets its turn (2026-08-07, "use both
      // equally"); the misses ride along for the final error message.
      qobuzMisses = misses
    }
    if (ranked.length && !qobuzMisses) {
      const qpick = ranked[0]
      const dl = await runDownload(['id', qpick.source, qpick.mediaType, qpick.id])
      return { ...dl, matchDesc: qpick.desc }
    }

    // ── Bandcamp — equal citizen (2026-08-07, Jake: "bandcamp is very
    // much used by me too. use both equally"). Scene bands live here when
    // Qobuz has never heard of them. Full-track stream tier (same honesty
    // class as the SoundCloud fallback); the store view stays the checkout
    // for buying the record properly. Same guards as Qobuz: artist must
    // match, version markers rejected, and with a known duration the
    // staged file must prove itself before import.
    const bcResults = await bandcampSearch(query, wantAlbum ? 'a' : 't')
    const bcPick = bcResults.find((r) =>
      (!artist || recoArtistMatches(artist, r.band)) &&
      recoTitleMatches(title, r.name) &&
      !unwantedVersionOf(title, r.name))
    if (bcPick) {
      const st = await stageBandcamp(bcPick.url)
      if (st.ok) {
        let acceptable = true
        if (!wantAlbum && durationMs && st.staged.files.length === 1) {
          const probe = await probeStagedFile(st.staged.files[0])
          const durBad = probe.durSec != null && Math.abs(probe.durSec - durationMs / 1000) > DURATION_TOLERANCE_SEC
          const marker = probe.title ? unwantedVersionOf(title, probe.title) : null
          if (durBad || marker) acceptable = false
        }
        if (acceptable) {
          console.log(`[download] Bandcamp resolved “${query}” → ${bcPick.url}`)
          const dl = await importStaged(st.staged)
          return { ...dl, matchDesc: `${bcPick.name} — ${bcPick.band} (Bandcamp stream)` }
        }
        await discardStaged(st.staged)
      }
    }

    // ── SoundCloud fallback (2026-07-22, Jake: "auto qobuz first"). Qobuz
    // doesn't carry indie/underground singles (e.g. "Mr Vibe" by
    // Villanova on Indie House Records); SoundCloud does, full-length.
    // Only for single tracks — albums stay Qobuz-only (SoundCloud has no
    // real album concept). Full track, ~128k MP3 (lossy but complete —
    // beats a failed download for a track that exists nowhere lossless).
    if (!wantAlbum) {
      const ssearch = await searchCatalog({ query, source: 'soundcloud', mediaType: 'track', numResults: 15 })
      const spick = ssearch.ok && ssearch.results?.length
        ? pickBestSoundcloudMatch(title || query, artist, ssearch.results)
        : null
      if (spick) {
        console.log(`[download] Qobuz had no match for "${query}" — falling back to SoundCloud: ${spick.desc}`)
        const dl = await runDownload(['id', spick.source, spick.mediaType, spick.id])
        return { ...dl, matchDesc: `${spick.desc} (SoundCloud)` }
      }
    }

    if (!qsearch.ok && !qsearch.results?.length) {
      return { ok: false, error: qsearch.error || `No match for “${query}”.` }
    }
    if (qobuzMisses) {
      return { ok: false, error: `Neither Qobuz nor Bandcamp has the exact version you picked. Qobuz found: ${qobuzMisses.join(' · ')}. Try pasting a link in the Download view.` }
    }
    if (rejectedVersions.length) {
      // Everything that matched was a different recording. Failing loudly beats
      // silently shipping a re-record/live cut (Jake, 2026-08-07).
      return { ok: false, error: `Qobuz only has other versions of “${title}” (${rejectedVersions.slice(0, 3).join(', ')}). Try pasting a link in the Download view.` }
    }
    return { ok: false, error: `Not on Qobuz${wantAlbum ? '' : ' or SoundCloud'}: “${query}”. Try the Download view to search manually.` }
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
      return { ok: false, error: 'Paste a full http(s) link — a Qobuz, Tidal, Deezer, or YouTube URL.' }
    }
    if (/soundcloud\.com/i.test(link)) {   // 4.5: SoundCloud eliminated
      return { ok: false, error: 'SoundCloud isn’t supported — use Qobuz, Tidal, Deezer, or YouTube.' }
    }
    return runDownload(['url', link])
  })

  // Is Qobuz configured? (email + password hash both present)
  ipcMain.handle('streamrip:get-qobuz', async (): Promise<{ ok: boolean; configured: boolean; email?: string }> => {
    try {
      const cfg = await readFile(streamripConfigPath(), 'utf-8')
      const email = readQobuzField(cfg, 'email_or_userid')
      const pw = readQobuzField(cfg, 'password_or_token')
      return { ok: true, configured: !!(email && pw), email }
    } catch {
      return { ok: true, configured: false }
    }
  })

  // Save Qobuz creds: hash the password (MD5, what streamrip wants) and write
  // email + hash into config.toml. use_auth_token forced false (email+password
  // mode). Plaintext password is used only to compute the hash, never stored.
  ipcMain.handle('streamrip:set-qobuz', async (_e, email: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    const e = (email || '').trim()
    const p = password || ''
    if (!e || !p) return { ok: false, error: 'Enter both your Qobuz email and password.' }
    try {
      const path = streamripConfigPath()
      const cfg = await readFile(path, 'utf-8')
      const md5 = createHash('md5').update(p, 'utf8').digest('hex')
      const next = writeQobuzFields(cfg, { use_auth_token: 'false', email_or_userid: e, password_or_token: md5 })
      await writeFile(path, next, 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Google-SSO Qobuz: there is no password, so authenticate with the
  // user_auth_token Qobuz hands the logged-in web player (streamrip's
  // use_auth_token=true mode → user_id + token). The token IS the credential,
  // stored as-is; nothing to hash.
  ipcMain.handle('streamrip:set-qobuz-token', async (_e, userId: string, token: string): Promise<{ ok: boolean; error?: string }> => {
    const u = (userId || '').trim()
    const t = (token || '').trim()
    if (!u || !t) return { ok: false, error: 'Enter both your Qobuz user ID and auth token.' }
    try {
      const path = streamripConfigPath()
      const cfg = await readFile(path, 'utf-8')
      const next = writeQobuzFields(cfg, { use_auth_token: 'true', email_or_userid: u, password_or_token: t })
      await writeFile(path, next, 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
