/**
 * Pure tombstone / identity logic for Listen-to-the-List.
 * No Electron imports — safe for unit tests.
 */

import { recoNorm } from './reco-match.ts'

export const RECO_IDENTITY_TOMBSTONE_PREFIX = 'identity:'
export const RECO_FULL_TOMBSTONE_PREFIX = 'full:'

export interface RecoTombstoneRecord {
  id: string
  song?: string
  artist?: string
  note?: string
  matchedTitle?: string
  matchedArtist?: string
}

export function recoMatchKey(input: { song?: string; artist?: string; note?: string }): string {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return `${norm(input.song || '')}|${norm(input.artist || '')}|${norm(input.note || '')}`
}

export function recoRecordKey(r: RecoTombstoneRecord): string {
  return recoMatchKey({
    song: r.song || r.matchedTitle,
    artist: r.artist || r.matchedArtist,
    note: r.note,
  })
}

export function recoIdentityKey(song?: string, artist?: string): string | null {
  const s = recoNorm(song || '')
  const a = recoNorm(artist || '')
  return s && a ? `${s}|${a}` : null
}

export function recoRecordIdentityKey(r: RecoTombstoneRecord): string | null {
  return recoIdentityKey(r.song || r.matchedTitle, r.artist || r.matchedArtist)
}

export function isIdentityTombstoned(tombstones: Set<string>, r: RecoTombstoneRecord): boolean {
  const k = recoRecordIdentityKey(r)
  return Boolean(k && tombstones.has(RECO_IDENTITY_TOMBSTONE_PREFIX + k))
}

export function isRecordTombstoned(tombstones: Set<string>, r: RecoTombstoneRecord): boolean {
  if (tombstones.has(String(r.id))) return true
  if (isIdentityTombstoned(tombstones, r)) return true
  return tombstones.has(RECO_FULL_TOMBSTONE_PREFIX + recoRecordKey(r))
}

export function tombstoneKeysForRecord(r: RecoTombstoneRecord): string[] {
  const keys = [String(r.id)]
  const identity = recoRecordIdentityKey(r)
  if (identity) keys.push(RECO_IDENTITY_TOMBSTONE_PREFIX + identity)
  else keys.push(RECO_FULL_TOMBSTONE_PREFIX + recoRecordKey(r))
  return keys
}

/**
 * Text identity for display grouping / tombstone filtering only.
 * Must NOT authorize multi-row deletion — delete by stable id alone.
 * @deprecated Prefer id equality for destructive ops.
 */
export function recordsMatchForDelete(a: RecoTombstoneRecord, b: RecoTombstoneRecord): boolean {
  const idA = recoRecordIdentityKey(a)
  const idB = recoRecordIdentityKey(b)
  if (idA && idB) return idA === idB
  if (!idA && !idB) return recoRecordKey(a) === recoRecordKey(b)
  return false
}
