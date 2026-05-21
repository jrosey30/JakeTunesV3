// ════════════════════════════════════════════════════════════════════════
//  Library ↔ Bandcamp overlap (Brief 036 v2.2, Layer 2)
//
//  Marks Store items Jake already owns so he doesn't re-buy, and lets
//  recommenders demote/exclude owned releases. Non-destructive (UI badge +
//  ranking demotion only) — so normalized text matching is allowed here;
//  CLAUDE.md's identity-gate rule applies to destructive ops, which this
//  is not. Exact audioFingerprint match is preferred where present.
// ════════════════════════════════════════════════════════════════════════

import { LibraryRow, StoreAlbum } from '../types'

// ⚠️ TWIN: src/main/index.ts:1876 (_normFingerprint). Owned-detection keys
// must normalize identically to the importer's fingerprint normalizer or
// "owned" will silently miss/duplicate. Keep these two in lockstep.
export function normalizeText(s: unknown): string {
  return String(s || '')
    .replace(/^\s*\d{1,2}\s*[-._]\s*/, '')
    .replace(/\s*\b(feat(?:uring)?|ft)\b\.?[^)]*/ig, '')
    .replace(/[()[\]{}"',.\-!?:;#/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function albumKey(artist: unknown, album: unknown): string {
  return `${normalizeText(artist)}|${normalizeText(album)}`
}

export interface OwnedSets {
  fingerprints: Set<string>
  artistAlbum: Set<string>
}

export function buildOwnedSets(rows: LibraryRow[]): OwnedSets {
  const fingerprints = new Set<string>()
  const artistAlbum = new Set<string>()
  for (const r of rows) {
    if (r.audioFingerprint) fingerprints.add(r.audioFingerprint)
    if (r.album) artistAlbum.add(albumKey(r.albumArtist || r.artist, r.album))
  }
  return { fingerprints, artistAlbum }
}

/** Album-level owned check (StoreAlbum.title is the release title). */
export function isOwnedAlbum(album: StoreAlbum, owned: OwnedSets): boolean {
  return owned.artistAlbum.has(albumKey(album.artist, album.title))
}

/** Stamp `owned` on a batch of Store albums in place; returns the batch. */
export function markOwned(albums: StoreAlbum[], owned: OwnedSets): StoreAlbum[] {
  for (const a of albums) a.owned = isOwnedAlbum(a, owned)
  return albums
}
