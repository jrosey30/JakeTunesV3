// ════════════════════════════════════════════════════════════════════════
//  Bandcamp session/auth (Brief 036 v2.2, Layer 4)
//
//  Auth is just cookie persistence on the `persist:bandcamp` partition
//  (spike G1 PASS: fan_id recognized across full app restart). No token
//  storage, no Keychain. This module owns the session handle + login-state
//  check + clear-data.
// ════════════════════════════════════════════════════════════════════════

import { session, Session } from 'electron'
import { BANDCAMP_PARTITION } from '../data/scraper'
import { getFanId } from '../data/profile-data'

export function bandcampSession(): Session {
  return session.fromPartition(BANDCAMP_PARTITION)
}

export interface AuthStatus {
  loggedIn: boolean
  fanId?: number
  username?: string
}

/** Cheap-ish auth probe (drives the engine to the bandcamp origin). */
export async function checkAuth(): Promise<AuthStatus> {
  const who = await getFanId()
  return who ? { loggedIn: true, fanId: who.fanId, username: who.username } : { loggedIn: false }
}

/** Logout + "Clear Bandcamp profile data": wipe the partition's cookies +
 *  storage. Profile JSON deletion is handled by profile-store. */
export async function clearSession(): Promise<void> {
  const ses = bandcampSession()
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb', 'serviceworkers'],
  })
}
