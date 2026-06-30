/**
 * Discovery Brain — taste fingerprint, new-music radar, and rediscovery.
 *
 * Radar is ANCHORED to what the listener actually plays — top artists by
 * play count drive Exa searches ("new releases fans of X would love") and
 * every pick must tie back to an anchor artist via the `anchor` field.
 */

import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import {
  computeTasteFingerprint,
  getTasteAnchors,
  type TasteFingerprint,
  type TrackLike,
  type TasteAnchor,
} from './taste-model.ts'
import { parseCandidates, rankCandidates, type RankedCandidate, type RawCandidate } from './radar-core.ts'
import { computeRediscovery, type RediscoveryPick, type RediscoveryTrack } from './rediscovery.ts'
import { exaNewMusic, exaNewMusicForFans, exaSimilarArtists } from './exa.ts'
import { recoIdentityKey } from './reco-tombstone.ts'

type ClaudeCall = (callKey: string, params: MessageCreateParamsNonStreaming) => Promise<Message>

export interface DiscoveryBrainHost {
  libraryPath: string
  claudeCall: ClaudeCall
  musicManCore: string
  getListIdentityKeys: () => Promise<Set<string>>
  /** Listener profile plays/skips from listener-profile.json — optional but sharpens taste. */
  getListenerTasteContext?: () => Promise<string>
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

let radarCache: {
  candidates: RankedCandidate[]
  generatedAt: number
  fingerprintSummary: string
  anchors: TasteAnchor[]
} | null = null
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

function ownedAlbumSet(tracks: TrackLike[]): Set<string> {
  const out = new Set<string>()
  for (const t of tracks) {
    const artist = (t.albumArtist || t.artist || '').trim().toLowerCase()
    const album = ((t as { album?: string }).album || '').trim().toLowerCase()
    if (artist && album) out.add(`${artist}|${album}`)
  }
  return out
}

async function gatherTasteJournalism(anchors: TasteAnchor[], fp: TasteFingerprint, year: string): Promise<string> {
  const searches: Promise<string>[] = []

  // Primary: new releases for fans of THEIR top artists (the whole point).
  const fanArtists = anchors.slice(0, 5).map((a) => a.artist)
  if (fanArtists.length > 0) {
    searches.push(exaNewMusicForFans(fanArtists, year))
  }

  // Secondary: similar-artist journalism for top 3 anchors.
  for (const a of anchors.slice(0, 3)) {
    searches.push(exaSimilarArtists(a.artist))
  }

  // Tertiary: one genre-spine search for breadth (lowest priority).
  const spine = fp.spines[0]
  if (spine) {
    const scene = RADAR_SCENES[spine.name] || spine.name.toLowerCase()
    searches.push(exaNewMusic(scene, year))
  }

  const blocks = await Promise.all(searches)
  return blocks.filter(Boolean).join('\n\n')
}

async function extractRadarCandidates(
  host: DiscoveryBrainHost,
  fp: TasteFingerprint,
  anchors: TasteAnchor[],
  journalism: string,
  year: string,
  listenerCtx: string,
): Promise<RawCandidate[]> {
  const anchorList = anchors.map((a, i) =>
    `${i + 1}. ${a.artist} — ${a.plays} plays, ${a.tracks} tracks owned${a.primaryGenre ? `, usually ${a.primaryGenre}` : ''}`,
  ).join('\n')

  const user = [
    listenerCtx ? `Listener behavior:\n${listenerCtx}\n` : '',
    `Taste fingerprint: ${fp.summary}`,
    `Top genres by rotation: ${fp.topGenres.slice(0, 8).map((g) => `${g.genre} (${g.plays} plays)`).join(', ')}.`,
    '',
    'ANCHOR ARTISTS — every pick MUST connect to one of these (the listener\'s most-played):',
    anchorList || '(no strong play signal — use genre fit)',
    '',
    'Below is CURRENT music journalism about new releases and similar artists:',
    journalism,
    '',
    `From ONLY the releases and artists named above, pick up to 15 NEW releases (${Number(year) - 1}–${year}) this listener would love.`,
    'RULES:',
    '- Each pick MUST include "anchor": the exact name of ONE anchor artist above that this pick connects to (same scene, cited as similar, fan crossover).',
    '- "why" must say WHY in your voice — e.g. "Same dry funk as Chromeo, which you play constantly" — not generic hype.',
    '- Do NOT invent releases not named in the journalism.',
    '- Do NOT recommend artists they already own (see anchor list — those are owned).',
    '',
    'Return ONLY JSON — [{"artist","title","genre","year","why","anchor"}], no prose, no code fence.',
  ].join('\n')

  const reply = await host.claudeCall('new-music-radar', {
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
    system: host.musicManCore,
    messages: [{ role: 'user', content: user }],
  })
  const block = reply.content[0]
  const text = block && block.type === 'text' ? block.text : ''
  return parseCandidates(text)
}

/** Fallback when Exa is unavailable — still taste-anchored, no hallucinated journalism. */
async function tasteAnchoredFallback(
  host: DiscoveryBrainHost,
  fp: TasteFingerprint,
  anchors: TasteAnchor[],
  tracks: TrackLike[],
  year: string,
  listenerCtx: string,
): Promise<RawCandidate[]> {
  const owned = ownedAlbumSet(tracks)
  const albumSample = [...owned].slice(0, 120).join('\n')
  const anchorList = anchors.map((a) => `${a.artist} (${a.plays} plays)`).join(', ')

  const user = [
    listenerCtx ? `Listener behavior:\n${listenerCtx}\n` : '',
    `Taste: ${fp.summary}`,
    `Anchor artists (what they actually play): ${anchorList}`,
    `Top genres: ${fp.topGenres.slice(0, 8).map((g) => g.genre).join(', ')}`,
    '',
    `Recommend 10 albums they DON'T own that connect to their anchor artists — same scene, influences, or critical lineage. Year range ${Number(year) - 2}–${year} preferred but classics they'd obviously love are OK if recent stuff isn't your strength.`,
    '',
    'Albums they already have (DO NOT recommend these):',
    albumSample,
    '',
    'Each pick needs "anchor" (which of their anchor artists this connects to) and "why" (one sentence, specific, in your voice).',
    'Return ONLY JSON — [{"artist","title","genre","year","why","anchor"}], no prose, no code fence.',
  ].join('\n')

  const reply = await host.claudeCall('new-music-radar-fallback', {
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: host.musicManCore,
    messages: [{ role: 'user', content: user }],
  })
  const block = reply.content[0]
  const text = block && block.type === 'text' ? block.text : ''
  return parseCandidates(text)
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
    anchors?: TasteAnchor[]
    error?: string
  }> => {
    if (!force && radarCache && Date.now() - radarCache.generatedAt < RADAR_TTL_MS) {
      return {
        ok: true,
        candidates: radarCache.candidates,
        generatedAt: radarCache.generatedAt,
        cached: true,
        fingerprintSummary: radarCache.fingerprintSummary,
        anchors: radarCache.anchors,
      }
    }
    try {
      const tracks = await readLibraryTracks(host.libraryPath)
      const fp = computeTasteFingerprint(tracks)
      if (fp.totalTracks === 0) {
        return { ok: false, error: 'Your library is empty — nothing to base discovery on yet.' }
      }
      const anchors = getTasteAnchors(tracks, 8)
      if (anchors.length === 0) {
        return { ok: false, error: 'No play history yet — spin some tracks so we know what you like.' }
      }
      const year = String(new Date().getFullYear())
      const listenerCtx = host.getListenerTasteContext ? await host.getListenerTasteContext() : ''

      const journalism = await gatherTasteJournalism(anchors, fp, year)
      const raw = journalism
        ? await extractRadarCandidates(host, fp, anchors, journalism, year, listenerCtx)
        : await tasteAnchoredFallback(host, fp, anchors, tracks, year, listenerCtx)

      if (raw.length === 0) {
        return {
          ok: false,
          error: journalism
            ? 'Couldn\'t find picks from current journalism — try Refresh.'
            : 'Add your Exa key in Settings → AI for live release picks, or try Refresh for taste-based suggestions.',
        }
      }

      const listKeys = await host.getListIdentityKeys()
      const isOnList = (a: string, t: string): boolean => {
        const k = recoIdentityKey(a, t)
        return k != null && listKeys.has(k)
      }
      const candidates = rankCandidates(fp, raw, 12, isOnList, anchors)
      if (candidates.length === 0) {
        return { ok: false, error: 'Everything we found you already own or have on your list — try Refresh later.' }
      }

      radarCache = { candidates, generatedAt: Date.now(), fingerprintSummary: fp.summary, anchors }
      return {
        ok: true,
        candidates,
        generatedAt: radarCache.generatedAt,
        fingerprintSummary: fp.summary,
        anchors,
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
