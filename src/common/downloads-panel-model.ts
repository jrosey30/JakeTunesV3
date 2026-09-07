/**
 * Downloads panel — what the compact, global activity panel shows for each
 * job on the ONE scheduler, derived from the scheduler's own entries. Pure,
 * so the rows are testable and the panel is only a renderer of them.
 *
 * Preserved from the queue entry: provenance (who recommended it), the
 * edition identity Jake chose (collection id, count, year), the structured
 * result (counts, completion line, verdict, alternatives). A refused
 * verdict (exact-not-found / unverifiable / not-found) offers a NEW choice,
 * never a repeat of the refused one — the same rule as the Counter.
 */
import { jobFromQueueItem, liveItemId, type QueueItemLike } from './record-shop-live.ts'
import { refusedSelection } from './record-shop-commands.ts'
import type { ShopItem, Snapshot } from './record-shop.ts'
import { nearEditionOf } from './near-edition-detect.ts'
import type { Alternative } from './acquisition-identity.ts'

export type PanelStatus = 'downloading' | 'queued' | 'done' | 'failed' | 'refused' | 'canceled'
export type PanelAction = 'cancel' | 'retry' | 'chooseEdition' | 'chooseVersion' | 'compareEditions'

export interface PanelRow {
  key: string
  status: PanelStatus
  kind: 'album' | 'song' | 'link'
  title: string
  artist: string | null
  /** Edition identity: "album · 12 tracks · 1980 · iTunes 124906778". */
  edition: string | null
  /** Provenance: "from Alex", "from your Listen List", "pasted link". */
  from: string | null
  /** "10 imported · 2 already in your library" (done). */
  counts: string | null
  /** main's completion line or match description (done). */
  completion: string | null
  /** Short verdict + full explanation (failed / refused). */
  primary: string | null
  detail: string | null
  alternatives: ReadonlyArray<{ provider: string; desc: string; reason: string }>
  /** A refused edition that is the same record with a tracklist difference — Compare editions can lay it beside the picked one. */
  nearEdition: Alternative | null
  actions: PanelAction[]
  /** Seconds in flight (downloading) — the caller supplies `now`. */
  elapsedSec: number | null
  /** What to search for when choosing again (refused rows). */
  choose: { query: string; kind: 'album' | 'song'; artist: string; title: string } | null
}

export interface PanelSummary { active: number; queued: number; done: number; failed: number; canceled: number }

const STATUS_ORDER: Record<PanelStatus, number> = { downloading: 0, queued: 1, refused: 2, failed: 2, canceled: 3, done: 4 }

function editionOf(r: QueueItemLike['result']): string | null {
  if (r.kind !== 'query') return null
  const facts = [r.trackCount ? `${r.trackCount} tracks` : null, r.releaseYear ? String(r.releaseYear) : null, r.collectionId ? `iTunes ${r.collectionId}` : null].filter(Boolean)
  // The kind alone is not an edition — a bare song row shows nothing here.
  if (!facts.length) return null
  return [r.mediaType === 'album' ? 'album' : 'song', ...facts].join(' · ')
}

function provenanceOf(q: QueueItemLike): string | null {
  const o = q.result.origin
  if (q.result.kind !== 'query') return 'pasted link'
  if (!o) return null
  if (o.sourceLabel) return `from ${o.sourceLabel}`
  if (o.recommendationIds.length) return 'from your Listen List'
  return null
}

export function panelRowFor(q: QueueItemLike, now: number): PanelRow {
  const r = q.result
  const kind: PanelRow['kind'] = r.kind !== 'query' ? 'link' : r.mediaType === 'album' ? 'album' : 'song'
  const artist = (r.artist || '').trim() || null
  const title = kind === 'album' ? (r.album || r.desc) : kind === 'song' ? (r.title || r.desc) : r.desc
  // The Counter's refusal rule, through the same job projection.
  const syntheticItem = {
    itemId: r.origin?.entryId ? liveItemId(r.origin.entryId) : `queue:${q.key}`,
    kind: kind === 'album' ? 'release' : 'recording',
    display: { title, artist: artist ?? undefined },
  } as unknown as Snapshot<ShopItem>
  const job = jobFromQueueItem(q, syntheticItem, r.origin?.entryId ?? q.key, new Date(now).toISOString())
  const refused = q.status === 'failed' && refusedSelection(job)
  const status: PanelStatus = refused ? 'refused' : q.status
  const actions: PanelAction[] = []
  if (status === 'downloading' || status === 'queued') actions.push('cancel')
  else if (status === 'failed' || status === 'canceled') actions.push('retry')
  else if (status === 'refused') actions.push(kind === 'album' ? 'chooseEdition' : 'chooseVersion')
  const nearEdition = status === 'refused' && kind === 'album' && q.outcome === 'exact-not-found' ? nearEditionOf(q.alternatives as Alternative[] | undefined, r.trackCount ?? null) : null
  if (nearEdition) actions.push('compareEditions')
  const counts = status === 'done' ? `${q.imported ?? 0} imported · ${q.dupes ?? 0} already in your library` : null
  const chooseTitle = kind === 'album' ? (r.album || '') : (r.title || '')
  return {
    key: q.key, status, kind, title, artist,
    edition: editionOf(r),
    from: provenanceOf(q),
    counts,
    completion: status === 'done' ? (q.completion || q.matchDesc || null) : null,
    primary: status === 'failed' || status === 'refused' ? (q.primary || q.error || 'Download failed') : null,
    detail: status === 'failed' || status === 'refused' ? (q.detail || q.error || null) : null,
    alternatives: q.alternatives ?? [],
    nearEdition,
    actions,
    elapsedSec: status === 'downloading' && q.startedAt ? Math.max(0, Math.floor((now - q.startedAt) / 1000)) : null,
    choose: status === 'refused' && artist && chooseTitle ? { query: `${artist} ${chooseTitle}`.trim(), kind: kind === 'album' ? 'album' : 'song', artist, title: chooseTitle } : null,
  }
}

/** In-flight first, then what needs a decision, then what's finished — newest first within a group. */
export function downloadsPanelRows(queue: readonly QueueItemLike[], now: number): PanelRow[] {
  const rows = queue.map((q) => ({ row: panelRowFor(q, now), t: q.endedAt ?? q.startedAt ?? 0 }))
  rows.sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || b.t - a.t)
  return rows.map((x) => x.row)
}

export function panelSummary(rows: readonly PanelRow[]): PanelSummary {
  const s: PanelSummary = { active: 0, queued: 0, done: 0, failed: 0, canceled: 0 }
  for (const r of rows) {
    if (r.status === 'downloading') s.active++
    else if (r.status === 'queued') s.queued++
    else if (r.status === 'done') s.done++
    else if (r.status === 'canceled') s.canceled++
    else s.failed++
  }
  return s
}

/** The count inside the sidebar door: what's moving; else what needs a
 *  decision (failed + refused); else a neutral total when canceled jobs sit
 *  among the finished ones; "N done" only when every settled job really is. */
export function downloadsBadge(s: PanelSummary): string | undefined {
  const inFlight = s.active + s.queued
  if (inFlight > 0) return inFlight.toLocaleString()
  if (s.failed > 0) return `${s.failed.toLocaleString()} need attention`
  const settled = s.done + s.canceled
  if (settled === 0) return undefined
  return s.canceled > 0 ? `${settled.toLocaleString()} finished` : `${s.done.toLocaleString()} done`
}
