/**
 * The device page's sync timeline (Activity Sync front end, 2026-09-06):
 * a pure reduction of the engine's OWN progress events into six named
 * steps and one result line. The engine is untouched — this only reads
 * what it already sends (`sync-progress`: preflight / copy / verify / db /
 * cancelled / error) plus the final result the IPC returns.
 *
 * Verify vs Seal: the engine sends `verify` twice — the cold-remount proof
 * before the catalog and the seal after it. Reaching `db` (Catalog) is what
 * tells them apart.
 */
export type SyncStep = 'prepare' | 'wipe' | 'copy' | 'verify' | 'catalog' | 'seal'
export const SYNC_STEPS: ReadonlyArray<{ id: SyncStep; label: string }> = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'copy', label: 'Copy' },
  { id: 'verify', label: 'Verify' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'seal', label: 'Seal' },
]
const ORDER: Record<SyncStep, number> = { prepare: 0, wipe: 1, copy: 2, verify: 3, catalog: 4, seal: 5 }

export interface SyncEvent { phase: 'preflight' | 'copy' | 'verify' | 'db' | 'cancelled' | 'error'; current: number; total: number; title: string }

export interface SyncResult {
  ok: boolean
  landed?: number
  target?: number
  sealedOk?: boolean
  cancelled?: boolean
  copied?: number
  error?: string
}

export type TimelineStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'failed'

export interface SyncTimeline {
  status: TimelineStatus
  /** The step in progress (running) or the step it stopped at (failed / cancelled). */
  step: SyncStep | null
  reached: SyncStep[]
  current: number
  total: number
  title: string
  startedAt: number | null
  endedAt: number | null
  /** What the run was for (the set's size); the result line compares against it. */
  target: number | null
  landed: number | null
  copied: number | null
  /** The engine's own words, verbatim, for Details. */
  error: string | null
}

export const IDLE_TIMELINE: SyncTimeline = {
  status: 'idle', step: null, reached: [], current: 0, total: 0, title: '', startedAt: null, endedAt: null, target: null, landed: null, copied: null, error: null,
}

export function startTimeline(now: number, target: number | null, title = 'Starting…'): SyncTimeline {
  return { ...IDLE_TIMELINE, status: 'running', step: 'prepare', reached: ['prepare'], startedAt: now, target, title }
}

function stepFor(t: SyncTimeline, e: SyncEvent): SyncStep | null {
  switch (e.phase) {
    case 'preflight': return 'prepare'
    case 'copy': return /^wiping/i.test(e.title) ? 'wipe' : 'copy'
    case 'db': return 'catalog'
    case 'verify': return t.reached.includes('catalog') ? 'seal' : 'verify'
    default: return null
  }
}

function reach(reached: SyncStep[], step: SyncStep): SyncStep[] {
  const out = reached.filter((s) => ORDER[s] <= ORDER[step])
  for (const s of SYNC_STEPS) if (ORDER[s.id] <= ORDER[step] && !out.includes(s.id)) out.push(s.id)
  return out.sort((a, b) => ORDER[a] - ORDER[b])
}

/** Fold one engine event into the timeline. A finished or failed timeline
 *  ignores late events; a running one follows the engine exactly. */
export function reduceSyncEvent(t: SyncTimeline, e: SyncEvent, now: number): SyncTimeline {
  if (t.status === 'idle') t = startTimeline(now, t.target)
  if (t.status !== 'running') return t
  if (e.phase === 'cancelled') {
    return { ...t, status: 'cancelled', endedAt: now, copied: e.current, title: '' }
  }
  if (e.phase === 'error') {
    return { ...t, status: 'failed', endedAt: now, error: e.title || 'Sync failed', title: '' }
  }
  const step = stepFor(t, e)
  if (!step) return t
  return { ...t, step, reached: reach(t.reached, step), current: e.current, total: e.total, title: e.title || '' }
}

/** The IPC's final answer — the only thing allowed to say "done". `landed`
 *  is what the card proved (unmount/remount-verified), never what was sent;
 *  short of target, or an unsealed catalog, is a failure with the engine's
 *  text kept for Details. */
export function applySyncResult(t: SyncTimeline, r: SyncResult, now: number): SyncTimeline {
  const base = t.status === 'idle' ? startTimeline(now, r.target ?? null) : t
  const target = r.target ?? base.target
  if (r.cancelled) return { ...base, status: 'cancelled', endedAt: now, copied: r.copied ?? base.copied, title: '' }
  const landed = r.landed ?? null
  const short = target != null && landed != null && landed < target
  if (!r.ok || short || r.sealedOk === false) {
    const error = r.error || (short ? `Only ${landed} of ${target} songs stuck on the iPod.` : r.sealedOk === false ? 'The catalog was not sealed.' : 'Sync failed')
    return { ...base, status: 'failed', endedAt: now, target, landed, copied: r.copied ?? base.copied, error, title: '' }
  }
  return { ...base, status: 'done', step: 'seal', reached: reach(base.reached, 'seal'), endedAt: now, target, landed: landed ?? target, copied: r.copied ?? base.copied, error: null, title: '' }
}

/** 0–100 across the six steps, with the in-step fraction when the engine gives counts. */
export function timelinePercent(t: SyncTimeline): number {
  if (t.status === 'done') return 100
  if (!t.step) return 0
  const idx = ORDER[t.step]
  const within = t.total > 0 ? Math.min(1, t.current / t.total) : 0
  // Never 100 while still running — the seal step's own count would say so.
  return Math.min(99, Math.round(((idx + within) / SYNC_STEPS.length) * 100))
}

export function stepLabel(step: SyncStep): string { return SYNC_STEPS.find((s) => s.id === step)?.label ?? step }

/** One line, what About will say. */
export function resultLine(t: SyncTimeline, timeLabel: (ms: number) => string): string | null {
  if (t.status !== 'done') return null
  const n = (t.landed ?? t.target ?? 0).toLocaleString()
  const target = t.target != null ? t.target.toLocaleString() : n
  return `Landed ${n} of ${target} — verified on the card${t.endedAt ? `, ${timeLabel(t.endedAt)}` : ''}`
}

export function elapsedLabel(t: SyncTimeline, now: number): string {
  if (!t.startedAt) return ''
  const s = Math.max(0, Math.floor(((t.endedAt ?? now) - t.startedAt) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
