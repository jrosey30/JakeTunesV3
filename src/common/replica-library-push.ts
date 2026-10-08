/**
 * Who may publish library.json.
 *
 * A replica (workmini: streamSource homemini, or library.streamRoot set —
 * the same test as src/main/stream-playback.ts isHomeminiPlaybackClient)
 * adopts the catalog FROM the hub. It is not a source of truth. Writing
 * its library.json onto the NAS is how a song Jake deleted comes back:
 * the phone reads that NAS copy. Publishing it to the hub does the same
 * thing one step earlier.
 *
 * The stale-push guard (src/common/stale-push.ts) does not stop this.
 * It refuses a machine that is MISSING songs the destination has. A
 * replica that still holds a deleted song is a superset of older ids,
 * and that guard treats a superset as up to date and lets it push.
 * So a replica does not push library.json at all.
 *
 * The canonical laptop is unchanged: it publishes to the NAS and the hub.
 */

export interface LibraryPublishTargets {
  nas: boolean
  hub: boolean
}

export function libraryPublishTargets(isReplica: boolean): LibraryPublishTargets {
  if (isReplica) return { nas: false, hub: false }
  return { nas: true, hub: true }
}

/** Ids a save will actually publish. Empty on a replica, even if the
 *  in-memory library still contains songs the hub has dropped. */
export function idsPushedBySave(opts: {
  isReplica: boolean
  trackIds: Array<string | number>
}): { nas: string[]; hub: string[] } {
  const targets = libraryPublishTargets(opts.isReplica)
  const ids = opts.trackIds.map(String)
  return {
    nas: targets.nas ? ids : [],
    hub: targets.hub ? ids : [],
  }
}
