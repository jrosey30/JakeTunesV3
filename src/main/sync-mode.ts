/**
 * Sync-mode decisions for remote conditions (2026-08-22, flight-log stomp,
 * Jake: "stomp the wan full-sync thing too").
 *
 * The situation: when the laptop is away from home, the mount-keeper falls
 * back to mounting the NAS over the tailnet (SMB via a 100.64/10 address).
 * Quick syncs stay viable there — they touch only files modified in the
 * last few minutes. FULL syncs do not: the rsync --delete stat-walk over
 * the 73GB library cannot finish across a WAN link inside the 10-minute
 * kill-timer, so every hourly safety-net run died at the ceiling (8 in one
 * morning's flight log) while producing nothing.
 *
 * Policy encoded here, pure and node-tested:
 *   - A quick-mode request runs as asked, remote or not.
 *   - A full-mode request while the NAS mount is a TAILNET host downgrades
 *     to quick (new imports still propagate remotely!) and the caller
 *     records that a full pass is OWED — the first full sync that succeeds
 *     back on the home network clears the debt. Tombstones and out-of-band
 *     edits wait for home; nothing is lost, and nothing burns 600s to
 *     learn what the mount table already said.
 *
 * Sibling (not twin): platform.ts macNetworkMountSet() parses the same
 * `mount` table to EXCLUDE network mounts from the iPod scan. Same source,
 * different question — this asks WHICH HOST serves a specific volume.
 */

/** Tailscale hands out CGNAT space: 100.64.0.0/10 → 100.64.x – 100.127.x. */
export const TAILNET_HOST_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

/**
 * The host serving `volume` in `mount` output, or null.
 * Line shape: "//user@HOST/Share on /Volumes/Share (smbfs, nodev, ...)".
 */
export function mountHostFor(mountOutput: string, volume: string): string | null {
  for (const line of mountOutput.split('\n')) {
    // Share names may contain spaces ("Other Share"), so the share part is
    // non-greedy and the mount point is anchored to its leading slash.
    const m = line.match(/^\/\/(?:[^@/]*@)?([^/]+)\/.*? on (\/.+?) \(/)
    if (m && m[2].trim() === volume) return m[1]
  }
  return null
}

export function isTailnetHost(host: string | null): boolean {
  return !!host && TAILNET_HOST_RE.test(host)
}

export interface SyncModeDecision {
  quick: boolean
  /** True when a requested FULL pass was downgraded — the caller owes a
   *  full sync once the NAS is reachable at home speed again. */
  downgradedFromFull: boolean
}

export function decideSyncMode(wantQuick: boolean, nasViaTailnet: boolean): SyncModeDecision {
  if (wantQuick) return { quick: true, downgradedFromFull: false }
  if (nasViaTailnet) return { quick: true, downgradedFromFull: true }
  return { quick: false, downgradedFromFull: false }
}
