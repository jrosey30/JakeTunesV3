/** Shared shapes for Compare editions (the read-only near-edition comparison). */
import type { AlternativeTrack } from './acquisition-identity.ts'

export type TrackVerdict = 'exact' | 'mismatch' | 'unknown'
export interface TrackRow {
  n: number
  wantTitle: string
  gotTitle: string | null
  wantSec: number | null
  gotSec: number | null
  deltaSec: number | null
  verdict: TrackVerdict
  /** The judge's own words for a mismatch; "runtime mismatch" is the label. */
  reason: string | null
  /** The library already holds this recording (by recording identity) — action A skips it. */
  owned: boolean
}
export interface NearEditionSummary {
  total: number
  exact: number
  mismatch: number
  unknown: number
  /** Exact rows the library already holds — skipped by action A. */
  owned: number
  /** Exact rows action A would acquire (exact − owned). */
  toAcquire: number
  differing: Array<{ n: number; title: string; wantSec: number | null; gotSec: number | null; reason: string }>
  /** What action A would acquire and how it is recorded. */
  matchingSentence: string
  /** What action B would acquire and how it is recorded. */
  editionSentence: string
}
export interface CompareEditionsRequest {
  artist: string
  album: string
  collectionId?: number
  trackCount?: number
  releaseYear?: number
  candidate: { provider: string; desc: string; url?: string; tracks?: AlternativeTrack[]; releaseYear?: number }
}
export interface CompareEditionsResult {
  ok: true
  picked: { label: string; trackCount: number; releaseYear?: number; collectionId?: number }
  found: { provider: string; label: string; source: string; url?: string; trackCount: number; releaseYear?: number }
  rows: TrackRow[]
  summary: NearEditionSummary
  toleranceSec: number
}
