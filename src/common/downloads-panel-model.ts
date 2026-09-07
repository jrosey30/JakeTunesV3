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
import { differsLine, sourceEditionLabel } from './source-edition.ts'

export type PanelStatus = 'downloading' | 'queued' | 'done' | 'failed' | 'refused' | 'canceled'
export type PanelAction = 'cancel' | 'retry' | 'chooseEdition' | 'chooseVersion' | 'compareEditions' | 'retryGroup'

export interface PanelRow {
  key: string
  status: PanelStatus
  kind: 'album' | 'song' | 'link'
  title: string
  artist: string | null
  /** Edition identity: "album · 12 tracks · 1980 · iTunes 124906778". */
  edition: string | null
  /** A source edition chosen instead of a picked one: "chosen instead of iTunes 96265705 · differs at track 4 (8:04 vs 6:50)". */
  editionNote: string | null
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
  /** Matching-track Gets recovered from this refused album request (action A): the child jobs and their tally. */
  group: PanelGroup | null
  /** This row is a child of a group (a matching-track Get). */
  groupPosition: number | null
  actions: PanelAction[]
  /** Seconds in flight (downloading) — the caller supplies `now`. */
  elapsedSec: number | null
  /** What to search for when choosing again (refused rows). */
  choose: { query: string; kind: 'album' | 'song'; artist: string; title: string } | null
}

export interface PanelGroup {
  of: number
  selected: number
  done: number
  inFlight: number
  failed: number
  canceled: number
  skippedOwned: number
  notAcquired: Array<{ position: number; title: string; reason: string }>
  children: PanelRow[]
  /** "7 of 11 landed · 1 failed · track 4 not acquired (runtime mismatch)" — never "complete". */
  line: string
}

export interface PanelSummary { active: number; queued: number; done: number; failed: number; canceled: number }

const STATUS_ORDER: Record<PanelStatus, number> = { downloading: 0, queued: 1, refused: 2, failed: 2, canceled: 3, done: 4 }

function editionOf(r: QueueItemLike['result']): string | null {
  if (r.kind !== 'query') return null
  if (r.sourceEdition) return `Bandcamp edition · ${sourceEditionLabel(r.sourceEdition, r.trackCount)}`
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
    editionNote: r.sourceEdition ? [r.origin?.chosenInsteadOf ? `chosen instead of ${r.origin.chosenInsteadOf.label}` : null, differsLine(r.sourceEdition, !r.origin?.chosenInsteadOf)].filter(Boolean).join(' · ') || null : null,
    from: provenanceOf(q),
    counts,
    completion: status === 'done' ? (q.completion || q.matchDesc || null) : null,
    primary: status === 'failed' || status === 'refused' ? (q.primary || q.error || 'Download failed') : null,
    detail: status === 'failed' || status === 'refused' ? (q.detail || q.error || null) : null,
    alternatives: q.alternatives ?? [],
    nearEdition,
    group: null,
    groupPosition: r.origin?.group?.position ?? null,
    actions,
    elapsedSec: status === 'downloading' && q.startedAt ? Math.max(0, Math.floor((now - q.startedAt) / 1000)) : null,
    choose: status === 'refused' && artist && chooseTitle ? { query: `${artist} ${chooseTitle}`.trim(), kind: kind === 'album' ? 'album' : 'song', artist, title: chooseTitle } : null,
  }
}

/** In-flight first, then what needs a decision, then what's finished — newest first within a group. */
export function downloadsPanelRows(queue: readonly QueueItemLike[], now: number): PanelRow[] {
  const rows = queue.map((q) => ({ q, row: panelRowFor(q, now), t: q.endedAt ?? q.startedAt ?? 0 }))
  // Matching-track Gets fold under their refused album request.
  const byParent = new Map<string, Array<{ q: QueueItemLike; row: PanelRow }>>()
  for (const x of rows) {
    const g = x.q.result.origin?.group
    if (g) { const list = byParent.get(g.parentKey) ?? []; list.push(x); byParent.set(g.parentKey, list) }
  }
  const claimed = new Set<string>()
  for (const x of rows) {
    const kids = byParent.get(x.row.key)
    if (!kids?.length) continue
    kids.sort((a, b) => (a.row.groupPosition ?? 0) - (b.row.groupPosition ?? 0))
    const meta = kids[0].q.result.origin!.group!
    const children = kids.map((k) => k.row)
    const done = children.filter((c) => c.status === 'done').length
    const inFlight = children.filter((c) => c.status === 'downloading' || c.status === 'queued').length
    const failed = children.filter((c) => c.status === 'failed' || c.status === 'refused').length
    const canceled = children.filter((c) => c.status === 'canceled').length
    const selected = children.length + meta.skippedOwned
    const bits = [`${done + meta.skippedOwned} of ${meta.of} in your library`]
    if (inFlight) bits.push(`${inFlight} on the way`)
    if (failed) bits.push(`${failed} failed`)
    if (canceled) bits.push(`${canceled} canceled`)
    for (const na of meta.notAcquired) bits.push(`track ${na.position} not acquired (${na.reason})`)
    x.row.group = { of: meta.of, selected, done, inFlight, failed, canceled, skippedOwned: meta.skippedOwned, notAcquired: meta.notAcquired, children, line: bits.join(' · ') }
    if (failed + canceled > 0 && inFlight === 0) x.row.actions.push('retryGroup')
    for (const k of kids) claimed.add(k.row.key)
  }
  const top = rows.filter((x) => !claimed.has(x.row.key))
  top.sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || b.t - a.t)
  return top.map((x) => x.row)
}

export function panelSummary(rows: readonly PanelRow[]): PanelSummary {
  const s: PanelSummary = { active: 0, queued: 0, done: 0, failed: 0, canceled: 0 }
  const all = rows.flatMap((r) => (r.group ? [r, ...r.group.children] : [r]))
  for (const r of all) {
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
