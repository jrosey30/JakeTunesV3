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
import { differsLine, fmtSec, sourceEditionLabel, type SourceEdition } from './source-edition.ts'

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

/** Action B — the source edition, selected by URL + tracklist snapshot. */
export interface SourceEditionRequest {
  kind: 'query'
  source: 'bandcamp'
  mediaType: 'album'
  id: string
  desc: string
  artist: string
  album: string
  releaseYear?: number
  trackCount: number
  sourceEdition: SourceEdition
  origin: { recommendationIds: string[]; sourceKind?: string; sourceLabel?: string; chosenInsteadOf?: { parentKey: string; label: string } }
}
export interface SourceEditionPlan {
  job: SourceEditionRequest
  /** Shown before confirmation: the identity, the runtime differences, what will be recorded. */
  identityLine: string
  differences: Array<{ position: number; title: string; foundSec: number | null; pickedSec: number | null; line: string }>
  recordedLine: string
  neverLine: string
}

export function planSourceEditionGet(cmp: CompareEditionsResult, ctx: { parentKey: string; artist: string; album: string; sourceKind?: string; sourceLabel?: string }): SourceEditionPlan | { error: string } {
  if (cmp.found.provider !== 'bandcamp') return { error: `Only a Bandcamp edition can be selected by source today (${cmp.found.provider}).` }
  if (!cmp.found.url) return { error: 'This edition has no stable source address to select it by.' }
  const tracks = cmp.rows.map((r) => ({ title: r.gotTitle ?? r.wantTitle, trackNumber: r.n, durationSec: r.gotSec }))
  if (tracks.some((t) => !t.title)) return { error: 'The found tracklist is incomplete; it cannot be selected.' }
  const differences = cmp.rows.filter((r) => r.verdict !== 'exact').map((r) => ({ position: r.n, title: r.wantTitle, foundSec: r.gotSec, pickedSec: r.wantSec, line: `Track ${r.n} “${r.wantTitle}”: ${fmtSec(r.gotSec)} on this edition, ${fmtSec(r.wantSec)} on the one you picked` }))
  const se: SourceEdition = {
    provider: 'bandcamp', url: cmp.found.url, title: ctx.album, artist: ctx.artist, releaseYear: cmp.found.releaseYear, tracks,
    differsFrom: { label: cmp.picked.label, collectionId: cmp.picked.collectionId, tracks: differences.map((d) => ({ position: d.position, title: d.title, foundSec: d.foundSec, pickedSec: d.pickedSec })) },
  }
  const job: SourceEditionRequest = {
    kind: 'query', source: 'bandcamp', mediaType: 'album',
    id: `bc|album|${se.url.replace(/^https?:\/\//, '')}`,
    desc: `${ctx.album} — ${ctx.artist} (Bandcamp edition)`,
    artist: ctx.artist, album: ctx.album, releaseYear: se.releaseYear, trackCount: tracks.length,
    sourceEdition: se,
    origin: { recommendationIds: [], sourceKind: ctx.sourceKind, sourceLabel: ctx.sourceLabel, chosenInsteadOf: { parentKey: ctx.parentKey, label: cmp.picked.label } },
  }
  const d = differsLine(se)
  return {
    job,
    identityLine: `Bandcamp edition — ${sourceEditionLabel(se)}`,
    differences,
    recordedLine: `Recorded as the Bandcamp edition, ${tracks.length} of ${tracks.length}${d ? `; ${d}` : ''}. Verified against this exact tracklist; if the page has changed by then, nothing is imported.`,
    neverLine: `${cmp.picked.label} is not marked as owned by this; the Listen List entry for it is untouched.`,
  }
}
