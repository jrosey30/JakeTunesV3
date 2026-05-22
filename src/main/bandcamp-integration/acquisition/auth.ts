// Bandcamp session helpers. v4 keeps two:
//  - bandcampSession() — used by index.ts to attach download interception
//    to the same cookie jar as the embedded WebContentsView
//  - clearSession() — wipes the partition's storage. Not currently wired
//    to UI; preserved against future "Clear Bandcamp data" affordances.
//
// The pre-v4 checkAuth / getFanId path is gone: v4 lets Bandcamp's own
// embedded UI carry auth state. The caches->cachestorage fix from v3
// Phase B is preserved (Brief 036 v4 §6).

import { session, Session } from 'electron'
import { BANDCAMP_PARTITION } from '../partition'

export function bandcampSession(): Session {
  return session.fromPartition(BANDCAMP_PARTITION)
}

export async function clearSession(): Promise<void> {
  const ses = bandcampSession()
  await ses.clearStorageData({
    storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb', 'serviceworkers'],
  })
}
