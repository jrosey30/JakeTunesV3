// ── Offline "Download" (pin) store — Spotify-style ───────────────────────
// Streaming/cache machines (e.g. workmini) keep most of the library as
// stream-links to the NAS with a capped auto-cache of the hot rotation.
// "Download" pins a track so it becomes a real local file AND is exempt from
// cache eviction; "Remove Download" reverts it to a stream-link. This module
// mirrors that state into the renderer reactively (useSyncExternalStore).
// On all-local machines `streaming` is false → the UI hides the controls.

let pinned = new Set<string>() // ipod-style paths (":iPod_Control:Music:F13:X.m4a")
let inProgress = new Set<string>() // currently downloading
let streaming = false
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version++
  for (const l of listeners) l()
}

export function subscribeDownloads(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export function downloadsVersion(): number {
  return version
}
export function isStreamingLibrary(): boolean {
  return streaming
}
export function isDownloaded(path: string | undefined): boolean {
  return !!path && pinned.has(path)
}
export function isDownloading(path: string | undefined): boolean {
  return !!path && inProgress.has(path)
}

let inited = false
export async function initDownloads(): Promise<void> {
  if (inited) return
  inited = true
  try {
    const s = await window.electronAPI?.loadDownloadsState?.()
    if (s) {
      pinned = new Set(s.pinned || [])
      streaming = !!s.streaming
      emit()
    }
  } catch {
    /* non-fatal — controls just stay hidden */
  }
}

export async function downloadPaths(paths: string[]): Promise<void> {
  const todo = paths.filter((p) => p && !pinned.has(p) && !inProgress.has(p))
  if (!todo.length) return
  for (const p of todo) inProgress.add(p)
  emit()
  for (const p of todo) {
    try {
      const r = await window.electronAPI?.downloadTrack?.(p)
      if (r?.ok) pinned.add(p)
    } catch {
      /* leave un-pinned; user can retry */
    }
    inProgress.delete(p)
    emit()
  }
}

export async function removeDownloadPaths(paths: string[]): Promise<void> {
  const todo = paths.filter((p) => p && pinned.has(p))
  if (!todo.length) return
  for (const p of todo) {
    try {
      const r = await window.electronAPI?.removeDownload?.(p)
      if (r?.ok) pinned.delete(p)
    } catch {
      /* keep pinned on failure */
    }
  }
  emit()
}
