/**
 * The app side of the user-edit journal (2026-10-20): builds
 * user-edits-sync.ts from the app's caches and writers and runs its tick —
 * 60 s after boot, then every 5 minutes. The rules are
 * src/common/user-edits.ts; the wiring and roles are user-edits-sync.ts.
 */
import { STATE_DIR } from '../state-dir'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { getLastSyncSnapshot, triggerSync } from '../sync-orchestrator'
import { quietWarn } from '../flight-recorder'
import { createUserEditsSync, userEditsRole, type UserEditsSync } from '../user-edits-sync.ts'
import type { RowLike } from '../../common/user-edits.ts'
import type { MobileStarsApi } from './mobile-reads-ipc.ts'

export interface UserEditsIpcHost {
  libraryCache: { get: () => Promise<unknown> }
  overridesCache: { get: () => Promise<Record<string, unknown>> }
  stars: () => MobileStarsApi
  /** the app's one override writer (applyMetadataOverrideInternal) */
  applyOverride: (trackId: number, field: string, value: string, fingerprint?: string) => Promise<void>
  send: (channel: string, payload: unknown) => void
  isReplica: () => Promise<boolean>
  isLocked: () => string | null
}

export const USER_EDITS_APPLIED_CHANNEL = 'user-edits-applied'

export function registerUserEdits(host: UserEditsIpcHost): UserEditsSync {
  let rowsKey: unknown = null
  let rowsMap: ReadonlyMap<string, RowLike> = new Map()
  const sync = createUserEditsSync({
    dir: STATE_DIR,
    baseUrl: (() => { try { return new URL(MOBILE_BACKEND_URL).origin } catch { return 'http://homemini:3000' } })(),
    role: async () => userEditsRole({ isReplica: await host.isReplica(), syncScriptPresent: getLastSyncSnapshot().scriptPresent }),
    rows: async () => {
      const lib = await host.libraryCache.get() as { tracks?: Array<RowLike & { id?: unknown }> } | null
      const tracks = lib?.tracks
      if (tracks !== rowsKey) {
        rowsKey = tracks
        const m = new Map<string, RowLike>()
        for (const t of tracks ?? []) if (t && t.id != null) m.set(String(t.id), t)
        rowsMap = m
      }
      return rowsMap
    },
    overrides: () => host.overridesCache.get(),
    stars: () => host.stars().readStarState(),
    isLocked: host.isLocked,
    writeOverride: (id, field, value, fp) => host.applyOverride(id, field, value, fp),
    starAt: (id, starred, at) => host.stars().writeMobileStarSidecar(id, starred, at),
    applied: (updates) => host.send(USER_EDITS_APPLIED_CHANNEL, { updates }),
    publish: () => triggerSync('metadata-edit'),
    warn: (key, msg) => quietWarn(`user-edits-${key}`, msg),
  })
  const tick = () => { sync.tick().catch((err) => quietWarn('user-edits-tick', `[user-edits] tick failed: ${err instanceof Error ? err.message : String(err)}`)) }
  setTimeout(tick, 60_000)
  setInterval(tick, 5 * 60_000)
  return sync
}
