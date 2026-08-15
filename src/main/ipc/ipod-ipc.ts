/**
 * iPod device IPC: capacity, mount detect, eject, restore-from-XML.
 *
 * Mount state remains authoritative in main/index.ts (many non-IPC
 * call sites read/write it). This module mutates it through one host
 * interface so we don't fork a second source of truth.
 *
 * Does NOT rewrite the ipod-audio:// protocol handler.
 */
import { dialog } from 'electron'
import { join } from 'path'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { findIpodMount, volumeNameFromMount, ejectVolume, IS_MAC } from '../platform.ts'

export interface IpodMountSnapshot {
  mount: string | null
  volume: string | null
  missStreak: number
}

export interface IpodIpcHost {
  getMount: () => IpodMountSnapshot
  /** Atomic patch of mount/volume/missStreak. */
  setMount: (next: Partial<IpodMountSnapshot>) => void
  runPythonRestore: (
    args: string[],
    stdinData?: string,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  /**
   * True while sync-to-ipod holds the device. Mount polls must not treat a
   * verify remount as an unplug — that false→true edge fires auto-repair
   * and used to start a second writer mid-copy (roulette).
   */
  isSyncInFlight?: () => boolean
}

const IPOD_MISS_THRESHOLD = 3   // ~3 polls (~7.5s) of true absence before "disconnected"

export function registerIpodIpc(ipc: IpcRegistrar, host: IpodIpcHost): void {
  // Report the iPod's actual storage capacity by statting the mounted volume.
  ipc.handle('get-ipod-capacity', async () => {
    try {
      let { mount, volume } = host.getMount()
      if (!mount) {
        mount = await findIpodMount()
        volume = mount ? volumeNameFromMount(mount) : null
        host.setMount({ mount, volume })
      }
      if (!mount) return { ok: false, error: 'No iPod detected' }
      const { statfs } = await import('fs/promises')
      const s = await statfs(mount)
      const totalBytes = Number(s.blocks) * Number(s.bsize)
      const freeBytes = Number(s.bavail) * Number(s.bsize)
      let fsName: string | undefined
      if (IS_MAC) {
        try {
          const { execFile: xf } = await import('child_process')
          const { promisify: pf } = await import('util')
          const { stdout } = await pf(xf)('/sbin/mount', [], { timeout: 5000 })
          const line = stdout.split('\n').find((l: string) => l.includes(` on ${mount} `))
          const m = line?.match(/\(([a-z0-9_]+)[,)]/i)
          const raw = m?.[1]?.toLowerCase()
          fsName = raw === 'msdos' ? 'MS-DOS (FAT32)'
            : raw === 'hfs' ? 'Mac OS Extended (HFS+)'
            : raw === 'apfs' ? 'APFS'
            : raw === 'exfat' ? 'ExFAT'
            : raw
        } catch { /* leave undefined — the UI falls back to "Unknown" */ }
      }
      return { ok: true, totalBytes, freeBytes, mount, fsName }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { public: true })

  ipc.handle('check-ipod-mounted', async () => {
    try {
      let state = host.getMount()
      // Hold the last-known mount while a sync remounts the volume. A miss
      // here used to flip the sidebar to "ejected" then back, which fired
      // jaketunes-ipod-mounted and started auto-repair on top of the live
      // writer (two syncs, random Songs counts).
      if (host.isSyncInFlight?.() && state.mount) {
        return { mounted: true, name: state.volume }
      }
      let mount = await findIpodMount()
      // findIpodMount scans /Volumes, which can transiently miss a flapping
      // fskit mount even while it's fully readable — re-stat the last-known
      // iTunesDB directly before believing it's gone.
      if (!mount && state.mount) {
        try {
          const { stat } = await import('fs/promises')
          await stat(join(state.mount, 'iPod_Control', 'iTunes', 'iTunesDB'))
          mount = state.mount
        } catch { /* genuinely absent this poll */ }
      }
      if (mount) {
        const volume = volumeNameFromMount(mount)
        host.setMount({ mount, volume, missStreak: 0 })
        return { mounted: true, name: volume }
      }
      // No mount this poll. Ride out a brief flap rather than yanking the
      // iPod from the UI.
      state = host.getMount()
      if (state.mount && state.missStreak < IPOD_MISS_THRESHOLD) {
        host.setMount({ missStreak: state.missStreak + 1 })
        return { mounted: true, name: state.volume }
      }
      host.setMount({ mount: null, volume: null, missStreak: 0 })
      return { mounted: false, name: null }
    } catch {
      return { mounted: false, name: null }
    }
  }, { public: true })

  ipc.handle('eject-ipod', async () => {
    try {
      let { mount, volume } = host.getMount()
      if (!mount) {
        mount = await findIpodMount()
        volume = mount ? volumeNameFromMount(mount) : null
        host.setMount({ mount, volume })
      }
      if (!mount) return { ok: false, error: 'No iPod detected' }
      await ejectVolume(mount)
      host.setMount({ mount: null, volume: null, missStreak: 0 })
      return { ok: true }
    } catch {
      return { ok: false, error: 'Eject failed' }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('restore-xml-pick-file', async () => {
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
  }, { public: true })

  ipc.handle('restore-xml-scan', async (_event, xmlPath: string) => {
    const { volume } = host.getMount()
    if (!volume) return { ok: false, error: 'No iPod detected' }
    const mount = `/Volumes/${volume}`
    return await host.runPythonRestore(['--scan', mount, xmlPath])
  }, { public: true })

  ipc.handle('restore-xml-apply', async (_event, xmlPath: string, approvedIds: number[]) => {
    const { volume } = host.getMount()
    if (!volume) return { ok: false, error: 'No iPod detected' }
    const mount = `/Volumes/${volume}`
    const payload = JSON.stringify({ approvedIds })
    return await host.runPythonRestore(['--apply', mount, xmlPath], payload)
  }, { refuse: REFUSED_SENDER })
}
