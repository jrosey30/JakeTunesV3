/**
 * Workout / activity iPod sync set — pure scoring + selection.
 *
 * Syncs a rotating ~1000-track ALAC-friendly set shaped by the listener's
 * activity brief (run/ski/…) + live weather at their place.
 */

import {
  activityScoreHints,
  type ActivityBrief,
  type ActivityWeather,
} from './activity-context-core.ts'

export interface WorkoutTrack {
  id: number
  title?: string
  artist?: string
  album?: string
  genre?: string
  year?: string | number
  playCount?: number
  skipCount?: number
  rating?: number
  bpm?: number | null
  codec?: string
  fileSize?: number
  /** ms — needed by the skit/intro gate. Absent = gate passes it. */
  duration?: number
  /** Colon path. Absent in unit tests; the IPC boardable filter is the disk gate. */
  path?: string
  audioMissing?: boolean
}

export interface WorkoutVibe {
  name: string
  commentary: string
  genreBoosts?: string[]
  seedArtists?: string[]
  energy?: 'high' | 'mixed' | 'endurance'
}

export interface WorkoutSelectOpts {
  target?: number
  previousIds?: number[]
  vibe?: WorkoutVibe
  brief?: ActivityBrief
  weather?: ActivityWeather | null
  seed?: number
  /** Learned from sync history: tracks Jake REMOVED in review for this
   *  activity — heavily demoted so they stop coming back. */
  demoteIds?: number[]
  /** Tracks Jake ADDED in review for this activity — boosted. */
  boostIds?: number[]
  /** trackId → how many of the last few syncs contained it (any activity).
   *  2026-07-24: `previousIds` only remembered the LAST set, so anything two
   *  syncs back was fully fair game and the same favourites kept cycling.
   *  This is a graded, decaying memory instead of a one-shot flag. */
  recentCounts?: Map<number, number>
  /** Brain fit 0..1 per track (taste + steer), from computeActivityBrainFit.
   *  The dominant quality signal — folds the taste model into the score so
   *  the picker stops grabbing genre-tagged junk (2026-07-23). Absent → the
   *  heuristic runs alone (offline / no embeddings). */
  brainFitById?: Map<number, number>
  /** Taste-only fit 0..1 per track — drives the bottom-taste floor. */
  tasteById?: Map<number, number>
  /** Fraction of the eligible pool to floor out by taste in the primary
   *  pass (default 0.2 = cut the bottom-taste fifth — "the shit"). Backfill
   *  ignores the floor so `target` is still guaranteed. */
  tasteFloorPct?: number
}

export interface WorkoutSelectResult {
  trackIds: number[]
  scores: Map<number, number>
  alacCount: number
  name: string
  commentary: string
}

const WORKOUT_GENRE = /hip.?hop|rap|electronic|house|techno|dance|disco|funk|soul|r&b|rnb|edm|drum.?and.?bass|\bdnb\b|jungle|breakbeat|garage|boogie|trap|drill|club|electro|ambient.?techno|footwork|idm|big.?beat|nu.?disco|synth|industrial|metal|punk|hardcore|running|workout|fitness|cardio/i
const SLOW_GENRE = /folk|singer.?songwriter|acoustic|ballad|classical|ambient(?!.?techno)|lullaby|sleep|meditation|new.?age|chill.?out|downtempo|sad|country|jazz(?!.?funk)/i
const SKIP_ARTISTS = new Set(['various artists', 'various', 'va', 'unknown artist', 'soundtrack', 'compilation', ''])

// ── Skit / intro gate (Jake 2026-07-18: "absolutely at all times avoid
// skits, intro songs that are really really short — but differentiate
// short PUNK songs from skits") ──────────────────────────────────────
// Title patterns are out at ANY length. Short tracks are out UNLESS the
// genre is punk-family (where sub-minute songs are real songs) or Jake
// has demonstrated he plays/loves the track.
const SKIT_TITLE = /\b(skit|interlude|intro|outro|prelude|segue|snippet|spoken word|a\s?cappella)\b/i
const SHORT_OK_GENRE = /punk|hardcore|grind|powerviolence|thrash|crust|ska|garage|surf|noise/i
const SHORT_MS = 75_000   // under this, a non-punk track needs evidence
const MICRO_MS = 35_000   // under this, only punk-family survives

export function isSkitOrIntro(t: WorkoutTrack): boolean {
  if (SKIT_TITLE.test(t.title || '')) return true
  const dur = Number(t.duration) || 0
  if (dur <= 0 || dur >= SHORT_MS) return false
  const punkFamily = SHORT_OK_GENRE.test(t.genre || '')
  if (dur < MICRO_MS) return !punkFamily
  // 35-75s: punk-family passes; otherwise the listener must have shown
  // real intent (plays or a high rating) for it to count as a song.
  if (punkFamily) return false
  return !((Number(t.playCount) || 0) >= 5 || (Number(t.rating) || 0) >= 4)
}

function mulberry32(a: number): () => number {
  return () => {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function isAlacCodec(codec?: string): boolean {
  const c = (codec || '').toLowerCase()
  return c === 'alac' || c.includes('alac') || c.includes('apple lossless')
}

export function scoreWorkoutTrack(
  t: WorkoutTrack,
  vibe?: WorkoutVibe,
  brief?: ActivityBrief,
  weather?: ActivityWeather | null,
): number {
  const artist = (t.artist || '').trim()
  if (SKIP_ARTISTS.has(artist.toLowerCase())) return -100

  const plays = Number(t.playCount) || 0
  const skips = Number(t.skipCount) || 0
  const rating = Number(t.rating) || 0
  const genre = (t.genre || '').trim()
  const bpm = typeof t.bpm === 'number' && t.bpm > 0 ? t.bpm : null
  const hints = brief ? activityScoreHints(brief, weather ?? null) : null

  if (skips >= 3 && skips > plays) return -50

  let score = 0
  const bpmBias = hints?.bpmBias || (vibe?.energy === 'endurance' ? 'mid' : vibe?.energy === 'high' ? 'high' : 'mixed')

  if (bpm != null) {
    if (bpmBias === 'high') {
      if (bpm >= 145 && bpm <= 175) score += 30
      else if (bpm >= 130 && bpm < 145) score += 18
      else if (bpm >= 118 && bpm < 130) score += 8
      else if (bpm < 100) score -= 18
    } else if (bpmBias === 'mid') {
      if (bpm >= 110 && bpm <= 140) score += 26
      else if (bpm >= 140 && bpm <= 160) score += 14
      else if (bpm < 90) score -= 10
    } else {
      if (bpm >= 145 && bpm <= 175) score += 22
      else if (bpm >= 120 && bpm < 145) score += 18
      else if (bpm >= 100 && bpm < 120) score += 8
      else if (bpm < 90) score -= 12
    }
  }

  if (WORKOUT_GENRE.test(genre)) score += 16
  if (SLOW_GENRE.test(genre)) score -= 18

  // FLAVOR (2026-07-24, Jake: "more variety more flavor"). This used to be
  // min(plays,40)*0.35 — up to +14 purely for heavy rotation, which stacked
  // with the ★ bonus to make every set a greatest-hits reel of the same 200
  // songs. Play count is evidence a track is GOOD, but the 40th play says
  // nothing the 8th didn't; the taste model (brainTerm, ±45) is the real
  // quality signal now. Saturate the familiarity credit early so proven-good
  // beats unproven, without letting "played constantly" bury a deep cut.
  score += Math.min(plays, 8) * 0.7          // max +5.6, saturates fast
  score -= skips * 2.5

  if (rating >= 5) score += 14
  else if (rating >= 4) score += 10
  else if (rating === 1) score -= 12
  else if (rating === 2) score -= 6

  if (isAlacCodec(t.codec)) score += 6

  if (hints) {
    for (const g of hints.genreBoosts) {
      if (g && genre.toLowerCase().includes(g.toLowerCase())) score += 9
    }
    for (const g of hints.genrePenalties) {
      if (g && genre.toLowerCase().includes(g.toLowerCase())) score -= 10
    }
  }

  if (vibe) {
    const energy = vibe.energy || 'high'
    if (energy === 'high' && bpm != null && bpm >= 145) score += 6
    if (energy === 'endurance' && bpm != null && bpm >= 120 && bpm <= 150) score += 6
    for (const g of vibe.genreBoosts || []) {
      if (g && genre.toLowerCase().includes(g.toLowerCase())) score += 10
    }
    for (const a of vibe.seedArtists || []) {
      if (a && artist.toLowerCase() === a.toLowerCase()) score += 12
    }
  }

  return Math.round(score * 100) / 100
}

export function selectWorkoutSyncSet(
  tracks: WorkoutTrack[],
  opts: WorkoutSelectOpts = {},
): WorkoutSelectResult {
  const target = Math.max(1, Math.min(opts.target ?? 1000, tracks.length || 1))
  const previous = new Set(opts.previousIds || [])
  const vibe = opts.vibe
  const brief = opts.brief
  const weather = opts.weather
  const rand = mulberry32(opts.seed ?? 1)

  const demote = new Set(opts.demoteIds || [])
  const boost = new Set(opts.boostIds || [])
  const recentCounts = opts.recentCounts || new Map<number, number>()
  // How far a track can move on the score scale from luck alone. Sized against
  // BRAIN_WEIGHT (45): big enough that comparable candidates genuinely trade
  // places sync to sync, small enough that a great track never loses to a poor
  // one. This is the knob for "more variety" — raise it for wilder sets.
  const JITTER = 12
  // How hard a brain-loved / barely-played track is pulled into the set. This
  // is the "flavor" knob — raise it for more digging, lower it for comfort.
  const DEEP_CUT = 22
  // A track with no title or no artist can never sync (the iPod shows it
  // blank and the sync gate refuses it) — exclude it from the pool up
  // front so a blank never eats one of the 1000 slots (2026-07-21).
  // audioMissing / explicit empty path are the same class: they eat an N
  // slot and then the copy preflight refuses the whole set (2026-08-16).
  const named = (t: WorkoutTrack) => String(t.title || '').trim() !== '' && String(t.artist || '').trim() !== ''
  const playableHint = (t: WorkoutTrack) =>
    t.audioMissing !== true && (t.path === undefined || String(t.path).trim() !== '')
  const eligible = tracks.filter((t) => named(t) && playableHint(t) && !isSkitOrIntro(t))

  // Brain term: the taste model is the dominant quality signal now. Cosine
  // fit is tightly packed in this embedding space (~0.59 … 0.72 across the
  // library), so a fixed center/scale washes out — instead we SELF-CALIBRATE
  // off this run's own fit distribution: a track at the p90 corner of taste
  // gets +BRAIN_WEIGHT, one at p10 gets −BRAIN_WEIGHT, median is neutral.
  // That ~2·WEIGHT swing dominates the heuristic's ±40 so Jake's taste leads
  // the pick, while BPM/energy still shape activity fit within it. Robust
  // whether `fit` is taste-only (offline) or taste+context (steer note).
  // No-embedding tracks get 0 and ride the heuristic alone.
  const brainFit = opts.brainFitById
  const BRAIN_WEIGHT = 45
  let bMed = 0
  let bHalf = 1
  if (brainFit && brainFit.size > 0) {
    const fv: number[] = []
    for (const t of eligible) { const v = brainFit.get(t.id); if (v != null) fv.push(v) }
    if (fv.length > 4) {
      fv.sort((a, b) => a - b)
      bMed = fv[Math.floor(0.5 * (fv.length - 1))]
      const p10 = fv[Math.floor(0.1 * (fv.length - 1))]
      const p90 = fv[Math.floor(0.9 * (fv.length - 1))]
      bHalf = Math.max(1e-6, (p90 - p10) / 2)
    }
  }
  const brainTerm = (id: number): number => {
    const f = brainFit?.get(id)
    if (f == null) return 0
    const z = (f - bMed) / bHalf
    return Math.max(-1.6, Math.min(1.6, z)) * BRAIN_WEIGHT
  }

  const scored = eligible
    .map((t) => {
      let s = scoreWorkoutTrack(t, vibe, brief, weather)
      s += brainTerm(t.id)
      if (previous.has(t.id)) s -= 35
      if (demote.has(t.id)) s -= 60   // Jake pulled this in review — learn it
      if (boost.has(t.id)) s += 20    // Jake added this in review — learn it
      // Graded rotation memory: each recent appearance costs more than the
      // last, so a track that keeps showing up sinks steadily instead of
      // bouncing straight back the sync after it was dropped.
      const seen = recentCounts.get(t.id) || 0
      if (seen > 0) s -= Math.min(45, 14 * seen)
      // DEEP CUTS: a track the brain rates highly that Jake has barely played
      // is the most interesting thing a set can contain — it's his taste, but
      // not his habits. Gated on brain fit so this surfaces buried gems, never
      // unheard junk (a low-fit track gets nothing). Scaled by how unplayed it
      // is, so a never-played favourite-by-taste gets the full nudge.
      const fit = opts.brainFitById?.get(t.id)
      if (fit != null && fit >= 0.55) {
        const plays = Number(t.playCount) || 0
        if (plays <= 3) s += DEEP_CUT * fit * (1 - plays / 4)
      }
      // VARIETY (2026-07-24, Jake: "more variety more flavor"). The jitter was
      // ±1 on a scale where the brain term alone spans ±45 — effectively zero.
      // With a hard top-N sort that made the same brief produce the same set
      // every time. Give it real room to shuffle among comparable candidates.
      s += (rand() - 0.5) * 2 * JITTER
      return { t, s }
    })
    .filter((x) => x.s > -20)
    .sort((a, b) => b.s - a.s || a.t.id - b.t.id)

  // Taste floor: cut the bottom-taste fraction from the PRIMARY pass so the
  // set stops carrying "shit" Jake's brain scores low. Only tracks with a
  // real taste value are eligible to be floored (no-embedding tracks are
  // never cut for a signal they lack). Backfill below ignores the floor, so
  // "exactly `target`" is still guaranteed for any library ≥ target.
  const tasteById = opts.tasteById
  let tasteFloor = -Infinity
  if (tasteById && tasteById.size > 0) {
    const pct = Math.max(0, Math.min(0.6, opts.tasteFloorPct ?? 0.2))
    if (pct > 0) {
      const vals: number[] = []
      for (const t of eligible) { const v = tasteById.get(t.id); if (v != null) vals.push(v) }
      if (vals.length > 0) {
        vals.sort((a, b) => a - b)
        tasteFloor = vals[Math.min(vals.length - 1, Math.floor(pct * (vals.length - 1)))]
      }
    }
  }
  const belowFloor = (id: number): boolean => {
    if (tasteFloor === -Infinity) return false
    const v = tasteById?.get(id)
    return v != null && v < tasteFloor
  }

  // Diversity: at most 2 per artist — Jake, 2026-08-05: "only 2 songs allowed
  // per artist on activity sync. new rule." (History: 4 → 3 "diversify a
  // little more" → 2.) The artist cap is a RULE, not a preference, so unlike
  // the old version the relaxed pass no longer waives it — relaxing there
  // only drops the taste floor. The cap gives way solely in the guaranteed
  // backfill below, when the library genuinely cannot reach the target on
  // two-per-artist, because "always always always the full count" is the one
  // promise that outranks it — and that concession is logged, not silent.
  // A separate album cap is now redundant: two per artist already bounds any
  // one album by the same artist at two.
  const CAP = 2
  const perArtist = new Map<string, number>()
  const out: number[] = []
  const scoreMap = new Map<number, number>()

  const takePass = (relaxFloor: boolean) => {
    for (const { t, s } of scored) {
      if (out.length >= target) break
      if (scoreMap.has(t.id)) continue
      // Primary pass honors the taste floor; the relaxed pass drops it so a
      // small library can still reach target. The artist cap holds in BOTH.
      if (!relaxFloor && belowFloor(t.id)) continue
      const key = (t.artist || 'Unknown').toLowerCase().trim()
      const n = perArtist.get(key) || 0
      if (n >= CAP) continue
      out.push(t.id)
      scoreMap.set(t.id, s)
      perArtist.set(key, n + 1)
    }
  }

  takePass(false)
  if (out.length < target) takePass(true)
  if (out.length < target) {
    const shortBy = target - out.length
    console.warn(`[workout-sync] artist cap (2) relaxed to fill the last ${shortBy} slot(s) — not enough distinct artists at this target`)
    for (const { t, s } of scored) {
      if (out.length >= target) break
      if (scoreMap.has(t.id)) continue
      out.push(t.id)
      scoreMap.set(t.id, s)
    }
  }
  // Guarantee the target (Jake: "always always always 1000"): `scored` was
  // pruned to s>-20, so if the vibe scored too few positively we'd fall
  // short. Backfill from EVERY remaining eligible (named, non-skit) track
  // until we hit the target. Only a library with fewer than `target` named
  // songs can come up short now — and that's a true, reportable shortage.
  if (out.length < target) {
    for (const t of eligible) {
      if (out.length >= target) break
      if (scoreMap.has(t.id)) continue
      out.push(t.id)
      scoreMap.set(t.id, -100)
    }
  }

  const byId = new Map(tracks.map((t) => [t.id, t]))
  let alacCount = 0
  for (const id of out) {
    if (isAlacCodec(byId.get(id)?.codec)) alacCount++
  }

  return {
    trackIds: out,
    scores: scoreMap,
    alacCount,
    name: vibe?.name || 'Activity Sync',
    commentary: vibe?.commentary || 'AI activity set for this sync.',
  }
}
