/**
 * The Listen List's view of the Downloads scheduler (6.0 Record Shop).
 *
 * Until 2026-09-05 this file owned a SECOND serial queue: its own pending
 * list, its own processing flag, its own call into main with only artist +
 * title — no album intent, no runtime, no collection id, so an album row
 * pressed with Enter asked main for a TRACK named after the album, and the
 * Download view's queue bar never knew the job existed.
 *
 * Now there is one scheduler (views/DownloadStore/downloadQueue.ts). This
 * module only (a) turns a recommendation into a queue result that carries
 * the same identity a Download-view Get would, plus its provenance, and
 * (b) projects queue state back by recommendation id for the list's rows,
 * fulfillment sweep and friend credits. A loose ALBUM recommendation never
 * becomes a job here — it has no selected edition, so it is routed to
 * catalogue selection (the Download view's tracklist), and the selection's
 * Get carries the recommendation id back so the list still sees it land.
 */
import { requestDiscoveryTab } from '../views/discoveryTab.ts'
import type { Recommendation } from '../types.ts'
import {
  enqueue, cancel, retry, subscribeQueue, getQueue, itemForRecommendation,
  trackQueryId, albumQueryId, type QItem, type QResult, type QueueOrigin,
} from '../views/DownloadStore/downloadQueue.ts'

export type LtlDownloadState = 'idle' | 'queued' | 'downloading' | 'done' | 'error'

export interface LtlDownloadStatus {
  state: LtlDownloadState
  error?: string
  imported?: number
  matchDesc?: string
  /** Structured verdict from the one scheduler (6.0 Phase 1 vocabulary). */
  primary?: string
  detail?: string
  completion?: string
  alreadyOwned?: number
  outcome?: string
  jobKey?: string
}

export function recoFields(rec: Recommendation): { artist: string; title: string; album: string } {
  return {
    title: (rec.matchedTitle || rec.song || '').trim(),
    album: (rec.matchedAlbum || rec.album || '').trim(),
    artist: (rec.matchedArtist || rec.artist || '').trim(),
  }
}

/** Song / Album / Artist — what a recommendation IS. ⚠️ TWIN:
 *  views/ListenToTheListView.tsx recoType (the list groups by the same rule). */
export function recoKind(rec: Recommendation): 'song' | 'album' | 'concert' | 'artist' {
  const { title, album } = recoFields(rec)
  if (rec.kind === 'concert') return 'concert'
  if (rec.kind === 'album') return 'album'
  if (title) return 'song'
  if (album) return 'album'
  return 'artist'
}

function friendOf(rec: Recommendation): string | null {
  const m = String(rec.note || '').match(/(?:^|· )from ([^·]+?)(?: ·|$)/)
  return m ? m[1].trim() : null
}

/** Provenance that rides on the job: the recommendation id (the list's
 *  stable UUID), who sent it, and which lane. Never the catalogue provider. */
export function recoOrigin(rec: Recommendation): QueueOrigin {
  const friend = friendOf(rec)
  return { recommendationIds: [rec.id], entryId: rec.id, sourceKind: friend ? 'person' : rec.source, sourceLabel: friend ?? undefined }
}

export type RecoQueueDecision =
  | { kind: 'queue'; result: QResult }
  /** An album needs its EDITION chosen in the catalogue first. */
  | { kind: 'select-edition'; artist: string; album: string }
  /** Artist-only jots and concerts are browsed, never downloaded blind. */
  | { kind: 'browse-only'; reason: 'artist' | 'concert' | 'empty' }

/** Pure: the queue result a recommendation would become, or why it cannot. */
export function recoToQueueResult(rec: Recommendation): RecoQueueDecision {
  const { artist, title, album } = recoFields(rec)
  const kind = recoKind(rec)
  if (kind === 'concert') return { kind: 'browse-only', reason: 'concert' }
  if (kind === 'artist') return { kind: 'browse-only', reason: artist ? 'artist' : 'empty' }
  if (kind === 'album') return { kind: 'select-edition', artist, album }
  return {
    kind: 'queue',
    result: {
      kind: 'query', source: 'qobuz', mediaType: 'track',
      id: trackQueryId(artist, title),
      desc: `${title} — ${artist}`,
      artist, title,
      // The album hint opens main's album door when Qobuz's track search
      // misses the song; it is not a request for the whole record.
      album: album || undefined,
      origin: recoOrigin(rec),
    },
  }
}

/** Something on the row can be acted on (queued, or sent to selection). */
export function canDownloadReco(rec: Recommendation): boolean {
  const { title, artist } = recoFields(rec)
  return Boolean(title || artist)
}

const jobKeyFor = (rec: Recommendation): string | undefined => {
  const d = recoToQueueResult(rec)
  if (d.kind === 'queue') return `${d.result.source}|${d.result.mediaType}|${d.result.id}`
  if (d.kind === 'select-edition') return `qobuz|album|${albumQueryId(d.artist, d.album)}`
  return undefined
}

/** One recommendation's status, read off the job that carries its id (or,
 *  for a job started from the Download view before the list knew, off the
 *  identity key). Pure over the queue array. */
export function projectRecoStatus(queue: QItem[], rec: Pick<Recommendation, 'id'> & Partial<Recommendation>): LtlDownloadStatus {
  const it = queue.find((q) => q.result.origin?.recommendationIds.includes(rec.id))
    ?? (rec.artist || rec.song || rec.album ? (() => { const k = jobKeyFor(rec as Recommendation); return k ? queue.find((q) => q.key === k) : undefined })() : undefined)
  if (!it) return { state: 'idle' }
  const base = { jobKey: it.key, matchDesc: it.matchDesc, completion: it.completion, primary: it.primary, detail: it.detail, outcome: it.outcome }
  switch (it.status) {
    case 'queued': return { ...base, state: 'queued' }
    case 'downloading': return { ...base, state: 'downloading' }
    case 'done': {
      const imported = it.imported ?? 0, owned = it.dupes ?? 0
      if (imported > 0 || owned > 0) return { ...base, state: 'done', imported, alreadyOwned: owned }
      return { ...base, state: 'error', error: 'Nothing was imported.' }
    }
    case 'failed': return { ...base, state: 'error', error: it.error || it.primary || 'Download failed.' }
    case 'canceled': default: return { ...base, state: 'idle' }
  }
}

type Listener = () => void
let snapshot: ReadonlyMap<string, LtlDownloadStatus> = new Map()
let snapshotVersion = -1
let queueVersion = 0
subscribeQueue(() => { queueVersion++ })

/** Rebuilt only when the queue changed — useSyncExternalStore needs a
 *  stable reference between changes. */
export function getLtlDownloadSnapshot(): ReadonlyMap<string, LtlDownloadStatus> {
  if (snapshotVersion === queueVersion) return snapshot
  const m = new Map<string, LtlDownloadStatus>()
  for (const it of getQueue()) {
    for (const id of it.result.origin?.recommendationIds ?? []) m.set(id, projectRecoStatus([it], { id }))
  }
  snapshot = m; snapshotVersion = queueVersion
  return snapshot
}

export function subscribeLtlDownload(listener: Listener): () => void {
  return subscribeQueue(listener)
}

export function getLtlDownloadStatus(id: string): LtlDownloadStatus {
  return getLtlDownloadSnapshot().get(id) ?? { state: 'idle' }
}

export function isLtlDownloadBusy(id: string): boolean {
  const s = getLtlDownloadStatus(id).state
  return s === 'queued' || s === 'downloading'
}

/** Queue a recommendation on the one scheduler, or say what must happen
 *  first. Re-arms a failed/canceled job for the same recording. */
export function queueRecoDownload(rec: Recommendation): RecoQueueDecision {
  const d = recoToQueueResult(rec)
  if (d.kind !== 'queue') return d
  if (isLtlDownloadBusy(rec.id)) return d
  enqueue(d.result)
  return d
}

/** Bulk: songs queue; albums and browse-only rows are counted, not guessed. */
export function queueAllRecoDownloads(recs: Recommendation[]): { queued: number; needSelection: number; browseOnly: number } {
  const out = { queued: 0, needSelection: 0, browseOnly: 0 }
  for (const rec of recs) {
    const d = queueRecoDownload(rec)
    if (d.kind === 'queue') out.queued++
    else if (d.kind === 'select-edition') out.needSelection++
    else out.browseOnly++
  }
  return out
}

export async function cancelRecoDownload(id: string): Promise<void> {
  const it = itemForRecommendation(id)
  if (it) await cancel(it.key)
}

export function retryRecoDownload(id: string): void {
  const it = itemForRecommendation(id)
  if (it) retry(it.key)
}

/** Open the Download view with a search prefilled and, for an album, its
 *  tracklist expanded so the EDITION is chosen there. The recommendation's
 *  provenance travels with the prefill so the Get made from that tracklist
 *  carries it, and the list sees that job by id. */
/** What to SEARCH the catalogue with: the enrichment's decorated name is
 *  for display, not for the search box (live, 2026-09-05: "Sting & Bedouin
 *  Desert Rose (Reimagined) [feat. Cheb Mami]" returned nothing; "Bedouin
 *  Desert Rose" finds the record). Bracket groups and feature credits are
 *  dropped from the query only; the full name still drives the expansion. */
export function prefillQueryFor(artist: string, name: string): string {
  const plain = String(name || '').replace(/\s*[([{][^)\]}]*[)\]}]/g, '').replace(/\s+(?:feat|ft|featuring)\.?\s.*$/i, '').replace(/\s{2,}/g, ' ').trim()
  const who = String(artist || '').replace(/\s*[&,]\s*.*$/, '').trim()   // "Sting & Bedouin" → the first credited act
  return [who || artist, plain || name].filter(Boolean).join(' ').trim()
}

export function prefillDownloadView(rec: Recommendation, kind: 'album' | 'song' = 'song'): void {
  const { artist, title, album } = recoFields(rec)
  const name = kind === 'album' ? album || title : title || album
  // Search with the jot AS WRITTEN (what the hub holds), not the iTunes
  // enrichment: "Bedouin — Desert Rose (Reimagined)" was enriched to
  // "Sting & Bedouin — … [feat. Cheb Mami]" and the search found Sting's
  // catalogue instead of the record (live, 2026-09-05).
  const rawArtist = (rec.artist || '').trim() || artist
  const rawName = kind === 'album' ? ((rec.album || '').trim() || name) : ((rec.song || '').trim() || name)
  const query = prefillQueryFor(rawArtist, rawName)
  // Carry WHAT this is, not just the words. Jake: album rows "just take me to
  // the download search bar and doesnt work" — the receiver filled the box and
  // never searched, so he landed on an empty page. It now runs the search, and
  // for an album it opens that album's tracklist so he can take the whole
  // thing or pick songs out of it.
  // Record Shop → Browse takes it (step 5 slice 4); the legacy Download route
  // ignores a prefill addressed to Browse.
  window.dispatchEvent(new CustomEvent('jaketunes-download-prefill', {
    detail: { query, kind, artist, title: name, origin: recoOrigin(rec), target: 'browse' },
  }))
}

/** Open Record Shop → Browse. Call AFTER the prefill event: a mounted Browse
 *  already took it; a fresh one reads the captured prefill when it mounts. */
export function openBrowse(dispatch: (a: { type: 'SET_VIEW'; view: 'discovery' }) => void): void {
  requestDiscoveryTab('browse')
  dispatch({ type: 'SET_VIEW', view: 'discovery' })
}
