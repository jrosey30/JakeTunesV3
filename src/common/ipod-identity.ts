/**
 * Which iPod is plugged in (Jake 2026-10-23: a second iPod, the red Mini,
 * gets its own Pool, Robert Smith style — one iPod per purpose).
 *
 * Until now nothing identified a device: whatever iPod was mounted became
 * "the iPod" and inherited the one global Pool, sync manifest and play-count
 * state. Plugging a second iPod into that would have mapped its plays through
 * the first iPod's manifest (wrong songs, double counts) and let a sync wipe
 * it to the first iPod's set.
 *
 * Identity is a small marker file the app writes onto the iPod itself
 * (`iPod_Control/jaketunes-device.json`), so every Mac agrees on which iPod
 * is which. The PRIMARY iPod is Jake's original 2004 Mini ("my top 1000
 * songs"). It keeps every existing state file exactly where it is; nothing
 * about it moves. Any other iPod is a separate device and, until it has its
 * own Pool (step 2), is read-only: no sync, no play-count ingest, no seal
 * inspection.
 *
 * Pure rules only — no fs, no Electron — so node --test loads it.
 */

export const IPOD_MARKER_REL = ['iPod_Control', 'jaketunes-device.json'] as const

export interface IpodDeviceMarker {
  version: 1
  /** Stable id, never reused. */
  id: string
  /** Jake's name for it ("Original", "Red"). */
  name: string
  /** Sticker colour (CSS colour or a word like "red"); null = not chosen. */
  color: string | null
  /** One line: what this iPod is for. */
  purpose: string | null
  /** The original iPod: owns the existing (legacy, global) sync state. */
  primary: boolean
  createdAt: string
}

export const ORIGINAL_DEFAULTS = {
  name: 'Original',
  purpose: 'My top 1000 songs',
} as const

const MAX_NAME = 40
const MAX_PURPOSE = 120

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

/** Validate a marker read off a card. Anything malformed is treated as no marker. */
export function parseDeviceMarker(raw: unknown): IpodDeviceMarker | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1) return null
  const id = typeof r.id === 'string' && /^[a-z0-9-]{6,64}$/.test(r.id) ? r.id : null
  const name = cleanText(r.name, MAX_NAME)
  if (!id || !name) return null
  return {
    version: 1,
    id,
    name,
    color: cleanText(r.color, 32),
    purpose: cleanText(r.purpose, MAX_PURPOSE),
    primary: r.primary === true,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
  }
}

export function buildDeviceMarker(input: {
  id: string
  name: unknown
  color?: unknown
  purpose?: unknown
  primary: boolean
  now: string
}): IpodDeviceMarker | null {
  return parseDeviceMarker({
    version: 1,
    id: input.id,
    name: input.name,
    color: input.color ?? null,
    purpose: input.purpose ?? null,
    primary: input.primary,
    createdAt: input.now,
  })
}

/**
 * Does the card's catalog look like the set the last sync put on the
 * original? Both directions must agree: the red Mini once carried the WHOLE
 * library, so "every manifest song is on the card" alone would match it.
 */
export function catalogMatchesManifest(cardPaths: readonly string[], manifestPaths: readonly string[]): boolean {
  const norm = (p: string) => p.trim().toLowerCase()
  const card = new Set(cardPaths.filter(Boolean).map(norm))
  const man = new Set(manifestPaths.filter(Boolean).map(norm))
  if (card.size === 0 || man.size === 0) return false
  let shared = 0
  for (const p of man) if (card.has(p)) shared++
  return shared >= 0.95 * man.size && shared >= 0.95 * card.size
}

export type IpodIdentity =
  | { status: 'known'; device: IpodDeviceMarker }
  /** No marker. `canBeOriginal`: no original is registered yet on this Mac,
   *  so Jake may claim this one as the original. */
  | { status: 'unknown'; canBeOriginal: boolean }

/** Unmarked card: adopt it as the original only on strong evidence. */
export function shouldAutoAdoptOriginal(input: {
  registryHasPrimary: boolean
  catalogMatch: boolean
}): boolean {
  return !input.registryHasPrimary && input.catalogMatch
}

/** Only the original iPod may be synced or have its plays read, for now. */
export function ipodWriteRefusal(identity: IpodIdentity): string | null {
  if (identity.status === 'unknown') {
    return 'JakeTunes doesn’t know this iPod yet. Set it up on the Device page first — nothing on it was changed.'
  }
  if (!identity.device.primary) {
    return `${identity.device.name} has its own Pool, but JakeTunes can’t sync it yet — that comes next. Nothing on it was changed.`
  }
  return null
}

/**
 * ONE POOL PER iPOD (step 2, 2026-10-27). Where an iPod's Pool lives, relative to the state
 * dir: the Original (or no known iPod) keeps the legacy root file exactly where it is; any
 * other iPod has its own folder, keyed by its marker id. Pure so the rule is testable.
 */
export const IPOD_POOLS_DIR = 'ipod-pools'
export function ipodPoolRel(device: { id: string; primary: boolean } | null): string[] {
  return !device || device.primary ? ['activity-pool.json'] : [IPOD_POOLS_DIR, device.id, 'activity-pool.json']
}
