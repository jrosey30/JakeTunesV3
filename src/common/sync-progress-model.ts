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
  // Plain words (Jake, 2026-11-19). The ids stay the engine's.
  { id: 'prepare', label: 'Get ready' },
  { id: 'wipe', label: 'Clear' },
  { id: 'copy', label: 'Copy' },
  { id: 'verify', label: 'Check' },
  { id: 'catalog', label: 'Song list' },
  { id: 'seal', label: 'Finish' },
]
const ORDER: Record<SyncStep, number> = { prepare: 0, wipe: 1, copy: 2, verify: 3, catalog: 4, seal: 5 }

export interface SyncEvent {
  phase: 'preflight' | 'copy' | 'verify' | 'db' | 'cancelled' | 'error'
  current: number
  total: number
  title: string
  /** The engine's decision (2026-11-07): 'swap' moves only what changes, and
   *  its Wipe step is the removal of the songs leaving ("Remove"). */
  mode?: 'swap' | 'full'
  /** The engine's own result line ("Swapped 7 songs: 7 out, 7 in. 993 stayed."). */
  summary?: string
}

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
  /** How many engine events this run has seen — zero means no phase evidence. */
  seen: number
  /** A swap run: only the songs that change move; Wipe reads "Remove". */
  swap: boolean
  /** The engine's own result line, when it sent one. */
  summary: string | null
}

export const IDLE_TIMELINE: SyncTimeline = {
  status: 'idle', step: null, reached: [], current: 0, total: 0, title: '', startedAt: null, endedAt: null, target: null, landed: null, copied: null, error: null, seen: 0,
  swap: false, summary: null,
}

export function startTimeline(now: number, target: number | null, title = 'Starting…'): SyncTimeline {
  return { ...IDLE_TIMELINE, status: 'running', step: 'prepare', reached: ['prepare'], startedAt: now, target, title, seen: 0 }
}

function stepFor(t: SyncTimeline, e: SyncEvent): SyncStep | null {
  switch (e.phase) {
    case 'preflight': return 'prepare'
    case 'copy': return /^(wiping|removing)/i.test(e.title) ? 'wipe' : 'copy'
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
  t = { ...t, seen: t.seen + 1 }
  if (e.mode) t = { ...t, swap: e.mode === 'swap' }
  if (e.summary) t = { ...t, summary: e.summary }
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

/** A sync the page saw finish clean, as the timeline's result. The engine's
 *  own target wins over the count the timeline was started with: a list-only
 *  iPod's engine can leave a song off by design (homemini couldn't send it,
 *  #371) and seal one fewer, and that is a success, not a short seal
 *  (punkPod, 2026-11-07: 850 of 851 sealed, shown as "Stopped at Seal").
 *  A card that drops writes still fails: landed under the ENGINE's target. */
export function finishedSyncResult(done: { copied: number; total: number; target?: number }, startedTarget: number | null): SyncResult {
  return { ok: true, landed: done.total, target: done.target ?? startedTarget ?? done.total, copied: done.copied, sealedOk: true }
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

/** A swap's Wipe step only removes the songs leaving, so it reads "Remove". */
export function stepLabel(step: SyncStep, t?: Pick<SyncTimeline, 'swap'> | null): string {
  if (step === 'wipe' && t?.swap) return 'Remove'
  return SYNC_STEPS.find((s) => s.id === step)?.label ?? step
}

/** One line, and what About will say (Jake, 2026-11-19: "it needs to be simple").
 *  Only a clean sync gets here (status 'done' = every song landed and the card proved it);
 *  the engine's swap/full summary stays in its log. */
export function resultLine(t: SyncTimeline, _timeLabel?: (ms: number) => string): string | null {
  if (t.status !== 'done') return null
  const count = t.landed ?? t.target ?? 0
  const n = count.toLocaleString('en-US')
  return `Synced ${n} ${count === 1 ? 'song' : 'songs'}. On the iPod, Settings › About should say ${n}.`
}

/**
 * The engine's progress title, only when it is a song's name (the Copy step names the song
 * going on). Its working sentences ("Wiping the iPod for a clean rebuild…", "TSA — inspecting…",
 * "Writing iTunesDB...") are never shown (Jake, 2026-11-19: "it needs to be simple").
 */
export function songTitleOnly(step: SyncStep | null, title: string | null | undefined): string {
  const t = String(title || '').trim()
  if (step !== 'copy' || !t) return ''
  if (/(…|\.\.\.)$/.test(t) || /^(wiping|removing|converting|putting|writing|checking|swapping|full copy)\b/i.test(t) || /—|→/.test(t)) return ''
  return t
}

export function elapsedLabel(t: SyncTimeline, now: number): string {
  if (!t.startedAt) return ''
  const s = Math.max(0, Math.floor(((t.endedAt ?? now) - t.startedAt) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The header's claim about the card. "On the iPod" only when the newest
 *  recorded sync sealed its full set AND no attempt since has ended
 *  uncertain; otherwise the count is only what the LAST SYNC put on. */
export function ipodCountLabel(latest: { landed?: number; target?: number; sealedOk?: boolean; aborted?: boolean } | null, timelineStatus: TimelineStatus): 'On the iPod' | 'Last sync' | null {
  // An aborted sync's count is not what went on (the card may have been emptied again): no count.
  if (!latest || latest.landed == null || latest.aborted) return null
  const clean = latest.sealedOk !== false && !latest.aborted && (latest.target == null || latest.landed >= latest.target)
  if (!clean) return 'Last sync'
  if (timelineStatus === 'failed' || timelineStatus === 'cancelled' || timelineStatus === 'running') return 'Last sync'
  return 'On the iPod'
}
