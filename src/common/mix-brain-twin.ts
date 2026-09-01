/**
 * Mix-brain twin contract — **desktop is the source of truth**.
 *
 * Jake (2026-08): daily mixes on the phone "should have always twinned the
 * desktop." The expensive failure was Mobile generating decade / orbit tapes
 * from soft cosine alone while desktop already (or now) hard-gates the same
 * decisions. Shipping one side of this pair is the twin violation CLAUDE.md
 * bans.
 *
 * ⚠️ TWIN REQUIRED — JakeTunesMobile must keep these paths in lockstep:
 *    - backend/src/routes/mixes.ts   (decade year gate + orbit quality floor
 *      at GENERATION time — not only at playback)
 *    - backend/src/util/rag.ts       (mtime-reload embeddings.bin; decade
 *      hard-gate on retrieve when the query claims an era)
 *
 * Desktop counterparts (this repo — edit here first, then twin Mobile):
 *    - src/main/ai/decade-query.ts
 *    - src/main/ai/orbit-quality.ts
 *    - src/main/ai/embeddings.ts
 *    - src/main/playlist-vibes.ts   (SOAD / outlier quality floor lesson)
 *
 * Thresholds below are the shared numbers. Do not fork them in Mobile —
 * copy or import the same constants. A mix that needs weak neighbors to
 * hit its track count must ship short, not padded.
 */

/** Below this raw cosine to the seed, an orbit neighbor is not in orbit. */
export const ORBIT_ABS_FLOOR = 0.58

/** Drop trails this far below the best neighbor in the candidate set. */
export const ORBIT_REL_MARGIN = 0.12

/** Playlist-vibes outlier floor margin (documented healthy≈0.7+, weak≈0.5). */
export const PLAYLIST_VIBE_FLOOR_MARGIN = 0.08

export const MIX_BRAIN_TWIN = {
  sourceOfTruth: 'JakeTunesV3',
  mobileMustTwin: [
    'backend/src/routes/mixes.ts',
    'backend/src/util/rag.ts',
    'backend/src/util/ragRerank.ts',
  ],
  desktopCanonical: [
    'src/common/mix-brain-twin.ts',
    'src/main/ai/decade-query.ts',
    'src/main/ai/rag-rerank.ts',
    'src/main/ai/orbit-quality.ts',
    'src/main/ai/embeddings.ts',
    'src/main/playlist-vibes.ts',
  ],
  orbitAbsFloor: ORBIT_ABS_FLOOR,
  orbitRelMargin: ORBIT_REL_MARGIN,
  playlistVibeFloorMargin: PLAYLIST_VIBE_FLOOR_MARGIN,
  rules: [
    'decade-themed mixes hard-filter by library year (missing year = out)',
    'orbit / Because You Played mixes apply abs+rel cosine floor at generation',
    'never pad a mix to N with below-floor neighbors — ship short instead',
    'embeddings.bin mtime-reloads on desktop and Mobile so one brain stays shared',
  ],
} as const
