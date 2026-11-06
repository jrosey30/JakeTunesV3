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

import type { BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { lstat, mkdtemp, readdir, readFile, writeFile, rm } from 'fs/promises'
import { createRipProgress, cutShort, decodedSecFromStats, finishedRipFiles, RIP_HARD_CAP_MS, RIP_PROGRESS_CHECK_MS } from './rip-finish.ts'
import type { ImportedTrackRecord, BatchSummary } from '../bandcamp-integration/acquisition/download-router'
import { NO_EXPLICIT_WARNING, albumFirst, albumVersionOf, bandcampHitDoubt, isCompilationCopy, onWantedAlbum, rankStreamripCandidates, realAlbumTags, titleMatches, rankWithArtistAliases, searchTitle, searchQueryTitle, rankSoundcloudCandidates, unwantedVersionOf, liveBrandMarker, applyExplicitGate, isNoResultsMessage, isQobuzNoSuchItem, parseStreamripDesc, qobuzTrackMetaOf, type QobuzTrackMeta } from '../streamrip-match.ts'
import { buildRequestedAlbum, verifyAlbumCandidate, reconcileAlbumCompletion, describeCompletion, albumAlternativeDesc, orderTracks, parseCountTag, matchLibraryOwnership, ladderBudgetMs, type RequestedAlbum, type CandidateAlbum, type AlbumVerdict, type Ownership, type LibraryTrackLite } from '../album-identity.ts'
import { loadLibraryTracksLite, type ImportRowTags } from '../import-pipeline.ts'
import { itunesAlbumTracks, itunesFindAlbum, itunesSongRows } from '../download-search.ts'
import { asksAppleForLength, buildRequestedRecording, expectedRuntimes, flagToJudge, judgeHitsByMeta, requestedLength, verifyCandidate, finalOutcome, describeOutcome, soundcloudSearchNote, type Alternative, type CandidateEvidence, type DownloadOutcome, type ExpectedRuntime, type Provider } from '../exact-recording.ts'
import { albumToLookFor, ownedAlbumSpelling, ownedAlbumTest, type RealAlbum } from '../../common/real-album.ts'
import { lookUpRealAlbum } from '../real-album-lookup.ts'
import { requestFromSourceEdition, verifySourceEdition } from '../source-edition-verify.ts'
import type { SourceEdition } from '../../common/source-edition.ts'
import { shareSourceKey } from '../../common/source-playlists.ts'
import { recoArtistMatches } from '../reco-match.ts'
import { isAllowedStreamripUrl } from '../url-safety.ts'
import { artistAliases } from '../artist-spellings-store.ts'
import { quietWarn } from '../flight-recorder.ts'

export interface StreamripDeps {
  ipc: IpcRegistrar
  getMainWindow: () => BrowserWindow | null
  /** Same importer Bandcamp uses; we pass source='streamrip', plus the Listen
   *  List row's share source when this job answers one (the row's addedVia). */
  importDownloaded: (absPaths: string[], source?: string, addedVia?: string, rowTags?: ImportRowTags) => Promise<ImportedTrackRecord[] | BatchSummary>
  /** The app's MusicBrainz identity and shared throttle (index.ts mbThrottle). */
  mbThrottle: () => Promise<void>
  mbUserAgent: string
}

// pipx installs the launcher here; an absolute path sidesteps the app's spawn
// PATH (which doesn't include ~/.local/bin). A bare 'rip' is the PATH fallback.
function ripBinary(): string {
  return join(homedir(), '.local', 'bin', 'rip')
}

// Same pipx folder on the MacBook. A bare 'yt-dlp' there was ENOENT whenever the
// app was opened normally: 15 of the 15 Bandcamp fetches in main.log since 10/22
// (Brief 224). homemini's comes from Homebrew, which index.ts adds to PATH, so a
// bare 'yt-dlp' is the fallback. workmini has neither.
function ytDlpBinary(): string {
  return join(homedir(), '.local', 'bin', 'yt-dlp')
}

const AUDIO_EXT = new Set(['.flac', '.m4a', '.mp3', '.aac', '.alac', '.ogg', '.opus', '.wav', '.aiff', '.aif'])

// A failed Qobuz transfer can leave a ZERO-BYTE stub with a healthy
// filename ("file said 4 bytes, read 0 bytes" — live 2026-09-01: '18 and
// Life' and 'Come Sail Away' both imported as tagless ghost rows because
// this collector counted FILES, not bytes, and the wrong-version witness
// passes unreadable probes unjudged). Anything under the floor is a stub:
// dropped here, so a stub-only staging reads as a FAILED download and the
// ladder's designed fallbacks (next candidate, Bandcamp, SoundCloud)
// actually get their turn.
const MIN_AUDIO_BYTES = 64 * 1024
// A Bandcamp file stays the MP3 it was served as, 16 KB a second at 128k, so the
// floor above would refuse any track under 4.1 s (and with it the album it is on).
// yt-dlp only names the audio once the transfer finished, so half a second is enough.
const MIN_BANDCAMP_AUDIO_BYTES = 8 * 1024

/** Recursively collect REAL audio files streamrip wrote under the staging
 *  dir — stubs below the floor are logged and refused. */
async function collectAudio(dir: string, minBytes = MIN_AUDIO_BYTES): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string): Promise<void> {
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else {
        const dot = e.name.lastIndexOf('.')
        if (dot < 0 || !AUDIO_EXT.has(e.name.slice(dot).toLowerCase())) continue
        try {
          const { stat } = await import('fs/promises')
          const st = await stat(p)
          if (st.size < minBytes) {
            console.warn(`[streamrip] refusing ${st.size}-byte stub: ${e.name}`)
            continue
          }
        } catch { continue }
        out.push(p)
      }
    }
  }
  await walk(dir)
  return out.sort()
}

interface RunResult { code: number; stdout: string; stderr: string; enoent: boolean; timedOut?: boolean }
// Live children — so a mis-click can be CANCELED (Jake, 2026-07-16). Killing
// the rip process aborts the transfer; the staging temp dir is wiped by the
// caller's finally, so a canceled download leaves nothing behind.
//
// 6.0 Phase 4: children are KIND-tagged. Cancel kills only 'download'
// children — an in-flight suggestion SEARCH no longer dies because Jake
// canceled a track (the old Set was a global blast radius). The ladder
// also checks cancelRequested between stages, so cancel ends the whole
// fallback ladder, not just the current process.
const activeProcs = new Map<ReturnType<typeof execFile>, 'download' | 'search'>()
let cancelRequested = false
function run(bin: string, args: string[], timeoutMs: number, kind: 'download' | 'search' = 'download', stillMoving?: () => Promise<boolean>): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const child = execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (timer) clearTimeout(timer)
      activeProcs.delete(child)
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null
      const enoent = e?.code === 'ENOENT'
      const code = typeof e?.code === 'number' ? e.code : (e ? 1 : 0)
      resolve({ code, stdout: stdout || '', stderr: stderr || '', enoent, timedOut })
    })
    activeProcs.set(child, kind)
    const atDeadline = async (): Promise<void> => {
      if (stillMoving && Date.now() - started < RIP_HARD_CAP_MS && await stillMoving()) {
        timer = setTimeout(() => { void atDeadline() }, RIP_PROGRESS_CHECK_MS)
        return
      }
      timedOut = true
      child.kill('SIGTERM')
    }
    timer = setTimeout(() => { void atDeadline() }, timeoutMs)
  })
}

/** Every byte under a rip's staging folder: is the transfer still moving? */
async function bytesUnder(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) total += await bytesUnder(p)
    else total += (await lstat(p).catch(() => null))?.size ?? 0
  }
  return total
}

// 6.0 Phase 4: the fallback ladder gets ONE overall clock. Worst case used
// to be unbounded stacked 20-minute timeouts with a single spinner; now a
// download attempt has this much wall time TOTAL, and each stage's process
// timeout is clamped to what remains.
const LADDER_DEADLINE_MS = 12 * 60 * 1000
function ladderClock(budgetMs = LADDER_DEADLINE_MS): { remaining: () => number; expired: () => boolean; budgetMs: number } {
  const deadline = Date.now() + budgetMs
  return {
    remaining: () => Math.max(0, deadline - Date.now()),
    expired: () => Date.now() >= deadline,
    budgetMs,
  }
}

/** Resolve a working `rip` invocation (absolute pipx path, else PATH). */
async function resolveRip(): Promise<{ bin: string; version: string } | null> {
  for (const bin of [ripBinary(), 'rip']) {
    const r = await run(bin, ['--version'], 10000)
    if (!r.enoent && r.code === 0) return { bin, version: r.stdout.trim() }
  }
  return null
}

/**
 * Why `rip` didn't resolve — INSTALLED-BUT-BROKEN is a different problem
 * from NOT-INSTALLED, and telling Jake to install something he already has
 * sends him in a circle.
 *
 * 2026-08-08, live: streamrip 2.1.0 was installed and on disk, but Pillow's
 * compiled _imaging linked against /opt/homebrew/opt/openjpeg/lib/
 * libopenjp2.7.dylib, which a Homebrew change had removed. `rip --version`
 * died with an ImportError, exited non-zero, and the store reported "not
 * installed" — so the suggested fix (`pipx install streamrip`) would have
 * answered "already installed" and left him stuck. The real fix was one
 * `brew install openjpeg`. The traceback said so; nothing surfaced it.
 */
async function ripDiagnosis(): Promise<string> {
  const r = await run(ripBinary(), ['--version'], 10000)
  if (r.enoent) {
    const p = await run('rip', ['--version'], 10000)
    if (p.enoent) return 'streamrip isn’t installed. Run: pipx install streamrip'
  }
  const out = `${r.stderr || ''}\n${r.stdout || ''}`
  const dylib = out.match(/Library not loaded: (\S+)/)
  if (dylib) {
    // Homebrew names the formula after the lib in the overwhelming majority
    // of cases (…/opt/<formula>/lib/…), so name it rather than make him read
    // a traceback.
    const formula = dylib[1].match(/\/opt\/([^/]+)\//)?.[1]
    return `streamrip is installed but can’t start: a library it needs is missing (${dylib[1]}).`
      + (formula ? ` Fix it with: brew install ${formula}` : '')
  }
  const last = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0]
  return last
    ? `streamrip is installed but failed to start: ${last.slice(0, 200)}`
    : 'streamrip isn’t installed. Run: pipx install streamrip'
}

/** Last 1-3 non-empty lines of streamrip's output — its own "needs login" /
 *  bad-link / geo-block message, surfaced verbatim to the user. */
function tailMessage(res: RunResult): string {
  const lines = (res.stderr || res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
  // streamrip prints rich tracebacks in box-drawing frames; the last three
  // lines are usually the frame, not the reason. Prefer the exception line.
  const exc = [...lines].reverse().find((l) => /^[A-Za-z_.]*(Error|Exception)\b/.test(l))
  if (exc) {
    // SoundCloud moved its catalog behind encrypted HLS (2026-09): the plain
    // MP3 stream 404s and streamrip's client dies on the missing key. Name it.
    if (/KeyError: 'url'/.test(exc) && /soundcloud/i.test(res.stderr || '')) return 'SoundCloud no longer streams this track openly'
    return exc.slice(0, 200)
  }
  return lines.filter((l) => !/^[│╭╰─┃┏┗━]/.test(l)).slice(-3).join(' ').slice(0, 300)
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

/** 6.0 Phase 4: orphaned staging dirs from a crash/kill mid-download used
 *  to live in tmpdir forever (cleanup was finally-only, and the same class
 *  left 404 iTunesDB temps totaling 6.3GB on the NAS). Sweep our own
 *  prefixes at boot — anything older than an hour is a corpse. */
async function sweepOrphanedStaging(): Promise<void> {
  const prefixes = ['jaketunes-rip-', 'jaketunes-bc-', 'jaketunes-ripsearch-', 'jaketunes-itunesdb-']
  try {
    const entries = await readdir(tmpdir(), { withFileTypes: true })
    let swept = 0
    for (const e of entries) {
      if (!prefixes.some((p) => e.name.startsWith(p))) continue
      const p = join(tmpdir(), e.name)
      try {
        const { stat } = await import('fs/promises')
        const st = await stat(p)
        if (Date.now() - st.mtimeMs < 3600_000) continue   // possibly live
        await rm(p, { recursive: true, force: true })
        swept++
      } catch { /* raced with its owner — leave it */ }
    }
    if (swept) console.log(`[streamrip] swept ${swept} orphaned staging dir(s)`)
  } catch { /* tmpdir unreadable — nothing to do */ }
}

export function registerStreamripStore(deps: StreamripDeps): void {
  setTimeout(() => { void sweepOrphanedStaging() }, 30_000).unref()
  const { ipc } = deps
  /** outcome + alternatives (6.0 Phase 1): the structured verdict behind the
   *  message — 'exact-not-found' with the candidates that were judged and
   *  why each failed, so a future approval UI can offer them instead of the
   *  app silently picking one. */
  type DownloadResult = { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: DownloadOutcome; alternatives?: Alternative[]; primary?: string; detail?: string; importedTitles?: string[]; dupeFiles?: string[]; completion?: string }

  // Download stage 1: run a rip subcommand (`url …` or `id …`) into a fresh
  // staging dir and sweep it for audio. The caller decides whether to import
  // (importStaged) or discard (discardStaged) — the split exists so
  // download-by-query can VERIFY a candidate's duration against the version
  // the user actually picked before it ever touches the library
  // (2026-08-07: Qobuz text search shipped a re-recorded Etta James and a
  // live John Mayer; the wrong version must die in staging, not in the app).
  interface StagedRip { staging: string; files: string[] }
  /// The last staging failure's stderr tail, so the final "no source had it"
  /// verdict can tell a NETWORK failure apart from a genuine miss (2026-09-03:
  /// ten Sister Nancy tracks "no source had it" while the laptop's link was
  /// flapping — streamrip exited 1 on every one and nothing said why).
  let lastStageFailure: string | null = null
  async function stageRip(ripSubcmd: string[], maxMs = 1000 * 60 * 20): Promise<{ ok: true; staged: StagedRip } | { ok: false; error: string }> {
    lastStageFailure = null
    const rip = await resolveRip()
    if (!rip) return { ok: false, error: await ripDiagnosis() }
    let staging = ''
    try {
      staging = await mkdtemp(join(tmpdir(), 'jaketunes-rip-'))
      // --no-db: ignore streamrip's persistent "already downloaded" database.
      // We stage to a throwaway temp dir (wiped every run) and dedupe at import
      // by fingerprint, so that DB can only hurt us — once a track is logged in
      // it, later attempts SKIP it and fetch nothing ("Skipping track … marked
      // as downloaded in the database" → 0 files → 0 imported, no error shown).
      // Always re-fetch; the app owns dedup, not streamrip.
      //
      // 6.0 Phase 4: one retry with backoff — a transient blip on a long
      // FLAC transfer used to be a total loss. The retry wipes the staging
      // dir first (partial files must never survive into collectAudio),
      // respects cancel, and fits inside the caller's remaining clock.
      const attempts = 2
      const wipeStaging = (p: string): Promise<void> =>
        rm(p, { recursive: true, force: true }).catch((err) =>
          quietWarn('streamrip-staging-wipe', '[streamrip] staging cleanup failed:', err instanceof Error ? err.message : err))
      let res: RunResult = { code: 1, stdout: '', stderr: '', enoent: false }
      const started = Date.now()
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (cancelRequested) break
        if (attempt > 1) {
          await wipeStaging(staging)
          staging = await mkdtemp(join(tmpdir(), 'jaketunes-rip-'))
          await new Promise((r) => setTimeout(r, 3000))
        }
        const left = maxMs - (Date.now() - started)
        if (left < 15000) break
        const here = staging
        res = await run(rip.bin, ['--folder', staging, '--quality', '4', '--no-db', '--no-progress', ...ripSubcmd], left, 'download', createRipProgress(() => bytesUnder(here)))
        // Stopped mid-transfer: what's there is cut off under its final name. Nothing it left counts.
        if (res.timedOut) {
          console.warn(`[streamrip] stopped: no new bytes past the deadline (${Math.round((Date.now() - started) / 60000)} min). Nothing imported.`)
          await wipeStaging(staging)
          return { ok: false, error: 'The connection was too slow to finish this download. Nothing was imported, so try again on a better connection.' }
        }
        const got = await wholeRipFiles(await finishedRipFiles(await collectAudio(staging), probeStagedFile))
        if (got.length > 0) return { ok: true, staged: { staging, files: got } }
        if (cancelRequested) break
        const why = tailMessage(res)
        console.warn(`[streamrip] attempt ${attempt}/${attempts} produced nothing (exit ${res.code})${why ? ` — ${why}` : ''}${attempt < attempts ? ' — retrying' : ''}`)
        if (res.code !== 0) lastStageFailure = why || `exit ${res.code}`
      }
      await wipeStaging(staging)
      if (cancelRequested) return { ok: false, error: 'canceled' }
      return { ok: false, error: tailMessage(res) || `streamrip downloaded nothing (exit ${res.code}).${ripSubcmd[1] === 'soundcloud' ? '' : ' That service may need login in streamrip’s config.'}` }
    } catch (err) {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: safeIpcError(err, 'tool-failed') }
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
  // `noAnswer` is not "nothing on Bandcamp". A bot check comes back as 200 and an HTML
  // page titled "Client Challenge" (2026-11-04: 23 of 24 calls from plain Node across
  // the three machines, none of 3 from Electron, none from curl), and reading that as
  // zero results made the verdict say Bandcamp had nothing when it had the song. This
  // reports it. It does not try to get past it.
  async function bandcampSearch(text: string, kind: 'a' | 't'): Promise<{ hits: Array<{ name: string; band: string; url: string; album: string | null }> } | { noAnswer: string }> {
    try {
      const res = await fetch('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        body: JSON.stringify({ search_text: text, search_filter: kind, fan_id: null, full_page: false }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { noAnswer: `HTTP ${res.status}` }
      if (!(res.headers.get('content-type') || '').includes('json')) return { noAnswer: 'a web page instead of results' }
      const d = await res.json() as { auto?: { results?: Array<{ type?: string; name?: string; band_name?: string; item_url_path?: string; album_name?: string | null }> } }
      return {
        hits: (d.auto?.results || [])
          .filter((r) => r.type === kind && r.name && r.band_name && r.item_url_path)
          .map((r) => ({ name: String(r.name), band: String(r.band_name), url: String(r.item_url_path), album: r.album_name ? String(r.album_name) : null })),
      }
    } catch (err) { return { noAnswer: err instanceof Error ? err.message : 'no answer' } }
  }

  async function stageBandcamp(url: string): Promise<{ ok: true; staged: StagedRip } | { ok: false; error: string }> {
    let staging = ''
    try {
      staging = await mkdtemp(join(tmpdir(), 'jaketunes-bc-'))
      // The file as Bandcamp serves it (Brief 224). `-x --audio-format m4a` turned
      // 128k MP3s into AACs of 345k and up: about three times the bytes, no better
      // sound, and files that then looked high quality (44 are in the library). The
      // import copies MP3 and AAC untouched and converts lossless
      // (shouldConvertOnImport), so nothing downstream needs m4a. Never
      // --allow-unplayable-formats: a locked upload stays refused.
      const args = ['--embed-metadata', '-o', join(staging, '%(playlist_index|00)02d - %(title)s.%(ext)s'), url]
      let res = await run(ytDlpBinary(), args, 1000 * 60 * 20)
      if (res.enoent) res = await run('yt-dlp', args, 1000 * 60 * 20)
      if (res.enoent) {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        // A pipx launcher whose Python is gone is ENOENT too, and "install it" would
        // answer "already installed" and send Jake in a circle (see ripDiagnosis).
        const launcherThere = await lstat(ytDlpBinary()).then(() => true, () => false)
        return { ok: false, error: launcherThere
          ? 'yt-dlp is installed but can’t start: the Python it runs on is gone. Run: pipx reinstall yt-dlp'
          : 'yt-dlp isn’t installed on this Mac, so Bandcamp can’t be fetched here. Run: pipx install yt-dlp' }
      }
      const files = await collectAudio(staging, MIN_BANDCAMP_AUDIO_BYTES)
      if (files.length === 0) {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        return { ok: false, error: tailMessage(res) || `Bandcamp fetch produced nothing (exit ${res.code}).` }
      }
      return { ok: true, staged: { staging, files } }
    } catch (err) {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: safeIpcError(err, 'tool-failed') }
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
  interface StagedProbe { durSec: number | null; title: string; album: string; artist: string; albumArtist: string; trackNumber?: number; trackTotal?: number; discNumber?: number; discTotal?: number }
  /** Decode each file to its end: a header says the whole song even when the bytes stop early. */
  async function wholeRipFiles(files: string[]): Promise<string[]> {
    const out: string[] = []
    for (const file of files) {
      const probe = await probeStagedFile(file)
      const res = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-stats', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], 5 * 60_000, 'search')
      const decoded = decodedSecFromStats(res.stderr)
      if (cutShort(probe.durSec, decoded)) console.warn(`[streamrip] refusing a cut-off file: ${file.slice(file.lastIndexOf('/') + 1)} decodes to ${decoded}s of ${probe.durSec}s`)
      else out.push(file)
    }
    return out
  }

  async function probeStagedFile(file: string): Promise<StagedProbe> {
    // track/disc read "2/15" style; the album contract orders the staged
    // files by them and checks the disc structure of the edition.
    const res = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,album,artist,album_artist,track,disc', '-of', 'json', file], 30_000)
    try {
      const parsed = JSON.parse(res.stdout || '{}') as { format?: { duration?: string; tags?: Record<string, string> } }
      const v = parseFloat(parsed.format?.duration || '')
      const tags = parsed.format?.tags || {}
      const tag = (k: string) => String(tags[k] ?? tags[k.toUpperCase()] ?? '').trim()
      const tr = parseCountTag(tag('track')), di = parseCountTag(tag('disc'))
      return { durSec: Number.isFinite(v) && v > 0 ? v : null, title: tag('title'), album: tag('album'), artist: tag('artist'), albumArtist: tag('album_artist'), trackNumber: tr.n, trackTotal: tr.of, discNumber: di.n, discTotal: di.of }
    } catch {
      return { durSec: null, title: '', album: '', artist: '', albumArtist: '' }
    }
  }

  /** The album's own cover, for a copy whose file carries a compilation's. Any trouble: none. */
  async function fetchAlbumCover(urls: string[]): Promise<Uint8Array | undefined> {
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': deps.mbUserAgent } })
        if (!res.ok) continue
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (bytes.length > 1024) return bytes
      } catch { /* the next, or none */ }
    }
    return undefined
  }

  // Download stage 2: import staged audio into the library + tell the renderer.
  async function importStaged(staged: StagedRip, opts: { only?: string[]; addedVia?: string; rowTags?: ImportRowTags } = {}): Promise<DownloadResult> {
    try {
      // `only` = the album contract's pick of files whose tracks are NOT
      // already owned; everything else in staging is discarded with it.
      const summary = await deps.importDownloaded(opts.only ?? staged.files, 'streamrip', opts.addedVia, opts.rowTags)
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
      const dupeFiles = Array.isArray(summary) ? [] : (((summary as { dupes?: Array<{ src: string }> }).dupes ?? []).map((d) => d.src))
      return { ok: true, imported: importedTracks.length, dupes, importedTitles: importedTracks.map((t) => String(t.title ?? '')), dupeFiles }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'tool-failed') }
    } finally {
      await rm(staged.staging, { recursive: true, force: true }).catch(() => {})
    }
  }

  // Shared download core: stage → import, no verification between. Used by the
  // pasted-link and picked-id paths, where the user chose the exact catalog
  // item themselves. Quality 4 = max the service allows; the app's own import
  // step converts to the user's library format afterward.
  async function runDownload(ripSubcmd: string[], addedVia?: string): Promise<DownloadResult> {
    const st = await stageRip(ripSubcmd)
    if (!st.ok) return { ok: false, error: st.error }
    return importStaged(st.staged, { addedVia })
  }

  // Abort every in-flight rip process (download or search). The queue marks
  // the item canceled; the killed process's staging dir is cleaned as usual.
  ipc.handle('streamrip:cancel-active', async () => {
    let killed = 0
    cancelRequested = true
    for (const [c, kind] of activeProcs) {
      if (kind !== 'download') continue   // searches survive a track cancel
      try { c.kill('SIGKILL'); killed++ } catch { /* already gone */ }
    }
    return { ok: true, killed }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('streamrip:status', async () => {
    const rip = await resolveRip()
    // When it isn't usable, say WHY — "not installed" and "installed but
    // its Homebrew dependency vanished" need different fixes (2026-08-08).
    return rip
      ? { ok: true, installed: true, version: rip.version }
      : { ok: true, installed: false, reason: await ripDiagnosis() }
  }, { public: true })

  // ── Qobuz metadata witness (2026-08-16, the clean-version gate) ──────
  // streamrip's search JSON is too slim to distinguish editions (measured:
  // five identical "Mask Off by Future" descs hiding a 204s album cut, two
  // 258s remixes, and the parental flags). The metadata endpoint answers
  // with the SAME credentials streamrip already holds; values are read per
  // call and never logged. Fail-soft everywhere: a hiccup yields absent
  // entries, and absent entries pass the gate unjudged.
  async function readQobuzCreds(): Promise<{ appId: string; token: string } | null> {
    try {
      const cfgPath = join(homedir(), 'Library', 'Application Support', 'streamrip', 'config.toml')
      const raw = await readFile(cfgPath, 'utf-8')
      const q = raw.split(/^\[qobuz\]/m)[1]?.split(/^\[/m)[0] || ''
      const pick = (key: string): string => {
        const m = q.match(new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'm'))
        return m ? m[1] : ''
      }
      const appId = pick('app_id')
      const token = pick('password_or_token') || pick('token')
      return appId && token ? { appId, token } : null
    } catch { return null }
  }

  /** One metadata call. 'gone' only on Qobuz's own 404; any other trouble is null,
   *  which is no answer, and no answer is unjudged. A redirect would carry the token
   *  with it, so that is no answer too. */
  async function qobuzGet(path: string, creds: { appId: string; token: string }, timeoutMs: number): Promise<{ body: unknown } | 'gone' | null> {
    try {
      const res = await fetch(
        'https://www.qobuz.com/api.json/0.2/' + path + '&app_id=' + creds.appId,
        { headers: { 'X-User-Auth-Token': creds.token, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' },
      )
      if (res.status === 404) return isQobuzNoSuchItem(await res.json().catch(() => null)) ? 'gone' : null
      return res.ok ? { body: await res.json() } : null
    } catch { return null }
  }

  async function qobuzAlbumMeta(ids: string[], gone?: Set<string>): Promise<Map<string, QobuzTrackMeta>> {
    const out = new Map<string, QobuzTrackMeta>()
    const creds = await readQobuzCreds()
    if (!creds || ids.length === 0) return out
    await Promise.all(ids.map(async (id) => {
      const answer = await qobuzGet('album/get?album_id=' + encodeURIComponent(id), creds, 6000)
      if (answer === 'gone') { gone?.add(id); return }
      if (!answer) return
      const d = answer.body as { parental_warning?: boolean; tracks_count?: number; version?: string | null; title?: string }
      out.set(id, {
        parentalWarning: typeof d.parental_warning === 'boolean' ? d.parental_warning : undefined,
        durationSec: undefined,
        album: d.title,
        version: d.version ?? null,
      })
    }))
    return out
  }

  /** The album's own tracklist — the ALBUM DOOR. Qobuz's TRACK search
   *  misses songs its catalogue carries (2026-08-29: every track of
   *  Vacations' "Pursuit of Anything" was downloadable by id while track
   *  search returned 1957 Mose Allison), so when the caller names the
   *  album we can walk in through album/get and pick the track by id. */
  interface QobuzAlbumListing {
    title?: string; artist?: string; version?: string | null; tracksCount?: number; mediaCount?: number; upc?: string
    releaseDate?: string; releaseYear?: number; parentalWarning?: boolean
    tracks: Array<{ id: string; title: string; durationSec?: number; streamable?: boolean; trackNumber?: number; discNumber?: number; parentalWarning?: boolean; performer?: string }>
  }
  async function qobuzAlbumTrackList(albumId: string): Promise<QobuzAlbumListing> {
    const creds = await readQobuzCreds()
    if (!creds) return { tracks: [] }
    try {
      const answer = await qobuzGet('album/get?album_id=' + encodeURIComponent(albumId), creds, 8000)
      if (!answer || answer === 'gone') return { tracks: [] }
      const d = answer.body as { title?: string; version?: string | null; artist?: { name?: string }; tracks_count?: number; media_count?: number; upc?: string; parental_warning?: boolean; release_date_original?: string; release_date_stream?: string; tracks?: { items?: Array<{ id?: number | string; title?: string; version?: string | null; duration?: number; streamable?: boolean; track_number?: number; media_number?: number; parental_warning?: boolean; performer?: { name?: string } }> } }
      const releaseDate = typeof d.release_date_stream === 'string' ? d.release_date_stream : undefined
      const original = typeof d.release_date_original === 'string' ? d.release_date_original : releaseDate
      return {
        title: typeof d.title === 'string' ? d.title : undefined,
        artist: typeof d.artist?.name === 'string' ? d.artist.name : undefined,
        version: typeof d.version === 'string' ? d.version : null,
        tracksCount: typeof d.tracks_count === 'number' ? d.tracks_count : undefined,
        mediaCount: typeof d.media_count === 'number' ? d.media_count : undefined,
        upc: typeof d.upc === 'string' ? d.upc : undefined,
        parentalWarning: typeof d.parental_warning === 'boolean' ? d.parental_warning : undefined,
        releaseDate,
        releaseYear: original && /^\d{4}/.test(original) ? Number(original.slice(0, 4)) : undefined,
        tracks: (d.tracks?.items || [])
          .filter((t) => t && t.id != null && t.title)
          // Qobuz keeps "Live"/"Remix" in a separate version field; the
          // tracklist compare must see it as part of the title.
          .map((t) => ({ id: String(t.id), title: t.version ? `${t.title} (${t.version})` : String(t.title), durationSec: typeof t.duration === 'number' ? t.duration : undefined, streamable: typeof t.streamable === 'boolean' ? t.streamable : undefined, trackNumber: typeof t.track_number === 'number' ? t.track_number : undefined, discNumber: typeof t.media_number === 'number' ? t.media_number : undefined, parentalWarning: typeof t.parental_warning === 'boolean' ? t.parental_warning : undefined, performer: typeof t.performer?.name === 'string' ? t.performer.name : undefined })),
      }
    } catch { return { tracks: [] } }
  }

  async function qobuzTrackMeta(ids: string[], gone?: Set<string>): Promise<Map<string, QobuzTrackMeta>> {
    const out = new Map<string, QobuzTrackMeta>()
    const creds = await readQobuzCreds()
    if (!creds || ids.length === 0) return out
    await Promise.all(ids.map(async (id) => {
      const answer = await qobuzGet('track/get?track_id=' + encodeURIComponent(id), creds, 6000)
      if (answer === 'gone') { gone?.add(id); return }
      if (answer) out.set(id, qobuzTrackMetaOf(answer.body as Parameters<typeof qobuzTrackMetaOf>[0]))
    }))
    return out
  }

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
    if (!rip) return { ok: false, error: await ripDiagnosis() }
    let dir = ''
    try {
      dir = await mkdtemp(join(tmpdir(), 'jaketunes-ripsearch-'))
      const out = join(dir, 'results.json')
      const res = await run(rip.bin, ['search', '-o', out, '-n', String(n), source, mediaType, query], 1000 * 60, 'search')
      let raw = ''
      try { raw = await readFile(out, 'utf-8') } catch { /* no file written */ }
      if (!raw) {
        const why = tailMessage(res)
        // "No search results found for query …" is the catalogue answering
        // "nothing here" — an EMPTY result, not a failed provider.
        if (isNoResultsMessage(why)) return { ok: true, results: [] }
        return { ok: false, error: why || `No results (exit ${res.code}).${source === 'soundcloud' ? '' : ` ${source} may need login in streamrip’s config.`}` }
      }
      const parsed = JSON.parse(raw) as Array<{ source?: string; media_type?: string; id?: string; desc?: string }>
      const results: SearchResult[] = parsed
        .filter((r) => r && r.id && r.desc)
        .map((r) => ({ source: r.source || source, mediaType: r.media_type || mediaType, id: String(r.id), desc: String(r.desc) }))
      return { ok: true, results }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'tool-failed') }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // Browse: search a source's catalog, return a results list to pick from.
  ipc.handle('streamrip:search', async (_e, opts: { query?: string; source?: string; mediaType?: string; numResults?: number }): Promise<{ ok: boolean; results?: SearchResult[]; error?: string }> => {
    return searchCatalog({
      query: opts?.query || '',
      source: opts?.source,
      mediaType: opts?.mediaType,
      numResults: opts?.numResults,
    })
  }, { refuse: REFUSED_SENDER })

  // One-shot: search Qobuz for artist+title, pick the best match, download + import.
  // Used by Listen to the List and the Download view so the renderer doesn't
  // round-trip search → pick → download. `durationMs` (when the caller knows
  // the exact version — the Download view's iTunes pick carries it) turns on
  // download-time verification: a candidate whose real length is off by more
  // than the request's tolerance (exact-recording.ts requestedLength) is
  // discarded in staging and the next-ranked candidate is tried. Qobuz's desc
  // gives NO album/length, so a live-album cut with a clean title ("Your Body
  // Is a Wonderland" from a live record) is undetectable before download — the
  // file's own clock is the only trustworthy witness. A clean row has no clock. A row
  // with no `durationMs`, every Listen List row among them, asks Apple for one first.
  const fmtDur = (s: number | null): string => s == null ? 'unknown length' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  ipc.handle('streamrip:download-by-query', async (_e, opts: { sourceEdition?: SourceEdition; artist?: string; title?: string; song?: string; album?: string; durationMs?: number; cleanedSource?: boolean; explicitSource?: boolean; releaseYear?: number; collectionId?: number; trackCount?: number; addedVia?: string }): Promise<DownloadResult & { matchDesc?: string }> => {
    cancelRequested = false            // new attempt = clean slate
    lastStageFailure = null            // never let an OLD rip's error explain THIS request
    const addedVia = shareSourceKey(opts?.addedVia)   // every import below lands with it
    const artist = (opts?.artist || '').trim()
    // album set WITHOUT a title -> resolve a whole ALBUM on Qobuz; else a single track.
    const wantAlbum = Boolean((opts?.album || '').trim()) && !(opts?.title || opts?.song)
    const title = wantAlbum ? (opts!.album as string).trim() : (opts?.title || opts?.song || '').trim()
    // An album's clock is sized to the album (ladderBudgetMs) — the flat
    // 12 minutes gave up mid-rip on a 12-track Deluxe on 2026-09-05.
    const clock = ladderClock(ladderBudgetMs(wantAlbum, opts?.trackCount))
    /// Every decision on the ladder, printed with the failure so a "didn't
    /// work" has a cause in main.log (2026-09-04: Watch the Throne failed with
    /// no line saying why; info-level logs never reach main.log).
    const trace: string[] = []
    const gaveUp = (): { ok: false; error: string } => {
      // The trace used to die with the clock — "Gave up" left main.log empty.
      console.warn(`[download] GAVE UP “${title}” — ${artist} after ${Math.round(clock.budgetMs / 60000)} min: ${trace.join(' | ')}`)
      return { ok: false, error: `Gave up after ${Math.round(clock.budgetMs / 60000)} minutes of fallbacks — the services are slow right now. Try again, or paste a link in the Download view.` }
    }
    if (!title && !artist) return { ok: false, error: 'Nothing to search for.' }
    const durationMs = !wantAlbum && typeof opts?.durationMs === 'number' && opts.durationMs > 1000 ? opts.durationMs : 0
    // Search by the song's NAME, not by iTunes' edition metadata. iTunes hands
    // us things like "Mo Money Mo Problems (feat. Ma$e & Puff Daddy) [Amended]"
    // and "Life After Death [Amended Version] (2014 Remaster)"; asking a
    // catalogue for those by name matches nothing, or matches the censored cut.
    const lookFor = searchTitle(title) || title
    // The QUERY drops masked tokens ("N****s Bleed" -> "Bleed"); a catalogue
    // cannot be searched for asterisks. Ranking still uses the full masked
    // title, so the right row is recognised when it comes back.
    const query = [artist, searchQueryTitle(title) || lookFor].filter(Boolean).join(' ')
    const mediaType = wantAlbum ? 'album' : 'track'

    // ── Qobuz first (lossless when it has the track) ──
    let qsearch = await searchCatalog({ query, source: 'qobuz', mediaType, numResults: 25 })
    trace.push(`qobuz search “${query}”: ${qsearch.ok ? `${qsearch.results?.length ?? 0} results` : `ERR ${qsearch.error}`}`)
    // Second chance (2026-09-04, XTC "Drums and Wires (Bonus Track Version)"):
    // a packaging label the stripper did not know left the query too literal
    // and Qobuz answered nothing. Ask again with every bracket dropped — the
    // candidates that come back are still ranked and judged like any other.
    const bare = [artist, (searchQueryTitle(title) || lookFor).replace(/\s*[([{][^)\]}]*[)\]}]/g, '').replace(/\s{2,}/g, ' ').trim()].filter(Boolean).join(' ')
    if (qsearch.ok && (qsearch.results?.length ?? 0) === 0 && bare && bare !== query) {
      qsearch = await searchCatalog({ query: bare, source: 'qobuz', mediaType, numResults: 25 })
      trace.push(`qobuz retry “${bare}”: ${qsearch.ok ? `${qsearch.results?.length ?? 0} results` : `ERR ${qsearch.error}`}`)
    }
    // 2026-11-03: Qobuz files The English Beat as "The Beat". When only another
    // name for the artist stands in the way, MusicBrainz is asked once; the same
    // names then let the staged file's tags through the judge.
    // A song may also come back under another way of writing its credit ("Oma" for
    // "OMA & SitarNik"). The judge below reads the same length: a clean row has none.
    // A row that came with no length asks Apple what the recording runs (2026-11-05).
    // Any trouble is no length: the guard stays out of it, not the download.
    // ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripWalk.ts walkDownload.
    let runtimes: ExpectedRuntime[] = []
    if (!wantAlbum && title && artist && asksAppleForLength({ title, album: opts?.album, durationMs, cleanedSource: opts?.cleanedSource, explicitSource: opts?.explicitSource })) {
      const rows = await itunesSongRows(lookFor, artist)
      runtimes = expectedRuntimes({ title, artist, album: opts?.album }, rows ?? [])
      trace.push(rows === null ? 'apple: no answer, so no length' : runtimes.length ? `apple lists ${runtimes.map((r) => `${fmtDur(r.sec)} ±${r.tolSec}`).join(', ')}` : 'apple: no length for this recording')
    }
    const clocked = runtimes.length > 0 || requestedLength({ title, album: opts?.album, durationMs, cleanedSource: opts?.cleanedSource }).durationSec > 0
    const { ranked, rejectedVersions, aliases } = qsearch.ok && qsearch.results?.length
      ? await rankWithArtistAliases(lookFor || query, artist, qsearch.results, mediaType, (a) => artistAliases(a, { throttle: deps.mbThrottle, userAgent: deps.mbUserAgent }), wantAlbum ? undefined : { clocked })
      : { ranked: [], rejectedVersions: [], aliases: [] as string[] }
      if (aliases.length) trace.push(`“${artist}” also goes by ${aliases.slice(0, 4).map((a) => `“${a}”`).join(', ')} (MusicBrainz)`)
      trace.push(`ranked ${ranked.length}${rejectedVersions.length ? `, rejected versions ${rejectedVersions.length}` : ''}${ranked[0] ? ` — top “${ranked[0].desc}”` : ''}`)
    // ── The identity contract (6.0 Phase 1). ONE judge for every lane:
    // the clicked row's identity, and each staged file must prove it is
    // that recording before it can touch the library. Every rejection is
    // kept as a structured alternative for the verdict at the end.
    const req = buildRequestedRecording({
      artist, artistAliases: aliases, title, album: opts?.album, durationMs, runtimes,
      releaseYear: opts?.releaseYear, cleanedSource: opts?.cleanedSource, explicitSource: opts?.explicitSource,
    })
    if (durationMs && !req.durationSec) trace.push(`no length: ${fmtDur(durationMs / 1000)} is the clean row's`)
    // ── The song's real album (JakeTunesMobile Brief 231). A store's first hit for a hit song
    // is a compilation, and so can be the row's own album. MusicBrainz says which album to look
    // for: common/real-album.ts. Any trouble is null, and the ladder goes on the row.
    const rowAlbum = (opts?.album || '').trim()
    let real: RealAlbum | null = null
    let library: LibraryTrackLite[] = []
    if (!wantAlbum && title && artist) {
      library = await loadLibraryTracksLite().catch(() => [] as LibraryTrackLite[])
      real = await lookUpRealAlbum(lookFor, artist, durationMs ? [durationMs / 1000] : [], ownedAlbumTest(library, artist), {
        throttle: deps.mbThrottle,
        userAgent: deps.mbUserAgent,
        onTrouble: (why) => trace.push(`musicbrainz: ${why}: going on the row`),
      })
      req.album = albumToLookFor(rowAlbum, real, (a) => albumVersionOf(title, a) !== null)
      if (req.album !== rowAlbum) trace.push(`“${title}” is on “${req.album}”${rowAlbum ? `, not “${rowAlbum}”` : ''} (MusicBrainz)`)
    }
    const alternatives: Alternative[] = []
    // Qobuz rows that matched the song but were other versions are the first
    // structured alternatives — "we found these, none was the exact one".
    for (const rv of rejectedVersions.slice(0, 6)) alternatives.push({ provider: 'qobuz', desc: rv, reason: 'is a different version' })
    let anyMatched = ranked.length > 0 || rejectedVersions.length > 0
    let sawUnverifiable = false
    /** Probe a staged rip and judge it as ONE recording. Album requests never
     *  reach this — they go through the album identity contract below; a
     *  multi-file stage on a TRACK request is left to the catalogue pick. */
    const judgeStaged = async (provider: Provider, staged: StagedRip, desc: string, extra: Partial<CandidateEvidence> = {}): Promise<ReturnType<typeof verifyCandidate>> => {
      if (staged.files.length !== 1) return { verdict: 'exact', evidence: ['album rip'], albumMatches: true }
      const probe = await probeStagedFile(staged.files[0])
      return verifyCandidate(req, { provider, desc, title: probe.title, album: probe.album, artist: probe.artist, durationSec: probe.durSec, ...extra })
    }
    const noteReject = (provider: Provider, desc: string, verdict: ReturnType<typeof verifyCandidate>): void => {
      if (verdict.verdict === 'exact') return
      if (verdict.verdict === 'unverifiable') sawUnverifiable = true
      alternatives.push({ provider, desc, reason: verdict.reason })
      trace.push(`${provider} “${desc}”: ${verdict.verdict} — ${verdict.reason}`)
      console.log(`[download] ${verdict.verdict === 'reject' ? 'rejected' : 'could not verify'} ${provider} candidate for “${title}”: “${desc}” ${verdict.reason}`)
    }

      // ── The clean-version gate (2026-08-16). Explicitness is an identity
      // axis resolved BEFORE any byte downloads: when the clicked row was
      // explicit, candidates Qobuz itself flags clean are refused, and if
      // every candidate is clean the download fails LOUDLY — a censored
      // file must never silently satisfy a request for the record.
      let ranked2 = ranked
      // Qobuz's search index outlives its catalog (2026-09-04, Vampire
      // Weekend: search returns album alk4osa4lhi6a and tracks 60132045…
      // that album/get + track/get answer 404 "No result matching given
      // argument"). The metadata probe below is also an availability probe:
      // an id Qobuz answers that for is skipped, so the pick walks the next
      // candidates instead of one-shotting the first. A timeout is no answer,
      // and a hit with no answer still gets its turn.
      const probed = new Set<string>()
      let metaMap: Map<string, QobuzTrackMeta> = new Map()
      let explicitOnQobuz = false
      let offAlbum = new Set<string>()
      const onlyCleanFailure = (refused: typeof ranked): DownloadResult & { matchDesc?: string } => ({
        ok: false,
        outcome: 'exact-not-found',
        alternatives: refused.map((c) => ({ provider: 'qobuz' as const, desc: c.desc, reason: NO_EXPLICIT_WARNING })),
        // What is known, and no more: "no warning" is not "censored" (flagToJudge).
        error: 'Apple lists an explicit ' + (mediaType === 'album' ? 'edition of this album' : 'cut of this track') + ', but no copy on Qobuz is marked explicit (' + refused.length + ' checked). It may be the clean edit, so nothing was imported. Try the album download, or another source.',
      })
      if (ranked.length) {
        const top = ranked.slice(0, 6)
        const gone = new Set<string>()
        const meta = await (mediaType === 'album' ? qobuzAlbumMeta : qobuzTrackMeta)(top.map((c) => c.id), gone)
        for (const c of top) probed.add(c.id)
        metaMap = meta
        for (const c of top) if (gone.has(c.id)) trace.push(`skip “${c.desc}”: gone from Qobuz's catalog (404)`)
        if (mediaType === 'track') {
          // 2026-09-04 (Jake: "why do these clean versions keep appearing???"):
          // explicit wins by DEFAULT, not only when the clicked row said so.
          // Apple's listing was the clean edition of Watch the Throne, so
          // explicitSource was false, the gate stayed off, and Qobuz's edited
          // edition was eligible. Now: when an explicit master exists the clean
          // ones are refused outright. A record with no explicit edition anywhere
          // (parental_warning false across the board) still downloads — that is a
          // genuinely clean record. What counts as the master: judgeHitsByMeta.
          const v = judgeHitsByMeta(req, top, meta, gone)
          for (const r of v.wrongRecording) noteReject('qobuz', r.hit.desc, r.verdict)
          for (const c of v.nothingToCensor) meta.set(c.id, { ...meta.get(c.id), parentalWarning: undefined })
          explicitOnQobuz = v.explicitOnQobuz
          if (v.explicitMaster) {
            trace.push(`${opts?.explicitSource ? 'explicit gate' : 'explicit-first'}: kept ${v.kept.length}, refused clean ${v.refusedClean.length}`)
            if (v.refusedClean.length > 0) console.log('[streamrip] refused ' + v.refusedClean.length + ' clean candidate(s) for "' + title + '" — an explicit master exists')
            // From here on this is a request for the explicit record: a hit past the
            // sixth and the album door hear Qobuz's flag the same way.
            req.explicit = 'explicit'
          }
          if (v.kept.length === 0 && v.refusedClean.length > 0) return onlyCleanFailure(v.refusedClean)
          ranked2 = [...v.kept, ...ranked.slice(6)]
          // A row is only overruled by a certain answer, unless Qobuz says the row's own album is
          // a compilation: then any album of the artist's that MusicBrainz knows is the better name.
          if (real && !real.lateAlbum && req.album === rowAlbum && rowAlbum !== real.album && v.kept.some((c) => {
            const m = meta.get(c.id)
            return m?.album !== undefined && onWantedAlbum(req.album, m.album) && isCompilationCopy(req, m)
          })) {
            trace.push(`“${rowAlbum}” is a compilation: looking for “${real.album}” (MusicBrainz)`)
            req.album = real.album
          }
          const order = albumFirst(req, ranked2, meta)
          ranked2 = order.walk
          offAlbum = order.offAlbum
        } else {
          ranked2 = ranked.filter((c) => !gone.has(c.id))
          // An album request with no explicit row is judged further down, once the
          // album contract exists to say which edition is this one.
          if (opts?.explicitSource) {
            const gate = applyExplicitGate(top.filter((c) => !gone.has(c.id)), meta, true)
            if (gate.kept.length === 0 && gate.refusedClean.length > 0) return onlyCleanFailure(gate.refusedClean)
            trace.push(`explicit gate: kept ${gate.kept.length}, refused clean ${gate.refusedClean.length}`)
            if (gate.refusedClean.length > 0) {
              console.log('[streamrip] explicit gate refused ' + gate.refusedClean.length + ' clean candidate(s) for "' + title + '"')
            }
            ranked2 = [...gate.kept, ...ranked.slice(6)]
          }
        }
      }

    // ── The ALBUM identity contract (6.0 Phase 1, final slice). The row Jake
    // clicked names an EDITION; its ordered tracklist comes from the same
    // catalogue by collection id. Every candidate album is judged twice —
    // on the provider's listing before a byte moves, and on the staged
    // files before import. Not proven = not imported, never partially.
    let reqAlbum: RequestedAlbum | null = null
    const sourceEdition = opts?.sourceEdition && opts.sourceEdition.provider === 'bandcamp' && opts.sourceEdition.url && opts.sourceEdition.tracks?.length ? opts.sourceEdition : null
    if (wantAlbum && sourceEdition) {
      // Action B (Compare editions): the request IS the source edition's own
      // tracklist snapshot — no iTunes lookup, no other provider. Verified
      // against that snapshot below; a changed source is refused.
      reqAlbum = requestFromSourceEdition(sourceEdition)
      trace.push(`source edition: ${sourceEdition.provider} ${sourceEdition.url} — ${sourceEdition.tracks.length} tracks (snapshot)`)
    } else if (wantAlbum) {
      let cid = typeof opts?.collectionId === 'number' && opts.collectionId > 0 ? opts.collectionId : undefined
      // Rows without a collection id can acquire a tracklist only from an
      // unambiguous name/edition match. A bonus, live, or deluxe listing must
      // never silently redefine a request for the plain record.
      if (!cid) {
        const found = await itunesFindAlbum(artist, title).catch(() => null)
        if (found) { cid = found.collectionId; trace.push(`album resolved by name → iTunes ${found.collectionId} “${found.collectionName}”`) }
        else trace.push('album could not be resolved by name on iTunes')
      }
      const lookup = cid ? await itunesAlbumTracks(cid).catch(() => null) : null
      const rows = lookup?.ok ? lookup.tracks : []
      reqAlbum = buildRequestedAlbum({
        artist, artistAliases: aliases, title,
        trackCount: opts?.trackCount ?? lookup?.trackCount,
        tracks: rows.map((t) => ({ title: t.song, trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSecs, explicitness: t.explicitness })),
        discCount: rows.reduce((m, t) => Math.max(m, t.discCount ?? t.discNumber ?? 1), 0) || undefined,
        releaseYear: lookup?.releaseYear ?? opts?.releaseYear,
        collectionId: cid,
        explicitSource: opts?.explicitSource,
      })
      trace.push(`album identity: ${reqAlbum.trackCount ?? '?'} tracks${reqAlbum.tracks.length ? ` (${reqAlbum.tracks.length} titled${rows.some((r) => r.durationSecs) ? ', timed' : ''})` : ' (no tracklist)'}${reqAlbum.discCount && reqAlbum.discCount > 1 ? `, ${reqAlbum.discCount} discs` : ''}${reqAlbum.packaging.length ? `, edition ${reqAlbum.packaging.join('+')}` : ''}${reqAlbum.versionMarkers.length ? `, ${reqAlbum.versionMarkers.join('+')}` : ''}${cid ? `, iTunes ${cid}` : ''}`)
    }
    // Ownership by identity BEFORE a byte moves: an album Jake already has is
    // answered from the library, not re-ripped; a partly owned one stages
    // whole (the edition must still be proven) and imports only the rest.
    let ownership: Ownership | null = null
    if (reqAlbum && reqAlbum.tracks.length) {
      const lib = await loadLibraryTracksLite().catch(() => [] as LibraryTrackLite[])
      ownership = matchLibraryOwnership(reqAlbum, lib)
      trace.push(`library: ${ownership.ownedCount}/${reqAlbum.tracks.length} already owned by identity`)
      if (ownership.missing.length === 0) {
        const c = reconcileAlbumCompletion({ req: reqAlbum, staged: [], imported: [], dupes: ownership.owned.map((o) => ({ title: o.track.title, artist: o.track.artist, durationSec: o.track.durationSec })) })
        const completion = describeCompletion(c)
        console.warn(`[download] album “${title}” — ${artist}: already in your library — ${completion}; nothing downloaded`)
        return { ok: true, imported: 0, dupes: ownership.ownedCount, outcome: 'imported', matchDesc: `${title} — ${completion}`, completion }
      }
    }
    const stagedProbes = new Map<string, StagedProbe>()
    /** What the staged files SAY they are, in catalogue order. */
    const albumFromStaged = async (provider: Provider, staged: StagedRip, desc: string): Promise<CandidateAlbum> => {
      const probes = await Promise.all(staged.files.map(async (f) => { const p = await probeStagedFile(f); stagedProbes.set(f, p); return p }))
      const majority = (xs: string[]): string => {
        const c = new Map<string, number>()
        for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1)
        return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
      }
      const tracks = orderTracks(probes.map((p, i) => ({ title: p.title, trackNumber: p.trackNumber, discNumber: p.discNumber, durationSec: p.durSec, file: staged.files[i] })))
      return {
        provider, desc, staged: true,
        title: majority(probes.map((p) => p.album)),
        artist: majority(probes.map((p) => p.albumArtist || p.artist)),
        trackCount: tracks.length,
        discCount: Math.max(1, ...probes.map((p) => p.discTotal ?? p.discNumber ?? 1)),
        tracks,
      }
    }
    const noteAlbumReject = (provider: Provider, cand: CandidateAlbum, verdict: AlbumVerdict, url?: string): void => {
      if (verdict.verdict === 'exact') return
      if (verdict.verdict === 'unverifiable') sawUnverifiable = true
      const desc = albumAlternativeDesc(cand)
      // The judged tracklist rides along (no file paths) so Compare editions
      // can show every track, not just the first mismatch the judge stopped at.
      const tracks = cand.tracks?.map((t) => ({ title: t.title, trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSec ?? null }))
      alternatives.push({ provider, desc, reason: verdict.reason, tracks, trackCount: cand.trackCount ?? tracks?.length, url })
      trace.push(`${provider} edition “${desc}”: ${verdict.verdict} — ${verdict.reason}`)
      console.log(`[download] ${verdict.verdict === 'reject' ? 'refused' : 'could not prove'} ${provider} edition for “${title}”: “${desc}” ${verdict.reason}`)
    }
    /** Import a verified album and account for it — duplicates count only
     *  when the library copy IS the requested recording. */
    const finishAlbum = async (staged: StagedRip, cand: CandidateAlbum, desc: string, evidence: string[]): Promise<DownloadResult & { matchDesc?: string }> => {
      trace.push(`exact edition: “${desc}” (${evidence.join(', ')})`)
      // The verified tracklist is positional: staged track i IS requested
      // track i, so the files of already-owned tracks stay in staging and
      // are discarded with it. Without a tracklist every file goes to the
      // importer, whose key now ignores edition stamps.
      const ownedIdx = new Set((ownership?.owned ?? []).map((o) => o.index))
      const only = ownership && cand.tracks?.length ? cand.tracks.map((t, i) => (ownedIdx.has(i) ? null : t.file)).filter((f): f is string => Boolean(f)) : undefined
      if (only) trace.push(`import ${only.length} of ${staged.files.length} staged files (${ownedIdx.size} already owned)`)
      const dl = await importStaged(staged, { only, addedVia })
      if (!dl.ok || !reqAlbum) return { ...dl, matchDesc: desc, outcome: dl.ok ? 'imported' : 'provider-failed' }
      const dupes = [
        ...(ownership?.owned ?? []).map((o) => ({ title: o.track.title, artist: o.track.artist, durationSec: o.track.durationSec })),
        ...(dl.dupeFiles ?? []).map((f) => stagedProbes.get(f)).filter((p): p is StagedProbe => Boolean(p)).map((p) => ({ title: p.title, artist: p.artist, durationSec: p.durSec })),
      ]
      const c = reconcileAlbumCompletion({ req: reqAlbum, staged: cand.tracks ?? [], imported: (dl.importedTitles ?? []).map((t) => ({ title: t })), dupes })
      const completion = describeCompletion(c)
      // warn-level on purpose: info never reaches main.log, and a successful
      // album run left no trace at all on 2026-09-05.
      console.warn(`[download] album “${title}” — ${artist}${c.complete ? '' : ' landed short'}: ${completion}`)
      if (!c.complete) return {
        ...dl, ok: false, matchDesc: desc, completion, outcome: 'provider-failed',
        primary: 'Album import incomplete', error: completion,
        detail: `${completion}. The tracks already imported are in your library. Retry to import the missing tracks.`,
      }
      return { ...dl, matchDesc: `${desc} — ${completion}`, completion, outcome: 'imported' }
    }

    if (sourceEdition && reqAlbum) {
      // Action B: straight to the selected source; nothing else is tried.
      if (cancelRequested) return { ok: false, error: 'canceled', outcome: 'canceled' }
      const st = await stageBandcamp(sourceEdition.url)
      if (!st.ok) { trace.push(`source edition stage: ${st.error}`); return { ok: false, error: st.error, outcome: 'provider-failed', primary: 'Download failed', detail: `The Bandcamp edition at ${sourceEdition.url} could not be fetched: ${st.error}` } }
      const desc = `${sourceEdition.title} — ${sourceEdition.artist} (Bandcamp edition)`
      const stagedAlbum = await albumFromStaged('bandcamp', st.staged, desc)
      if (!stagedAlbum.artist) stagedAlbum.artist = sourceEdition.artist
      const post = verifySourceEdition(sourceEdition, stagedAlbum)
      if (post.verdict !== 'exact') {
        await discardStaged(st.staged)
        noteAlbumReject('bandcamp', stagedAlbum, post, sourceEdition.url)
        return { ok: false, outcome: 'exact-not-found', error: post.reason, primary: 'Source edition changed', detail: `${post.reason}. Nothing was imported. Compare editions again to see the current tracklist.`, alternatives }
      }
      console.log(`[download] source edition resolved → ${sourceEdition.url}`)
      return finishAlbum(st.staged, stagedAlbum, desc, post.evidence)
    }

    /** What Qobuz's own listing says about a candidate album. */
    const albumListing = async (cand: (typeof ranked)[number]): Promise<CandidateAlbum> => {
      const meta = metaMap.get(cand.id)
      const tl = await qobuzAlbumTrackList(cand.id)
      const parsed = parseStreamripDesc(cand.desc)
      return {
        provider: 'qobuz', desc: cand.desc, id: cand.id,
        title: tl.title ?? parsed.title, artist: tl.artist ?? parsed.artist, version: tl.version ?? meta?.version ?? null,
        trackCount: tl.tracksCount ?? (tl.tracks.length || undefined), discCount: tl.mediaCount,
        tracks: tl.tracks.length ? tl.tracks.map((t) => ({ title: t.title, trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSec })) : undefined,
        releaseYear: tl.releaseYear, upc: tl.upc, parentalWarning: tl.parentalWarning ?? meta?.parentalWarning,
      }
    }
    // Explicit-first for a record (2026-09-04), and the same rule as for a song: only
    // this edition can prove a clean one is censored. A Deluxe flagged explicit threw
    // out the edition Jake picked and then failed the contract itself: Ants From Up
    // There (19 tracks, he picked 10), Fancy Footwork (24, he picked 11), If You Insist
    // (main.log, 2026-10). A contract that cannot tell keeps the flag's word.
    if (reqAlbum && !opts?.explicitSource) {
      for (const c of ranked2.filter((x) => metaMap.get(x.id)?.parentalWarning === true)) {
        if (verifyAlbumCandidate(reqAlbum, await albumListing(c)).verdict === 'reject') continue
        const kept = ranked2.filter((x) => metaMap.get(x.id)?.parentalWarning !== false)
        trace.push(`explicit-first: kept ${kept.length}, refused clean ${ranked2.length - kept.length}`)
        if (kept.length < ranked2.length) console.log('[streamrip] explicit-first refused ' + (ranked2.length - kept.length) + ' clean candidate(s) for "' + title + '" — an explicit edition of it exists')
        ranked2 = kept
        break
      }
    }

    // A clean file from the WRONG album (a compilation carrying the same master) is held as a
    // fallback while a canonical-album copy is looked for, through the album door too.
    let fallback: { staged: StagedRip; desc: string; meta: QobuzTrackMeta | undefined } | null = null
    if (ranked2.length) {
      // Qobuz: try the top candidates in rank order. Every staged file is
      // judged — with a known runtime AND without one (the old "no duration"
      // path went stage → import with no witness at all).
      let lastRipErr = ''
      for (const cand of ranked2.slice(0, 3)) {
        if (cancelRequested) {
          if (fallback) await discardStaged(fallback.staged)
          return { ok: false, error: 'canceled', outcome: 'canceled' }
        }
        if (clock.expired()) {
          if (fallback) await discardStaged(fallback.staged)
          return { ...gaveUp(), outcome: 'provider-failed' }
        }
        // A good copy is in hand: another album's copy would not be better.
        if (fallback && offAlbum.has(cand.id)) continue
        if (reqAlbum) {
          // Pre-stage: the provider's own listing must not contradict the
          // edition (cheap refusal); the staged files then have to prove it.
          const listing = await albumListing(cand)
          const pre = verifyAlbumCandidate(reqAlbum, listing)
          trace.push(`album listing “${cand.desc}”: ${pre.verdict}${pre.verdict === 'exact' ? ` (${pre.evidence.join(', ')})` : ` — ${pre.reason}`}`)
          if (pre.verdict === 'reject') { noteAlbumReject('qobuz', listing, pre); continue }
          anyMatched = true
          const ast = await stageRip(['id', cand.source, cand.mediaType, cand.id], clock.remaining())
          trace.push(`stage “${cand.desc}”: ${ast.ok ? `${ast.staged.files.length} file(s)` : ast.error}`)
          if (!ast.ok) { lastRipErr = ast.error; continue }
          const stagedAlbum = await albumFromStaged('qobuz', ast.staged, cand.desc)
          // The listing's identifiers travel with the files it produced.
          stagedAlbum.upc = listing.upc; stagedAlbum.releaseYear = listing.releaseYear; stagedAlbum.parentalWarning = listing.parentalWarning
          const post = verifyAlbumCandidate(reqAlbum, stagedAlbum)
          if (post.verdict !== 'exact') { await discardStaged(ast.staged); noteAlbumReject('qobuz', stagedAlbum, post); continue }
          if (fallback) await discardStaged(fallback.staged)
          return finishAlbum(ast.staged, stagedAlbum, cand.desc, [...pre.verdict === 'exact' ? pre.evidence : [], ...post.evidence])
        }
        const st = await stageRip(['id', cand.source, cand.mediaType, cand.id], clock.remaining())
        trace.push(`stage “${cand.desc}”: ${st.ok ? 'ok' : st.error}`)
        if (!st.ok) {
          // A dead id or a rip that died: the next-ranked candidate gets its
          // turn either way (stageRip already retried once with backoff).
          lastRipErr = st.error
          continue
        }
        // Past the sixth hit nothing has asked Qobuz about it yet, and a row with no
        // length has only this flag to go on. The same rule as the top hits reads it.
        const meta = metaMap.get(cand.id) ?? (probed.has(cand.id) ? undefined : (await qobuzTrackMeta([cand.id])).get(cand.id))
        const verdict = await judgeStaged('qobuz', st.staged, cand.desc, { parentalWarning: flagToJudge(meta, explicitOnQobuz), version: meta?.version ?? undefined })
        if (verdict.verdict === 'exact') {
          // A compilation only counts as the album when the row names that very album.
          if (verdict.albumMatches && !(isCompilationCopy(req, meta) && !req.album)) {
            if (fallback) await discardStaged(fallback.staged)
            trace.push(`exact: “${cand.desc}” (${verdict.evidence.join(', ')})`)
            const dl = await importStaged(st.staged, { addedVia })
            return { ...dl, matchDesc: cand.desc, outcome: dl.ok ? 'imported' : 'provider-failed' }
          }
          if (!fallback) { fallback = { staged: st.staged, desc: cand.desc, meta }; continue }
          await discardStaged(st.staged)
          continue
        }
        await discardStaged(st.staged)
        noteReject('qobuz', cand.desc, verdict)
      }
      if (lastRipErr) trace.push(`qobuz rips failed — last: ${lastRipErr}`)
    }

    /** The song, from the wrong album: the row still says the right one when that's certain. */
    const importFallback = async (held: { staged: StagedRip; desc: string; meta: QobuzTrackMeta | undefined }): Promise<DownloadResult & { matchDesc?: string }> => {
      const durationSec = (await probeStagedFile(held.staged.files[0])).durSec ?? undefined
      const tags = realAlbumTags(req, real, { durationSec, meta: held.meta })
      const owned = tags ? ownedAlbumSpelling(library, tags.albumArtist, tags.album) : null
      console.log(`[download] no canonical-album copy of “${title}” on Qobuz — importing verified off-album master (“${held.desc}”)${tags ? `, filed on “${owned?.album ?? tags.album}”` : ''}`)
      const rowTags: ImportRowTags | undefined = tags ? { ...tags, album: owned?.album ?? tags.album, cover: await fetchAlbumCover(tags.coverUrls) } : undefined
      const dl = await importStaged(held.staged, { addedVia, rowTags })
      return { ...dl, matchDesc: held.desc, outcome: dl.ok ? 'imported' : 'provider-failed' }
    }

    if (cancelRequested) {
      if (fallback) await discardStaged(fallback.staged)
      return { ok: false, error: 'canceled', outcome: 'canceled' }
    }
    if (clock.expired()) return fallback ? importFallback(fallback) : { ...gaveUp(), outcome: 'provider-failed' }
    // ── The ALBUM DOOR (2026-08-29, "another failed download. getting
    // ridiculous"): Qobuz's track search misses songs its own catalogue
    // carries. When the caller named the album, find the ALBUM, read its
    // tracklist, and download the wanted track by id — lossless, canonical
    // album, judged by the same contract as the top hits (title + Qobuz's own
    // runtime + its explicit flag). 2026-11-04: on Migos' "Bad and Boujee", a row
    // labelled explicit, this door brought in Culture's 332.7 s edition with no
    // warning, a different mix, after the 343.2 s explicit file had been refused on
    // a clean row's length. A Bay Bay's album lists its Single Version, no warning,
    // before the explicit cut: so the tracks of an album's editions are judged together.
    // ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts albumDoorHits.
    // 2026-11-05: the real album's door first, with a copy from elsewhere in hand or not. The
    // row's own album, when it is another, is still a way to the song if nothing is held.
    for (const albName of wantAlbum ? [] : [...new Set([req.album, rowAlbum])].filter(Boolean)) {
      if (fallback && albName !== req.album) continue
      const asearch = await searchCatalog({ query: [artist, searchTitle(albName) || albName].filter(Boolean).join(' '), source: 'qobuz', mediaType: 'album', numResults: 10 })
      const albumsNamed = (name: string): typeof ranked => rankStreamripCandidates(name, artist, asearch.results ?? [], 'album', aliases, { clocked: false }).ranked
      // The name as the row writes it comes first, so a Deluxe row finds the Deluxe. The
      // album's other editions come too, and a row's own name can't be trusted to find the
      // record: Apple's "Life After Death [Amended Version] (2014 Remaster)" reads as Qobuz's
      // amended "(2014 Remaster)", and not as its explicit "(2014 Remastered Edition)".
      const editions = [...new Map([...albumsNamed(albName), ...albumsNamed(searchTitle(albName) || albName)].map((a) => [a.id, a])).values()].slice(0, 4)
      const listings = await Promise.all(editions.map(async (alb) => ({ alb, tl: await qobuzAlbumTrackList(alb.id) })))
      const doorTracks = listings.flatMap(({ alb, tl }) => tl.tracks.filter((t) => titleMatches(lookFor || title, t.title)).map((t) => ({ ...t, alb, tl })))
      const trackMeta = new Map(doorTracks.map((t): [string, QobuzTrackMeta] => [t.id, { title: t.title, parentalWarning: t.parentalWarning, albumParentalWarning: t.tl.parentalWarning, durationSec: t.durationSec, album: t.tl.title }]))
      // Big Pun's "Still Not a Player" EP closes with Incubus's own, by that very title.
      const doorHits = doorTracks.map((t) => ({ id: t.id, desc: `${t.title} by ${t.performer || artist}` }))
      const tried = new Set<string>()
      for (const { id } of judgeHitsByMeta(req, doorHits, trackMeta, new Set(), explicitOnQobuz).kept) {
        const hit = doorTracks.find((t) => t.id === id)!
        const alb = hit.alb
        // One track from an album, and two fetches at most.
        if (tried.has(alb.id)) continue
        if (tried.size === 2) break
        tried.add(alb.id)
        anyMatched = true
        // "you could have said the album is not coming out until october 2"
        // (2026-08-29, verbatim): a PRE-RELEASE track is on the album page
        // with streamable=false — say WHEN instead of a bare Retry.
        if (hit.streamable === false) {
          const when = hit.tl.releaseDate ? ` — releases ${hit.tl.releaseDate}` : ''
          console.warn(`[download] “${title}” is on “${alb.desc}” but not out yet${when}`)
          if (fallback) continue
          return { ok: false, error: `Not out yet: “${alb.desc}”${when}. It'll download once it releases.`, outcome: 'not-released' }
        }
        console.log(`[download] album door: “${title}” found inside “${alb.desc}” (track ${hit.id}) — Qobuz track search had missed it`)
        const st = await stageRip(['id', 'qobuz', 'track', hit.id], clock.remaining())
        if (!st.ok) { trace.push(`album door stage: ${st.error}`); continue }
        // The flag was read above, by the rule that knows what it means.
        const verdict = await judgeStaged('qobuz', st.staged, `${hit.title} — via album “${alb.desc}”`)
        if (verdict.verdict === 'exact') {
          // Through the row's door: the song, and still not the album MusicBrainz names.
          if (!verdict.albumMatches) {
            if (fallback) await discardStaged(st.staged)
            else fallback = { staged: st.staged, desc: `${hit.title} — via album “${alb.desc}”`, meta: trackMeta.get(hit.id) }
            continue
          }
          if (fallback) await discardStaged(fallback.staged)
          const dl = await importStaged(st.staged, { addedVia })
          return { ...dl, matchDesc: `${hit.title} — via album “${alb.desc}”`, outcome: dl.ok ? 'imported' : 'provider-failed' }
        }
        await discardStaged(st.staged)
        noteReject('qobuz', `${hit.title} — via album “${alb.desc}”`, verdict)
      }
    }
    if (fallback) return importFallback(fallback)

    if (cancelRequested) return { ok: false, error: 'canceled', outcome: 'canceled' }
    if (clock.expired()) return { ...gaveUp(), outcome: 'provider-failed' }
    // ── Bandcamp — equal citizen (2026-08-07, Jake: "bandcamp is very
    // much used by me too. use both equally"). Scene bands live here when
    // Qobuz has never heard of them. Full-track stream tier; the store view
    // stays the checkout for buying the record properly. Same judge.
    const bcSearch = await bandcampSearch(query, wantAlbum ? 'a' : 't')
    const bandcampNoAnswer = 'noAnswer' in bcSearch ? bcSearch.noAnswer : null
    trace.push('hits' in bcSearch ? `bandcamp: ${bcSearch.hits.length} results` : `bandcamp search: no answer (${bcSearch.noAnswer})`)
    const bcNamed = ('hits' in bcSearch ? bcSearch.hits : []).filter((r) =>
      (!artist || recoArtistMatches(artist, r.band)) &&
      titleMatches(title, r.name) &&
      !unwantedVersionOf(title, r.name) &&
      !liveBrandMarker(title, r.name))
    // A row with a length holds the file to it. One without has only tags, and a fan's
    // upload can carry the right ones (bandcampHitDoubt). Asked before the fetch, and
    // before the two tries are counted, so a real release further down still gets its turn.
    // With a length a doubtful page may still land, after the pages that aren't: Björk's
    // bootleg pages answer ahead of bjork.bandcamp.com, run 4:10, and used up both tries.
    const bcPageDoubt = (r: { url: string; band: string; album: string | null }): string | null => bandcampHitDoubt({ artist, title, album: opts?.album || '' }, r)
    const bcDoubt = (r: { url: string; band: string; album: string | null }): string | null => req.durationSec > 0 ? null : bcPageDoubt(r)
    const bcPicks = [...bcNamed.filter((r) => !bcPageDoubt(r)), ...bcNamed.filter((r) => bcPageDoubt(r) && !bcDoubt(r))].slice(0, 2)
    const bcLeftAlone = bcNamed.filter((r) => bcDoubt(r)).slice(0, 2)
    for (const r of bcLeftAlone) trace.push(`bandcamp “${r.name}” at ${r.url}: ${bcDoubt(r)}`)
    // Not "nothing resembling it". But not a refused file either, so a Qobuz outage or a
    // failed transfer keeps its own verdict: this is only a note.
    if (bcLeftAlone.length && qsearch.ok) anyMatched = true
    let bandcampFailure: string | null = null
    for (const bcPick of bcPicks) {
      if (cancelRequested) return { ok: false, error: 'canceled', outcome: 'canceled' }
      anyMatched = true
      const st = await stageBandcamp(bcPick.url)
      if (!st.ok) { trace.push(`bandcamp stage: ${st.error}`); bandcampFailure = st.error; continue }
      const desc = `${bcPick.name} — ${bcPick.band} (Bandcamp stream)`
      if (reqAlbum) {
        // Same contract, staged files only — Bandcamp has no listing endpoint.
        const stagedAlbum = await albumFromStaged('bandcamp', st.staged, desc)
        if (!stagedAlbum.artist) stagedAlbum.artist = bcPick.band
        const post = verifyAlbumCandidate(reqAlbum, stagedAlbum)
        if (post.verdict !== 'exact') { await discardStaged(st.staged); noteAlbumReject('bandcamp', stagedAlbum, post, bcPick.url); continue }
        console.log(`[download] Bandcamp resolved “${query}” → ${bcPick.url}`)
        return finishAlbum(st.staged, stagedAlbum, desc, post.evidence)
      }
      const verdict = await judgeStaged('bandcamp', st.staged, desc, { artist: bcPick.band })
      if (verdict.verdict === 'exact') {
        console.log(`[download] Bandcamp resolved “${query}” → ${bcPick.url}`)
        const dl = await importStaged(st.staged, { addedVia })
        return { ...dl, matchDesc: desc, outcome: dl.ok ? 'imported' : 'provider-failed' }
      }
      await discardStaged(st.staged)
      noteReject('bandcamp', desc, verdict)
    }

    if (cancelRequested) return { ok: false, error: 'canceled', outcome: 'canceled' }
    if (clock.expired()) return { ...gaveUp(), outcome: 'provider-failed' }
    // ── SoundCloud fallback (2026-07-22, Jake: "auto qobuz first"). Qobuz
    // doesn't carry indie/underground singles; SoundCloud does, full-length
    // (~128k MP3 — lossy but complete). Single tracks only. It is NEVER a
    // silent substitute: the walk tries a few uploads and each must pass
    // the same judge as Qobuz — the 5 Years Time remix died here.
    //
    // This lane's trouble is its own news, never the song's verdict (Brief 224):
    // streamrip's search dies on nearly every query now, and "Check the login in
    // Setup" was all 16 PROVIDER UNAVAILABLEs in main.log. Only a file it delivered
    // and the judge ruled on counts. stageRip clears lastStageFailure, so Qobuz's
    // is kept from here on.
    const stageFailureBeforeSoundcloud = lastStageFailure
    let soundcloudSearchError: string | null = null
    let soundcloudStageFailure: string | null = null
    if (!wantAlbum) {
      const ssearch = await searchCatalog({ query, source: 'soundcloud', mediaType: 'track', numResults: 15 })
      trace.push(`soundcloud search: ${ssearch.ok ? `${ssearch.results?.length ?? 0} results` : `ERR ${ssearch.error}`}`)
      if (!ssearch.ok) soundcloudSearchError = ssearch.error || 'its search failed'
      const spicks = ssearch.ok && ssearch.results?.length
        ? rankSoundcloudCandidates(title || query, artist, ssearch.results).slice(0, 3)
        : []
      for (const spick of spicks) {
        if (cancelRequested) return { ok: false, error: 'canceled', outcome: 'canceled' }
        if (clock.expired()) return { ...gaveUp(), outcome: 'provider-failed' }
        console.log(`[download] Qobuz had no exact match for "${query}" — trying SoundCloud: ${spick.desc}`)
        const st = await stageRip(['id', spick.source, spick.mediaType, spick.id], clock.remaining())
        if (!st.ok) { trace.push(`soundcloud stage “${spick.desc}”: ${st.error}`); soundcloudStageFailure = st.error; continue }
        anyMatched = true
        const desc = `${spick.desc} (SoundCloud)`
        // The file's own clock and tags are the only trustworthy witnesses
        // here (2026-08-29, the TopKnot case) — probed explicitly in this
        // lane, then judged by the same contract as every other provider.
        const probe = st.staged.files.length === 1 ? await probeStagedFile(st.staged.files[0]) : null
        const verdict = probe
          ? verifyCandidate(req, { provider: 'soundcloud', desc: spick.desc, title: probe.title, album: probe.album, artist: probe.artist, durationSec: probe.durSec })
          : await judgeStaged('soundcloud', st.staged, spick.desc)
        if (verdict.verdict === 'exact') {
          const dl = await importStaged(st.staged, { addedVia })
          return { ...dl, matchDesc: desc, outcome: dl.ok ? 'imported' : 'provider-failed' }
        }
        await discardStaged(st.staged)
        noteReject('soundcloud', desc, verdict)
      }
    }

    console.warn(`[download] trace “${title}” — ${artist}: ${trace.join(' | ')}`)
    // ── The verdict. Provider trouble stays distinct from "we looked and
    // nothing was the exact recording", which stays distinct from "nothing
    // resembled it at all". Prefer "Exact version not found" over a false
    // success every time.
    const searchFailure = !qsearch.ok ? (qsearch.error || 'Qobuz search failed') : null
    const ripFailure = stageFailureBeforeSoundcloud ?? bandcampFailure
    const ripFailureIsBandcamp = !stageFailureBeforeSoundcloud && Boolean(bandcampFailure)
    const outcome = finalOutcome({ alternatives, ripFailure, searchFailure, anyMatched, unverifiable: sawUnverifiable })
    // Whatever went wrong that the verdict's own sentence does not say.
    const laneNotes = [
      searchFailure && outcome !== 'provider-unavailable' ? `Qobuz wasn’t searched: ${searchFailure}.` : null,
      bandcampNoAnswer ? `Bandcamp wasn’t searched (${bandcampNoAnswer}), so it may still have this.` : null,
      ...bcLeftAlone.map((r) => `Bandcamp has “${r.name}” at ${r.url}, left alone: it ${bcDoubt(r)}.`),
      bandcampFailure && !(outcome === 'provider-failed' && ripFailureIsBandcamp) ? `Bandcamp has a match that could not be fetched: ${bandcampFailure}.` : null,
      // The same words as Qobuz's failure (no rip on this Mac) are already said.
      soundcloudSearchError && soundcloudSearchError !== searchFailure ? soundcloudSearchNote(soundcloudSearchError) : null,
      soundcloudStageFailure ? `SoundCloud has a match that could not be fetched: ${soundcloudStageFailure}.` : null,
    ].filter((n): n is string => Boolean(n))
    const unasked = [...(bandcampNoAnswer ? ['Bandcamp'] : []), ...(soundcloudSearchError ? ['SoundCloud'] : [])]
    const { primary, detail } = describeOutcome(outcome, { title, artist, query, alternatives, ripFailure, loginlessRipFailure: ripFailureIsBandcamp, searchFailure, otherVersions: rejectedVersions, wantAlbum, unasked, laneNotes })
    console.warn(`[download] ${primary.toUpperCase()} “${title}” — ${artist}: ${detail.replace(/\n/g, ' | ')}`)
    return { ok: false, outcome, alternatives, primary, detail, error: `${primary}: ${detail.split('\n')[0]}` }
  }, { refuse: REFUSED_SENDER })

  // Download a picked search result by its streamrip id.
  ipc.handle('streamrip:download-id', async (_e, source: string, mediaType: string, id: string, addedVia?: string): Promise<DownloadResult> => {
    cancelRequested = false
    if (!source || !mediaType || !id) return { ok: false, error: 'Nothing selected to download.' }
    // IDs from search results are opaque store ids — reject path-like junk.
    if (/[\/\\\0]/.test(String(id)) || String(id).length > 128) {
      return { ok: false, error: 'Invalid download id.' }
    }
    if (!/^(qobuz|tidal|deezer|youtube)$/i.test(String(source))) {
      return { ok: false, error: 'Unsupported source.' }
    }
    if (!/^(track|album|playlist|artist)$/i.test(String(mediaType))) {
      return { ok: false, error: 'Unsupported media type.' }
    }
    return runDownload(['id', source, mediaType, id], shareSourceKey(addedVia))
  }, { refuse: REFUSED_SENDER })

  // Download a pasted streaming link directly.
  ipc.handle('streamrip:download', async (_e, url: string): Promise<DownloadResult> => {
    cancelRequested = false
    const link = (url || '').trim()
    if (!isAllowedStreamripUrl(link)) {
      return { ok: false, error: 'Paste a Qobuz, Tidal, Deezer, or YouTube https link.' }
    }
    return runDownload(['url', link])
  }, { refuse: REFUSED_SENDER })

  // Is Qobuz configured? (email + password hash both present)
  ipc.handle('streamrip:get-qobuz', async (): Promise<{ ok: boolean; configured: boolean; email?: string }> => {
    try {
      const cfg = await readFile(streamripConfigPath(), 'utf-8')
      const email = readQobuzField(cfg, 'email_or_userid')
      const pw = readQobuzField(cfg, 'password_or_token')
      return { ok: true, configured: !!(email && pw), email }
    } catch {
      return { ok: true, configured: false }
    }
  }, { public: true })

  // Save Qobuz creds: hash the password (MD5, what streamrip wants) and write
  // email + hash into config.toml. use_auth_token forced false (email+password
  // mode). Plaintext password is used only to compute the hash, never stored.
  ipc.handle('streamrip:set-qobuz', async (_e, email: string, password: string): Promise<{ ok: boolean; error?: string }> => {
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
    } catch {
      return { ok: false, error: 'Could not save Qobuz credentials.' }
    }
  }, { refuse: REFUSED_SENDER })

  // Google-SSO Qobuz: there is no password, so authenticate with the
  // user_auth_token Qobuz hands the logged-in web player (streamrip's
  // use_auth_token=true mode → user_id + token). The token IS the credential,
  // stored as-is; nothing to hash.
  ipc.handle('streamrip:set-qobuz-token', async (_e, userId: string, token: string): Promise<{ ok: boolean; error?: string }> => {
    const u = (userId || '').trim()
    const t = (token || '').trim()
    if (!u || !t) return { ok: false, error: 'Enter both your Qobuz user ID and auth token.' }
    try {
      const path = streamripConfigPath()
      const cfg = await readFile(path, 'utf-8')
      const next = writeQobuzFields(cfg, { use_auth_token: 'true', email_or_userid: u, password_or_token: t })
      await writeFile(path, next, 'utf-8')
      return { ok: true }
    } catch {
      return { ok: false, error: 'Could not save Qobuz token.' }
    }
  }, { refuse: REFUSED_SENDER })
}
