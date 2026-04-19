// Cross-platform helpers for macOS and Windows.
// Keeps platform-branching out of the main IPC handlers so each site
// has one call like findIpodVolume() instead of an if/else tree.

import { join } from 'path'
import { readdir, stat } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execP = promisify(execFile)

export const IS_MAC = process.platform === 'darwin'
export const IS_WINDOWS = process.platform === 'win32'

/**
 * Name of the Python executable on this platform.
 * macOS/Linux use "python3", Windows uses "python" (py.exe also works).
 */
export const PYTHON_CMD = IS_WINDOWS ? 'python' : 'python3'

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
 */
export async function listMountPoints(): Promise<string[]> {
  if (IS_MAC) {
    try {
      const entries = await readdir('/Volumes')
      return entries.map(v => `/Volumes/${v}`)
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
 * Check whether the given mount point is an iPod by looking for the
 * iTunesDB file at the standard path.
 */
export async function isIpodMount(mountPoint: string): Promise<boolean> {
  try {
    await stat(join(mountPoint, 'iPod_Control', 'iTunes', 'iTunesDB'))
    return true
  } catch {
    return false
  }
}

/**
 * Find the first mounted iPod on the system, or null if none is connected.
 * Returns the mount point (full path), not just the volume name.
 */
export async function findIpodMount(): Promise<string | null> {
  const mounts = await listMountPoints()
  for (const m of mounts) {
    if (await isIpodMount(m)) return m
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
async function embedTags(path: string, tags: AudioTags): Promise<void> {
  const nonEmpty = Object.entries(tags).some(([, v]) => v !== undefined && v !== null && v !== '')
  if (!nonEmpty) return
  const { app } = await import('electron')
  const { join } = await import('path')
  const { spawn } = await import('child_process')
  const script = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/tag_writer.py')
  await new Promise<void>((resolve) => {
    const py = spawn(PYTHON_CMD, [script, path])
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
): Promise<void> {
  if (fmt === 'aiff') {
    // AIFF is the native ripped format; no conversion needed.
    const { copyFile } = await import('fs/promises')
    await copyFile(src, dest)
    if (tags) await embedTags(dest, tags)
    return
  }

  if (IS_MAC) {
    const args: string[] = (() => {
      switch (fmt) {
        case 'aac-128': return ['-f', 'm4af', '-d', 'aac', '-b', '128000', '-s', '2']
        case 'aac-256': return ['-f', 'm4af', '-d', 'aac', '-b', '256000', '-s', '2']
        case 'aac-320': return ['-f', 'm4af', '-d', 'aac', '-b', '320000', '-s', '2']
        case 'alac':    return ['-f', 'm4af', '-d', 'alac']
        case 'wav':     return ['-f', 'WAVE', '-d', 'LEI16']
      }
    })()
    await execP('afconvert', [src, dest, ...args], { timeout: 120000 })
    if (tags) await embedTags(dest, tags)
    return
  }

  // Windows — shell out to ffmpeg.
  const args: string[] = (() => {
    switch (fmt) {
      case 'aac-128': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '128k', dest]
      case 'aac-256': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '256k', dest]
      case 'aac-320': return ['-y', '-i', src, '-c:a', 'aac', '-b:a', '320k', dest]
      case 'alac':    return ['-y', '-i', src, '-c:a', 'alac', dest]
      case 'wav':     return ['-y', '-i', src, '-c:a', 'pcm_s16le', dest]
    }
  })()
  try {
    await execP('ffmpeg', args, { timeout: 120000 })
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
