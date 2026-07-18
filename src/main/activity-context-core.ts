/**
 * Pure activity-context types + prompt/score helpers (no Electron).
 * Persistence lives in activity-context.ts.
 */

export type ActivityKind = 'bop' | 'run' | 'ski' | 'lift' | 'bike' | 'walk' | 'hike' | 'other'
export type Intensity = 'easy' | 'medium' | 'hard'
export type SettingKind = 'city' | 'trail' | 'gym' | 'mountain' | 'indoors' | 'water'
export type SocialKind = 'solo' | 'friends'

export interface ActivityBrief {
  id?: string
  profileName?: string
  activity: ActivityKind
  intensity: Intensity
  setting: SettingKind
  place: string
  social: SocialKind
  note?: string
}

export interface ActivityWeather {
  tempF: number
  condition: string
  description: string
  placeLabel: string
}

export interface ActivityBrainContext {
  brief: ActivityBrief
  weather: ActivityWeather | null
  setName?: string
  setCommentary?: string
  updatedAt: string
}

export interface SavedActivityProfile extends ActivityBrief {
  id: string
  profileName: string
  updatedAt: string
}

export function labelActivity(a: ActivityKind): string {
  const map: Record<ActivityKind, string> = {
    bop: 'Bopping Around',
    run: 'Run', ski: 'Ski', lift: 'Lift', bike: 'Bike', walk: 'Walk', hike: 'Hike', other: 'Activity',
  }
  return map[a] || 'Activity'
}

export function formatActivityContextForPrompt(ctx: ActivityBrainContext | null): string {
  if (!ctx?.brief) return ''
  const b = ctx.brief
  const lines = [
    `ACTIVITY CONTEXT (what the listener is doing / preparing for — use this to shape music picks, commentary, and tone):`,
    `• Activity: ${labelActivity(b.activity)} · Intensity: ${b.intensity} · Setting: ${b.setting} · ${b.social === 'friends' ? 'With friends' : 'Solo'}`,
  ]
  if (b.place?.trim()) lines.push(`• Place: ${b.place.trim()}`)
  if (ctx.weather) {
    lines.push(
      `• Weather there now: ${ctx.weather.tempF}°F, ${ctx.weather.description || ctx.weather.condition}`
      + (ctx.weather.placeLabel ? ` (${ctx.weather.placeLabel})` : ''),
    )
  }
  if (b.activity === 'bop') {
    lines.push(
      `• Mode: everyday listening — hanging around, commuting, errands, killing time. Not a workout. Favor variety and vibe over pure BPM grind.`,
    )
  }
  if (b.note?.trim()) lines.push(`• Listener note: ${b.note.trim()}`)
  if (ctx.setName) lines.push(`• Latest iPod set: “${ctx.setName}”${ctx.setCommentary ? ` — ${ctx.setCommentary}` : ''}`)
  lines.push(
    `Use this as live situational context. A hard ski day in the cold is not “Bopping Around” on the train. Match energy, density, and social vibe — do not ignore the weather or place.`,
  )
  return lines.join('\n')
}

export function activityScoreHints(brief: ActivityBrief, weather: ActivityWeather | null): {
  bpmBias: 'high' | 'mid' | 'mixed'
  genreBoosts: string[]
  genrePenalties: string[]
  weatherNote: string
} {
  const genreBoosts: string[] = []
  const genrePenalties: string[] = []
  let bpmBias: 'high' | 'mid' | 'mixed' = 'mixed'
  let weatherNote = ''

  if (brief.intensity === 'hard') bpmBias = 'high'
  else if (brief.intensity === 'easy') bpmBias = 'mid'
  else bpmBias = 'mixed'

  // Everyday listening — hanging around, commuting, errands. Not a workout set.
  if (brief.activity === 'bop') {
    genreBoosts.push('hip-hop', 'indie', 'soul', 'funk', 'electronic', 'rap', 'disco', 'r&b')
    genrePenalties.push('hardcore', 'doom', 'sludge')
    bpmBias = brief.intensity === 'hard' ? 'mixed' : 'mid'
  }
  if (brief.activity === 'run' || brief.activity === 'bike') {
    genreBoosts.push('electronic', 'hip-hop', 'house', 'techno', 'rap')
    bpmBias = brief.intensity === 'easy' ? 'mid' : 'high'
  }
  if (brief.activity === 'ski') {
    genreBoosts.push('electronic', 'techno', 'industrial', 'metal', 'punk', 'hip-hop')
    bpmBias = 'high'
  }
  if (brief.activity === 'lift') {
    genreBoosts.push('hip-hop', 'metal', 'rap', 'electronic', 'punk')
    bpmBias = 'high'
  }
  if (brief.activity === 'walk' || brief.activity === 'hike') {
    genreBoosts.push('indie', 'electronic', 'soul', 'funk')
    genrePenalties.push('metal', 'hardcore')
    bpmBias = 'mid'
  }

  if (brief.setting === 'city') genreBoosts.push('hip-hop', 'rap', 'house', 'disco')
  if (brief.setting === 'trail' || brief.setting === 'mountain') {
    genreBoosts.push('electronic', 'post-punk', 'indie')
    genrePenalties.push('club')
  }
  if (brief.setting === 'gym') genreBoosts.push('hip-hop', 'electronic', 'trap')
  if (brief.social === 'friends') genreBoosts.push('disco', 'funk', 'dance', 'house')

  if (weather) {
    const t = weather.tempF
    const cond = `${weather.condition} ${weather.description}`.toLowerCase()
    weatherNote = `${weather.placeLabel || brief.place}: ${t}°F, ${weather.description || weather.condition}`
    if (t <= 35 || /snow|ice|freezing|blizzard/.test(cond)) {
      genreBoosts.push('techno', 'industrial', 'hip-hop', 'metal')
      weatherNote += ' — cold/harsh: denser, driving tracks'
    } else if (t >= 80 || /hot|humid|heat/.test(cond)) {
      genreBoosts.push('disco', 'funk', 'house', 'soul')
      genrePenalties.push('doom', 'sludge')
      weatherNote += ' — hot: lighter groove, less sludge'
    } else if (/rain|drizzle|storm|thunder/.test(cond)) {
      genreBoosts.push('electronic', 'trip', 'hip-hop')
      weatherNote += ' — wet: moody but still moving'
    } else if (/clear|sun/.test(cond)) {
      genreBoosts.push('funk', 'disco', 'indie')
      weatherNote += ' — clear: open, bright energy OK'
    }
  }

  return {
    bpmBias,
    genreBoosts: [...new Set(genreBoosts)].slice(0, 10),
    genrePenalties: [...new Set(genrePenalties)].slice(0, 6),
    weatherNote,
  }
}
