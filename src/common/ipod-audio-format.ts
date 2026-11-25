/**
 * Each iPod's own audio format: a stored profile per device (Brief 265 Part 2, Jake,
 * 2026-11-24: "adding another iPod means configuring a device profile, not rewriting the
 * sync engine").
 *
 * The library keeps its one copy of every song. Only what goes onto an iPod is made smaller,
 * at sync time, into the sync cache on the Mac (never the library, never the NAS).
 *
 * A profile:
 *   codec   'alac' — lossless masters go on as they are (the existing rules still turn a
 *                    FLAC, multichannel or over-ceiling file into the iPod-safe 16-bit /
 *                    44.1 kHz ALAC mirror); 'aac' / 'mp3' — every lossless song (every
 *                    non-MP3 song for 'mp3') is converted to that codec at `kbps`.
 *   kbps    128 | 192 | 256 | 320, for the lossy codecs.
 *   enabled false = this iPod follows the Device page's convert setting, as before.
 *   verifiedFormats  what the physical iPod was proven to play (Gen 1: Part 4). Recorded,
 *                    never assumed.
 *
 * Stored in their own file in the state dir (main/ipod-audio-profiles.ts,
 * ipod-audio-profiles.json), written only by main, so no renderer save of ui-state can
 * overwrite them. Keyed by the physical iPod: its serial number from the set-up record
 * ("serial:<SERIAL>", ipod-onboarding.json) when it has one. Without a serial the key is the
 * id in the iPod's ID file, which is its homemini list id (registerIpod writes the list id).
 * A profile under the list id is moved onto the serial key the first time both are known
 * (adoptProfile), so a second card on the same list never shares it; a card moved to another
 * list keeps its serial-keyed profile, and a list-keyed one is carried to the new list id
 * (carryProfileOnMove).
 *
 * Seeds (Jake's table, 2026-11-24) apply only when an iPod has no stored profile. An iPod with
 * neither follows the Device page's setting exactly as today.
 *
 * Pure: node --test loads it.
 */

export type IpodAudioCodec = 'alac' | 'aac' | 'mp3'
export type IpodLossyKbps = 128 | 192 | 256 | 320

export interface IpodAudioProfile {
  codec: IpodAudioCodec
  kbps?: IpodLossyKbps
  enabled: boolean
  verifiedFormats?: string[]
}

/** The file (in the state dir) that holds { [key]: IpodAudioProfile }. Main writes it; nothing else does. */
export const IPOD_AUDIO_PROFILES_FILE = 'ipod-audio-profiles.json'

/** Gen 1: a first-generation iPod (10 GB). MP3 is its documented baseline (Part 4: verify on arrival). */
export const GEN1_IPOD_ID = 'f8ff5c4e-f4d1-41a7-9c4c-57cca2f867ca'
/** Y2KPod: a 40 GB third-generation iPod. ALAC (Jake's table; the code had AAC 256 until Brief 265). */
export const Y2K_IPOD_ID = '842f4c4f-14f2-45b4-9c5d-32c1295604da'
/** IndieSleaze: an 8 GB nano. AAC 256. */
export const INDIE_SLEAZE_IPOD_ID = '2a2f2e5c-a5b6-48fe-934c-a7c38b744132'
/** punkPod: a 256 GB mini. ALAC. */
export const PUNK_IPOD_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
/** iBANDCAMP: a 256 GB iPod Video. ALAC (Jake, 2026-11-24); see SEED_PROFILES. */
export const IBANDCAMP_IPOD_ID = 'a7f82840-2f4a-4efc-9707-28fc08b7a8f3'

/**
 * Jake's table, used only for an iPod with no stored profile. The Original (the primary iPod,
 * whatever its id) is seeded ALAC through `primary`.
 *
 * iBANDCAMP is ALAC (Jake, 2026-11-24: "stays as it is", lossless, no re-copy), not the table's
 * AAC 256: its last sync put 3,984 masters on it as they are and 1,376 iPod-safe ALAC rescues,
 * and none differ from this Mac's library. With the Device page's convert setting off (as it is),
 * ALAC changes nothing; with it on, ALAC keeps it from converting ~4,000 songs.
 */
export const SEED_PROFILES: ReadonlyMap<string, IpodAudioProfile> = new Map([
  [GEN1_IPOD_ID, { codec: 'mp3', kbps: 320, enabled: true }],
  [Y2K_IPOD_ID, { codec: 'alac', enabled: true }],
  [INDIE_SLEAZE_IPOD_ID, { codec: 'aac', kbps: 256, enabled: true }],
  [PUNK_IPOD_ID, { codec: 'alac', enabled: true }],
  [IBANDCAMP_IPOD_ID, { codec: 'alac', enabled: true }],
])
const PRIMARY_SEED: IpodAudioProfile = { codec: 'alac', enabled: true }

export type ProfileStore = Record<string, IpodAudioProfile>

const KBPS: readonly number[] = [128, 192, 256, 320]

/** A stored value as a profile, or null when it isn't one (a hand-edited or torn file never syncs anything odd). */
export function parseProfile(raw: unknown): IpodAudioProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const codec = r.codec
  if (codec !== 'alac' && codec !== 'aac' && codec !== 'mp3') return null
  const out: IpodAudioProfile = { codec, enabled: r.enabled !== false }
  if (codec !== 'alac') {
    const k = Number(r.kbps)
    if (!KBPS.includes(k)) return null
    out.kbps = k as IpodLossyKbps
  }
  if (Array.isArray(r.verifiedFormats)) out.verifiedFormats = r.verifiedFormats.filter((x): x is string => typeof x === 'string')
  return out
}

/** The store as saved in ui-state.json; anything malformed is dropped entry by entry. */
export function parseProfileStore(raw: unknown): ProfileStore {
  const out: ProfileStore = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = parseProfile(v)
    if (p && k) out[k] = p
  }
  return out
}

export interface IpodRef {
  /** The iPod's serial number from its set-up record (the physical iPod). */
  serial?: string | null
  /** The id in the iPod's own ID file (its homemini list id). */
  deviceId?: string | null
  /** The homemini list id, when it is known separately (fallback key). */
  listId?: string | null
  /** The Original. */
  primary?: boolean
}

/** The store key for an iPod's serial number. */
export function serialProfileKey(serial: string | null | undefined): string | null {
  const s = String(serial ?? '').trim().toUpperCase()
  return s ? `serial:${s}` : null
}

/** Which profile governs this iPod: stored by serial, stored by its ID-file / list id, seeded, or none. */
export function resolveIpodAudioProfile(store: ProfileStore, ipod: IpodRef): IpodAudioProfile | null {
  const sk = serialProfileKey(ipod.serial)
  if (sk && store[sk]) return store[sk]
  const keys = [ipod.deviceId, ipod.listId].filter((k): k is string => !!k)
  for (const k of keys) if (store[k]) return store[k]
  for (const k of keys) { const s = SEED_PROFILES.get(k); if (s) return { ...s } }
  if (ipod.primary) return { ...PRIMARY_SEED }
  return null
}

/**
 * Move a profile stored under the iPod's ID-file / list id onto its serial key, the first time
 * both are known. Returns the new store, or null when nothing changes. Moved, never copied: a
 * second card that later takes the same list does not inherit the first card's profile. An
 * entry already under the serial wins (it is the physical key); the list-id entry is dropped.
 */
export function adoptProfile(store: ProfileStore, ipod: IpodRef): ProfileStore | null {
  const sk = serialProfileKey(ipod.serial)
  if (!sk) return null
  const from = [ipod.deviceId, ipod.listId].filter((k): k is string => !!k && k !== sk && !!store[k])
  if (from.length === 0) return null
  const next: ProfileStore = { ...store }
  if (!next[sk]) next[sk] = next[from[0]]
  for (const k of from) delete next[k]
  return next
}

/**
 * A card Jake moved to another list (iPod set-up, confirmedMove). A serial-keyed profile
 * already follows the card: nothing changes. Without a serial, the profile under the old list
 * id is the card's, so it moves to the new list id (replacing whatever that list id held).
 */
export function carryProfileOnMove(store: ProfileStore, move: { fromId: string; toId: string; serial?: string | null }): ProfileStore | null {
  const sk = serialProfileKey(move.serial)
  if (sk) {
    // Make sure the card's profile is under its serial, not left behind on the old list id.
    return adoptProfile(store, { serial: sk.slice('serial:'.length), deviceId: move.fromId })
  }
  if (!move.fromId || !move.toId || move.fromId === move.toId || !store[move.fromId]) return null
  const next: ProfileStore = { ...store }
  next[move.toId] = next[move.fromId]
  delete next[move.fromId]
  return next
}

export interface SyncConvertChoice {
  enabled: boolean
  targetKbps: 128 | 192 | 256 | 320
  codec?: 'aac' | 'mp3'
}

/**
 * What a sync of this iPod converts. Its profile wins over what the Device page passed; with no
 * profile (or a profile switched off) it is exactly what was passed (the same object, so a
 * caller can tell nothing changed). 'alac' = convert nothing: { enabled: false }.
 */
export function convertOptionsForProfile<T extends SyncConvertChoice>(
  profile: IpodAudioProfile | null,
  passed: T | undefined,
): T | SyncConvertChoice | undefined {
  if (!profile || !profile.enabled) return passed
  if (profile.codec === 'alac') {
    if (passed && !passed.enabled) return passed
    return { enabled: false, targetKbps: passed?.targetKbps ?? 256 }
  }
  return { enabled: true, targetKbps: profile.kbps ?? 256, codec: profile.codec }
}

/** Kept for callers that only know an id: the seeds alone (no store). */
export function convertOptionsForIpod<T extends SyncConvertChoice>(
  ipodId: string | null | undefined,
  passed: T | undefined,
  store: ProfileStore = {},
  primary = false,
): T | SyncConvertChoice | undefined {
  return convertOptionsForProfile(resolveIpodAudioProfile(store, { deviceId: ipodId, primary }), passed)
}

/** A one-line description for the sync log and the Device page. */
export function describeProfile(p: IpodAudioProfile | null): string {
  if (!p || !p.enabled) return "the Device page's convert setting"
  return p.codec === 'alac' ? 'ALAC (lossless as is)' : `${p.kbps ?? 256}k ${p.codec === 'mp3' ? 'MP3' : 'AAC'}`
}
