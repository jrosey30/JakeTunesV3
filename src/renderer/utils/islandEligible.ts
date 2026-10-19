import type { Track } from '../types'
import { verifyLiveSetCompleteness } from './liveSetCompleteness.ts'
import { sortAlbumTracks } from './albumTrackOrder.ts'

/// TOP 10 ISLAND ALBUMS eligibility (2026-10-18) — complete albums only.
///
/// The desktop's ONE completeness doctrine decides (verifyLiveSetCompleteness,
/// the gate behind Live Mode and Play Album — no second definition). The island
/// shelf takes its SHAPE verdict (`complete`), not the stricter declared-total
/// proof Play Album needs: the phone's island picker gives an untagged-but-
/// whole rip the benefit of the doubt too, and a missing track, a gap, a
/// duplicate seat or a short tail still disqualifies.
///
/// Plus the phone's floor: at least 3 tracks — a single or a two-song 7"
/// is not a desert-island album.
///
/// ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/AlbumCompleteness.swift
///    (`minTracks` + `isComplete`, the island picker's gate) and its server
///    twin backend/src/util/albumCompleteness.ts. Same spirit, not the same
///    code: the phone's loose gate does not demand track numbers; the desktop
///    doctrine does (it cannot verify an unnumbered album at all).
export const ISLAND_MIN_TRACKS = 3

export function islandEligible(tracks: readonly Track[]): boolean {
  if (tracks.length < ISLAND_MIN_TRACKS) return false
  return verifyLiveSetCompleteness(sortAlbumTracks(tracks)).complete
}
