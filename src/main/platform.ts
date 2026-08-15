// Cross-platform helpers for macOS and Windows.
// Keeps platform-branching out of the main IPC handlers so each site
// has one call like findIpodVolume() instead of an if/else tree.

import { join } from 'path'
import { open, readdir, stat } from 'fs/promises'
import { execFile, execSync } from 'child_process'
import { promisify } from 'util'
import { remountUnmountArgSets } from './remount-unmount-args.ts'

export { remountUnmountArgSets } from './remount-unmount-args.ts'

const execP = promisify(execFile)

export const IS_MAC = process.platform === 'darwin'
export const IS_WINDOWS = process.platform === 'win32'

// ────────────────────────────────────────────────────────────────────
// Python resolution (Brief 010b)
//
// The installed/packaged Electron app inherits a minimal PATH from
// Finder/Launchpad — typically just /usr/bin:/bin:/usr/sbin:/sbin —
// which doesn't include /opt/homebrew/bin. Spawning a bare "python3"
// therefore lands on the first python3 in that minimal PATH (Apple's
// system Python if any), which may or may not have librosa accessible.
//
// In dev mode (`npm run dev`), the terminal's full PATH is inherited
// so /opt/homebrew/bin/python3 (the brew install that has librosa via
// pip) is used and audio analysis works. Same code path, different
// runtime environment → silent failure in production.
//
// Fix: at startup, try a prioritized list of candidate absolute paths,
// pick the first whose `import librosa` succeeds, cache it. If none
// work, PYTHON_CMD is null and the audio analysis worker skips the
// job loud (no timestamp sentinel) instead of writing empty data.
//
// Non-audio-analysis consumers (mutagen tag writer, iPod DB scripts,
// salvage scripts) don't require librosa. They use `PYTHON_CMD ?? 'python3'`
// so they keep working with whatever Python the resolved path picks up
// (or the bare fallback, matching pre-010b behavior).
// ────────────────────────────────────────────────────────────────────

const PYTHON_CANDIDATES_MAC = [
  '/opt/homebrew/bin/python3',  // Apple Silicon Homebrew
  '/usr/local/bin/python3',     // Intel Homebrew or python.org
  '/usr/bin/python3',           // macOS system Python (Xcode-bundled)
]

function tryPython(cmd: string): { ok: boolean; version?: string; error?: string } {
  try {
    const output = execSync(`${cmd} -c "import librosa; print(librosa.__version__)"`, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return { ok: true, version: output }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function resolvePythonCmd(): string | null {
  // Windows: skip detection — librosa-on-Windows isn't a supported
  // workflow yet, and the existing 'python' (or py.exe) PATH lookup
  // continues to work for the non-librosa consumers.
  if (IS_WINDOWS) return 'python'

  for (const candidate of PYTHON_CANDIDATES_MAC) {
    const result = tryPython(candidate)
    if (result.ok) {
      console.log(`[python] Resolved PYTHON_CMD to: ${candidate} (librosa: ${result.version})`)
      return candidate
    }
  }
  // Last resort: whatever PATH resolves. Mostly useful in dev mode
  // where the terminal PATH has /opt/homebrew/bin — production
  // launchd PATH almost never reaches this branch usefully.
  const fallback = tryPython('python3')
  if (fallback.ok) {
    console.log(`[python] Resolved PYTHON_CMD to: python3 (PATH lookup, librosa: ${fallback.version})`)
    return 'python3'
  }
  console.error('[python] ERROR: no Python with librosa found in any candidate. Audio analysis disabled.')
  console.error('[python] Tried:', PYTHON_CANDIDATES_MAC.concat(['python3 (PATH)']).join(', '))
  return null
}

/**
 * Absolute path to the Python interpreter to use for spawned scripts,
 * or null if no librosa-equipped Python was found on this machine.
 *
 * Audio-analysis sites MUST null-check before spawning — null means
 * "skip the job, don't write the sentinel."
 *
 * Non-librosa sites (mutagen tag readers/writers, iPod DB scripts)
 * should fall back to a bare `'python3'` when this is null:
 *     spawn(PYTHON_CMD ?? 'python3', [...])
 */
export const PYTHON_CMD: string | null = resolvePythonCmd()

/**
 * Human-readable message shown when Python is missing, directing the
 * user to the right install method for their OS.
 */
export const PYTHON_INSTALL_HINT = IS_WINDOWS
  ? 'Python 3 is not installed. Install it from https://www.python.org/downloads/ and make sure "Add Python to PATH" is checked during install.'
  : 'Python 3 is not installed. Install it from python.org or run: xcode-select --install'

/**
 * Enumerate every plausible mount point on this platform.
 *   macOS:  ["/Volumes/JACOBROSENB", "/Volumes/Highway To Hell", ...]
 *   Windows: ["D:\\", "E:\\", "F:\\", ...]
 *
 * NETWORK MOUNTS ARE EXCLUDED on macOS (the 2026-07-08 beachball fix).
 * An iPod is never an smbfs/afpfs/nfs share — but the device poll runs
 * findIpodMount every ~2.5s, and stat()ing iPod_Control on the NAS
 * shares put continuous SMB round-trips on Node's 4-thread fs pool.
 * The moment the NAS was slow, hung stats saturated the pool and EVERY
 * fs op in the app queued behind them — so view switches (which load
 * data through main-process fs IPC) beachballed. The `mount` table is
 * parsed per pass (one cheap child process, no fs threadpool) and any
 * network filesystem is dropped before a single stat happens.
 */
const NETWORK_FS_RE = /\b(smbfs|afpfs|nfs|webdav|autofs|ftp)\b/i

async function macNetworkMountSet(): Promise<Set<string>> {
  try {
    const { stdout } = await execP('mount', [])
    const netMounts = new Set<string>()
    for (const line of stdout.split('\n')) {
      // "//jake@ds225/JakeShared on /Volumes/JakeShared (smbfs, nodev, ...)"
      const m = line.match(/ on (\/Volumes\/[^(]+?) \(([^)]+)\)/)
      if (m && NETWORK_FS_RE.test(m[2])) netMounts.add(m[1].trim())
    }
    return netMounts
  } catch {
    return new Set()   // can't read the table — scan everything, as before
  }
}

export async function listMountPoints(): Promise<string[]> {
  if (IS_MAC) {
    try {
      const [entries, netMounts] = await Promise.all([readdir('/Volumes'), macNetworkMountSet()])
      return entries
        .map(v => `/Volumes/${v}`)
        .filter(p => !netMounts.has(p))
    } catch {
      return []
    }
  }

  // Windows: probe every letter from D onward (skip A/B floppies and C system drive).
  // Only include letters that actually exist as a mounted drive.
  const candidates: string[] = []
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try {
      await stat(root)
      candidates.push(root)
    } catch { /* no drive at that letter */ }
  }
  return candidates
}

/**
 * Given a mount point (like "/Volumes/JACOBROSENB" or "E:\\"), return a
 * human-readable volume name suitable for showing in the sidebar.
 */
export function volumeNameFromMount(mountPoint: string): string {
  if (IS_MAC) {
    // "/Volumes/JACOBROSENB" -> "JACOBROSENB"
    const m = mountPoint.match(/\/Volumes\/(.+?)\/?$/)
    return m ? m[1] : mountPoint
  }
  // Windows: "E:\\" -> "E:". A better approach would query the volume
  // label via WMI, but for now the drive letter is a fair fallback.
  return mountPoint.replace(/\\$/, '')
}

/**
 * Check whether the given mount point is an iPod. Primary signal is
 * the iTunesDB at the canonical path; 4.5 fallback: if iPod_Control
 * exists at the root but iTunesDB is missing (uninitialized iPod,
 * mid-sync write, brand-new device), still treat it as an iPod so
 * the sidebar entry appears and the user can take action from there.
 */
export async function isIpodMount(mountPoint: string): Promise<boolean> {
  try {
    await stat(join(mountPoint, 'iPod_Control', 'iTunes', 'iTunesDB'))
    return true
  } catch { /* iTunesDB missing — try the directory fallback */ }
  try {
    await stat(join(mountPoint, 'iPod_Control'))
    return true
  } catch {
    return false
  }
}

/**
 * Find the first mounted iPod on the system, or null if none is connected.
 * Returns the mount point (full path), not just the volume name.
 * 4.5: diagnostic logging — every check logs the mount list and the
 * iTunesDB stat results so a "iPod plugged in but not appearing" bug
 * is debuggable from a single dev-console open instead of needing
 * fresh instrumentation each time.
 */
// The renderer's hotplug poll calls this every ~2.5s. A short negative
// cache keeps the steady state (no iPod, none appearing) at zero fs work
// most ticks, and the result log fires on STATE CHANGES only — 104
// identical "NO iPod found" lines in 4 minutes buried every real signal
// in the console (observed 2026-07-08 while hunting the beachball).
let ipodNegativeCacheUntil = 0
let lastIpodLogState: string | null = null

export async function findIpodMount(): Promise<string | null> {
  if (Date.now() < ipodNegativeCacheUntil) return null
  const mounts = await listMountPoints()
  const checks: { mount: string; isIpod: boolean }[] = []
  for (const m of mounts) {
    const hit = await isIpodMount(m)
    checks.push({ mount: m, isIpod: hit })
    if (hit) {
      ipodNegativeCacheUntil = 0
      if (lastIpodLogState !== `found:${m}`) {
        lastIpodLogState = `found:${m}`
        console.log('[ipod-detect] FOUND iPod at', m, '— mounts scanned:', mounts.length)
      }
      return m
    }
  }
  // No match. Dump what we saw — a typical "I plugged it in!" report
  // is either (a) mount missing entirely from /Volumes (macOS didn't
  // mount it), or (b) mount present but no iPod_Control/iTunes/iTunesDB
  // (uninitialized iPod, or wrong device).
  ipodNegativeCacheUntil = Date.now() + 10_000
  const state = `none:${checks.map((c) => c.mount).join(',')}`
  if (lastIpodLogState !== state) {
    lastIpodLogState = state
    console.log('[ipod-detect] NO iPod found. Checked:', JSON.stringify(checks))
  }

  // macOS-only fallback: the iPod might be physically connected but
  // unmounted (e.g. previous sync triggered a safety-eject, or the
  // device was reset). `diskutil list -plist external` will still
  // show it as a physical disk. If any external HFS partition is
  // found that isn't currently mounted, try to mount it and see if
  // it turns out to be an iPod.
  if (IS_MAC) {
    try {
      const { stdout } = await execP('diskutil', ['list', '-plist', 'external'])
      // Cheap regex parse: look for disk identifiers followed by HFS
      // partitions. We don't need a full plist parser for this.
      const matches = stdout.matchAll(/<key>DeviceIdentifier<\/key>\s*<string>(disk\d+s\d+)<\/string>[\s\S]*?<key>Content<\/key>\s*<string>Apple_HFS<\/string>/g)
      for (const m of matches) {
        const id = m[1]
        // Skip partitions that are already mounted.
        if (mounts.some(mp => mp.includes(id))) continue
        try {
          const { stdout: mountOut } = await execP('diskutil', ['mount', id], { timeout: 15000 })
          const mm = mountOut.match(/on (\/Volumes\/[^\s]+)/)
          const mountedAt = mm ? mm[1] : null
          if (mountedAt && await isIpodMount(mountedAt)) {
            // Success on the remount path must clear the negative cache
            // set above, or the next poll would report null for 10s
            // while the iPod is sitting there mounted.
            ipodNegativeCacheUntil = 0
            lastIpodLogState = `found:${mountedAt}`
            return mountedAt
          }
        } catch {
          /* not mountable or not an iPod — skip */
        }
      }
    } catch {
      /* diskutil not available or query failed — give up */
    }
  }

  return null
}

/**
 * Eject a mounted volume. Cross-platform wrapper.
 *   macOS:   `diskutil eject /Volumes/NAME`
 *   Windows: PowerShell Shell.Application eject
 */
export async function ejectVolume(mountPoint: string): Promise<void> {
  if (IS_MAC) {
    // Drain dirty FAT32 pages before the eject command. A sync that just
    // finished can still have catalog bytes in the page cache; ejecting
    // without this is how a 500/500 report became 33 songs on the Mini.
    try { await execP('sync', [], { timeout: 15000 }) } catch { /* best-effort */ }
    await execP('diskutil', ['eject', mountPoint])
    return
  }
  // Windows — use PowerShell to call the Shell.Application COM object's
  // InvokeVerb("Eject") on the drive. Works for USB drives and CDs alike.
  const driveLetter = mountPoint.replace(/\\$/, '').replace(/:$/, ':')
  const ps = `(New-Object -comObject Shell.Application).Namespace(17).ParseName('${driveLetter}').InvokeVerb('Eject')`
  await execP('powershell', ['-NoProfile', '-Command', ps])
}

/**
 * Resolve a mounted volume's BSD device node (e.g. "/dev/disk9s2") from its
 * mount point, via `diskutil info -plist`. Needed to unmount+remount a specific
 * volume by node. macOS only; returns null if it can't be resolved.
 */
export async function resolveDeviceNode(mountPoint: string): Promise<string | null> {
  if (!IS_MAC) return null
  try {
    const { stdout } = await execP('diskutil', ['info', '-plist', mountPoint], { timeout: 15000 })
    const m = stdout.match(/<key>DeviceNode<\/key>\s*<string>(\/dev\/disk\d+s\d+)<\/string>/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * macOS fsync() does not wait for the media. USB FAT32 needs F_FULLFSYNC or
 * the next remount/eject still drops the file (copyFile "succeeded", Mini
 * shows 33). Best-effort: POSIX fsync first, then Darwin F_FULLFSYNC via
 * Python's fcntl — no native addon.
 */
export async function fullFsync(filePath: string): Promise<void> {
  const fh = await open(filePath, 'r+')
  try { await fh.sync() } finally { await fh.close() }
  if (!IS_MAC) return
  const py = PYTHON_CMD ?? 'python3'
  try {
    await execP(py, [
      '-c',
      'import fcntl,os,sys; fd=os.open(sys.argv[1], os.O_RDWR); fcntl.fcntl(fd, fcntl.F_FULLFSYNC); os.close(fd)',
      filePath,
    ], { timeout: 20000 })
  } catch { /* fsync already ran */ }
}

export interface RemountVolumeOpts {
  /**
   * Permit `diskutil unmount force`. Default false. Sync must never pass true:
   * force-unmount is how a verified 500-song set became 33 on the card.
   */
  allowForce?: boolean
}

/**
 * Flush, then unmount + remount a volume to EVICT the macOS mount cache so
 * subsequent reads come from the physical device, not cached pages. This is the
 * only reliable way to see what truly committed on an fskit/FAT32 iPod whose
 * cache reports writes that never reached the card (the "picked 500, got 299"
 * bug — 2026-07-24).
 *
 * `diskutil eject` is deliberately NOT used: it powers the device down and macOS
 * won't auto-remount a FAT32 volume (findIpodMount's remount fallback only
 * handles Apple_HFS). `unmount`+`mount` by node keeps the device enumerated and
 * diskutil restores it at the same /Volumes/NAME path.
 *
 * Never throws. Returns { ok, mountPoint } on success (mountPoint is where it
 * came back — the same path in practice) or { ok:false, error }.
 */
export async function remountVolume(mountPoint: string, opts: RemountVolumeOpts = {}): Promise<{ ok: boolean; mountPoint?: string; error?: string }> {
  if (!IS_MAC) return { ok: false, error: 'remount is macOS-only' }
  const node = await resolveDeviceNode(mountPoint)
  if (!node) return { ok: false, error: `could not resolve device node for ${mountPoint}` }
  const allowForce = opts.allowForce === true
  const CLEAN_TRIES = 10
  let unmounted = false
  let lastErr = ''
  for (let tryN = 1; tryN <= CLEAN_TRIES && !unmounted; tryN++) {
    try { await execP('sync', [], { timeout: 15000 }) } catch { /* best-effort */ }
    for (const args of remountUnmountArgSets(node, mountPoint, false)) {
      try {
        await execP('diskutil', args, { timeout: 30000 })
        unmounted = true
        break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
    }
    if (!unmounted && tryN < CLEAN_TRIES) {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  if (!unmounted && allowForce) {
    try {
      await execP('diskutil', ['unmount', 'force', node], { timeout: 30000 })
      unmounted = true
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  if (!unmounted) {
    return {
      ok: false,
      error: `clean unmount failed for ${node} (refusing force — force unmount discards dirty FAT32 pages and is the 500→33 roulette). ${lastErr}`.trim(),
    }
  }
  // Remount by node — diskutil mount is synchronous and restores /Volumes/NAME.
  try {
    await execP('diskutil', ['mount', node], { timeout: 30000 })
  } catch (e) {
    return { ok: false, error: `mount failed for ${node}: ${e instanceof Error ? e.message : String(e)}` }
  }
  // Confirm it's actually back. A DIRECT stat bypasses findIpodMount's 10s
  // negative cache and the fskit /Volumes readdir flap; wait up to ~5s for the
  // volume to settle after the flapping remount.
  for (let i = 0; i < 10; i++) {
    try { await stat(join(mountPoint, 'iPod_Control')); return { ok: true, mountPoint } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, error: `remounted but ${mountPoint} did not reappear` }
}

/**
 * Check if any optical drive currently has media inserted.
 *   macOS:   `drutil status` and parse output
 *   Windows: PowerShell query WMI for CD/DVD drives with media
 */
export async function hasOpticalMedia(): Promise<boolean> {
  if (IS_MAC) {
    try {
      const { stdout } = await execP('drutil', ['status'])
      return stdout.includes('Type:') && !stdout.includes('No media')
    } catch {
      return false
    }
  }
  // Windows
  try {
    const { stdout } = await execP('powershell', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_CDROMDrive | Where-Object { $_.MediaLoaded -eq $true } | Select-Object -First 1 -ExpandProperty Drive"
    ])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Eject whatever optical disc is in the drive.
 *   macOS:   `drutil eject`
 *   Windows: PowerShell eject on the first CD/DVD drive
 */
export async function ejectOpticalMedia(): Promise<void> {
  if (IS_MAC) {
    await execP('drutil', ['eject'])
    return
  }
  const ps = `$d = (Get-CimInstance Win32_CDROMDrive | Select-Object -First 1 -ExpandProperty Drive); if ($d) { (New-Object -comObject Shell.Application).Namespace(17).ParseName($d).InvokeVerb('Eject') }`
  await execP('powershell', ['-NoProfile', '-Command', ps])
}

/**
 * Return the relative filesystem path to a native audio-device helper,
 * or null if no helper is available on this platform.
 *
 * macOS ships a Swift binary. Windows has no helper yet (device selection
 * falls back to the OS default device). That returns null here and the
 * caller treats the device list as empty.
 */
export function audioHelperRelPath(): string | null {
  if (IS_MAC) return 'core/audio_helper'
  // Windows: not yet implemented — return null so the caller degrades gracefully.
  return null
}

// ────────────────────────────────────────────────────────────────────
// Audio conversion (CD rip / library import)
//
// macOS has `afconvert` built in — no install required.
// Windows needs ffmpeg, which JakeTunes expects on PATH. If it's missing
// the user gets a clear error with a download link rather than a crash.
// ────────────────────────────────────────────────────────────────────

/** Output formats JakeTunes can produce. */
export type AudioFormat = 'aac-128' | 'aac-256' | 'aac-320' | 'alac' | 'aiff' | 'wav'

/** File extension produced for each format. */
export function extensionForFormat(fmt: AudioFormat): string {
  switch (fmt) {
    case 'alac':  return '.m4a'
    case 'aiff':  return '.aiff'
    case 'wav':   return '.wav'
    default:      return '.m4a' // all AAC variants
  }
}

/**
 * Pick the output format for an imported file given the user's preferred
 * default. Jake's import policy (covers Bandcamp purchases, drag-drop
 * manual uploads, anywhere):
 *
 *   - FLAC source -> AAC (no point keeping a lossy-of-lossless copy
 *     when the AAC encoder is fine for everyday listening)
 *   - WAV source  -> AAC (same reasoning, plus uncompressed sizes are
 *     wasteful on the library disk)
 *   - ALAC source -> ALAC (lossless stays lossless)
 *   - everything else -> the user's preferred default unchanged
 *
 * The AAC variant for FLAC/WAV picks the user's preferred bitrate if
 * they already had one (aac-128/256/320); otherwise defaults to
 * aac-256.
 */
export function resolveImportFormat(srcPath: string, userPreferred: AudioFormat): AudioFormat {
  const ext = srcPath.slice(srcPath.lastIndexOf('.')).toLowerCase()
  if (ext === '.flac' || ext === '.wav') {
    return userPreferred.startsWith('aac-') ? userPreferred : 'aac-256'
  }
  return userPreferred
}

/**
 * Metadata that can be embedded into the output file at convert time. All
 * fields are optional — only non-empty values are written.
 */
export interface AudioTags {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  year?: string | number
  trackNumber?: number
  trackCount?: number
  discNumber?: number
  discCount?: number
  uuid?: string
}

/**
 * Write tags into an audio file using Python + mutagen (already a runtime
 * dependency). Runs after the encoder finishes. Best-effort: a failure
 * here is logged but does not abort the rip — you'd rather have an
 * untagged file than no file.
 */
/**
 * iPod firmware needs the MP4 index (moov) BEFORE the audio data. ffmpeg
 * muxes moov LAST by default, and files arriving from external pipelines
 * (streamrip's own conversion, yt-dlp, etc.) often come that way — they
 * play fine everywhere except 2004-era iPods, which skip them instantly
 * (2026-07-19: 1,135 such files found in the library; "Veronica"/"WRTB"
 * were Jake's first two). Lossless remux (-c copy) with +faststart when
 * needed; no-op when the file is already well-ordered or not an mp4.
 */
export async function ensureFaststart(path: string): Promise<void> {
  if (!/\.(m4a|mp4|m4b)$/i.test(path)) return
  try {
    const { open: openFile, rename: renameFS, unlink: unlinkFS } = await import('fs/promises')
    const fh = await openFile(path, 'r')
    const order: string[] = []
    try {
      let pos = 0
      const hdr = Buffer.alloc(16)
      while (order.length < 8) {
        const { bytesRead } = await fh.read(hdr, 0, 16, pos)
        if (bytesRead < 8) break
        let size = hdr.readUInt32BE(0)
        const name = hdr.toString('latin1', 4, 8)
        order.push(name)
        if (size === 1) size = Number(hdr.readBigUInt64BE(8))
        else if (size === 0) break
        pos += size
      }
    } finally {
      await fh.close()
    }
    const moov = order.indexOf('moov')
    const mdat = order.indexOf('mdat')
    if (moov < 0 || mdat < 0 || moov < mdat) return // fine as-is
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execP = promisify(execFile)
    const tmp = path + '.faststart.m4a'
    await execP('ffmpeg', ['-nostdin', '-y', '-i', path, '-map', '0', '-c', 'copy', '-movflags', '+faststart', tmp], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
    await renameFS(tmp, path).catch(async (err) => { await unlinkFS(tmp).catch(() => {}); throw err })
  } catch (err) {
    console.warn(`ensureFaststart: left ${path} as-is:`, err)
  }
}

async function embedTags(path: string, tags: AudioTags): Promise<void> {
  const nonEmpty = Object.entries(tags).some(([, v]) => v !== undefined && v !== null && v !== '')
  if (!nonEmpty) return
  const { app } = await import('electron')
  const { join } = await import('path')
  const { spawn } = await import('child_process')
  const script = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/tag_writer.py')
  await new Promise<void>((resolve) => {
    // embedTags only needs mutagen, not librosa, so we fall back to
    // a bare 'python3' if the librosa-aware resolver returned null.
    const py = spawn(PYTHON_CMD ?? 'python3', [script, path])
    let stderr = ''
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    py.on('error', (err) => {
      console.warn(`embedTags: could not launch tagger for ${path}: ${err}`)
      resolve()
    })
    py.on('close', (code) => {
      if (code !== 0) console.warn(`embedTags: exit ${code} for ${path}: ${stderr}`)
      resolve()
    })
    py.stdin.write(JSON.stringify(tags))
    py.stdin.end()
  })
}

/**
 * Two-step ALAC conversion that's guaranteed to produce iPod-Classic-
 * playable output regardless of source format:
 *
 *   1. ffmpeg decodes the source to 16-bit PCM WAV at ≤48 kHz
 *   2. afconvert encodes the WAV back to ALAC
 *
 * Why both tools? Going ffmpeg → ALAC direct produces files that
 * metadata-wise claim 16-bit but contain bitstream layouts iPod's
 * hardware decoder chokes on ("scratched CD" stutter). afconvert is
 * Apple's own encoder — its ALAC output is byte-for-byte compatible
 * with iPod's decoder. But afconvert can't easily force 16-bit from
 * a 32-bit input in one shot, hence the WAV intermediate.
 */
async function convertToIpodSafeAlac(src: string, dest: string, readTimeoutMs = 300000): Promise<void> {
  const { unlink } = await import('fs/promises')
  const { randomBytes } = await import('crypto')
  const os = await import('os')
  const { join } = await import('path')
  const wavTmp = join(os.tmpdir(), `jaketunes-alac-${randomBytes(6).toString('hex')}.wav`)

  try {
    // Step 1: decode to 16-bit PCM WAV. Let ffmpeg pick sample rate
    // up to 48kHz; only downsample if the source is higher-res.
    // readTimeoutMs is caller-scaled when the SOURCE is slow media (CD
    // rips read at ~realtime on a slow drive/disc — see convertAudio).
    await execP('ffmpeg', [
      '-y', '-i', src,
      '-map', '0:a:0',
      '-sample_fmt', 's16',
      '-ar', '44100',
      '-f', 'wav',
      '-loglevel', 'error',
      wavTmp,
    ], { timeout: readTimeoutMs, maxBuffer: 64 * 1024 * 1024 })

    // Step 2: afconvert → ALAC
    await execP('afconvert', [
      '-f', 'm4af', '-d', 'alac', wavTmp, dest,
    ], { timeout: 300000, maxBuffer: 64 * 1024 * 1024 })
  } finally {
    // Always clean up the WAV scratch file, even on failure.
    await unlink(wavTmp).catch(() => {})
  }
}

/**
 * Convert `src` to `dest` in the requested format. Uses afconvert on macOS
 * and ffmpeg on Windows. For the AIFF "format" we just copy the source
 * unchanged, since most CDs already rip as AIFF.
 *
 * If `tags` is provided, write them into the output file after encoding
 * so the file is self-identifying even if the library.json ever
 * disappears. ffmpeg gets them via `-metadata`; afconvert doesn't support
 * tagging, so we post-process with mutagen.
 *
 * On Windows, throws a helpful error if ffmpeg isn't on PATH.
 */
export async function convertAudio(
  src: string,
  dest: string,
  fmt: AudioFormat,
  tags?: AudioTags,
  opts?: { timeoutMs?: number },
): Promise<void> {
  // The timeout exists to catch HUNG encoders, not to police slow media.
  // A fixed 300s ceiling has now twice killed legitimate CD rips (120s ate
  // an 8-minute James Brown track; 300s ate every track of a 1988 disc
  // reading at ~realtime — ffmpeg measured 341s for a 4:50 track). Callers
  // ripping from slow sources pass a duration-scaled timeoutMs; local-file
  // conversions keep the 300s default.
  const timeoutMs = opts?.timeoutMs ?? 300000
  if (fmt === 'aiff') {
    // AIFF is the native ripped format; no conversion needed.
    const { copyFile } = await import('fs/promises')
    await copyFile(src, dest)
    if (tags) await embedTags(dest, tags)
    return
  }

  if (IS_MAC) {
    // Special case: ALAC import ALWAYS targets 16-bit / 44.1kHz so
    // anything imported is guaranteed iPod-Classic-playable. Without
    // this, importing a 24/32-bit or 96/192kHz "high-res" album as
    // ALAC would produce files the iPod hardware skips like a
    // scratched CD. We use a two-step pipeline so the output is
    // written by afconvert (Apple's own encoder, iPod-friendly
    // bitstream), not ffmpeg-direct-to-ALAC (which creates valid-
    // looking files that iPod's decoder chokes on).
    if (fmt === 'alac') {
      await convertToIpodSafeAlac(src, dest, timeoutMs)
      if (tags) await embedTags(dest, tags)
      return
    }

    // `aac@44100` pins output to 44.1 kHz regardless of source rate.
    // iPod Mini Gen 1's AAC decoder mishandles 48 kHz playback (audible
    // squeaking on ~half of 48k tracks), so we resample at encode time —
    // mirroring the ALAC path's iPod-safety guarantee above.
    const args: string[] = (() => {
      switch (fmt) {
        case 'aac-128': return ['-f', 'm4af', '-d', 'aac@44100', '-b', '128000', '-s', '2']
        case 'aac-256': return ['-f', 'm4af', '-d', 'aac@44100', '-b', '256000', '-s', '2']
        case 'aac-320': return ['-f', 'm4af', '-d', 'aac@44100', '-b', '320000', '-s', '2']
        case 'wav':     return ['-f', 'WAVE', '-d', 'LEI16@44100']
        default:        return []
      }
    })()
    // Timeout is caller-scaled for slow sources (CD rips); 300s default
    // otherwise. The old fixed limits (120s, then 300s) each ended up
    // killing legitimate slow rips — see the convertAudio doc comment.
    await execP('afconvert', [src, dest, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
    if (tags) await embedTags(dest, tags)
    return
  }

  // Windows — shell out to ffmpeg. `-ar 44100` matches the macOS AAC
  // path's iPod-safety resample; ALAC also pinned for the same reason
  // (mirrors macOS convertToIpodSafeAlac).
  const args: string[] = (() => {
    switch (fmt) {
      case 'aac-128': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', dest]
      case 'aac-256': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '256k', '-ar', '44100', dest]
      case 'aac-320': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '320k', '-ar', '44100', dest]
      case 'alac':    return ['-y', '-i', src, '-c:a', 'alac', '-ar', '44100', '-sample_fmt', 's16p', dest]
      case 'wav':     return ['-y', '-i', src, '-c:a', 'pcm_s16le', '-ar', '44100', dest]
    }
  })()
  try {
    await execP('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ENOENT')) {
      throw new Error(
        'ffmpeg is not installed. Download it from https://www.gyan.dev/ffmpeg/builds/ (choose "release essentials"), extract, and add its bin/ folder to your PATH. Then restart JakeTunes.'
      )
    }
    throw err
  }
  if (tags) await embedTags(dest, tags)
}
