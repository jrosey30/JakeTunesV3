// Mobile → desktop overrides drain. Reads an OverridesQueueFile JSON
// (typically produced by JakeTunes Mobile's Settings → Export
// overrides… action) and merges play counts / lastPlayedAt back into
// the desktop library.
//
// ⚠️ TWIN: mobile/src/services/overrides/queue.ts (producer).
// OVERRIDES_QUEUE_VERSION must match on both sides — see
// mobile/src/types.ts. Refuse forward-version files; bump both
// constants together when the shape changes. (Citation: the 0x64
// mediaKind incident — docs/postmortems/2026-04-26-ipod-songcount-counter.md
// — for what happens when a writer silently changes a field's
// meaning.)
//
// ⚠️ Identity rule (per docs/postmortems/2026-04-25-verify-repair-cascade
// §C): every override is gated on `audioFingerprint` matching the
// current track at `trackId`. If the fingerprint doesn't match, the
// override is STALE (the user re-imported the album between the
// mobile play and this drain) and the override is discarded with a
// log line. NEVER force-merge on id alone — track ids get
// reassigned on re-import.

import { readFile } from 'fs/promises'

// Bump this when MobileTrackOverrides or OverridesQueueFile shape
// changes on either side. Must equal mobile/src/types.ts
// OVERRIDES_QUEUE_VERSION.
export const OVERRIDES_QUEUE_VERSION = 1

// Mirror of mobile/src/types.ts MobileTrackOverrides. Kept hand-twinned
// rather than imported across the platform boundary — desktop main
// can't import from mobile/, and dragging a shared package into the
// monorepo for one type isn't worth it yet. If the mobile shape
// changes, update this in the same commit.
export interface MobileTrackOverride {
  trackId: number
  audioFingerprint?: string
  playCountDelta?: number
  lastPlayedAt?: number
  skipCountDelta?: number
  rating?: number
  queuedAt: number
}

export interface OverridesQueueFile {
  version: number
  deviceId: string
  exportedAt: string
  overrides: MobileTrackOverride[]
}

// The fields applyOverrides may modify on a Track. Anything outside
// this set is left alone — drain is play-state only, not metadata.
// Kept as a structural type so we don't have to import the renderer's
// full Track interface into main (it has React/howler dependencies in
// transitive imports).
export interface MergeableTrack {
  id: number
  audioFingerprint?: string
  playCount: number
  skipCount?: number
  lastPlayedAt?: number
  rating: number
}

export type DiscardReason =
  | 'unknown-trackid'
  | 'fingerprint-missing-on-mobile'
  | 'fingerprint-missing-on-desktop'
  | 'fingerprint-mismatch'

export interface DiscardedOverride {
  override: MobileTrackOverride
  reason: DiscardReason
}

export interface ApplyResult<T extends MergeableTrack> {
  tracks: T[]                          // updated copy (caller should persist)
  applied: number                      // number of overrides whose deltas landed
  appliedTrackIds: number[]            // track ids touched (deduped)
  discarded: DiscardedOverride[]
}

// Pure: takes the current tracks and a list of overrides; returns a
// new tracks array (does not mutate the input) plus accounting for
// what landed and what didn't. Caller is responsible for persisting.
export function applyOverrides<T extends MergeableTrack>(
  tracks: T[],
  overrides: MobileTrackOverride[],
): ApplyResult<T> {
  const byId = new Map<number, T>()
  for (const t of tracks) byId.set(t.id, t)

  const discarded: DiscardedOverride[] = []
  const touched = new Set<number>()
  let applied = 0

  // Mutate via a shallow copy so we don't disturb the input.
  const out: T[] = tracks.map((t) => ({ ...t }))
  const outById = new Map<number, T>()
  for (const t of out) outById.set(t.id, t)

  for (const o of overrides) {
    const track = outById.get(o.trackId)
    if (!track) {
      discarded.push({ override: o, reason: 'unknown-trackid' })
      continue
    }
    // Identity gate. If either side lacks a fingerprint, we can't
    // confirm identity → discard rather than force-merge.
    if (!o.audioFingerprint) {
      discarded.push({ override: o, reason: 'fingerprint-missing-on-mobile' })
      continue
    }
    if (!track.audioFingerprint) {
      discarded.push({ override: o, reason: 'fingerprint-missing-on-desktop' })
      continue
    }
    if (track.audioFingerprint !== o.audioFingerprint) {
      discarded.push({ override: o, reason: 'fingerprint-mismatch' })
      continue
    }

    // Apply additive deltas and last-write-wins fields.
    if (typeof o.playCountDelta === 'number' && o.playCountDelta > 0) {
      track.playCount = (track.playCount || 0) + o.playCountDelta
    }
    if (typeof o.skipCountDelta === 'number' && o.skipCountDelta > 0) {
      track.skipCount = (track.skipCount || 0) + o.skipCountDelta
    }
    if (typeof o.lastPlayedAt === 'number') {
      track.lastPlayedAt = Math.max(track.lastPlayedAt || 0, o.lastPlayedAt)
    }
    if (typeof o.rating === 'number') {
      // Last write wins on rating — but only within this drain.
      // Cross-device rating conflict resolution is Phase 1.
      track.rating = o.rating
    }
    applied++
    touched.add(track.id)
  }

  return { tracks: out, applied, appliedTrackIds: Array.from(touched), discarded }
}

// File-loading helper. Validates shape + schema version. Returns null
// + error string on any problem (caller surfaces to UI).
export async function readOverridesQueueFile(
  path: string,
): Promise<{ ok: true; file: OverridesQueueFile } | { ok: false; error: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    return { ok: false, error: `couldn't read file: ${(err as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` }
  }
  const o = parsed as Partial<OverridesQueueFile>
  if (typeof o.version !== 'number') {
    return { ok: false, error: 'missing version field' }
  }
  if (o.version > OVERRIDES_QUEUE_VERSION) {
    return {
      ok: false,
      error:
        `file was written by a newer mobile (v${o.version}). ` +
        `Update JakeTunes desktop to apply it.`,
    }
  }
  if (!Array.isArray(o.overrides)) {
    return { ok: false, error: 'missing overrides[] array' }
  }
  if (typeof o.deviceId !== 'string') {
    return { ok: false, error: 'missing deviceId' }
  }
  return { ok: true, file: o as OverridesQueueFile }
}
