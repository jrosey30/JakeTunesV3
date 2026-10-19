/**
 * One impression per thing per batch per day (2026-10-19). Re-renders and
 * same-day revisits must not inflate the 'shown' count that acceptance
 * divides by. Only 'shown' rows are ever dropped; verdicts always land.
 */
export interface ImpressionLike { surface: string; verdict: string; key?: Record<string, unknown>; ctx?: Record<string, unknown> }

export function makeImpressionDedupe(): (ev: ImpressionLike, nowIso: string) => boolean {
  const seen = new Set<string>()
  let day = ''
  return (ev, nowIso) => {
    if (ev.verdict !== 'shown') return false
    const d = nowIso.slice(0, 10)
    if (d !== day) { day = d; seen.clear() }
    const k = `${ev.surface}|${JSON.stringify(ev.key ?? {})}|${String((ev.ctx ?? {}).batch ?? '')}`
    if (seen.has(k)) return true
    seen.add(k)
    return false
  }
}
