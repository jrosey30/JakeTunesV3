/**
 * The small iPods carry smaller files (Jake, 2026-11-24: "gen 1 ipod has a 10 gb max,
 * indie sleaze ipod has a 8 gb max and y2kpod has a 40 gb max … sync my ipod playlists
 * as they are to AAC/high end mp3 only for those 3 ipods. without making copies of those
 * files").
 *
 * The library keeps its one copy of every song. Only what goes onto these three iPods is
 * made smaller, at sync time, into the sync cache on the Mac (the same cache the convert
 * toggle always used; never the library, never the NAS):
 *
 *   • Gen 1 (a 2001 iPod): its firmware plays MP3 and nothing newer, no AAC and no ALAC.
 *     Every song that isn't already an MP3 goes on as a 320 kbps MP3.
 *   • Y2KPod and IndieSleaze: a lossless song goes on as 256 kbps AAC. A song that is
 *     already AAC or MP3 goes on as it is.
 *
 * Every other iPod follows the Device page's convert setting, as before.
 *
 * Keyed by the iPod's id, which is its list id on homemini (ipod-lists.json), so a
 * rename changes nothing. Pure: node --test loads it.
 */

export type IpodAudioCodec = 'aac' | 'mp3'

export interface IpodAudioFormat {
  codec: IpodAudioCodec
  kbps: 256 | 320
}

/** Gen 1: a first-generation iPod. MP3 only. */
export const GEN1_IPOD_ID = 'f8ff5c4e-f4d1-41a7-9c4c-57cca2f867ca'
/** Y2KPod: a 40 GB third-generation iPod. */
export const Y2K_IPOD_ID = '842f4c4f-14f2-45b4-9c5d-32c1295604da'
/** IndieSleaze: 8 GB. */
export const INDIE_SLEAZE_IPOD_ID = '2a2f2e5c-a5b6-48fe-934c-a7c38b744132'

const FORMATS: ReadonlyMap<string, IpodAudioFormat> = new Map([
  [GEN1_IPOD_ID, { codec: 'mp3', kbps: 320 }],
  [Y2K_IPOD_ID, { codec: 'aac', kbps: 256 }],
  [INDIE_SLEAZE_IPOD_ID, { codec: 'aac', kbps: 256 }],
])

/** The fixed format for this iPod, or null when it follows the Device page's setting. */
export function ipodAudioFormat(ipodId: string | null | undefined): IpodAudioFormat | null {
  if (!ipodId) return null
  return FORMATS.get(ipodId) ?? null
}

export interface SyncConvertChoice {
  enabled: boolean
  targetKbps: 128 | 192 | 256 | 320
  codec?: IpodAudioCodec
}

/**
 * What a sync of this iPod converts: its own format when it has one, else exactly what
 * the Device page passed (the same object, so a caller can tell nothing changed).
 */
export function convertOptionsForIpod<T extends SyncConvertChoice>(
  ipodId: string | null | undefined,
  passed: T | undefined,
): T | SyncConvertChoice | undefined {
  const own = ipodAudioFormat(ipodId)
  if (!own) return passed
  return { enabled: true, targetKbps: own.kbps, codec: own.codec }
}
