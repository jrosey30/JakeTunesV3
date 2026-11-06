/**
 * Is this Mac away from home? (2026-11-06, the away-from-home audit)
 *
 * Away, the NAS mount rides the tailnet, and every SMB call on it shares one TCP
 * connection with whatever bulk flow is running: a stat can wait 10 s behind it,
 * and a 13 MB state write took 11 minutes to leave the kernel after the app was
 * gone (the 21-minute quit, 11/5). The breaker only asks "was that slow?", so an
 * idle share passes, the app starts a backup, the backup slows the share, and the
 * breaker trips again. The mount table can't settle it either: a tailnet mount
 * left over at home reads as away, and the flip back to the LAN path would never run.
 *
 * So ask the route. `route -n get <the NAS's LAN address>` prints a `gateway:` line
 * only when the packet would leave the LAN. It touches nothing on the share and
 * can't hang on it. Cached, because the app asks every few seconds.
 *
 * Only a route that answers with an interface and a gateway says "away". A failed
 * read says nothing, and the caller goes on as if this check did not exist.
 *
 * ⚠️ TWIN: Dr. Claude/scripts/jaketunes-homemini-sync.sh share_is_away() and
 * JakeTunesMobile deploy/lib/mini-endpoint.sh mini_has_gateway(), the same rule in bash.
 */
import { execFile } from 'child_process'

/** The DS225 on the home LAN. ⚠️ TWIN: NAS_LAN_IP in the sync script. */
export const NAS_LAN_IP = '192.168.1.223'
export const AWAY_CACHE_MS = 30_000

export function routeShowsGateway(routeOutput: string): boolean {
  return /^\s*interface:/m.test(routeOutput) && /^\s*gateway:/m.test(routeOutput)
}

/** The output of `route -n get`, or null when it could not be read. */
export function readNasRoute(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/sbin/route', ['-n', 'get', NAS_LAN_IP], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

export function createAwayCheck(deps: {
  readRoute: () => Promise<string | null>
  now?: () => number
  cacheMs?: number
}): () => Promise<boolean> {
  const now = deps.now ?? Date.now
  const cacheMs = deps.cacheMs ?? AWAY_CACHE_MS
  let cached: { at: number; away: boolean } | null = null
  let inflight: Promise<boolean> | null = null
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.away
    if (inflight) return inflight
    inflight = deps.readRoute()
      .then((out) => out !== null && routeShowsGateway(out), () => false)
      .then((away) => {
        cached = { at: now(), away }
        inflight = null
        return away
      })
    return inflight
  }
}
