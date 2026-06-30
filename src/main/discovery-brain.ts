/**
 * Discovery Brain — taste fingerprint, new-music radar, and rediscovery.
 *
 * Phase 1: taste-model.ts computes the fingerprint from library.json.
 * Phase 2: Exa journalism + Music Man extraction → rankCandidates.
 * Phase 3: rediscovery.ts mines owned-but-overlooked artists + MM pitches.
 */

import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { computeTasteFingerprint, type TasteFingerprint, type TrackLike } from './taste-model.ts'
import { parseCandidates, rankCandidates, type RankedCandidate } from './radar-core.ts'
import { computeRediscovery, type RediscoveryPick, type RediscoveryTrack } from './rediscovery.ts'
import { exaNewMusic } from './exa.ts'
import { recoIdentityKey } from './reco-tombstone.ts'

type ClaudeCall = (callKey: string, params: MessageCreateParamsNonStreaming) => Promise<Message>

export interface DiscoveryBrainHost {
  libraryPath: string
  claudeCall: ClaudeCall
  musicManCore: string
  getListIdentityKeys: () => Promise<Set<string>>
}

const RADAR_TTL_MS = 6 * 60 * 60 * 1000
const REDISCOVERY_TTL_MS = 6 * 60 * 60 * 1000

const RADAR_SCENES: Record<string, string> = {
  'Rock & Alternative': 'indie rock, alternative, and punk',
  'Hip-Hop & Rap': 'hip-hop and rap',
  'Electronic & Dance': 'electronic, house, and dance',
  'Soul, Funk & R&B': 'soul, funk, and R&B',
  Pop: 'pop',
  'Jazz, Blues & Classical': 'jazz and experimental',
}

let radarCache: { candidates: RankedCandidate[]; generatedAt: number; fingerprintSummary: string } | null = null
let rediscoveryCache: { at: number; picks: RediscoveryPick[] } | null = null

async function readLibraryTracks(libraryPath: string): Promise<TrackLike[]> {
  try {
    const raw = await readFile(libraryPath, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: TrackLike[] }
    return Array.isArray(lib.tracks) ? lib.tracks : []
  } catch {
    return []
  }
}

async function addMusicManRediscoveryPitches(
  host: DiscoveryBrainHost,
  picks: RediscoveryPick[],
): Promise<RediscoveryPick[]> {
  if (picks.length === 0) return picks
  const list = picks.map((p, i) =>
    `${i + 1}. ${p.artist}${p.album ? ` — "${p.album}"` : ''} (${p.genre || 'genre?'}; owns ${p.ownedTracks} track${p.ownedTracks === 1 ? '' : 's'}, played ${p.plays}× in JakeTunes${p.rating >= 4 ? ', starred' : ''})`,
  ).join('\n')
  const user = [
    `These are artists in the listener's OWN library that they clearly bought into but have barely or never played INSIDE JakeTunes. Critical context: their real listening lives partly on Spotify, so "0 plays here" almost always means "loved elsewhere, just never spun in this app yet" — NOT "never heard" or "disliked".`,
    '',
    `Write a ONE-sentence rediscovery nudge for EACH, in your voice — confident, opinionated, specific. Frame it as "you've been sleeping on this / it's sitting right here" — NEVER "you've never heard this". Lean on the facts (how much they own, the genre, that it's starred or freshly added) when it lands. Keep each under ~22 words.`,
    '',
    list,
    '',
    'Return ONLY a JSON array of strings — one per item, in order. No numbering, no prose, no code fence.',
  ].join('\n')
  const reply = await host.claudeCall('rediscovery', {
    model: 'claude-sonnet-4-6',
    max_tokens: 1400,
    system: host.musicManCore,
    messages: [{ role: 'user', content: user }],
  })
  const block = reply.content[0]
  const text = block && block.type === 'text' ? block.text : ''
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    const arr = JSON.parse(cleaned) as unknown[]
    return picks.map((p, i) => {
      const line = arr[i]
      return typeof line === 'string' && line.trim() ? { ...p, reason: line.trim() } : p
    })
  } catch {
    return picks
  }
}

export function registerDiscoveryBrainIpc(host: DiscoveryBrainHost): void {
  ipcMain.handle('get-taste-fingerprint', async (): Promise<{ ok: boolean; fingerprint?: TasteFingerprint; error?: string }> => {
    try {
      const tracks = await readLibraryTracks(host.libraryPath)
      return { ok: true, fingerprint: computeTasteFingerprint(tracks) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'taste failed' }
    }
  })

  ipcMain.handle('get-new-music-radar', async (_e, force?: boolean): Promise<{
    ok: boolean
    candidates?: RankedCandidate[]
    generatedAt?: number
    cached?: boolean
    fingerprintSummary?: string
    error?: string
  }> => {
    if (!force && radarCache && Date.now() - radarCache.generatedAt < RADAR_TTL_MS) {
      return {
        ok: true,
        candidates: radarCache.candidates,
        generatedAt: radarCache.generatedAt,
        cached: true,
        fingerprintSummary: radarCache.fingerprintSummary,
      }
    }
    try {
      const tracks = await readLibraryTracks(host.libraryPath)
      const fp = computeTasteFingerprint(tracks)
      if (fp.totalTracks === 0) {
        return { ok: false, error: 'Your library is empty — nothing to base discovery on yet.' }
      }
      const year = String(new Date().getFullYear())
      const scenes = fp.spines.slice(0, 3).map((s) => RADAR_SCENES[s.name] || s.name.toLowerCase())
      const blocks = await Promise.all(scenes.map((s) => exaNewMusic(s, year)))
      const journalism = blocks.filter(Boolean).join('\n\n')
      if (!journalism) {
        return {
          ok: false,
          error: 'New for You needs web search for fresh releases. Add your Exa key in Settings → AI to activate live picks (no made-up recommendations without it).',
        }
      }
      const user = [
        `This listener's taste: ${fp.summary}`,
        `Top genres: ${fp.topGenres.slice(0, 8).map((g) => g.genre).join(', ')}.`,
        '',
        'Below is CURRENT music journalism about new releases:',
        journalism,
        '',
        `From ONLY the releases named above, pick up to 15 NEW releases (${Number(year) - 1}–${year}) this listener would most likely love given their taste. For each give: artist, release title, its genre, the year, and a one-sentence "why" in your voice tying it to their taste. Do NOT invent releases that aren't named above. Return ONLY JSON — an array of objects [{"artist","title","genre","year","why"}], no prose, no code fence.`,
      ].join('\n')
      const reply = await host.claudeCall('new-music-radar', {
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: host.musicManCore,
        messages: [{ role: 'user', content: user }],
      })
      const block = reply.content[0]
      const text = block && block.type === 'text' ? block.text : ''
      const listKeys = await host.getListIdentityKeys()
      const isOnList = (a: string, t: string): boolean => {
        const k = recoIdentityKey(a, t)
        return k != null && listKeys.has(k)
      }
      const candidates = rankCandidates(fp, parseCandidates(text), 12, isOnList)
      radarCache = { candidates, generatedAt: Date.now(), fingerprintSummary: fp.summary }
      return {
        ok: true,
        candidates,
        generatedAt: radarCache.generatedAt,
        fingerprintSummary: fp.summary,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'radar failed' }
    }
  })

  ipcMain.handle('get-rediscovery', async (_e, force?: boolean): Promise<{ ok: boolean; picks?: RediscoveryPick[]; cached?: boolean; error?: string }> => {
    if (!force && rediscoveryCache && Date.now() - rediscoveryCache.at < REDISCOVERY_TTL_MS) {
      return { ok: true, picks: rediscoveryCache.picks, cached: true }
    }
    try {
      const tracks = await readLibraryTracks(host.libraryPath) as RediscoveryTrack[]
      const picks = computeRediscovery(tracks, new Date(), 9)
      if (picks.length === 0) return { ok: true, picks: [] }
      const pitched = await addMusicManRediscoveryPitches(host, picks)
      rediscoveryCache = { at: Date.now(), picks: pitched }
      return { ok: true, picks: pitched }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'rediscovery failed' }
    }
  })
}
