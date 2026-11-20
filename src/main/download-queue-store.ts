/**
 * The Downloads waiting list on disk (Brief 258, Record Shop Phase 5).
 *
 * The renderer owns the list; this keeps it in the app's data folder so a
 * restart or an update picks up where it left off. One file,
 * `download-queue.json`, written whole and atomically (writeJsonAtomic: a
 * unique temp file, fsync, rename). Writes are coalesced: one at a time, and
 * a save that arrives during a write is written once after it, newest wins.
 *
 * Main also writes a small ledger in the same file: the arm id of every job
 * whose import finished, the moment it finished (streamrip-store calls
 * `markFinished` before it answers the renderer). A quit between the import
 * and the renderer saving "done" therefore never downloads the job again.
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from './atomic-write.ts'
import { capSaved, emptyQueueDoc, parseSavedQueue, pruneFinished, toSavedJobs, type FinishedJob, type SavedJob, type SavedQueueDoc } from '../common/download-lanes.ts'
import type { IpcRegistrar } from './ipc-register.ts'
import { REFUSED_SENDER } from './ipc-register.ts'

export interface DownloadQueueStore {
  load: () => Promise<SavedQueueDoc>
  saveJobs: (jobs: SavedJob[]) => Promise<void>
  markFinished: (armId: string, f: Omit<FinishedJob, 'at'>) => Promise<void>
  /** Resolves when everything asked for so far is on disk. */
  flush: () => Promise<void>
}

export function createDownloadQueueStore(opts: {
  path: string
  now?: () => number
  write?: (path: string, data: unknown) => Promise<void>
  warn?: (msg: string) => void
}): DownloadQueueStore {
  const now = opts.now ?? Date.now
  const write = opts.write ?? ((p: string, d: unknown) => writeJsonAtomic(p, d, false))
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  let doc: SavedQueueDoc | null = null
  let loading: Promise<SavedQueueDoc> | null = null
  let writing: Promise<void> | null = null
  let dirty = false

  async function readDoc(): Promise<SavedQueueDoc> {
    try {
      const raw = await readFile(opts.path, 'utf-8')
      const parsed = parseSavedQueue(JSON.parse(raw))
      if (parsed) return parsed
      warn('[downloads] saved list not readable; starting empty')
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') warn('[downloads] saved list not readable; starting empty')
    }
    return emptyQueueDoc(now())
  }

  function load(): Promise<SavedQueueDoc> {
    if (doc) return Promise.resolve(doc)
    if (!loading) loading = readDoc().then((d) => { doc = doc ?? d; return doc })
    return loading
  }

  function kick(): Promise<void> {
    dirty = true
    if (writing) return writing
    writing = (async () => {
      try {
        while (dirty) {
          dirty = false
          const d = await load()
          d.savedAt = now()
          try { await write(opts.path, d) } catch { warn('[downloads] could not save the list') }
        }
      } finally { writing = null }
    })()
    return writing
  }

  return {
    load,
    async saveJobs(jobs) {
      const d = await load()
      const t = now()
      d.jobs = capSaved(toSavedJobs(jobs), t)
      d.finished = pruneFinished(d.finished, d.jobs, t)
      await kick()
    },
    async markFinished(armId, f) {
      if (!armId) return
      const d = await load()
      d.finished[armId] = { ...f, at: now() }
      await kick()
    },
    async flush() {
      while (writing) await writing
    },
  }
}

export function registerDownloadQueueStore(ipc: IpcRegistrar, store: DownloadQueueStore): void {
  ipc.handle('download-queue:load', async () => store.load(), { refuse: null })
  ipc.handle('download-queue:save', async (_e, jobs: unknown) => {
    if (!Array.isArray(jobs)) return { ok: false }
    await store.saveJobs(jobs as SavedJob[])
    return { ok: true }
  }, { refuse: REFUSED_SENDER })
}
