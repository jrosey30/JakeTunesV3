/**
 * The device page's sync timeline store — fed by App's `sync-progress`
 * listener (the engine's own events) and by the device page when the IPC
 * result lands; read by the page's phase strip and result line. Also the
 * fixture harness's door: `ingest` / `finish` drive the same rendering the
 * engine does, so every phase and failure can be verified without an iPod.
 */
import { IDLE_TIMELINE, applySyncResult, reduceSyncEvent, startTimeline, type SyncEvent, type SyncResult, type SyncTimeline } from '../common/sync-progress-model'

let timeline: SyncTimeline = IDLE_TIMELINE
const subs = new Set<() => void>()
const emit = (): void => { for (const f of subs) f() }
export function subscribeSyncTimeline(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } }
export function getSyncTimeline(): SyncTimeline { return timeline }
export function startSyncTimeline(target: number | null, title?: string): void { timeline = startTimeline(Date.now(), target, title); emit() }
export function ingestSyncEvent(e: SyncEvent): void { timeline = reduceSyncEvent(timeline, e, Date.now()); emit() }
export function finishSyncTimeline(r: SyncResult): void { timeline = applySyncResult(timeline, r, Date.now()); emit() }
/** Dismiss a finished / failed / cancelled run (a new attempt replaces it anyway). */
export function clearSyncTimeline(): void { timeline = IDLE_TIMELINE; emit() }

/** Dev-only fixture door (`#deviceFixture`): the device page renders without
 *  an iPod and the timeline is driven by hand. Never true in a packaged build
 *  without the hash, and the sync buttons stay wired to the real IPC. */
export function deviceFixtureRequested(): boolean {
  return typeof window !== 'undefined' && /(^|#|&)deviceFixture(=|&|$)/.test(window.location.hash)
}

/** Eject outcome shown on the device page — from the real IPC result, or from
 *  the harness (Jake: simulate eject failure rather than disrupting a write). */
let ejectFailure: string | null = null
const ejectSubs = new Set<() => void>()
export function subscribeEjectFailure(fn: () => void): () => void { ejectSubs.add(fn); return () => { ejectSubs.delete(fn) } }
export function getEjectFailure(): string | null { return ejectFailure }
export function showEjectFailure(reason: string | null): void { ejectFailure = reason; for (const f of ejectSubs) f() }
