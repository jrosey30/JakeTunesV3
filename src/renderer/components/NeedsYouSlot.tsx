/**
 * The one-tap fix beside a job in Downloads' "Needs you" section (Brief 258).
 *
 * Phase 5 leaves the slot empty. A later phase (Brief 257's closest-edition
 * offer) registers one component here and nothing else in the panel changes:
 *
 *   setNeedsYouFix(MyOffer)   // MyOffer: ({ row, item }) => JSX | null
 *
 * `row.needsYou` says why the job waits (`kind`: 'refused' | 'failed', and the
 * row's one plain `line`); `item` is the queue's own job (its result, outcome,
 * alternatives, and any field that phase put on it). Render null when there
 * is nothing to offer. A field added to a job that must survive a restart is
 * named in `SAVED_FIELDS` (common/download-lanes.ts).
 */
import type { ComponentType } from 'react'
import type { PanelRow } from '../../common/downloads-panel-model'
import type { QItem } from '../views/DownloadStore/downloadQueue'

export interface NeedsYouFixProps { row: PanelRow; item: QItem }

let Fix: ComponentType<NeedsYouFixProps> | null = null
const subs = new Set<() => void>()

export function setNeedsYouFix(c: ComponentType<NeedsYouFixProps> | null): void {
  Fix = c
  for (const f of subs) f()
}
export function subscribeNeedsYouFix(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } }
export function getNeedsYouFix(): ComponentType<NeedsYouFixProps> | null { return Fix }

export default function NeedsYouSlot(props: NeedsYouFixProps & { fix: ComponentType<NeedsYouFixProps> | null }) {
  const { fix: C, ...p } = props
  if (!C || !p.row.needsYou) return null
  return <div className="dlp-needs-you-fix"><C {...p} /></div>
}
