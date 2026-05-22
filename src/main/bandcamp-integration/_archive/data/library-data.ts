// ════════════════════════════════════════════════════════════════════════
//  Library reader (Brief 036 v2.2, Layer 3)
//
//  Reads userData/library.json (the authoritative collection) and merges
//  metadata-overrides.json on top — desktop applies overrides, which is
//  where engagement signals (lastPlayedAt, skipCount) and manual rating
//  corrections live (see src/main/index.ts override plumbing). Produces
//  normalized LibraryRow[] for signal computation.
//
//  Engagement nulls are deliberate: rating 0 / never-played → null so the
//  staple-score math (signal-computation) drops those terms instead of
//  averaging in a zero (Dex refinement).
// ════════════════════════════════════════════════════════════════════════

import { app } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { LibraryRow } from '../types'

interface RawTrack {
  id: number
  artist?: string
  albumArtist?: string
  album?: string
  title?: string
  genre?: string
  year?: number | string
  playCount?: number
  rating?: number
  lastPlayedAt?: number
  skipCount?: number
  audioFingerprint?: string
}

type OverrideEntry = { fp?: string; fields?: Record<string, string> }

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function readLibraryRows(): Promise<LibraryRow[]> {
  let raw: { tracks?: RawTrack[] }
  try {
    raw = JSON.parse(await readFile(join(app.getPath('userData'), 'library.json'), 'utf-8'))
  } catch {
    return []
  }
  let overrides: Record<string, OverrideEntry> = {}
  try {
    overrides = JSON.parse(await readFile(join(app.getPath('userData'), 'metadata-overrides.json'), 'utf-8'))
  } catch {
    overrides = {}
  }

  const tracks = raw.tracks || []
  return tracks.map((t) => {
    const ov = overrides[String(t.id)]
    const f = (ov && ov.fields) || {}
    // Override fp must match the track's fingerprint to apply, mirroring the
    // renderer's gate; when either side lacks an fp we still apply (legacy).
    const fpOk = !ov?.fp || !t.audioFingerprint || ov.fp === t.audioFingerprint
    const get = (key: keyof RawTrack, fallback: unknown): unknown =>
      fpOk && (key as string) in f ? f[key as string] : fallback

    const ratingVal = num(get('rating', t.rating))
    const lastPlayed = num(get('lastPlayedAt', t.lastPlayedAt))
    return {
      id: t.id,
      artist: String(t.artist || ''),
      albumArtist: String(t.albumArtist || t.artist || ''),
      album: String(t.album || ''),
      title: String(t.title || ''),
      genre: String(t.genre || ''),
      year: num(get('year', t.year)),
      playCount: num(get('playCount', t.playCount)) ?? 0,
      rating: ratingVal && ratingVal > 0 ? ratingVal : null,
      lastPlayedAt: lastPlayed && lastPlayed > 0 ? lastPlayed : null,
      skipCount: num(get('skipCount', t.skipCount)) ?? 0,
      audioFingerprint: t.audioFingerprint,
    }
  })
}
