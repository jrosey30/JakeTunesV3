/**
 * AI support IPC: Claude ceiling/stats, radio plan/cast, chat history,
 * Cynthia ledger/findings surface, library-context + radio memory clears.
 *
 * Heavy Music Man bodies (musicman-chat / -radio / -playlist / picks /
 * streaming DJ) and the Cynthia investigation pipeline stay in
 * main/index.ts for this slice — they share persona helpers, RAG, and
 * Claude streaming closures. Prefer extracting those with their helper
 * bundles in a follow-up once deps are injectable.
 */
import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { setShowPlan, clearShowPlan, clearMemory } from '../radio-memory.ts'
import { RADIO_CAST } from '../cast.ts'
import { setLibraryContext } from '../library-digest.ts'
import {
  getFindingsFor,
  dismissFinding,
  getLedger,
  sweepStatus,
} from '../cynthia-sweep.ts'

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
}

function chatHistoryPath(): string {
  return join(app.getPath('userData'), 'chat-history.json')
}

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
    return {
      ok: true,
      cast: RADIO_CAST.map((m) => ({ id: m.id, tag: m.tag, label: m.label, voiceId: m.voiceId, kind: m.kind })),
    }
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
}
