/**
 * Activity-aware iPod sync IPC — brief + place weather + AI vibe → 1000-track set.
 * Persists activity context for the Music Man brain.
 */

import type { IpcRegistrar } from './ipc-register.ts'
import { REFUSED_SENDER } from './ipc-register.ts'
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
  artistCapKey,
  isAlacCodec,
  type WorkoutTrack,
  type WorkoutVibe,
} from './workout-sync.ts'
import { buildActivityQueryText } from './activity-context-core.ts'
import { computeActivityBrainFit, type BrainFitResult } from './activity-brain.ts'
import { pickTasteExemplars } from './discovery-brain.ts'
import { getEmbeddingsMap, embedTexts } from './ai/embeddings.ts'
import { halfAndHalfLine, splitHalfAndHalf } from '../common/activity-split'
import { pickFromTop1000 } from '../common/top1000-sync.ts'

type ClaudeCall = (callKey: string, params: MessageCreateParamsNonStreaming) => Promise<Message>

export interface WorkoutSyncHost {
  ipc: IpcRegistrar
  claudeCall: ClaudeCall
  musicManCore: string
  /** Track ids that can NEVER land on the iPod (full-concert-owned — the
   *  sync drops them at copy time, so the picker must never offer them.
   *  2026-07-20: MM picked 4 concert tracks → "exactly 1000" silently
   *  synced as 996). */
  getIneligibleTrackIds?: () => Promise<Set<number>>
  /** The Original's brain half: homemini's Top 1000, ranked best first —
   *  null when the plugged-in iPod isn't the Original or homemini isn't
   *  answering, and Music Man picks instead (top1000-sync-source.ts). */
  top1000ForSync?: () => Promise<number[] | null>
  /** The plugged-in iPod's own state dir (step 2b: the root for the Original or no iPod,
   *  ipod-pools/<id>/ for any other known iPod); null = an unknown card, whose state is
   *  never written. index.ts resolves it through resolveIpodState. */
  ipodStateDir?: () => Promise<string | null>
}

const WORKOUT_TARGET = 1000
const ROOT_STATE_DIR = () => app.getPath('userData')
const STATE_FILE = (dir: string) => join(dir, 'workout-sync-state.json')
const HISTORY_FILE = (dir: string) => join(dir, 'workout-sync-history.json')
// Best-effort NAS mirror so the nightly brain jobs on homemini
// (JT_STATE_DIR = /Volumes/JakeShared/JakeTunesState) can ingest the
// sync history — this is how activity syncs feed the brain over time.
const HISTORY_NAS_MIRROR = '/Volumes/JakeShared/JakeTunesState/workout-sync-history.json'
const HISTORY_CAP = 200

interface SyncHistoryEdit { id: number; title: string; artist: string }
export interface SyncHistoryEntry {
  syncedAt: string
  name: string
  brief: ActivityBrief
  trackCount: number
  alacCount: number
  /** The set's track ids. Added 2026-07-24 so the picker can rotate against the
   *  last several syncs instead of only the immediately previous one — history
   *  written before this is simply absent and contributes nothing. */
  trackIds?: number[]
  /** Jake's review-sheet edits — the strongest taste signal we have. */
  added: SyncHistoryEdit[]
  removed: SyncHistoryEdit[]
}

async function loadSyncHistory(dir: string): Promise<SyncHistoryEntry[]> {
  try {
    const raw = await readFile(HISTORY_FILE(dir), 'utf-8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

async function appendSyncHistory(dir: string, entry: SyncHistoryEntry): Promise<void> {
  const cur = await loadSyncHistory(dir)
  const next = [entry, ...cur].slice(0, HISTORY_CAP)
  const json = JSON.stringify(next, null, 2)
  await writeFile(HISTORY_FILE(dir), json)
  // Only the Original's history feeds the brain on homemini (step 2b: a second iPod's
  // syncs are its own business, never mirrored).
  if (dir !== ROOT_STATE_DIR()) return
  try {
    // Never existsSync on JakeShared — sync SMB probe beachballs the main
    // process on workmini. Circuit breaker decides; write is best-effort.
    const { nasAvailable } = await import('./state-dir')
    if (await nasAvailable()) {
      await writeFile(HISTORY_NAS_MIRROR, json)
    }
  } catch { /* NAS asleep — local copy is the source of truth */ }
}

interface WorkoutSyncState {
  trackIds: number[]
  name: string
  commentary: string
  syncedAt: string
  alacCount: number
  /** The convert settings this set was ACTUALLY synced with — the plug-in
   *  auto-repair replays these when ui-state's convert prefs are missing
   *  (they got clobbered once and every repair silently aborted;
   *  2026-08-07). Replaying the recorded choice is not a silent default. */
  convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }
  brief?: ActivityBrief
}

async function loadState(dir: string): Promise<WorkoutSyncState | null> {
  try {
    const raw = await readFile(STATE_FILE(dir), 'utf-8')
    const parsed = JSON.parse(raw) as WorkoutSyncState
    if (!parsed || !Array.isArray(parsed.trackIds)) return null
    return parsed
  } catch {
    return null
  }
}

async function saveState(dir: string, state: WorkoutSyncState): Promise<void> {
  try {
    await writeFile(STATE_FILE(dir), JSON.stringify(state, null, 2))
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
  historyLines?: string,
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
    historyLines ? `\nWhat past syncs taught us (review edits are the listener's OWN corrections — respect them):\n${historyLines}` : '',
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
  const { ipc } = host
  ipc.handle('build-workout-sync-set', async (
    _e,
    tracks: WorkoutTrack[],
    opts?: { target?: number; brief?: ActivityBrief; saveProfile?: boolean; pool?: { ids: number[]; fill: boolean; pinnedIds?: number[] } },
  ) => {
    try {
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return { ok: false, error: 'Library is empty — nothing to sync.' }
      }
      // Concert-owned tracks are unsyncable — drop them from the pool
      // BEFORE the Music Man picks, so "exactly 1000" means 1000 on the
      // device (enforced main-side, same as the sync's own filter).
      if (host.getIneligibleTrackIds) {
        try {
          const out = await host.getIneligibleTrackIds()
          if (out.size) {
            const before = tracks.length
            tracks = tracks.filter((t) => !out.has(Number(t.id)))
            if (tracks.length !== before) console.log(`[workout-sync] ${before - tracks.length} concert-owned track(s) removed from the pick pool`)
          }
        } catch { /* no live sets → nothing to exclude */ }
      }
      const brief: ActivityBrief = opts?.brief || {
        activity: 'bop',
        intensity: 'medium',
        setting: 'city',
        place: 'Brooklyn',
        social: 'solo',
      }

      // ── HALF AND HALF (2026-10-16) ─────────────────────────────────
      // Jake: "ipod sync pool needs to be 50% automated 50% manual" — always.
      // Every sync of N = the NEWEST N/2 songs of the hand-built pool + the
      // rest picked by Music Man (src/common/activity-split.ts — the sheet shows the same split). Older drops wait their
      // turn; a pool under N/2 goes on whole and Music Man covers the rest.
      // Pool songs are exempt from the 2-per-artist rule; Music Man's half is
      // not, and counts the pool half. (Replaces the 2026-09-02 either/or
      // "Who picks" pool mode and its over-target hard stop.)
      const pool = opts?.pool
      const poolMode = !!pool && ((Array.isArray(pool.ids) && pool.ids.length > 0) || (Array.isArray(pool.pinnedIds) && pool.pinnedIds.length > 0))
      const byId = new Map(tracks.map((t) => [Number(t.id), t]))
      const syncable = (t: WorkoutTrack): boolean =>
        String(t.title || '').trim() !== '' && String(t.artist || '').trim() !== ''
        && t.audioMissing !== true && (t.path === undefined || String(t.path).trim() !== '')
      const target = Math.max(1, Math.floor(Number(opts?.target) || WORKOUT_TARGET))
      let poolIds: number[] = []
      let pinnedIds: number[] = []
      if (poolMode) {
        const seenPinned = new Set<number>()
        for (const raw of pool.pinnedIds || []) {
          const id = Number(raw)
          const t = byId.get(id)
          if (!t || seenPinned.has(id) || !syncable(t)) continue
          seenPinned.add(id)
          pinnedIds.push(id)
        }
        const seen = new Set<number>()
        for (const raw of pool.ids || []) {
          const id = Number(raw)
          const t = byId.get(id)
          if (!t || seen.has(id) || !syncable(t)) continue
          seen.add(id)
          poolIds.push(id)
        }
        if (poolIds.length !== (pool.ids || []).length) {
          console.log(`[workout-sync] pool: ${pool.ids.length - poolIds.length} id(s) not syncable/unknown — dropped from ${pool.ids.length}`)
        }
      }
      const split = splitHalfAndHalf(poolIds, target, pinnedIds)
      const manualIds = split.manualIds
      const gap = split.brainTarget
      const wantBrain = gap > 0

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

      // ── THE ORIGINAL'S BRAIN HALF = THE TOP 1000 (2026-10-23) ────────
      // The Original is "my top 1000 songs": the brain half goes straight
      // down the quiz's ranked list (common/top1000-sync.ts), skipping your
      // half. Music Man only picks what the list can't cover — all of it
      // when homemini isn't answering or this isn't the Original.
      let topIds: number[] = []
      let topReserve: number[] = []
      if (wantBrain && host.top1000ForSync) {
        const ranked = await host.top1000ForSync().catch((err) => {
          console.warn('[workout-sync] Top 1000 lookup failed — Music Man picks:', err instanceof Error ? err.message : err)
          return null
        })
        if (ranked && ranked.length > 0) {
          const got = pickFromTop1000(ranked, {
            gap,
            exclude: new Set([...poolIds, ...pinnedIds]),
            syncable: (id) => { const t = byId.get(id); return !!t && syncable(t) },
          })
          topIds = got.picked
          topReserve = got.reserve
          console.log(`[workout-sync] Top 1000: ${topIds.length}/${gap} of the brain half from the ranked list`)
        }
      }
      const musicManGap = gap - topIds.length

      // This iPod's own last set and history (step 2b); an unknown card reads as nothing.
      const stateDir = (await host.ipodStateDir?.()) ?? ROOT_STATE_DIR()
      const prev = await loadState(stateDir)
      let fillIds: number[] = []
      let reserveIds: number[] = []
      let name = ''
      let commentary = ''
      if (musicManGap > 0) {
        // Learn from history: edits Jake made in review for THIS activity.
        // Removed tracks get demoted hard; added tracks get boosted. The
        // vibe prompt also sees a compact digest so Music Man's framing
        // improves sync over sync.
        const history = await loadSyncHistory(stateDir)
        const sameActivity = history.filter((h) => h?.brief?.activity === brief.activity).slice(0, 20)
        const demoteIds = [...new Set(sameActivity.flatMap((h) => (h.removed || []).map((e) => e.id)))]
        const boostIds = [...new Set(sameActivity.flatMap((h) => (h.added || []).map((e) => e.id)))]
        const historyLines = sameActivity.slice(0, 8).map((h) => {
          const rm = (h.removed || []).slice(0, 5).map((e) => `${e.title} — ${e.artist}`).join('; ')
          const ad = (h.added || []).slice(0, 5).map((e) => `${e.title} — ${e.artist}`).join('; ')
          return `• ${h.syncedAt.slice(0, 10)} "${h.name}" (${h.trackCount} tracks)${rm ? ` | removed: ${rm}` : ''}${ad ? ` | added: ${ad}` : ''}`
        }).join('\n')
        const vibe = await askActivityVibe(host, tracks, brief, weather, prev?.name, historyLines || undefined)

        // Brain fit — the taste model finally decides the set (Jake 2026-07-23:
        // "get better at picking… you pick a lot of shit and miss on a lot of
        // shit"). taste = precomputed embeddings vs his starred/heavy-rotation
        // corners (works offline); ctx = the free-text steer embedded into a
        // query vector (best-effort — no key/offline just drops it). Any
        // failure → null → the heuristic picker runs exactly as before.
        let brainFit: BrainFitResult | null = null
        try {
          const embById = await getEmbeddingsMap()
          if (embById.size >= 100) {
            let queryVec: Float32Array | null = null
            try {
              const [qv] = await embedTexts([buildActivityQueryText(brief)])
              queryVec = qv || null
            } catch { queryVec = null }
            const fit = computeActivityBrainFit({
              eligibleIds: tracks.map((t) => Number(t.id)),
              embById,
              exemplarIds: pickTasteExemplars(tracks),
              queryVec,
            })
            if (fit.usable) {
              brainFit = fit
              console.log(`[workout-sync] brain fit on ${fit.fitById.size}/${tracks.length} tracks (ctx=${queryVec ? 'yes' : 'no'})`)
            }
          }
        } catch (err) {
          console.warn('[workout-sync] brain fit unavailable — heuristic only:', err instanceof Error ? err.message : err)
        }

        // Rotation memory across the last several syncs (2026-07-24, Jake: "more
        // variety"). `prev` only carried the most recent set, so a track dropped
        // one sync ago returned immediately. Count appearances across the recent
        // history — ANY activity, since Jake notices repeats across the board —
        // and let the picker apply a graded penalty.
        const RECENT_SYNCS = 6
        const recentCounts = new Map<number, number>()
        for (const h of history.slice(0, RECENT_SYNCS)) {
          for (const id of (h.trackIds || [])) {
            recentCounts.set(Number(id), (recentCounts.get(Number(id)) || 0) + 1)
          }
        }
        if (recentCounts.size) {
          console.log(`[workout-sync] rotation memory: ${recentCounts.size} track(s) seen in the last ${RECENT_SYNCS} sync(s)`)
        }

        // Music Man's half never picks a pooled id (the older drops wait their
        // turn rather than sneak in), and the artist cap starts from the pool
        // half actually going on (same key function).
        const seedArtistCounts = new Map<string, number>()
        for (const id of [...manualIds, ...topIds]) {
          const k = artistCapKey(byId.get(id)?.artist)
          seedArtistCounts.set(k, (seedArtistCounts.get(k) || 0) + 1)
        }

        const selected = selectWorkoutSyncSet(tracks, {
          target: musicManGap,
          previousIds: prev?.trackIds,
          recentCounts,
          vibe,
          brief,
          weather,
          seed: Date.now(),
          demoteIds,
          boostIds,
          brainFitById: brainFit?.fitById,
          tasteById: brainFit?.tasteById,
          excludeIds: [...poolIds, ...pinnedIds, ...topIds],
          seedArtistCounts,
        })
        fillIds = selected.trackIds
        reserveIds = selected.reserveIds
        name = selected.name
        commentary = manualIds.length > 0 || topIds.length > 0
          ? `${selected.commentary} ${halfAndHalfLine(split, manualIds.length, topIds.length, fillIds.length)}`
          : selected.commentary
      } else if (topIds.length > 0) {
        name = (brief.profileName || '').trim() || 'Top 1000'
        commentary = halfAndHalfLine(split, manualIds.length, topIds.length, 0)
      } else {
        name = (brief.profileName || '').trim() || 'iPod Pool'
        commentary = `Hand-built pool — ${poolIds.length} songs, in the order you dropped them.`
      }

      fillIds = [...topIds, ...fillIds]
      reserveIds = [...topReserve, ...reserveIds]
      const trackIds = [...manualIds, ...fillIds]
      if (trackIds.length === 0) {
        return { ok: false, error: 'Could not build an activity set from this library.' }
      }
      let alacCount = 0
      for (const id of trackIds) if (isAlacCodec(byId.get(id)?.codec)) alacCount++
      console.log(`[workout-sync] half and half: ${split.pinnedCount} pinned + ${manualIds.length - split.pinnedCount} pool drops (newest of ${poolIds.length}) + ${topIds.length} Top 1000 + ${fillIds.length - topIds.length} Music Man = ${trackIds.length}/${target}`)
      // #47 (fill-to-N): a hand-built pool is its own N; a brain-built set is
      // short only when the library could not fill the requested target.
      const requested = wantBrain ? target : trackIds.length
      const shortfall = Math.max(0, requested - trackIds.length)
      if (shortfall > 0) {
        console.warn(`[workout-sync] requested ${requested}, proposing ${trackIds.length} (shortfall ${shortfall})`)
      }

      // REVIEW GATE (2026-07-18): building is now a PROPOSAL — nothing
      // persists here. The renderer shows the set for review (edits,
      // substitutions) and calls commit-workout-sync-set only after the
      // device sync actually succeeds. Cancelling the review leaves no
      // trace, so plug-in auto-sync can never chase a phantom set.
      return {
        ok: true,
        trackIds,
        reserveIds,
        requested,
        shortfall,
        name,
        commentary,
        alacCount,
        total: trackIds.length,
        rotatedFrom: prev?.trackIds?.length ?? 0,
        weather,
        brief,
        pool: poolMode ? { pooled: manualIds.length, filled: fillIds.length } : undefined,
      }
    } catch (err) {
      console.error('[workout-sync] build failed:', err)
      return { ok: false, error: 'api-failed' }
    }
  }, { refuse: REFUSED_SENDER })

  // REVIEW GATE: called by the renderer AFTER a confirmed sync lands.
  // State written here is the ground truth "last set on the iPod" that
  // plug-in auto-sync repairs and the next build rotates away from.
  ipc.handle('commit-workout-sync-set', async (
    _e,
    payload: {
      trackIds: number[]; name: string; commentary: string; alacCount: number
      brief: ActivityBrief; weather?: ActivityWeather | null
      convertOptions?: { enabled: boolean; targetKbps: 128 | 192 | 256 }
      added?: Array<{ id: number; title: string; artist: string }>
      removed?: Array<{ id: number; title: string; artist: string }>
    },
  ) => {
    try {
      if (!Array.isArray(payload?.trackIds) || payload.trackIds.length === 0) {
        return { ok: false, error: 'Nothing to commit — empty track list.' }
      }
      const state: WorkoutSyncState = {
        trackIds: payload.trackIds.map(Number),
        name: String(payload.name || 'Activity Sync'),
        commentary: String(payload.commentary || ''),
        syncedAt: new Date().toISOString(),
        alacCount: Number(payload.alacCount) || 0,
        convertOptions: payload.convertOptions,
        brief: payload.brief,
      }
      // Recorded with the iPod it was synced to (step 2b). A sync to an unknown card
      // cannot have happened (the engine refuses it), so there is nothing to record.
      const stateDir = await host.ipodStateDir?.() ?? ROOT_STATE_DIR()
      await saveState(stateDir, state)
      // Taste ledger (2026-08-07): the review gate is the purest verdict
      // stream there is — Jake literally marking wrong picks. Append the
      // edits so the nightly learner and the acceptance KPI see them.
      try {
        const { appendFile } = await import('node:fs/promises')
        const ledger = join(app.getPath('userData'), 'taste-ledger.jsonl')
        const evts: string[] = []
        for (const tr of (payload.added ?? [])) {
          evts.push(JSON.stringify({ ts: state.syncedAt, surface: 'review-gate', verdict: 'accept', key: { trackId: tr.id }, ctx: { set: state.name } }))
        }
        for (const tr of (payload.removed ?? [])) {
          evts.push(JSON.stringify({ ts: state.syncedAt, surface: 'review-gate', verdict: 'reject', key: { trackId: tr.id }, ctx: { set: state.name } }))
        }
        if (evts.length) await appendFile(ledger, evts.join('\n') + '\n', 'utf-8')
      } catch { /* ledger is best-effort */ }
      // Ledger every confirmed sync (with Jake's review edits) — feeds
      // the next build's demote/boost lists, the vibe prompt digest, and
      // (via the NAS mirror) the nightly brain jobs on homemini.
      await appendSyncHistory(stateDir, {
        syncedAt: state.syncedAt,
        name: state.name,
        brief: payload.brief,
        trackCount: state.trackIds.length,
        alacCount: state.alacCount,
        trackIds: state.trackIds,   // feeds the picker's multi-sync rotation memory
        added: Array.isArray(payload.added) ? payload.added : [],
        removed: Array.isArray(payload.removed) ? payload.removed : [],
      }).catch(() => {})
      // Feed the AI brain — Music Man chat/DJ/radio will see this context.
      await saveActivityBrainContext({
        brief: payload.brief,
        weather: payload.weather ?? null,
        setName: state.name,
        setCommentary: state.commentary,
        updatedAt: state.syncedAt,
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: 'io-failed' }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('get-workout-sync-state', async () => {
    const s = await loadState((await host.ipodStateDir?.()) ?? ROOT_STATE_DIR())
    return { ok: true, state: s }
  }, { public: true })

  ipc.handle('get-activity-profiles', async () => {
    const profiles = await loadActivityProfiles()
    return { ok: true, profiles }
  }, { public: true })

  ipc.handle('get-activity-brain-context', async () => {
    const ctx = await loadActivityBrainContext()
    return {
      ok: true,
      context: ctx,
      promptBlock: formatActivityContextForPrompt(ctx),
    }
  }, { public: true })

  ipc.handle('preview-place-weather', async (_e, place: string) => {
    const wx = await getWeatherForPlace(place || 'Brooklyn')
    return { ok: true, weather: wx }
  }, { public: true })
}

/** Sync helper for Music Man prompt injection (read from disk/memory). */
export async function getActivityPromptBlock(): Promise<string> {
  const ctx = await loadActivityBrainContext()
  return formatActivityContextForPrompt(ctx)
}
