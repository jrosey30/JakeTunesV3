/**
 * The NAS circuit breaker (2026-07-08, "figure it the fuck out"), lifted out of
 * state-dir.ts so it can run under test: state-dir asks electron for userData and
 * names the real mount.
 *
 * The old isNasMounted() was a SYNCHRONOUS existsSync on the SMB mount — a
 * stale Synology share turns any sync fs call into a seconds-long
 * MAIN-PROCESS block, and even async SMB calls park libuv threadpool
 * threads until the SMB timeout, starving every other fs op in the app.
 * Jake's old laptop ran a LOCAL-ONLY library and "rarely froze"; this
 * machine's NAS-touching timers are the difference. The breaker makes the
 * app immune to a flaky share: one 2s-timeout probe decides, a slow/absent
 * NAS opens the breaker and ALL NAS IO is skipped for 5 minutes.
 *
 * Away from home (2026-11-06): no probe at all, see nasAvailable below.
 */

// Flap damping (same day, four transitions in 30 min on a marginal WAN
// link): a failure RIGHT AFTER a recovery earns a longer cooldown — the
// link is oscillating around the probe threshold and rapid retries just
// churn state. A failure after a LONG healthy stretch keeps the quick
// 5-min retry, so genuinely-good windows are still harvested promptly
// (the 17:58Z quick pass that healed nine stranded tracks rode exactly
// such a window — never damp those).
const FLAP_WINDOW_MS = 10 * 60_000
const COOLDOWN_MS = 5 * 60_000
const FLAP_COOLDOWN_MS = 15 * 60_000
// While the breaker is open, look again this often — cheap enough to be
// invisible, frequent enough that recovery is felt in a minute, not fifteen.
const HALF_OPEN_PROBE_MS = 60_000
const VERDICT_CACHE_MS = 30_000
const PROBE_TIMEOUT_MS = 2000

export interface NasBreaker {
  nasAvailable(): Promise<boolean>
  /** Last KNOWN verdict — never touches the filesystem. Kept for sync
   *  contexts (UI badges); authoritative checks use nasAvailable(). */
  isNasMounted(): boolean
  onNasRecovery(fn: () => void): void
}

export function createNasBreaker(deps: {
  /** One stat of the NAS. Rejecting, or not answering in time, means no. */
  probe: () => Promise<unknown>
  /** Is this Mac proven away from home? (nas-route.ts) */
  isAway: () => Promise<boolean>
  now?: () => number
  warn?: (message: string) => void
  probeTimeoutMs?: number
}): NasBreaker {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  let nasBreakerUntil = 0
  let lastVerdict = false
  let lastProbeAt = 0
  let probeInflight: Promise<boolean> | null = null
  // Transition-once logging (2026-08-22 flight-log stomp): a sustained
  // remote-mode episode used to re-warn on EVERY re-trip (~every 6 min,
  // all day when the laptop is away). One warn when the breaker OPENS,
  // one when the NAS comes back; the episode in between stays quiet.
  let breakerEpisodeOpen = false
  let lastRecoveryAt = 0
  // Recovery kick (2026-08-22): a good window on a marginal link may only
  // last minutes — waiting for the next hourly tick wastes it (the 17:58Z
  // harvest that healed nine stranded tracks was pure timing luck). The
  // orchestrator registers here; recovery fires it. Layering: state-dir
  // must not import the orchestrator, so this is a callback seam.
  let nasRecoveryListener: (() => void) | null = null

  async function nasAvailable(): Promise<boolean> {
    // No SMB when away (2026-11-06). Not a probe, not a stat: nas-route.ts says this
    // Mac isn't on the NAS's LAN, so the answer is no until home. The
    // episode stays open, so the first good probe back home is a recovery and
    // fires the kick, and that sync is what moves a tailnet mount back to the LAN.
    if (await deps.isAway()) {
      lastVerdict = false
      if (!breakerEpisodeOpen) {
        breakerEpisodeOpen = true
        warn('[nas-breaker] away from home (the NAS\'s LAN address is behind a gateway, or on-link and not answering) — no NAS IO until home; will report recovery')
      }
      return false
    }
    const at = now()
    // HALF-OPEN (2026-08-25). A cooldown used to return false WITHOUT looking, so
    // a NAS that came back after 30 seconds still had every write refused for the
    // full 15 minutes — and Jake watched "Couldn't sync to homemini: NAS
    // unavailable (breaker cooldown)" on a NAS that was demonstrably up (a manual
    // sync ran clean while the banner was showing). The probe is ONE stat with a
    // 2s timeout; that is not the hammering a breaker exists to prevent. So while
    // cooling down, retry once a minute and close the moment it answers.
    if (at < nasBreakerUntil && at - lastProbeAt < HALF_OPEN_PROBE_MS) return false
    if (at >= nasBreakerUntil && at - lastProbeAt < VERDICT_CACHE_MS) return lastVerdict   // verdict cache
    if (probeInflight) return probeInflight
    probeInflight = (async () => {
      try {
        const ok = await Promise.race([
          deps.probe().then(() => true, () => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), probeTimeoutMs)),
        ])
        lastVerdict = ok
        lastProbeAt = now()
        if (!ok) {
          const flapping = lastRecoveryAt > 0 && now() - lastRecoveryAt < FLAP_WINDOW_MS
          nasBreakerUntil = now() + (flapping ? FLAP_COOLDOWN_MS : COOLDOWN_MS)
          if (!breakerEpisodeOpen) {
            breakerEpisodeOpen = true
            warn(`[nas-breaker] NAS slow or absent — skipping ALL NAS IO (${flapping ? '15-min cooldown, link is flapping' : '5-min cooldowns'}; will report recovery)`)
          }
        } else if (breakerEpisodeOpen) {
          breakerEpisodeOpen = false
          nasBreakerUntil = 0          // half-open probe succeeded: stop refusing NOW
          lastRecoveryAt = now()
          warn('[nas-breaker] NAS recovered — resuming NAS IO')
          try { nasRecoveryListener?.() } catch (err) { console.warn('[nas-breaker] recovery listener threw:', err) }
        }
        return ok
      } finally {
        probeInflight = null
      }
    })()
    return probeInflight
  }

  return {
    nasAvailable,
    isNasMounted: () => (now() < nasBreakerUntil ? false : lastVerdict),
    onNasRecovery: (fn) => { nasRecoveryListener = fn },
  }
}
