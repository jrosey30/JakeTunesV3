/**
 * Compare editions, action A — the matching-track Gets, as a plan. Pure:
 * turns the comparison into song requests for the ONE scheduler, each
 * pinned to the picked edition's recording identity (title as picked,
 * version markers therefore intact, runtime as picked), skipping owned
 * recordings and every row the judge did not call exact. The jobs carry a
 * group (the refused album request) and NO recommendationIds — landing
 * them can never fulfil the album jot or complete the picked edition.
 */
import type { CompareEditionsResult, TrackRow } from './near-edition-types.ts'

export interface MatchingTrackRequest {
  kind: 'query'
  source: 'qobuz'
  mediaType: 'track'
  id: string
  desc: string
  artist: string
  title: string
  album: string
  durationMs: number | undefined
  releaseYear?: number
  origin: {
    recommendationIds: string[]
    sourceKind?: string
    sourceLabel?: string
    group: { parentKey: string; label: string; of: number; position: number; notAcquired: Array<{ position: number; title: string; reason: string }>; skippedOwned: number; collectionId?: number }
  }
}

export interface MatchingTrackPlan {
  jobs: MatchingTrackRequest[]
  skippedOwned: TrackRow[]
  notAcquired: Array<{ position: number; title: string; reason: string }>
  /** What pressing the button does — exact counts. */
  sentence: string
}

const norm = (s: string): string => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function planMatchingTrackGets(cmp: CompareEditionsResult, ctx: { parentKey: string; artist: string; album: string; releaseYear?: number; sourceKind?: string; sourceLabel?: string }): MatchingTrackPlan {
  const exact = cmp.rows.filter((r) => r.verdict === 'exact')
  const skippedOwned = exact.filter((r) => r.owned)
  const notAcquired = cmp.rows.filter((r) => r.verdict !== 'exact').map((r) => ({ position: r.n, title: r.wantTitle, reason: r.reason ?? 'unknown' }))
  const group = { parentKey: ctx.parentKey, label: `${ctx.album} — ${ctx.artist}`, of: cmp.rows.length, position: 0, notAcquired, skippedOwned: skippedOwned.length, collectionId: cmp.picked.collectionId }
  const jobs: MatchingTrackRequest[] = exact.filter((r) => !r.owned).map((r) => ({
    kind: 'query', source: 'qobuz', mediaType: 'track',
    id: `q|track|${norm(ctx.artist)}|${norm(r.wantTitle)}`,
    desc: `${r.wantTitle} — ${ctx.artist}`,
    artist: ctx.artist, title: r.wantTitle, album: ctx.album,
    durationMs: r.wantSec != null ? Math.round(r.wantSec * 1000) : undefined,
    releaseYear: ctx.releaseYear,
    origin: { recommendationIds: [], sourceKind: ctx.sourceKind, sourceLabel: ctx.sourceLabel, group: { ...group, position: r.n } },
  }))
  const n = jobs.length
  const sentence = n === 0
    ? 'Nothing to acquire: every matching track is already in your library.'
    : `Gets ${n} song${n === 1 ? '' : 's'} now${skippedOwned.length ? ` (${skippedOwned.length} already in your library skipped)` : ''}; ${notAcquired.length} not acquired.`
  return { jobs, skippedOwned, notAcquired, sentence }
}
