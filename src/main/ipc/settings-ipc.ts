/**
 * App-settings + inbox IPC.
 *
 * Extracted from main/index.ts. Host supplies the small bits of shared
 * main-process state (active AI host cache) so this module stays free
 * of the mega-file's closures.
 */
import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import {
  startOrReconfigureInboxWatcher,
  deleteInboxSource,
  getDefaultInboxPath,
  type InboxConfig,
} from '../inbox-watcher.ts'

export interface SettingsIpcHost {
  /** Persist + live-apply the AI host preference ('mm' | 'megan'). */
  setCachedActiveHost: (host: 'mm' | 'megan') => void
}

function appSettingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

/**
 * The installed app still reads autoSyncOnConnect from disk. Forcing the
 * flag false only in the load payload left the file true — restart of
 * the old binary repaired the last set and Mini Songs went to 486.
 * Rewrite the file so plug-in cannot start a writer.
 */
export async function persistRetiredIpodWriters(): Promise<void> {
  const path = appSettingsPath()
  try {
    const raw = await readFile(path, 'utf-8')
    const settings = JSON.parse(raw) as Record<string, unknown>
    const sync = (settings.sync && typeof settings.sync === 'object' && !Array.isArray(settings.sync))
      ? { ...(settings.sync as Record<string, unknown>) }
      : {}
    if (sync.autoSyncOnConnect === false && sync.autoRemoveDeletedFromIpod === false) return
    sync.autoSyncOnConnect = false
    sync.autoRemoveDeletedFromIpod = false
    settings.sync = sync
    await writeFile(path, JSON.stringify(settings, null, 2), 'utf-8')
    console.log('[settings] retired iPod auto-sync / auto-remove — wrote false to disk so a restart cannot repair')
  } catch { /* missing file is fine */ }
}

export function registerSettingsIpc(ipc: IpcRegistrar, host: SettingsIpcHost): void {
  void persistRetiredIpodWriters()
  ipc.handle('load-app-settings', async () => {
    try {
      const data = await readFile(appSettingsPath(), 'utf-8')
      const settings = JSON.parse(data) as Record<string, unknown>
      // Never round-trip the Exa secret into the renderer. Report configured
      // status only; a new key can still be typed in Preferences and saved.
      const ai = (settings.ai && typeof settings.ai === 'object' && !Array.isArray(settings.ai))
        ? { ...(settings.ai as Record<string, unknown>) }
        : {}
      const fromSettings = typeof ai.exaApiKey === 'string' && ai.exaApiKey.trim().length > 0
      const fromEnv = !!(process.env.EXA_API_KEY && process.env.EXA_API_KEY.trim())
      delete ai.exaApiKey
      ai.exaConfigured = fromSettings || fromEnv
      settings.ai = ai
      // Activity sets must not be mutated by plug-in repair or delete-sync.
      // 2026-08-15: Mini Songs 500→492 after a "successful" sync while
      // auto-repair / post-pass deletes were still in play.
      const syncIn = (settings.sync && typeof settings.sync === 'object' && !Array.isArray(settings.sync))
        ? { ...(settings.sync as Record<string, unknown>) }
        : {}
      syncIn.autoSyncOnConnect = false
      syncIn.autoRemoveDeletedFromIpod = false
      settings.sync = syncIn
      void persistRetiredIpodWriters()
      return { ok: true, settings }
    } catch {
      return { ok: true, settings: null }   // missing file is fine — renderer applies defaults
    }
  }, { public: true })

  ipc.handle('save-app-settings', async (_e, settings: Record<string, unknown>) => {
    try {
      await mkdir(app.getPath('userData'), { recursive: true })
      // Refresh the cached host preference so subsequent prompt builds
      // pick up the new value without an app restart.
      const aiIn = (settings.ai as { aiHost?: 'mm' | 'megan'; exaApiKey?: string; clearExaKey?: boolean } | undefined)
      host.setCachedActiveHost(aiIn?.aiHost === 'megan' ? 'megan' : 'mm')
      // 4.5: live-apply EXA_API_KEY into process.env so the next searchWeb
      // call picks it up without an app restart. Same value also written
      // to userData/.env so it survives restarts via the existing
      // env-load fallback at the top of index.ts.
      // Only update when the renderer sent a non-empty key (or explicit clear).
      // An empty string after redacted load must NOT wipe a configured key.
      if (typeof aiIn?.exaApiKey === 'string' && aiIn.exaApiKey.trim()) {
        const key = aiIn.exaApiKey.trim()
        process.env.EXA_API_KEY = key
        try {
          const envPath = join(app.getPath('userData'), '.env')
          let existing = ''
          try { existing = await readFile(envPath, 'utf-8') } catch { /* fresh file */ }
          const lines = existing.split('\n').filter(l => !l.startsWith('EXA_API_KEY='))
          lines.push(`EXA_API_KEY=${key}`)
          await writeFile(envPath, lines.filter(l => l.trim()).join('\n') + '\n', 'utf-8')
        } catch (err) {
          console.warn('[save-app-settings] EXA_API_KEY .env write failed:', err)
        }
      } else if (aiIn?.clearExaKey === true) {
        delete process.env.EXA_API_KEY
        try {
          const envPath = join(app.getPath('userData'), '.env')
          let existing = ''
          try { existing = await readFile(envPath, 'utf-8') } catch { /* none */ }
          const lines = existing.split('\n').filter(l => !l.startsWith('EXA_API_KEY='))
          await writeFile(envPath, lines.filter(l => l.trim()).join('\n') + (lines.some(l => l.trim()) ? '\n' : ''), 'utf-8')
        } catch (err) {
          console.warn('[save-app-settings] EXA_API_KEY .env clear failed:', err)
        }
      }
      // Persist settings WITHOUT the secret — .env is the source of truth.
      const toWrite: Record<string, unknown> = { ...settings }
      if (toWrite.ai && typeof toWrite.ai === 'object' && !Array.isArray(toWrite.ai)) {
        const aiOut = { ...(toWrite.ai as Record<string, unknown>) }
        delete aiOut.exaApiKey
        delete aiOut.exaConfigured
        delete aiOut.clearExaKey
        toWrite.ai = aiOut
      }
      toWrite.sync = {
        ...((toWrite.sync && typeof toWrite.sync === 'object' && !Array.isArray(toWrite.sync))
          ? toWrite.sync as Record<string, unknown>
          : {}),
        autoSyncOnConnect: false,
        autoRemoveDeletedFromIpod: false,
      }
      await writeFile(appSettingsPath(), JSON.stringify(toWrite, null, 2), 'utf-8')
      // 4.4.13: reconfigure the inbox watcher on every save. Idempotent
      // when nothing changed; instant pickup of toggle/path edits without
      // an app restart. Errors are non-fatal — the save itself succeeded,
      // so we return ok regardless and log the reconfigure failure.
      try {
        const inboxRaw = settings.inbox as { enabled?: boolean; path?: string } | undefined
        const inboxConfig: InboxConfig = {
          enabled: inboxRaw?.enabled !== false,         // default ON
          path: typeof inboxRaw?.path === 'string' ? inboxRaw.path : '',
        }
        const result = await startOrReconfigureInboxWatcher(inboxConfig)
        if (!result.ok) {
          console.warn('[save-app-settings] inbox watcher reconfigure failed:', result.error)
        }
      } catch (err) {
        console.warn('[save-app-settings] inbox watcher reconfigure threw:', err)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  // 4.4.13 — Renderer's import queue calls this after a successful (or
  // dupe-skipped) import of a file that came from the inbox auto-import.
  // The watcher module path-gates the delete to its own watched directory
  // — even a corrupted/spoofed renderer can't ask main to rm an arbitrary file.
  ipc.handle('delete-inbox-source', async (_e, filePath: string) => {
    return deleteInboxSource(filePath)
  }, { refuse: REFUSED_SENDER })

  // SettingsModal queries this to populate the placeholder for the inbox
  // path input — so users see the resolved ~/Music2/_inbox path even when
  // they haven't picked a custom location yet.
  ipc.handle('get-default-inbox-path', async () => {
    return { ok: true, path: getDefaultInboxPath() }
  }, { public: true })
}
