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

  score += Math.min(plays, 40) * 0.35
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

  const scored = tracks
    .map((t) => {
      let s = scoreWorkoutTrack(t, vibe, brief, weather)
      if (previous.has(t.id)) s -= 35
      s += (rand() - 0.5) * 2
      return { t, s }
    })
    .filter((x) => x.s > -20)
    .sort((a, b) => b.s - a.s || a.t.id - b.t.id)

  const CAP = 4
  const perArtist = new Map<string, number>()
  const out: number[] = []
  const scoreMap = new Map<number, number>()

  const takePass = (relaxCap: boolean) => {
    for (const { t, s } of scored) {
      if (out.length >= target) break
      if (scoreMap.has(t.id)) continue
      const key = (t.artist || 'Unknown').toLowerCase().trim()
      const n = perArtist.get(key) || 0
      if (!relaxCap && n >= CAP) continue
      out.push(t.id)
      scoreMap.set(t.id, s)
      perArtist.set(key, n + 1)
    }
  }

  takePass(false)
  if (out.length < target) takePass(true)
  if (out.length < target) {
    for (const { t, s } of scored) {
      if (out.length >= target) break
      if (scoreMap.has(t.id)) continue
      out.push(t.id)
      scoreMap.set(t.id, s)
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
