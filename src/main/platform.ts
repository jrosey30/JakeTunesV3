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
    try {
      await execP('diskutil', ['eject', mountPoint])
    } catch (err) {
      // 2026-08-25 — diskutil's own words are the ONLY useful part of an eject
      // failure ("in use by process N", "dissented by ..."), and they were
      // being thrown away: the caller caught this and returned the literal
      // string 'Eject failed', which the UI then prefixed with "Eject failed:"
      // — Jake got "Eject failed: Eject failed" and no reason at all.
      // Re-thrown with the cause, PATH-FREE so safeIpcError won't scrub it.
      const raw = String((err as { stderr?: string; message?: string })?.stderr
        || (err as Error)?.message || '')
      const busy = /in use by process\s+(\d+)\s*\(([^)]+)\)/i.exec(raw)
      if (/simulator/i.test(raw)) {
        // Same escalation as the sync path: shut simulators, then kill the
        // service that holds stale state, retrying the eject after each.
        const steps: Array<{ cmd: string; args: string[]; timeout: number }> = [
          { cmd: 'xcrun', args: ['simctl', 'shutdown', 'all'], timeout: 60000 },
          { cmd: 'killall', args: ['-9', 'com.apple.CoreSimulator.CoreSimulatorService'], timeout: 20000 },
        ]
        for (const step of steps) {
          try { await execP(step.cmd, step.args, { timeout: step.timeout }) } catch { /* best-effort */ }
          await new Promise((r) => setTimeout(r, 3000))
          try {
            await execP('diskutil', ['eject', mountPoint])
            return
          } catch { /* try the next escalation */ }
        }
        throw new Error('the iOS Simulator is holding the disk and would not let go — unplug and replug the iPod')
      }
      if (busy) throw new Error(`the disk is still in use by ${busy[2]}`)
      if (/dissent/i.test(raw)) throw new Error('another app refused to let the disk go')
      if (/busy|resource/i.test(raw)) throw new Error('the disk is busy')
      throw new Error('the disk did not respond to eject')
    }
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
    if (!unmounted && /simulator/i.test(lastErr)) {
      if (tryN === 1) {
        try { await execP('xcrun', ['simctl', 'shutdown', 'all'], { timeout: 60000 }) } catch { /* best-effort */ }
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      if (tryN === 2) {
        // Still dissenting with nothing booted: the SERVICE is holding stale
        // state. launchd brings it back when something needs it.
        try { await execP('killall', ['-9', 'com.apple.CoreSimulator.CoreSimulatorService'], { timeout: 20000 }) } catch { /* best-effort */ }
        await new Promise((r) => setTimeout(r, 4000))
        continue
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
    const hint = /simulator/i.test(lastErr)
      ? 'the iOS Simulator is holding the card — quit it (xcrun simctl shutdown all) and sync again. '
      : ''
    return {
      ok: false,
      error: `${hint}clean unmount failed for ${node} (refusing force — force unmount discards dirty FAT32 pages and is the 500→33 roulette). ${lastErr}`.trim(),
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
 * Missing / invalid `library.defaultImportFormat` lands here.
 * ALAC, not AAC: the library master stays lossless unless the setting
 * itself asks for something else.
 */
export const DEFAULT_IMPORT_FORMAT: AudioFormat = 'alac'

/**
 * Output format for one imported file.
 *
 * 2026-05-22 (8f6bd26, "FLAC/WAV → AAC policy") forced FLAC and WAV to
 * 256 kbps AAC even when this setting was ALAC, and the comment called
 * that Jake's policy. It was not. It was an abandoned idea for putting
 * AAC on the iPod, and Jake decided not to go ahead with it. It was
 * never meant to apply to library import. That override is gone.
 *
 * Library import honors `userPreferred` (the setting, default `'alac'`).
 * A lossless source therefore stays lossless. Lossy MP3/AAC are not
 * re-encoded; callers copy those bytes. iPod sync is a separate path
 * and is not decided here.
 *
 * `srcPath` stays in the signature so every import call site still
 * routes through this one function. The extension is no longer a
 * reason to ignore the setting.
 */
export function resolveImportFormat(_srcPath: string, userPreferred: AudioFormat): AudioFormat {
  return userPreferred
}

/** ffmpeg ALAC sample format that preserves the source bit depth.
 *  16-bit → s16p (ffprobe reports 16). Wider than 16 → s32p: ALAC stores
 *  24-bit in 32-bit samples and ffprobe reports bits_per_raw_sample=24.
 *  Forcing s32p on a 16-bit source makes the file report 24, so the
 *  choice has to follow the source. */
export function alacSampleFmt(bitsPerSample: number): 's16p' | 's32p' {
  return bitsPerSample > 16 ? 's32p' : 's16p'
}

/** PCM codec for a WAV intermediate that keeps the source bit depth. */
export function nativePcmCodec(bitsPerSample: number): 'pcm_s16le' | 'pcm_s24le' | 'pcm_s32le' {
  if (bitsPerSample > 24) return 'pcm_s32le'
  if (bitsPerSample > 16) return 'pcm_s24le'
  return 'pcm_s16le'
}

/**
 * ffmpeg args for a library ALAC encode. No `-ar` and no `-ac`: sample
 * rate and channel count stay the source's, so the decode is bit-exact.
 * `-map 0:v?` + `-c:v copy` keeps an attached cover when the source has
 * one; without the explicit audio map, ffmpeg tries to re-encode that
 * picture as h264 and the m4a mux fails.
 *
 * Before (every platform's library ALAC, and the Windows branch):
 *   -c:a alac -ar 44100 -sample_fmt s16p
 * which truncated 24-bit to 16-bit and resampled 96 kHz to 44.1 kHz.
 */
export function ffmpegPreserveAlacArgs(src: string, dest: string, bitsPerSample: number | null): string[] {
  const args = ['-y', '-i', src, '-map', '0:a:0', '-map', '0:v?', '-c:v', 'copy', '-c:a', 'alac']
  if (bitsPerSample != null && bitsPerSample > 0) args.push('-sample_fmt', alacSampleFmt(bitsPerSample))
  args.push(dest)
  return args
}

/**
 * afconvert data format for library ALAC on macOS. `alac` with no
 * `@44100` takes the WAV's own sample rate and bit depth. The WAV must
 * already be native-depth PCM (see nativePcmCodec) — a 16-bit
 * intermediate would throw the high bits away before afconvert runs.
 * afconvert is macOS-only; other platforms use ffmpegPreserveAlacArgs.
 */
export const AFCONVERT_LIBRARY_ALAC_DATA_FORMAT = 'alac'

export function afconvertLibraryAlacArgs(wav: string, dest: string): string[] {
  return ['-f', 'm4af', '-d', AFCONVERT_LIBRARY_ALAC_DATA_FORMAT, wav, dest]
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
  // Best-effort, matching the comment above: a missing electron app
  // (unit tests, a bare node process) must not fail the encode. The
  // file already carries whatever tags the encoder copied.
  let appRoot: string
  try {
    const electron = await import('electron') as { app?: { isPackaged?: boolean; getAppPath?: () => string } }
    const app = electron.app
    if (!app?.getAppPath) {
      console.warn(`embedTags: electron app unavailable, leaving encoder tags on ${path}`)
      return
    }
    appRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
  } catch (err) {
    console.warn(`embedTags: electron unavailable, leaving encoder tags on ${path}:`, err)
    return
  }
  const { join } = await import('path')
  const { spawn } = await import('child_process')
  const script = join(appRoot, 'core/tag_writer.py')
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
 * Existing iPod Mini mirror only — NOT library import.
 *
 * `buildIpodSafeAlacMirror` passes `ipodSafe: true` so a FLAC (or a
 * hi-res file over the Mini's bitrate ceiling) still becomes 16-bit /
 * 44.1 kHz stereo ALAC for the device. Library import does not call
 * this. The May 22 FLAC→AAC rule was an abandoned iPod idea; it is
 * not reintroduced here.
 *
 *   1. ffmpeg decodes the source to 16-bit PCM WAV at 44.1 kHz
 *   2. afconvert encodes the WAV back to ALAC
 *
 * Why both tools? ffmpeg → ALAC direct can produce a bitstream the
 * Mini's hardware decoder stutters on. afconvert is Apple's encoder.
 * afconvert can't easily force 16-bit from a 32-bit input in one shot,
 * hence the WAV intermediate.
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
      // Downmix to stereo. The Mini has no multichannel decoder: a 5.1
      // track indexes and then plays SILENT. "iPod-safe" has to mean the
      // channel count too, not just bit depth and sample rate.
      '-ac', '2',
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

export interface SourceAudioLayout {
  bitsPerSample: number
  sampleRate: number
  channels: number
}

/** First audio stream's bit depth, rate, and channel count. Null when
 *  ffprobe can't answer — the encoder then omits `-sample_fmt` and lets
 *  ffmpeg keep the decoded layout instead of guessing 16-bit. */
export async function probeSourceAudioLayout(src: string): Promise<SourceAudioLayout | null> {
  try {
    const { stdout } = await execP('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=bits_per_raw_sample,sample_rate,channels,sample_fmt',
      '-of', 'json', src,
    ], { timeout: 15000, maxBuffer: 1024 * 1024 })
    const parsed = JSON.parse(stdout || '{}') as { streams?: Array<Record<string, string | number>> }
    const s = parsed.streams?.[0]
    if (!s) return null
    let bits = Number(s.bits_per_raw_sample) || 0
    const sampleFmt = String(s.sample_fmt || '')
    if (!bits) {
      if (sampleFmt.startsWith('s16')) bits = 16
      else if (sampleFmt.startsWith('s32') || sampleFmt.startsWith('s24')) bits = 24
      else bits = 16
    }
    return {
      bitsPerSample: bits,
      sampleRate: Number(s.sample_rate) || 0,
      channels: Number(s.channels) || 0,
    }
  } catch (err) {
    console.warn(`[convert] ffprobe layout failed for ${src}:`, err instanceof Error ? err.message : err)
    return null
  }
}

async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
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
}

/** Library ALAC: same bit depth and sample rate as the source.
 *  macOS writes it with afconvert (`-d alac` on a native-depth WAV) so
 *  the bitstream stays Apple's. ffmpeg is the encoder everywhere else,
 *  and the fallback if afconvert fails.
 *
 *  The WAV step shells out to `ffmpeg` / `ffprobe` on PATH. There is no
 *  ffmpeg binary bundled in the app. On a Mac that is whichever ffmpeg
 *  is on PATH (typically Homebrew: `/opt/homebrew/bin/ffmpeg` or
 *  `/usr/local/bin/ffmpeg`). afconvert encodes the WAV; it does not
 *  decode the source FLAC, so a Mac with no PATH ffmpeg cannot run this
 *  branch and falls through to the ffmpeg preserve args (which also
 *  need that same binary). */
async function convertToLibraryAlac(src: string, dest: string, timeoutMs: number): Promise<void> {
  const layout = await probeSourceAudioLayout(src)
  const bits = layout?.bitsPerSample ?? null
  // No probed depth → skip the WAV step. Guessing 16-bit here would
  // truncate a 24-bit master before afconvert ever saw it. ffmpeg's
  // preserve args omit -sample_fmt in that case and keep the layout.
  if (IS_MAC && bits != null) {
    const { unlink } = await import('fs/promises')
    const { randomBytes } = await import('crypto')
    const os = await import('os')
    const { join } = await import('path')
    const wavTmp = join(os.tmpdir(), `jaketunes-alac-${randomBytes(6).toString('hex')}.wav`)
    try {
      await runFfmpeg([
        '-y', '-i', src,
        '-map', '0:a:0',
        '-c:a', nativePcmCodec(bits ?? 16),
        '-f', 'wav',
        '-loglevel', 'error',
        wavTmp,
      ], timeoutMs)
      await execP('afconvert', afconvertLibraryAlacArgs(wavTmp, dest), { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
      return
    } catch (err) {
      console.warn(`[convert] afconvert library ALAC failed, ffmpeg will keep bit depth:`, err instanceof Error ? err.message : err)
    } finally {
      await unlink(wavTmp).catch((err) => {
        console.warn(`[convert] leftover WAV ${wavTmp}:`, err instanceof Error ? err.message : err)
      })
    }
  }
  await runFfmpeg(ffmpegPreserveAlacArgs(src, dest, bits), timeoutMs)
}

/**
 * Convert `src` to `dest` in the requested format. Uses afconvert on macOS
 * and ffmpeg on Windows. For the AIFF "format" we just copy the source
 * unchanged, since most CDs already rip as AIFF.
 *
 * ALAC keeps the source bit depth and sample rate (24-bit stays 24-bit,
 * 96 kHz stays 96 kHz). The old library path pinned `-ar 44100` and
 * `-sample_fmt s16p` — that was the abandoned iPod downsample, and it
 * does not apply to library import. Pass `ipodSafe: true` only from the
 * existing Mini mirror (`buildIpodSafeAlacMirror`), which still needs
 * 16-bit / 44.1 kHz stereo.
 *
 * If `tags` is provided, write them into the output file after encoding
 * so the file is self-identifying even if the library.json ever
 * disappears. ffmpeg copies source metadata; afconvert doesn't support
 * tagging, so we post-process with mutagen.
 *
 * On Windows, throws a helpful error if ffmpeg isn't on PATH.
 */
export async function convertAudio(
  src: string,
  dest: string,
  fmt: AudioFormat,
  tags?: AudioTags,
  opts?: { timeoutMs?: number; ipodSafe?: boolean },
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

  if (fmt === 'alac') {
    if (opts?.ipodSafe) {
      if (IS_MAC) await convertToIpodSafeAlac(src, dest, timeoutMs)
      // Audio only. Mapping the attached cover makes ffmpeg try to mux
      // it as h264 and the m4a encode fails — the mac step already uses
      // -map 0:a:0. Rate and bit depth stay pinned for the Mini.
      else await runFfmpeg(['-y', '-i', src, '-map', '0:a:0', '-c:a', 'alac', '-ar', '44100', '-sample_fmt', 's16p', dest], timeoutMs)
    } else {
      await convertToLibraryAlac(src, dest, timeoutMs)
    }
    if (tags) await embedTags(dest, tags)
    return
  }

  if (IS_MAC) {
    // `aac@44100` pins AAC output to 44.1 kHz regardless of source rate.
    // iPod Mini Gen 1's AAC decoder mishandles 48 kHz playback (audible
    // squeaking on ~half of 48k tracks), so we resample at encode time.
    // This is the sync/AAC encoder, not the library ALAC master.
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
  // path's iPod-safety resample. Library ALAC is handled above and is
  // not pinned.
  const args: string[] = (() => {
    switch (fmt) {
      case 'aac-128': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', dest]
      case 'aac-256': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '256k', '-ar', '44100', dest]
      case 'aac-320': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '320k', '-ar', '44100', dest]
      case 'wav':     return ['-y', '-i', src, '-c:a', 'pcm_s16le', '-ar', '44100', dest]
      default:        return ['-y', '-i', src, dest]
    }
  })()
  await runFfmpeg(args, timeoutMs)
  if (tags) await embedTags(dest, tags)
}
