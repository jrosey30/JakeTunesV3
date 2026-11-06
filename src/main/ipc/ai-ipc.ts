/**
 * AI support IPC: Claude ceiling/stats, radio plan/cast, chat history,
 * Cynthia ledger/findings surface, library-context + radio memory clears,
 * plus thin Music Man surfaces (TTS speak, album blurb/take, save-recording).
 *
 * Heavy Music Man bodies (musicman-chat / -radio / -playlist / picks /
 * streaming DJ) stay in main/index.ts — they share persona helpers, RAG,
 * and Claude streaming closures. Prefer extracting those with their helper
 * bundles in a follow-up once deps are injectable.
 *
 * Cynthia investigate/chat/report live in cynthia-ipc.ts.
 */
import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { setShowPlan, clearShowPlan, clearMemory } from '../radio-memory.ts'
import { musicManVoiceId, radioCastForRenderer } from '../cast.ts'
import { LARRY_VOICE_ID } from '../../common/cohost.ts'
import { allowWithinRateLimit } from '../url-safety.ts'
import { MUSIC_MAN_CORE } from '../personas.ts'
import { setLibraryContext } from '../library-digest.ts'
import {
  getFindingsFor,
  dismissFinding,
  getLedger,
  sweepStatus,
} from '../cynthia-sweep.ts'
import type Anthropic from '@anthropic-ai/sdk'
import { MODEL_SMART, MODEL_FAST } from '../../common/ai-models.ts'
import { wholeSentences } from '../../common/sentences.ts'
import { albumNotesKey, createAlbumNotesStore, type AlbumNotesStore } from '../album-notes.ts'
import { cleanAiProse } from '../../common/clean-ai-prose.ts'
import { isWeakBlurb } from '../../common/weak-blurb.ts'
import { speakFast, speakTake, speakText } from '../eleven-speech.ts'
import { MAX_DIALOGUE_CHARS, type DialogueInput } from '../../common/speech.ts'

export interface AiIpcHost {
  setClaudeDailyCeiling: (ceiling: number) => Promise<{ ok: boolean; dailyCeiling: number }>
  getClaudeStats: () => Promise<{
    ok: boolean
    sessionCallCount: number
    callsToday: number
    dailyCeiling: number
    lastResetDate: string
    cachedKeys: string[]
  }>
  /** Cynthia ledger revert needs sweep hooks + album snapshot from index. */
  revertCynthiaLedgerEntry: (id: string) => Promise<unknown>
  /** App settings (Preferences → AI voice gate). */
  readAppSettings: () => Promise<Record<string, unknown> | null>
  /** Active AI host preference (mm vs larry) for default TTS voice. */
  readActiveHost: () => 'mm' | 'larry'
  /** Main window for save dialogs. */
  getMainWindow: () => BrowserWindow | null
  claudeCall: (
    callKey: string,
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ) => Promise<Anthropic.Messages.Message>
  /** Cached web search used to ground album blurbs. */
  searchWebCached: (query: string, album?: string) => Promise<string>
}

function chatHistoryPath(): string {
  return join(app.getPath('userData'), 'chat-history.json')
}

// The history and the take live on disk (album-notes.ts): the same words
// every time the page opens.
let albumNotes: AlbumNotesStore | null = null
function albumNotesStore(): AlbumNotesStore {
  return (albumNotes ??= createAlbumNotesStore(join(app.getPath('userData'), 'album-notes.json')))
}
const ttsRateBucket = new Map<string, number[]>()

export function registerAiIpc(ipc: IpcRegistrar, host: AiIpcHost): void {
  ipc.handle('set-claude-daily-ceiling', async (_e, ceiling: number) => {
    return host.setClaudeDailyCeiling(ceiling)
  }, { refuse: REFUSED_SENDER })

  ipc.handle('get-claude-stats', async () => {
    return host.getClaudeStats()
  }, { public: true })

  ipc.handle('radio-set-show-plan', async (_e, plan: { theme: string; throughline: string; setList: { id: number; title: string; artist: string }[] }) => {
    try {
      await setShowPlan(plan)
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('radio-get-cast', async () => {
    return { ok: true, cast: radioCastForRenderer(musicManVoiceId()) }
  }, { public: true })

  ipc.handle('radio-clear-show-plan', async () => {
    try {
      await clearShowPlan()
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('clear-radio-memory', async () => {
    try {
      await clearMemory()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('set-library-context', (_event, ctx: string) => {
    setLibraryContext(ctx)
  }, { refuse: undefined })

  ipc.handle('load-chat-history', async () => {
    try {
      const data = await readFile(chatHistoryPath(), 'utf-8')
      return { ok: true, conversations: JSON.parse(data) }
    } catch {
      return { ok: true, conversations: [] }
    }
  }, { public: true })

  ipc.handle('save-chat-history', async (_event, conversations: unknown[]) => {
    await mkdir(join(app.getPath('userData')), { recursive: true })
    await writeFile(chatHistoryPath(), JSON.stringify(conversations, null, 2), 'utf-8')
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  // Cynthia ledger / findings — sweep module already owns the logic.
  ipc.handle('cynthia-get-findings', async (_e, albumKeys: string[]) => {
    const findings = await getFindingsFor(Array.isArray(albumKeys) ? albumKeys : [])
    return { ok: true, findings }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('cynthia-dismiss-fix', async (_e, fix: { trackId: number; field: string; newValue: string }) => {
    if (!fix || typeof fix.trackId !== 'number' || !fix.field) return { ok: false, error: 'invalid fix key' }
    await dismissFinding(fix)
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('cynthia-get-ledger', async (_e, limit?: number) => {
    const entries = await getLedger(typeof limit === 'number' ? limit : 200)
    return { ok: true, entries }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('cynthia-revert-ledger-entry', async (_e, id: string) => {
    return host.revertCynthiaLedgerEntry(String(id || ''))
  }, { refuse: REFUSED_SENDER })

  ipc.handle('cynthia-sweep-status', async () => {
    const status = await sweepStatus()
    return { ok: true, ...status }
  }, { refuse: REFUSED_SENDER })

  // ── Thin Music Man surfaces ──────────────────────────────────────────

  // One bucket for both doors, 60 calls a minute: a break is one to three calls
  // now, and the per-line fallback (a dozen lines at most) still fits, so all
  // this ever stops is a renderer gone wrong.
  const ttsAllowed = (): boolean => allowWithinRateLimit(ttsRateBucket, 'musicman-speak', 60, 60_000)
  const voiceIsOff = async (): Promise<boolean> => {
    const settings = await host.readAppSettings()
    const ai = (settings?.ai as { musicManVoiceEnabled?: boolean } | undefined)
    return ai?.musicManVoiceEnabled === false
  }

  ipc.handle('musicman-speak', async (_event, text: string, fast?: boolean, voiceId?: string) => {
    if (!ttsAllowed()) {
      return { ok: false, error: 'TTS rate limit — try again in a moment.' }
    }
    const spoken = typeof text === 'string' ? text.slice(0, 4000) : ''
    if (!spoken.trim()) return { ok: true, audio: '' }
    try {
      if (await voiceIsOff()) return { ok: true, audio: '' }
      const voice = voiceId || (host.readActiveHost() === 'larry' ? LARRY_VOICE_ID : musicManVoiceId())
      const audio = fast ? await speakFast(spoken, voice) : await speakText(spoken, voice)
      return { ok: true, audio: audio.toString('base64') }
    } catch (err: unknown) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  // A radio break: one run of host and caller lines as one recording, plus when
  // each line is speaking. A failure here is the renderer's cue to speak the run
  // line by line through musicman-speak.
  ipc.handle('radio-dialogue', async (_event, lines: DialogueInput[]) => {
    if (!ttsAllowed()) {
      return { ok: false, error: 'TTS rate limit — try again in a moment.' }
    }
    const inputs = Array.isArray(lines) ? lines : []
    const valid = inputs.length > 0 && inputs.every((l) => typeof l?.text === 'string' && !!l.text.trim() && typeof l.voiceId === 'string' && !!l.voiceId)
    if (!valid || inputs.reduce((sum, l) => sum + l.text.length, 0) > MAX_DIALOGUE_CHARS) {
      return { ok: false, error: 'invalid-input' }
    }
    try {
      if (await voiceIsOff()) return { ok: true, audio: '' }
      const take = await speakTake(inputs)
      return { ok: true, audio: take.audio.toString('base64'), segments: take.segments }
    } catch (err: unknown) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('get-album-blurb', async (_e, artist: string, album: string, year?: string | number): Promise<{ ok: boolean; blurb?: string; error?: string }> => {
    if (!album) return { ok: true, blurb: '' }
    const yr = year ? String(year).trim() : ''
    const key = albumNotesKey(artist, album, yr)
    const cached = await albumNotesStore().get('blurbs', key)
    if (cached) return { ok: true, blurb: cached }
    try {
      const search = await host.searchWebCached(`${artist} "${album}"${yr ? ` ${yr}` : ''} album`, album).catch(() => '')
      const user = [
        `Write a short, factual history of the album "${album}" by ${artist}${yr ? `, released in ${yr}` : ''}.`,
        yr ? `The release year is ${yr} — anchor on it; never state a different year.` : '',
        'Cover what it is and why it matters: the era/context, its place in the artist\'s career and music history, and what it is best known for.',
        '3-4 sentences. Neutral and encyclopedic — a HISTORY, not a review. Do NOT rate, rank, or editorialize.',
        'CRITICAL — accuracy over detail: only state facts you are certain of. If you do not actually recognize THIS specific album, describe it from the search results + the known year, and do NOT invent a release year, lineup changes, deaths, or events. A brief correct blurb beats a detailed wrong one.',
        'Avoid hyper-specific facts (exact session dates, chart/sales figures). Plain prose only — no markdown — and do not begin by repeating the album title.',
        search ? `\nLive web search results — TREAT AS GROUND TRUTH:\n${search}` : '',
      ].filter(Boolean).join('\n')
      const reply = await host.claudeCall('album-blurb', {
        model: MODEL_SMART,
        max_tokens: 700,
        system: 'You are a precise, neutral music historian. Ground every claim in the provided search results and the known release year. NEVER invent dates, deaths, lineup changes, or events you are not certain of — omit rather than guess. No ratings, rankings, or opinions.',
        messages: [{ role: 'user', content: user }],
      })
      const block = reply.content[0]
      let text = cleanAiProse(block && block.type === 'text' ? block.text : '', album)
      // Out of room → it stopped mid-sentence (Jake 2026-10-30: Perfecth's
      // history ended on "Where). Keep the finished sentences; never cache a
      // cut-off answer.
      const cut = reply.stop_reason === 'max_tokens'
      if (cut) text = wholeSentences(text)
      // A "drawing a blank" answer is never kept: kept, it would hide the
      // history for good; unkept, the next open asks again.
      if (!cut && !isWeakBlurb(text)) void albumNotesStore().set('blurbs', key, text)
      return { ok: true, blurb: text }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('get-album-take', async (_e, artist: string, album: string, year?: string | number): Promise<{ ok: boolean; take?: string; error?: string }> => {
    if (!album) return { ok: true, take: '' }
    const yr = year ? String(year).trim() : ''
    const key = albumNotesKey(artist, album, yr)
    const cached = await albumNotesStore().get('takes', key)
    if (cached) return { ok: true, take: cached }
    try {
      const user = [
        `Give your take on the album "${album}" by ${artist}${yr ? ` (${yr})` : ''}.`,
        yr ? `It's from ${yr} — place it correctly in that era of their run; never treat it as older or newer than it is.` : '',
        '2-3 sentences MAX, in your voice. Focus on the music\'s character and where it sits in the artist\'s run.',
        'Do NOT state hard facts you might be wrong about (specific producers, exact dates, chart/sales numbers) — credits are shown separately. No preamble, no "Ah," — just the take.',
        'Plain prose ONLY — no markdown (no # headings, no *asterisks*, no backticks).',
        'This is read, not spoken: no stage directions or performance tags like [softer] or [laughs].',
      ].filter(Boolean).join('\n')
      const reply = await host.claudeCall('album-take', {
        model: MODEL_FAST,
        max_tokens: 450,
        system: MUSIC_MAN_CORE,
        messages: [{ role: 'user', content: user }],
      })
      const block = reply.content[0]
      let text = cleanAiProse(block && block.type === 'text' ? block.text : '', album)
      // Out of room → it stopped mid-sentence (Jake 2026-10-30: Perfecth's
      // history ended on "Where). Keep the finished sentences; never cache a
      // cut-off answer.
      const cut = reply.stop_reason === 'max_tokens'
      if (cut) text = wholeSentences(text)
      if (!cut && !isWeakBlurb(text)) void albumNotesStore().set('takes', key, text)
      return { ok: true, take: text }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('save-recording-mp3', async (_event, audioBytes: Uint8Array, mimeType: string) => {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const { writeFile: writeF, rename, unlink, mkdir: mkdirP } = await import('fs/promises')
      const { tmpdir } = await import('os')
      const execP = promisify(execFile)

      const home = process.env.HOME || ''
      const recDir = join(home, 'Music', 'JakeTunes Recordings')
      try { await mkdirP(recDir, { recursive: true }) } catch { /* ignore */ }
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`
      const defaultName = `WJLR-${stamp}.mp3`
      const defaultPath = join(recDir, defaultName)

      const win = host.getMainWindow()
      const result = await dialog.showSaveDialog(win!, {
        title: 'Save Radio Recording',
        defaultPath,
        filters: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }

      const outPath = result.filePath
      const srcExt = mimeType.includes('ogg') ? 'ogg' : 'webm'
      const tmpInputPath = join(tmpdir(), `jaketunes-recording-${Date.now()}.${srcExt}`)
      const tmpOutPath = `${outPath}.partial.mp3`
      try {
        await writeF(tmpInputPath, Buffer.from(audioBytes))
        await execP('ffmpeg', [
          '-y',
          '-i', tmpInputPath,
          '-vn',
          '-codec:a', 'libmp3lame',
          '-qscale:a', '2',
          tmpOutPath,
        ], { timeout: 5 * 60 * 1000 })
        await rename(tmpOutPath, outPath)
        try { await unlink(tmpInputPath) } catch { /* ignore */ }
        return { ok: true, path: outPath }
      } catch (err) {
        try { await unlink(tmpInputPath) } catch { /* ignore */ }
        try { await unlink(tmpOutPath) } catch { /* ignore */ }
        throw err
      }
    } catch (err: unknown) {
      const msg = safeIpcError(err, 'api-failed')
      return { ok: false, error: msg }
    }
  }, { refuse: REFUSED_SENDER })
}
