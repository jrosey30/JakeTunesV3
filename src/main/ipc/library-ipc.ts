/**
 * Library IPC: artist aliases, playlists, listening memory, orphans.
 *
 * Extracted from main/index.ts. Heavy save-library / load-tracks /
 * metadata-override / artwork engines stay in index.ts — their closures
 * couple library persistence, NAS mirror, and sync triggers. This module
 * owns the denser *surface* channels whose logic is already injectable.
 */
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { STATE_DIR } from '../state-dir.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import {
  computeArtistCandidates,
  parseGroupingResponse,
  type GroupingProposal,
} from '../artist-groups-core.ts'
import type { TrackLike } from '../taste-model.ts'
import {
  getListeningMemory,
  recordPlay,
  recordSkip,
  recordRating,
} from '../listener-profile.ts'

function aliasesPath(): string {
  return join(STATE_DIR, 'artist-aliases.json')
}

export type ClaudeCall = (
  callKey: string,
  params: MessageCreateParamsNonStreaming,
) => Promise<Message>

export interface LibraryIpcHost {
  /** Current library tracks for AI artist-group classification. */
  getLibraryTracks: () => Promise<TrackLike[]>
  /** Shared Claude caller (ceiling + cache live in index.ts). */
  claudeCall: ClaudeCall
  getPlaylists: () => Promise<unknown[]>
  setPlaylists: (playlists: unknown[]) => void
  isSaveLocked: () => string | null
  /** The one reason this module ever sends. Typed as the literal so the
   *  host can keep its narrow SyncReason union — (reason: string) here
   *  rejected every narrower host and caused one of the "73 errors". */
  triggerSync: (reason: 'playlist') => void
  scanLibraryOrphans: () => Promise<{
    trackCount: number
    diskCount: number
    orphanCount: number
    orphanBytes: number
    samples: Array<{ basename: string; mtimeMs: number; size: number }>
  }>
  purgeLibraryOrphans: () => Promise<{ deleted: number; bytesFreed: number }>
}

export function registerLibraryIpc(ipc: IpcRegistrar, host: LibraryIpcHost): void {
  // artist-aliases.json: { "<raw artist tag>": "<canonical artist>" }.
  ipc.handle('load-artist-aliases', async (): Promise<{ ok: boolean; aliases: Record<string, string> }> => {
    try {
      const parsed = JSON.parse(await readFile(aliasesPath(), 'utf-8'))
      const aliases = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? parsed as Record<string, string>
        : {}
      return { ok: true, aliases }
    } catch {
      return { ok: true, aliases: {} }
    }
  }, { public: true })

  ipc.handle('save-artist-aliases', async (_e, aliases: Record<string, string>): Promise<{ ok: boolean; error?: string }> => {
    try {
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(aliases || {})) {
        const key = String(k).trim(); const val = String(v ?? '').trim()
        if (key && val) clean[key] = val
      }
      await mkdir(STATE_DIR, { recursive: true })
      const path = aliasesPath()
      const tmp = `${path}.tmp.json`
      await writeFile(tmp, JSON.stringify(clean, null, 2), 'utf-8')
      const { rename: renameFS } = await import('fs/promises')
      await renameFS(tmp, path)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })

  // Metadata hierarchy Phase 2 — AI-assisted artist grouping. Nothing is
  // applied here; the renderer shows proposals for user approval.
  ipc.handle('classify-artist-groups', async (): Promise<{ ok: boolean; proposals?: GroupingProposal[]; candidateCount?: number; error?: string }> => {
    try {
      const tracks = await host.getLibraryTracks()
      const { candidates, primaries } = computeArtistCandidates(tracks, { maxCandidates: 150, maxPrimaries: 400 })
      if (candidates.length === 0) return { ok: true, proposals: [], candidateCount: 0 }
      const user = [
        'Below are artist tags from a personal music library that contain a join marker ("&", "and", "/", "feat", "with", a comma, etc.). Each is exactly ONE of:',
        '  • "persona" — the SAME act/musician as a primary artist (their band, alias, "X & His Band", a spouse duo). e.g. Wings → Paul McCartney; Paul & Linda McCartney → Paul McCartney; Bruce Springsteen & The E Street Band → Bruce Springsteen.',
        '  • "collaboration" — distinct artists who collaborated; the track belongs to each but the tag is not one act. e.g. Paul McCartney & Stevie Wonder; "Rihanna, Kanye West, and Paul McCartney".',
        '  • "standalone" — the tag IS a single artist/band whose NAME merely contains those words; do NOT merge. e.g. Hall & Oates; King Gizzard & The Lizard Wizard; AC/DC; Simon & Garfunkel; Earth, Wind & Fire; Polo & Pan.',
        '',
        'For a "persona", set "canonical" to the primary. PREFER an exact name from this list of existing primary artists when one fits:',
        primaries.join(' | ') || '(none)',
        '',
        'Tags to classify (with track counts):',
        candidates.map((c) => `- ${c.tag} (${c.count})`).join('\n'),
        '',
        'Return ONLY JSON — an array of {"tag","type","canonical","contributors","why"}: "canonical" only for persona, "contributors" (array) only for collaboration, "why" = one short sentence. No prose, no code fence.',
      ].join('\n')
      const reply = await host.claudeCall('artist-groups:classify', {
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        system: 'You are a meticulous music-metadata expert. You know artist relationships precisely — a musician\'s bands/aliases/side-projects vs. one-off collaborations vs. standalone groups whose name simply contains "&"/"and"/"/". Be conservative: when unsure whether two tags are the SAME act, prefer "standalone" or "collaboration" over a wrong merge.',
        messages: [{ role: 'user', content: user }],
      })
      const block = reply.content[0]
      const text = block && block.type === 'text' ? block.text : ''
      return { ok: true, proposals: parseGroupingResponse(text), candidateCount: candidates.length }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('get-listening-memory', async () => getListeningMemory(), { public: true })

  ipc.handle('record-play', async (_event, track: { title: string; artist: string; album: string; genre: string; pct?: number }) =>
    recordPlay(track), { refuse: undefined })

  ipc.handle('record-skip', async (_event, track: { title: string; artist: string; pct?: number }) =>
    recordSkip(track), { refuse: undefined })

  ipc.handle('record-rating', async (_event, track: { title: string; artist: string; album: string; rating: number }) =>
    recordRating(track), { refuse: undefined })

  ipc.handle('load-playlists', async () => {
    return { ok: true, playlists: await host.getPlaylists() }
  }, { public: true })

  ipc.handle('save-playlists', async (_event, playlists: unknown[]) => {
    const lockReason = host.isSaveLocked()
    if (lockReason) {
      console.warn(`[save-playlists] refused (saves locked): ${lockReason}`)
      return { ok: false, error: 'state-save-locked', reason: lockReason }
    }
    host.setPlaylists(playlists)
    host.triggerSync('playlist')
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('scan-library-orphans', async () => {
    try {
      const result = await host.scanLibraryOrphans()
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { public: true })

  ipc.handle('purge-library-orphans', async () => {
    try {
      const { deleted, bytesFreed } = await host.purgeLibraryOrphans()
      return { ok: true, deleted, bytesFreed }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })
}
