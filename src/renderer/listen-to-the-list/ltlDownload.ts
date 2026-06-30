import type { Recommendation } from '../types'

export type LtlDownloadState = 'idle' | 'queued' | 'downloading' | 'done' | 'error'

export interface LtlDownloadStatus {
  state: LtlDownloadState
  error?: string
  imported?: number
  matchDesc?: string
}

type Listener = () => void

const statuses = new Map<string, LtlDownloadStatus>()
const pending: Array<{ id: string; artist: string; title: string }> = []
const listeners = new Set<Listener>()
let processing = false

function notify(): void {
  for (const l of listeners) l()
}

export function subscribeLtlDownload(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getLtlDownloadSnapshot(): ReadonlyMap<string, LtlDownloadStatus> {
  return statuses
}

export function getLtlDownloadStatus(id: string): LtlDownloadStatus {
  return statuses.get(id) ?? { state: 'idle' }
}

function recoFields(rec: Recommendation): { artist: string; title: string } {
  return {
    title: (rec.matchedTitle || rec.song || rec.album || '').trim(),
    artist: (rec.matchedArtist || rec.artist || '').trim(),
  }
}

export function canDownloadReco(rec: Recommendation): boolean {
  const { title, artist } = recoFields(rec)
  return Boolean(title || artist)
}

export function isLtlDownloadBusy(id: string): boolean {
  const s = statuses.get(id)?.state
  return s === 'queued' || s === 'downloading'
}

export function queueRecoDownload(rec: Recommendation): void {
  if (!canDownloadReco(rec)) return
  if (isLtlDownloadBusy(rec.id)) return
  const { artist, title } = recoFields(rec)
  statuses.set(rec.id, { state: 'queued' })
  pending.push({ id: rec.id, artist, title })
  notify()
  void drainQueue()
}

export function queueAllRecoDownloads(recs: Recommendation[]): void {
  for (const rec of recs) queueRecoDownload(rec)
}

async function drainQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (pending.length > 0) {
      const job = pending.shift()!
      statuses.set(job.id, { state: 'downloading' })
      notify()
      try {
        const r = await window.electronAPI.streamripDownloadByQuery?.({
          artist: job.artist,
          title: job.title,
        })
        if (r?.ok && (r.imported ?? 0) > 0) {
          statuses.set(job.id, {
            state: 'done',
            imported: r.imported,
            matchDesc: r.matchDesc,
          })
        } else if (r?.ok && r.dupes) {
          statuses.set(job.id, {
            state: 'done',
            imported: 0,
            matchDesc: r.matchDesc,
          })
        } else {
          statuses.set(job.id, {
            state: 'error',
            error: r?.error || 'Download failed.',
          })
        }
      } catch (err) {
        statuses.set(job.id, {
          state: 'error',
          error: err instanceof Error ? err.message : 'Download failed.',
        })
      }
      notify()
    }
  } finally {
    processing = false
  }
}

/** Open the Download sidebar view with a search prefilled (manual fallback). */
export function prefillDownloadView(rec: Recommendation): void {
  const { artist, title } = recoFields(rec)
  const query = [artist, title].filter(Boolean).join(' ')
  window.dispatchEvent(new CustomEvent('jaketunes-download-prefill', { detail: { query } }))
}
