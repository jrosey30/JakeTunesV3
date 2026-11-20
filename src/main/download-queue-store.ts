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
 *
 * A file it can't read right now (anything but "not there") is not an empty
 * list: the load fails and the renderer asks again, so a passing read error
 * can never let a save write over the waiting list. A file written by a newer
 * app is left exactly as it is: this app starts with an empty list in memory
 * and never writes it.
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from './atomic-write.ts'
import { capSaved, emptyQueueDoc, isNewerQueueFile, parseSavedQueue, pruneFinished, toSavedJobs, type FinishedJob, type SavedJob, type SavedQueueDoc } from '../common/download-lanes.ts'
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
  /** The file belongs to a newer app: never written by this one. */
  let frozen = false

  async function readDoc(): Promise<SavedQueueDoc> {
    let text: string
    try {
      text = await readFile(opts.path, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyQueueDoc(now())
      warn('[downloads] saved list could not be read; will ask again')
      throw e
    }
    let raw: unknown = null
    try { raw = JSON.parse(text) } catch { /* torn: never written by us whole */ }
    if (isNewerQueueFile(raw)) {
      frozen = true
      warn('[downloads] saved list is from a newer JakeTunes; leaving it as it is')
      return emptyQueueDoc(now())
    }
    const parsed = parseSavedQueue(raw)
    if (parsed) return parsed
    warn('[downloads] saved list not readable; starting empty')
    return emptyQueueDoc(now())
  }

  function load(): Promise<SavedQueueDoc> {
    if (doc) return Promise.resolve(doc)
    if (!loading) {
      loading = readDoc().then(
        (d) => { doc = doc ?? d; return doc },
        (e) => { loading = null; throw e },
      )
    }
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
          if (frozen) continue
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
      while (writing) await writing.catch(() => { /* said in the log */ })
    },
  }
}

export function registerDownloadQueueStore(ipc: IpcRegistrar, store: DownloadQueueStore, opts: { liveJobs?: () => string[] } = {}): void {
  ipc.handle('download-queue:load', async () => {
    // Who is running FIRST, then the list: a job gone from `live` wrote its ledger line before it left.
    const live = opts.liveJobs?.() ?? []
    return { ...(await store.load()), live }
  }, { refuse: null })
  ipc.handle('download-queue:save', async (_e, jobs: unknown) => {
    if (!Array.isArray(jobs)) return { ok: false }
    await store.saveJobs(jobs as SavedJob[])
    return { ok: true }
  }, { refuse: REFUSED_SENDER })
}
