/**
 * iPod activity-sync TSA — every boarded song must clear the lane, by identity.
 *
 * Jake 2026-08-15: "sick of chasing dragons." Catalog 500 with Mini Songs
 * 497 / 492 / 79 is the same class: a row the firmware will not list, or a
 * file that vanished after a later automatic pass. This module is the
 * checkpoint. It does not copy, convert, or delete. It names each passenger
 * by fingerprint (or exact path — never a folded title) and says cleared
 * or held.
 *
 * Destructive follow-up (auto-repair on plug-in, orphan deletes after the
 * catalog is written) is how a sealed set shrinks before the next Activity
 * Sync. TSA's job is to refuse success until every boarded identity is on
 * the card and in the catalog, then seal that set so plug-in is inspect-only.
 */

import { ipodFirmwareWillList } from './ipod-reconcile.ts'

export type TsaHoldReason = 'missing-file' | 'size-mismatch' | 'not-in-catalog' | 'unlistable'

export interface TsaPassenger {
  id: number
  identity: string
  destPath: string
  expectedSize: number
  title: string
  artist: string
}

export interface TsaLaneResult extends TsaPassenger {
  ok: boolean
  reason?: TsaHoldReason
}

export interface TsaScreen {
  cleared: TsaLaneResult[]
  held: TsaLaneResult[]
}

export interface TsaSealPassenger {
  id: number
  identity: string
  destPath: string
  expectedSize: number
}

export interface TsaSeal {
  version: 1
  sealedAt: string
  target: number
  passengers: TsaSealPassenger[]
}

/** Identity for a boarded track. Fingerprint first; exact path next; never title text. */
export function tsaPassengerIdentity(t: {
  audioFingerprint?: unknown
  path?: unknown
  id?: unknown
}): string {
  const fp = String(t.audioFingerprint ?? '').trim()
  if (fp) return `fp:${fp}`
  const path = tsaNormalizeColonPath(String(t.path ?? ''))
  if (path) return `path:${path}`
  return `id:${Number(t.id) || 0}`
}

/** Colon path the catalog and the card share. Filesystem slashes become colons. */
export function tsaNormalizeColonPath(path: string): string {
  let p = String(path || '').trim()
  if (!p) return ''
  p = p.replace(/\\/g, '/').replace(/\//g, ':')
  p = p.replace(/:+/g, ':')
  if (!p.startsWith(':')) p = `:${p}`
  return p
}

/**
 * Relative path under the iPod mount. Strip the leading colon so dest
 * resolution never depends on path.join treating a leading slash as
 * absolute. TSA stats and plug-in inspect both go through this.
 */
export function tsaRelFromColon(colonPath: string, sep = '/'): string {
  const s = sep === '\\' ? '\\' : '/'
  return tsaNormalizeColonPath(colonPath).replace(/^:/, '').replace(/:/g, s)
}

function tsaIndexOnCard(onCard: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [k, v] of onCard) {
    const n = tsaNormalizeColonPath(k)
    if (n) out.set(n, v)
  }
  return out
}

function tsaIndexCatalog(catalogPaths: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const p of catalogPaths) {
    const n = tsaNormalizeColonPath(p)
    if (n) out.add(n)
  }
  return out
}

export function tsaBoardPassenger(t: {
  id?: unknown
  audioFingerprint?: unknown
  path?: unknown
  fileSize?: unknown
  title?: unknown
  artist?: unknown
  destPath?: unknown
}): TsaPassenger {
  const destPath = tsaNormalizeColonPath(String(t.destPath ?? t.path ?? ''))
  return {
    id: Number(t.id) || 0,
    identity: tsaPassengerIdentity(t),
    destPath,
    expectedSize: Math.max(0, Math.floor(Number(t.fileSize) || 0)),
    title: String(t.title ?? ''),
    artist: String(t.artist ?? ''),
  }
}

/** Two boarded songs rewriting to the same .m4a dest — Mini would keep one. */
export function tsaDestCollisions(boarded: TsaPassenger[]): string[] {
  const counts = new Map<string, number>()
  for (const p of boarded) {
    if (!p.destPath) continue
    counts.set(p.destPath, (counts.get(p.destPath) || 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([path]) => path)
}

export const TSA_ACTIVITY_TARGETS = [100, 250, 500, 1000] as const

/**
 * Screen every boarded passenger against what is actually on the card
 * and in the catalog. onCard is destPath → byte size (0 / missing = hold).
 */
export function tsaScreen(opts: {
  boarded: TsaPassenger[]
  onCard: Map<string, number>
  catalogPaths: Set<string>
}): TsaScreen {
  const onCard = tsaIndexOnCard(opts.onCard)
  const catalogPaths = tsaIndexCatalog(opts.catalogPaths)
  const cleared: TsaLaneResult[] = []
  const held: TsaLaneResult[] = []
  for (const p of opts.boarded) {
    const dest = tsaNormalizeColonPath(p.destPath)
    const size = onCard.get(dest)
    if (size == null || size <= 0) {
      held.push({ ...p, destPath: dest, ok: false, reason: 'missing-file' })
      continue
    }
    if (p.expectedSize > 0 && size !== p.expectedSize) {
      held.push({ ...p, destPath: dest, ok: false, reason: 'size-mismatch' })
      continue
    }
    if (!catalogPaths.has(dest)) {
      held.push({ ...p, destPath: dest, ok: false, reason: 'not-in-catalog' })
      continue
    }
    if (!ipodFirmwareWillList({ title: p.title, artist: p.artist, path: dest })) {
      held.push({ ...p, destPath: dest, ok: false, reason: 'unlistable' })
      continue
    }
    cleared.push({ ...p, destPath: dest, ok: true })
  }
  return { cleared, held }
}

/** N boarded, 0 held, every boarded identity cleared. 492 of 500 is a hold. */
export function tsaAllClear(boarded: number, cleared: number, held: number): boolean {
  const n = Math.max(0, Math.floor(boarded))
  return n > 0 && held === 0 && cleared === n
}

/**
 * Activity wipe+rebuild may green only when the picked N is boarded,
 * screened all-clear, sealed on disk, and not a shortfall.
 * 100 / 250 / 500 / 1000 are the same rule — N means N.
 */
export function tsaActivityOk(opts: {
  target: number
  boarded: number
  cleared: number
  held: number
  sealed: boolean
  shortfall: boolean
}): boolean {
  const n = Math.max(0, Math.floor(opts.target))
  return n > 0
    && opts.boarded === n
    && tsaAllClear(opts.boarded, opts.cleared, opts.held)
    && opts.sealed
    && !opts.shortfall
}

export function tsaSealFromScreen(screen: TsaScreen, sealedAt: string): TsaSeal | null {
  if (!tsaAllClear(screen.cleared.length + screen.held.length, screen.cleared.length, screen.held.length)) {
    return null
  }
  return {
    version: 1,
    sealedAt,
    target: screen.cleared.length,
    passengers: screen.cleared.map((p) => ({
      id: p.id,
      identity: p.identity,
      destPath: p.destPath,
      expectedSize: p.expectedSize,
    })),
  }
}

export function parseTsaSeal(raw: unknown): TsaSeal | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  if (typeof o.sealedAt !== 'string' || !o.sealedAt) return null
  const target = Math.floor(Number(o.target) || 0)
  if (target <= 0 || !Array.isArray(o.passengers)) return null
  const passengers: TsaSealPassenger[] = []
  for (const row of o.passengers) {
    if (!row || typeof row !== 'object') return null
    const p = row as Record<string, unknown>
    const destPath = tsaNormalizeColonPath(String(p.destPath ?? ''))
    const identity = String(p.identity ?? '')
    if (!destPath || !identity) return null
    passengers.push({
      id: Number(p.id) || 0,
      identity,
      destPath,
      expectedSize: Math.max(0, Math.floor(Number(p.expectedSize) || 0)),
    })
  }
  if (passengers.length !== target) return null
  return { version: 1, sealedAt: o.sealedAt, target, passengers }
}

/** Compare a seal to live on-card sizes. Drift = anything missing or wrong size. */
export function tsaInspectSeal(
  seal: TsaSeal,
  onCard: Map<string, number>,
): { present: number; missing: Array<{ id: number; destPath: string; reason: TsaHoldReason }> } {
  const card = tsaIndexOnCard(onCard)
  const missing: Array<{ id: number; destPath: string; reason: TsaHoldReason }> = []
  let present = 0
  for (const p of seal.passengers) {
    const dest = tsaNormalizeColonPath(p.destPath)
    const size = card.get(dest)
    if (size == null || size <= 0) {
      missing.push({ id: p.id, destPath: dest, reason: 'missing-file' })
      continue
    }
    if (p.expectedSize > 0 && size !== p.expectedSize) {
      missing.push({ id: p.id, destPath: dest, reason: 'size-mismatch' })
      continue
    }
    present++
  }
  return { present, missing }
}
