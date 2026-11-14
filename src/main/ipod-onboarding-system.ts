/**
 * What iPod set-up asks the Mac itself (2026-11-14): the mount table, the
 * drive's own identity, the USB side of it, other iPods plugged in, renaming
 * the drive. Kept apart from ipc/ipod-onboarding-ipc.ts so the handlers can be
 * run in tests against folders, with these answers supplied by the test.
 * UNPROVEN ON AN iPOD: nothing here has been run against a device.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IS_MAC, isIpodMount, listMountPoints } from './platform.ts'
import { renameMacVolume } from './ipod-rename.ts'
import { usbFactsFromProfile } from './ipod-onboarding.ts'
import type { IpodUsbFacts } from '../common/ipod-onboarding.ts'

const execP = promisify(execFile)

export interface IpodSetupSystem {
  /** The text of `/sbin/mount`. */
  mountTable: () => Promise<string>
  /** The volume's own identity: its UUID and size as diskutil reports them. null = it wouldn't say. */
  driveId: (mount: string) => Promise<string | null>
  usb: (mount: string) => Promise<IpodUsbFacts | null>
  /** iPods mounted other than this one. */
  otherIpods: (mount: string) => Promise<number>
  /** Rename the drive; resolves to its new mount path (null = unknown). */
  renameVolume: (mount: string, label: string) => Promise<string | null>
}

const plist = (xml: string, key: string, type: 'string' | 'integer'): string | null =>
  new RegExp(`<key>${key}</key>\\s*<${type}>([^<]*)</${type}>`).exec(xml)?.[1] ?? null

/** `diskutil info -plist` → "uuid|size". Needs the UUID: a size alone is not an identity. */
export function driveIdFromDiskutil(xml: string): string | null {
  const uuid = plist(xml, 'VolumeUUID', 'string')
  const size = plist(xml, 'TotalSize', 'integer') ?? plist(xml, 'Size', 'integer')
  // A FAT32 volume with a zero serial reports the all-zero UUID: that is every such drive's
  // "id", so it is no id at all.
  return uuid && /[1-9a-f]/i.test(uuid) ? `${uuid}|${size ?? ''}` : null
}

export const realIpodSetupSystem: IpodSetupSystem = {
  mountTable: async () => (IS_MAC ? (await execP('/sbin/mount', [], { timeout: 5000 })).stdout : ''),
  driveId: async (mount) => {
    if (!IS_MAC) return null
    return driveIdFromDiskutil((await execP('diskutil', ['info', '-plist', mount], { timeout: 10_000 })).stdout)
  },
  usb: async (mount) => {
    if (!IS_MAC) return null
    const info = await execP('diskutil', ['info', '-plist', mount], { timeout: 10_000 })
    const whole = plist(info.stdout, 'ParentWholeDisk', 'string')
    if (!whole) return null
    for (const type of ['SPUSBDataType', 'SPUSBHostDataType']) {
      const out = await execP('system_profiler', [type, '-json'], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }).catch(() => null)
      const hit = out ? usbFactsFromProfile(JSON.parse(out.stdout), whole) : null
      if (hit) return hit
    }
    return null
  },
  otherIpods: async (mount) => {
    let n = 0
    for (const m of await listMountPoints()) if (m !== mount && await isIpodMount(m)) n++
    return n
  },
  renameVolume: (mount, label) => (IS_MAC ? renameMacVolume(mount, label) : Promise.resolve(null)),
}
