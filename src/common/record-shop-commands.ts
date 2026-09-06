/**
 * The Record Shop's commands — the same seven verbs in every presentation
 * (the regular shop and Step Inside), so a display mode can never decide
 * what an item is allowed to do. Main stays the authority for verification
 * and import; a presentation only asks.
 *
 * `shopActions` says which verbs an item offers RIGHT NOW from the model's
 * own facts (kind, selection, ownership, job state) — the regular shop and
 * Step Inside call it with the same inputs and get the same answer.
 */
import type { ShopItem, ShopOwnership, ShopAcquisitionJob, Snapshot } from './record-shop.ts'

export type ShopVerb = 'saveItem' | 'inspectSelection' | 'previewItem' | 'playOwned' | 'getSelection' | 'cancelJob' | 'retryJob' | 'chooseEdition'

export interface ShopCommands {
  saveItem(itemId: string): void
  inspectSelection(itemId: string): void
  previewItem(itemId: string): void
  playOwned(itemId: string): void
  getSelection(itemId: string): void
  cancelJob(jobId: string): void
  retryJob(jobId: string): void
  /** The sources answered and refused every candidate: repeating the same
   *  choice cannot help. This opens catalogue selection for the item. */
  chooseEdition(itemId: string): void
}

export interface ShopActionSet {
  verbs: ShopVerb[]
  /** Why Get is not offered, when it is not. */
  getBlocked?: 'browse-only' | 'select-edition' | 'select-recording' | 'owned' | 'in-flight' | 'refused' | 'retry'
}

/** A verdict that will not change by retrying the same selection. */
export function refusedSelection(job: Snapshot<ShopAcquisitionJob> | undefined): boolean {
  return Boolean(job && job.status === 'failed' && (job.result?.outcome === 'exact-not-found' || job.result?.outcome === 'unverifiable' || job.result?.outcome === 'not-found'))
}

export function shopActions(item: Snapshot<ShopItem>, ownership: Snapshot<ShopOwnership> | undefined, job: Snapshot<ShopAcquisitionJob> | undefined, saved: boolean): ShopActionSet {
  const verbs: ShopVerb[] = []
  if (!saved) verbs.push('saveItem')
  if (item.display.preview) verbs.push('previewItem')
  if (item.kind === 'artist' || item.kind === 'note' || item.kind === 'concert') return { verbs, getBlocked: 'browse-only' }
  verbs.push('inspectSelection')
  if (ownership && ownership.status !== 'unknown' && ownership.owned > 0) verbs.push('playOwned')
  if (job && (job.status === 'queued' || job.status === 'downloading')) { verbs.push('cancelJob'); return { verbs, getBlocked: 'in-flight' } }
  // Refused by the sources (exact version / edition not found, unverifiable,
  // nothing found): Retry and Get would repeat the refused choice, so the
  // item offers Details and a new selection instead.
  if (refusedSelection(job)) { verbs.push('chooseEdition'); return { verbs, getBlocked: 'refused' } }
  // A stalled or canceled job keeps its selection: Retry IS the acquisition
  // action, so Get is not offered beside it.
  if (job && (job.status === 'failed' || job.status === 'canceled')) { verbs.push('retryJob'); return { verbs, getBlocked: 'retry' } }
  // Nothing chosen yet: the way forward is to choose, in the catalogue.
  if (!item.selection) { verbs.push('chooseEdition'); return { verbs, getBlocked: item.kind === 'release' ? 'select-edition' : 'select-recording' } }
  if (ownership && ownership.status === 'complete') return { verbs, getBlocked: 'owned' }
  verbs.push('getSelection')
  return { verbs }
}

export interface ShopCommandCall { verb: ShopVerb; id: string; at: number }

/** A prototype implementation: records every call and does nothing else.
 *  The live wiring replaces it with the queue, the preview player and
 *  playback; the presentations do not change. */
export function recordingShopCommands(onCall?: (c: ShopCommandCall) => void): ShopCommands & { calls: ShopCommandCall[] } {
  const calls: ShopCommandCall[] = []
  const rec = (verb: ShopVerb) => (id: string): void => { const c = { verb, id, at: Date.now() }; calls.push(c); onCall?.(c) }
  return {
    calls,
    saveItem: rec('saveItem'), inspectSelection: rec('inspectSelection'), previewItem: rec('previewItem'), playOwned: rec('playOwned'),
    getSelection: rec('getSelection'), cancelJob: rec('cancelJob'), retryJob: rec('retryJob'), chooseEdition: rec('chooseEdition'),
  }
}

/** Presentation-neutral wording for the model's facts — one vocabulary. */
export function ownershipLabel(o: Snapshot<ShopOwnership> | undefined): string {
  if (!o || o.status === 'unknown') return 'Ownership unknown'
  if (o.status === 'complete') return o.expected === 1 ? 'In your library' : `All ${o.expected} in your library`
  if (o.status === 'partial') return `${o.owned} of ${o.expected} in your library`
  return o.expected === 1 ? 'Not in your library' : `None of ${o.expected} in your library`
}

export function editionLabel(item: Snapshot<ShopItem>): string | null {
  if (item.kind === 'release' && item.selection) {
    const r = item.selection.request
    const bits = [r.packaging.length ? r.packaging.join(' · ') : 'standard', r.trackCount ? `${r.trackCount} tracks` : null, r.discCount && r.discCount > 1 ? `${r.discCount} discs` : null, r.releaseYear ? String(r.releaseYear) : null].filter(Boolean)
    return bits.join(' · ')
  }
  if (item.kind === 'recording' && item.selection) {
    const r = item.selection.request
    const m = Math.floor(r.durationSec / 60), s = String(Math.round(r.durationSec % 60)).padStart(2, '0')
    return [r.album || null, r.durationSec ? `${m}:${s}` : null, r.releaseYear ? String(r.releaseYear) : null].filter(Boolean).join(' · ')
  }
  if (item.kind === 'release') return 'No edition selected yet'
  if (item.kind === 'recording') return 'No recording selected yet'
  return null
}

export function jobLabel(job: Snapshot<ShopAcquisitionJob> | undefined): string | null {
  if (!job) return null
  switch (job.status) {
    case 'queued': return 'Queued'
    case 'downloading': return 'Getting…'
    case 'canceled': return 'Canceled'
    case 'done': return job.result?.completion || (job.result?.imported ? `Imported ${job.result.imported}` : 'In your library')
    case 'failed': return job.result?.primary || 'Failed'
  }
}
