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
 * On-link isn't home until the address answers. A hotel or a friend's network numbered
 * 192.168.1.x, a very common default, gives the same route with no gateway, and on it the
 * app stated the share again. So on-link gets one ping, a second at most, cached with the route.
 * That state is said out loud, once per change: if something ever stopped ping at home (macOS
 * Local Network privacy can refuse what an app spawns), the Mac would read as away for good.
 * The NAS's name gets the same ping when the address is silent: it takes DHCP, so a new lease at
 * home leaves the address on-link and silent, and that read as away with the NAS right there.
 * A foreign network has no ds225.local to answer. A NAS that is simply down still reads as away,
 * and JakeTunesMobile's job says so (deploy/macbook-nas-sync.sh), because it can see homemini.
 *
 * A failed or empty read says nothing, so the last answer stands. Real `route -n get` with
 * no route prints nothing and exits 0 (measured), so the test is the interface line, not null.
 * A wake on the road before Wi-Fi is back landed there, and read as home for 30 s: one stat,
 * "NAS recovered", and the kick. With no earlier answer, the caller goes on as if this check
 * did not exist.
 *
 * ⚠️ TWIN: Dr. Claude/scripts/jaketunes-homemini-sync.sh share_is_away() and
 * JakeTunesMobile deploy/lib/mini-endpoint.sh mini_home_proof(), the same rule in bash.
 */
import { execFile } from 'child_process'

/** The DS225 on the home LAN. ⚠️ TWIN: NAS_LAN_IP in the sync script. */
export const NAS_LAN_IP = '192.168.1.223'
/** Its mDNS name, lan_ds225_host's first step in the sync script. */
export const NAS_LAN_NAME = 'ds225.local'
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

function pingOnce(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/sbin/ping', ['-c1', '-t1', host], { timeout: 3000 }, (err) => resolve(!err))
  })
}

/** One ping of the NAS's LAN address, then its name. False on no answer, and on anything stopping ping. */
export async function pingNas(ping: (host: string) => Promise<boolean> = pingOnce): Promise<boolean> {
  return (await ping(NAS_LAN_IP)) || ping(NAS_LAN_NAME)
}

export function createAwayCheck(deps: {
  readRoute: () => Promise<string | null>
  ping: () => Promise<boolean>
  now?: () => number
  cacheMs?: number
  log?: (message: string) => void
}): () => Promise<boolean> {
  const now = deps.now ?? Date.now
  const cacheMs = deps.cacheMs ?? AWAY_CACHE_MS
  const log = deps.log ?? ((m: string) => console.warn(m))
  let cached: { at: number; away: boolean } | null = null
  let inflight: Promise<boolean> | null = null
  let silent = false
  const noteSilent = (nowSilent: boolean): void => {
    if (nowSilent === silent) return
    silent = nowSilent
    log(nowSilent
      ? `[nas-route] on-link, no answer: ${NAS_LAN_IP} is on this Mac's subnet and neither it nor ${NAS_LAN_NAME} answered ping — treating this as away. On the home network this is wrong: look at ping first`
      : '[nas-route] on-link, no answer: over')
  }
  const look = async (): Promise<boolean> => {
    const out = await deps.readRoute().catch(() => null)
    if (out === null || !/^\s*interface:/m.test(out)) return cached?.away ?? false
    if (routeShowsGateway(out)) {
      noteSilent(false)
      return true
    }
    const answered = await deps.ping().catch(() => false)
    noteSilent(!answered)
    return !answered
  }
  return async () => {
    if (cached && now() - cached.at < cacheMs) return cached.away
    if (inflight) return inflight
    inflight = look()
      .then((away) => {
        cached = { at: now(), away }
        inflight = null
        return away
      })
    return inflight
  }
}
