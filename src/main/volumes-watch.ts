// Brief 264 (2026-11-20): see a plugged-in iPod the moment macOS mounts it.
//
// The sidebar polls check-ipod-mounted every 2.5 s. This watches /Volumes
// (a local directory: an entry appears or goes when anything mounts or
// unmounts) and, on any change, tells the detector at once (it drops its
// negative cache) and, ~300 ms after the burst settles, tells the renderer
// to check now. The poll stays as the backup. If the watcher can't start or
// fails later, it closes and says so once: the poll carries on alone.
import { watch as fsWatch } from 'fs'

export type WatchFn = (dir: string, listener: () => void) => {
  on: (ev: 'error', cb: (err: unknown) => void) => unknown
  close: () => void
}

export interface VolumesWatchOptions {
  dir?: string
  debounceMs?: number
  /** Called on every raw change, at once (cheap: clears the negative cache). */
  onRawChange?: () => void
  /** Called once per burst, after `debounceMs` of quiet. */
  onSettled: () => void
  watch?: WatchFn
  log?: (msg: string) => void
}

export interface VolumesWatch {
  /** False when the watcher never started or has failed: polling only. */
  active: () => boolean
  close: () => void
}

export function startVolumesWatch(opts: VolumesWatchOptions): VolumesWatch {
  const dir = opts.dir ?? '/Volumes'
  const debounceMs = opts.debounceMs ?? 300
  const log = opts.log ?? ((m: string) => console.log(m))
  const watchFn: WatchFn = opts.watch ?? ((d, l) => fsWatch(d, { persistent: false }, l))
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: ReturnType<WatchFn> | null = null
  let closed = false

  const stop = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
    const w = watcher
    watcher = null
    try { w?.close() } catch { /* already gone */ }
  }

  const onChange = (): void => {
    if (closed) return
    try { opts.onRawChange?.() } catch { /* never let a listener kill the watcher */ }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (closed) return
      try { opts.onSettled() } catch { /* same */ }
    }, debounceMs)
  }

  try {
    watcher = watchFn(dir, onChange)
    watcher.on('error', (err) => {
      if (closed || !watcher) return
      log(`[ipod-detect] ${dir} watcher failed (${String((err as Error)?.message ?? err)}) — polling only`)
      stop()
    })
  } catch (err) {
    log(`[ipod-detect] could not watch ${dir} (${String((err as Error)?.message ?? err)}) — polling only`)
    watcher = null
  }

  return {
    active: () => !closed && watcher !== null,
    close: () => { closed = true; stop() },
  }
}
