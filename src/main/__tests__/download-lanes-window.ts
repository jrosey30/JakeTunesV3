/**
 * Brief 258 tests: main, stubbed, for the renderer's download queue. Imported
 * BEFORE the queue module, so the queue sees it at start (it listens for "7 of
 * 12" and reads the saved list then), as it does in the app.
 */
import type { SavedJob, SavedQueueDoc } from '../../common/download-lanes.ts'

export type Answer = { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string }
export interface Call { what: string; jobId?: string; opts: Record<string, unknown> }

export const main = {
  calls: [] as Call[],
  /** What each walk answers, by song or album name; a function may hang until canceled. */
  answers: new Map<string, () => Promise<Answer>>(),
  inFlight: new Map<string, (a: Answer) => void>(),
  canceled: [] as Array<string | undefined>,
  progress: null as null | ((p: { jobId: string; have: number; of: number; reset?: boolean }) => void),
  /** main's end event for a job (a window that reloaded mid-job follows it). */
  ended: null as null | ((p: { jobId: string; result: Answer }) => void),
  saved: [] as SavedJob[][],
  load: async (): Promise<SavedQueueDoc | null> => null,
  save: async (jobs: SavedJob[]): Promise<void> => { main.saved.push(jobs) },
  /** How many walks run right now, overall and per kind, and the most seen. */
  running: { album: 0, song: 0, most: { album: 0, song: 0, total: 0 } },
}

function walk(name: string, kind: 'album' | 'song', jobId: string | undefined, opts: Record<string, unknown>): Promise<Answer> {
  main.calls.push({ what: name, jobId, opts })
  const r = main.running
  r[kind]++
  r.most[kind] = Math.max(r.most[kind], r[kind])
  r.most.total = Math.max(r.most.total, r.album + r.song)
  const a = main.answers.get(name)
  const p = new Promise<Answer>((res) => {
    if (jobId) main.inFlight.set(jobId, res)
    void (a ? a() : Promise.resolve({ ok: true, imported: 1, dupes: 0 })).then(res)
  })
  return p.finally(() => { r[kind]--; if (jobId) main.inFlight.delete(jobId) })
}

;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: (opts: Record<string, unknown>) => {
      const album = Boolean(opts.album) && !opts.title
      return walk(String(opts.title ?? opts.album), album ? 'album' : 'song', opts.jobId as string | undefined, opts)
    },
    streamripDownloadId: (source: string, mediaType: string, id: string, _addedVia?: string, jobId?: string) =>
      walk(id, mediaType === 'album' ? 'album' : 'song', jobId, { source, mediaType, id }),
    streamripCancelActive: async (jobId?: string) => {
      main.canceled.push(jobId)
      for (const [id, res] of main.inFlight) if (!jobId || id === jobId) res({ ok: false, error: 'canceled', outcome: 'canceled' })
      return { ok: true, killed: 1 }
    },
    onStreamripJobProgress: (cb: (p: { jobId: string; have: number; of: number; reset?: boolean }) => void) => { main.progress = cb; return () => {} },
    onStreamripJobEnded: (cb: (p: { jobId: string; result: Answer }) => void) => { main.ended = cb; return () => {} },
    downloadQueueLoad: () => main.load(),
    downloadQueueSave: (jobs: SavedJob[]) => main.save(jobs).then(() => ({ ok: true })),
    usageLog: () => {},
  },
  dispatchEvent: () => true,
}
