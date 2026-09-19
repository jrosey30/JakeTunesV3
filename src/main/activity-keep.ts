/**
 * Activity Sync — keep what is already right on the card.
 *
 * 2026-09-19. Jake swapped ~80 songs in a 1,000-song pool and watched the
 * sync copy all 1,000 again: the engine is wipe+rebuild by design (the
 * Sept 1 fix that ended the undercount war), and its ledger records the
 * delta (added 78 / removed 78) and then ignores it.
 *
 * This is the delta, gated on IDENTITY, never on text or on "it looks the
 * same": a boarded song is KEPT only when the last SEALED manifest lists
 * the same id at the same card path with the same fingerprint identity,
 * AND the file on the card is exactly the size of the file this sync
 * would copy in its place (the source, or its ALAC/AAC mirror — whatever
 * the current convert setting produces). Anything else is copied, and
 * everything on the card outside the keep set is deleted. Every proof
 * stage after the copy (two remounts at N, catalog N, firmware semantics,
 * TSA by identity, seal) is unchanged, so a wrong keep cannot seal.
 *
 * Pure, so node --test loads it. The engine feeds it stat() results.
 */
import { tsaNormalizeColonPath } from './ipod-sync-tsa.ts'

export interface SealedManifest {
  sealed?: unknown
  status?: unknown
  tracks?: unknown
}

export interface ManifestRow { id: number; destPath: string; identity: string }

/** The rows of a manifest that can vouch for a file: sealed, with
 *  fingerprint identities. A 'path:' or 'id:' identity vouches for nothing. */
export function sealedManifestRows(m: SealedManifest | null | undefined): Map<number, ManifestRow> {
  const out = new Map<number, ManifestRow>()
  if (!m || m.sealed !== true || m.status !== 'sealed' || !Array.isArray(m.tracks)) return out
  for (const raw of m.tracks as Array<Record<string, unknown>>) {
    const id = Number(raw?.id)
    const identity = String(raw?.identity ?? '')
    const destPath = tsaNormalizeColonPath(String(raw?.destPath ?? ''))
    if (!Number.isFinite(id) || id <= 0 || !destPath || !identity.startsWith('fp:')) continue
    out.set(id, { id, destPath, identity })
  }
  return out
}

export interface KeepCandidate {
  id: number
  /** Card path this sync WOULD write, colon form. */
  destPath: string
  /** Fingerprint identity of the boarded song (tsaPassengerIdentity). */
  identity: string
  /** Size of the exact file this sync would copy (source or mirror). */
  sourceSize: number
  /** Size of the file at destPath on the card now; undefined = absent. */
  onCardSize: number | undefined
}

export type KeepVerdict =
  | { keep: true }
  | { keep: false; why: 'no-manifest-row' | 'path-changed' | 'identity-changed' | 'weak-identity' | 'not-on-card' | 'size-differs' | 'bad-size' }

export function keepVerdict(c: KeepCandidate, rows: Map<number, ManifestRow>): KeepVerdict {
  if (!c.identity.startsWith('fp:')) return { keep: false, why: 'weak-identity' }
  const row = rows.get(c.id)
  if (!row) return { keep: false, why: 'no-manifest-row' }
  if (row.destPath !== tsaNormalizeColonPath(c.destPath)) return { keep: false, why: 'path-changed' }
  if (row.identity !== c.identity) return { keep: false, why: 'identity-changed' }
  if (!Number.isFinite(c.sourceSize) || c.sourceSize <= 0) return { keep: false, why: 'bad-size' }
  if (c.onCardSize === undefined) return { keep: false, why: 'not-on-card' }
  if (c.onCardSize !== c.sourceSize) return { keep: false, why: 'size-differs' }
  return { keep: true }
}

export interface KeepPlan {
  keepIds: Set<number>
  copyIds: number[]
  reasons: Record<string, number>
}

export function activityKeepPlan(candidates: KeepCandidate[], manifest: SealedManifest | null | undefined): KeepPlan {
  const rows = sealedManifestRows(manifest)
  const keepIds = new Set<number>()
  const copyIds: number[] = []
  const reasons: Record<string, number> = {}
  for (const c of candidates) {
    const v = keepVerdict(c, rows)
    if (v.keep) keepIds.add(c.id)
    else { copyIds.push(c.id); reasons[v.why] = (reasons[v.why] || 0) + 1 }
  }
  return { keepIds, copyIds, reasons }
}

/**
 * A targeted wipe is proven when the card lists EXACTLY the keep set —
 * nothing extra, nothing missing — on consecutive listings. With an empty
 * keep set this is the old "proven empty".
 */
export function wipeListingMatchesKeep(listed: string[], keepAbs: Set<string>): boolean {
  if (listed.length !== keepAbs.size) return false
  for (const p of listed) if (!keepAbs.has(p)) return false
  return true
}

export function keepStreak(matches: boolean, prevStreak: number): number {
  const prev = Math.max(0, Math.floor(Number(prevStreak) || 0))
  return matches ? prev + 1 : 0
}
