/**
 * Activity-aware iPod sync IPC — brief + place weather + AI vibe → 1000-track set.
 * Persists activity context for the Music Man brain.
 */

import { ipcMain } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { getWeatherForPlace } from './external'
import {
  activityScoreHints,
  formatActivityContextForPrompt,
  labelActivity,
  loadActivityBrainContext,
  loadActivityProfiles,
  saveActivityBrainContext,
  saveActivityProfile,
  type ActivityBrief,
  type ActivityWeather,
} from './activity-context'
import {
  selectWorkoutSyncSet,
  type WorkoutTrack,
  type WorkoutVibe,
} from './workout-sync.ts'

type ClaudeCall = (callKey: string, params: MessageCreateParamsNonStreaming) => Promise<Message>

export interface WorkoutSyncHost {
  claudeCall: ClaudeCall
  musicManCore: string
}

const WORKOUT_TARGET = 1000
const STATE_FILE = () => join(app.getPath('userData'), 'workout-sync-state.json')

interface WorkoutSyncState {
  trackIds: number[]
  name: string
  commentary: string
  syncedAt: string
  alacCount: number
  brief?: ActivityBrief
}

async function loadState(): Promise<WorkoutSyncState | null> {
  try {
    const raw = await readFile(STATE_FILE(), 'utf-8')
    const parsed = JSON.parse(raw) as WorkoutSyncState
    if (!parsed || !Array.isArray(parsed.trackIds)) return null
    return parsed
  } catch {
    return null
  }
}

async function saveState(state: WorkoutSyncState): Promise<void> {
  try {
    await writeFile(STATE_FILE(), JSON.stringify(state, null, 2))
  } catch (err) {
    console.warn('[workout-sync] state write failed:', err)
  }
}

function parseVibe(text: string): WorkoutVibe | null {
  if (!text) return null
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    const commentary = typeof o.commentary === 'string' ? o.commentary.trim() : ''
    if (!name) return null
    const genreBoosts = Array.isArray(o.genreBoosts)
      ? o.genreBoosts.filter((g): g is string => typeof g === 'string').slice(0, 8)
      : []
    const seedArtists = Array.isArray(o.seedArtists)
      ? o.seedArtists.filter((a): a is string => typeof a === 'string').slice(0, 12)
      : []
    const energy = o.energy === 'mixed' || o.energy === 'endurance' || o.energy === 'high'
      ? o.energy
      : 'high'
    return { name, commentary, genreBoosts, seedArtists, energy }
  } catch {
    return null
  }
}

async function askActivityVibe(
  host: WorkoutSyncHost,
  tracks: WorkoutTrack[],
  brief: ActivityBrief,
  weather: ActivityWeather | null,
  previousName?: string,
): Promise<WorkoutVibe> {
  const genreCounts = new Map<string, number>()
  const artistPlays = new Map<string, number>()
  for (const t of tracks) {
    if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) || 0) + 1)
    if (t.artist) artistPlays.set(t.artist, (artistPlays.get(t.artist) || 0) + (Number(t.playCount) || 0))
  }
  const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([g]) => g)
  const topArtists = [...artistPlays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([a]) => a)
  const hints = activityScoreHints(brief, weather)

  const user = [
    `Build THIS SYNC's iPod music set for a specific activity. The set will be ~1000 tracks from THEIR library.`,
    previousName ? `Last sync was called "${previousName}" — make this one feel DIFFERENT.` : '',
    '',
    `Activity: ${labelActivity(brief.activity)}`,
    `Intensity: ${brief.intensity}`,
    `Setting: ${brief.setting} (${brief.social === 'friends' ? 'with friends' : 'solo'})`,
    brief.place ? `Place: ${brief.place}` : '',
    weather
      ? `Weather at place: ${weather.tempF}°F, ${weather.description || weather.condition} (${weather.placeLabel})`
      : 'Weather: unknown — lean on activity + setting.',
    hints.weatherNote ? `Weather read: ${hints.weatherNote}` : '',
    brief.note ? `Listener note: ${brief.note}` : '',
    '',
    `Suggested genre lean (from heuristics): ${hints.genreBoosts.join(', ') || 'none'}`,
    `BPM bias: ${hints.bpmBias}`,
    `Library genres (top): ${topGenres.join(', ')}`,
    `Most-played artists: ${topArtists.join(', ')}`,
    '',
    'Return ONLY JSON:',
    '{"name":"short set name for this activity (include place or weather vibe if it lands)","commentary":"1 sentence in your voice — why this set for THIS activity/place/weather","energy":"high|mixed|endurance","genreBoosts":["up to 5 genre words from their library"],"seedArtists":["up to 8 artists from their most-played that fit"]}',
  ].filter(Boolean).join('\n')

  try {
    const reply = await host.claudeCall('workout-sync-vibe', {
      model: 'claude-sonnet-4-6',
      max_tokens: 450,
      system: host.musicManCore,
      messages: [{ role: 'user', content: user }],
    })
    const block = reply.content[0]
    const text = block && block.type === 'text' ? block.text : ''
    const vibe = parseVibe(text)
    if (vibe) return vibe
  } catch (err) {
    console.warn('[workout-sync] vibe call failed:', err)
  }

  return {
    name: `${labelActivity(brief.activity)} · ${brief.intensity}`,
    commentary: hints.weatherNote
      || `Built for a ${brief.intensity} ${labelActivity(brief.activity).toLowerCase()} — ${brief.setting}.`,
    energy: hints.bpmBias === 'high' ? 'high' : hints.bpmBias === 'mid' ? 'endurance' : 'mixed',
    genreBoosts: hints.genreBoosts.slice(0, 5),
    seedArtists: topArtists.slice(0, 6),
  }
}

export function registerWorkoutSyncIpc(host: WorkoutSyncHost): void {
  ipcMain.handle('build-workout-sync-set', async (
    _e,
    tracks: WorkoutTrack[],
    opts?: { target?: number; brief?: ActivityBrief; saveProfile?: boolean },
  ) => {
    try {
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return { ok: false, error: 'Library is empty — nothing to sync.' }
      }
      const brief: ActivityBrief = opts?.brief || {
        activity: 'run',
        intensity: 'medium',
        setting: 'city',
        place: 'Brooklyn',
        social: 'solo',
      }

      const wx = await getWeatherForPlace(brief.place || 'Brooklyn')
      const weather: ActivityWeather | null = wx
        ? {
            tempF: wx.tempF,
            condition: wx.condition,
            description: wx.description,
            placeLabel: wx.placeLabel || brief.place || 'Unknown',
          }
        : null

      if (opts?.saveProfile !== false) {
        await saveActivityProfile(brief).catch(() => {})
      }

      const prev = await loadState()
      const vibe = await askActivityVibe(host, tracks, brief, weather, prev?.name)
      const target = Math.min(opts?.target ?? WORKOUT_TARGET, tracks.length)
      const selected = selectWorkoutSyncSet(tracks, {
        target,
        previousIds: prev?.trackIds,
        vibe,
        brief,
        weather,
        seed: Date.now(),
      })
      if (selected.trackIds.length === 0) {
        return { ok: false, error: 'Could not build an activity set from this library.' }
      }

      const state: WorkoutSyncState = {
        trackIds: selected.trackIds,
        name: selected.name,
        commentary: selected.commentary,
        syncedAt: new Date().toISOString(),
        alacCount: selected.alacCount,
        brief,
      }
      await saveState(state)

      // Feed the AI brain — Music Man chat/DJ/radio will see this context.
      await saveActivityBrainContext({
        brief,
        weather,
        setName: selected.name,
        setCommentary: selected.commentary,
        updatedAt: state.syncedAt,
      })

      return {
        ok: true,
        trackIds: state.trackIds,
        name: state.name,
        commentary: state.commentary,
        alacCount: state.alacCount,
        total: state.trackIds.length,
        rotatedFrom: prev?.trackIds?.length ?? 0,
        weather,
        brief,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'workout sync failed' }
    }
  })

  ipcMain.handle('get-workout-sync-state', async () => {
    const s = await loadState()
    return { ok: true, state: s }
  })

  ipcMain.handle('get-activity-profiles', async () => {
    const profiles = await loadActivityProfiles()
    return { ok: true, profiles }
  })

  ipcMain.handle('get-activity-brain-context', async () => {
    const ctx = await loadActivityBrainContext()
    return {
      ok: true,
      context: ctx,
      promptBlock: formatActivityContextForPrompt(ctx),
    }
  })

  ipcMain.handle('preview-place-weather', async (_e, place: string) => {
    const wx = await getWeatherForPlace(place || 'Brooklyn')
    return { ok: true, weather: wx }
  })
}

/** Sync helper for Music Man prompt injection (read from disk/memory). */
export async function getActivityPromptBlock(): Promise<string> {
  const ctx = await loadActivityBrainContext()
  return formatActivityContextForPrompt(ctx)
}
