/**
 * iPod writes are click-only.
 *
 * 2026-08-16: Jake restarted the installed app. Disk still had
 * autoSyncOnConnect: true. Plug-in repaired the last 500-song set
 * without wipeFirst and Mini Songs landed at 486.
 *
 * Main process refuses any sync-to-ipod that is not an explicit
 * Activity Sync or Full Sync click. Renderer regression cannot
 * bring auto-repair back.
 */

export const IPOD_SYNC_ORIGINS = ['activity-click', 'full-library-click'] as const
export type IpodSyncOrigin = (typeof IPOD_SYNC_ORIGINS)[number]

export interface IpodSyncOpts {
  wipeFirst?: boolean
  origin?: string
}

export interface IpodSyncRefused {
  ok: false
  copied: 0
  error: string
}

export function refuseIpodSyncUnlessUserClick(syncOpts?: IpodSyncOpts): IpodSyncRefused | null {
  const origin = syncOpts?.origin
  if (origin !== 'activity-click' && origin !== 'full-library-click') {
    return {
      ok: false,
      copied: 0,
      error: 'iPod writes only happen when you click Activity Sync or Full Sync. Restart and plug-in will not copy, convert, or wipe.',
    }
  }
  if (origin === 'activity-click' && syncOpts?.wipeFirst !== true) {
    return {
      ok: false,
      copied: 0,
      error: 'Activity Sync must wipe and rebuild. Incremental repair is how Songs became 486.',
    }
  }
  if (origin === 'full-library-click' && syncOpts?.wipeFirst === true) {
    return {
      ok: false,
      copied: 0,
      error: 'Full Sync cannot use the activity wipe+rebuild engine.',
    }
  }
  return null
}
