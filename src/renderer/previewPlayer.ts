// Brief 122 — dedicated 30-second preview player for "Listen to the List".
//
// Deliberately SEPARATE from the Howler music engine (useAudio): previews
// must never touch the queue, now-playing, play-counts, crossfade, or any
// of the load-bearing playback machinery. This owns a single
// HTMLAudioElement and exposes a useSyncExternalStore-compatible snapshot
// so the now-playing pill (NowPlaying.tsx) can render the preview with the
// same iTunes scrubber the real player uses.
//
// Pausing/resuming the user's actual music around a preview is NOT done
// here (no hook access) — NowPlaying watches `playingId` transitions and
// calls togglePlayPause, since it already holds the useAudio handle.

export interface PreviewState {
  playingId: string | null
  title: string
  artist: string
  position: number
  duration: number
}

let state: PreviewState = { playingId: null, title: '', artist: '', position: 0, duration: 0 }
const listeners = new Set<() => void>()
let audio: HTMLAudioElement | null = null

function emit(): void {
  for (const l of listeners) l()
}

// New object only on real change → getSnapshot returns a stable reference
// between emits (required by useSyncExternalStore).
function setState(patch: Partial<PreviewState>): void {
  state = { ...state, ...patch }
  emit()
}

function ensureAudio(): HTMLAudioElement {
  if (audio) return audio
  const a = new Audio()
  a.addEventListener('timeupdate', () => setState({ position: a.currentTime }))
  a.addEventListener('loadedmetadata', () => setState({ duration: isFinite(a.duration) ? a.duration : 30 }))
  a.addEventListener('ended', () => stopPreview())
  a.addEventListener('error', () => {
    // 2026-09-01: "previews stopped playing again" recovered on restart
    // with no evidence — this handler was swallowing it. Name the failure
    // so the next occurrence is diagnosable from the console.
    const err = a.error
    console.warn(`[preview] media error code=${err?.code ?? '?'} msg=${err?.message || ''} src=${(a.src || '').slice(0, 90)}`)
    stopPreview()
  })
  audio = a
  return a
}

export function subscribePreview(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getPreviewSnapshot(): PreviewState {
  return state
}

export function playPreview(id: string, url: string, title: string, artist: string): void {
  const a = ensureAudio()
  setState({ playingId: id, title, artist, position: 0, duration: 0 })
  // Deezer preview URLs are SIGNED + TIME-LIMITED — the ones cached on
  // discovery cards expire on the shelf and 403 (media error code 4, the
  // 2026-09-01 console capture). Re-resolve a fresh URL at play time;
  // fall back to the cached one if the refresh misses (it may still be
  // inside its window).
  if (/\bdzcdn\.net\//.test(url) && window.electronAPI.refreshDeezerPreview) {
    void window.electronAPI.refreshDeezerPreview(artist, title)
      .then((r) => {
        if (state.playingId !== id) return  // user moved on mid-refresh
        a.src = (r.ok && r.previewUrl) ? r.previewUrl : url
        a.currentTime = 0
        a.play().catch(() => stopPreview())
      })
      .catch(() => {
        if (state.playingId !== id) return
        a.src = url
        a.currentTime = 0
        a.play().catch(() => stopPreview())
      })
    return
  }
  a.src = url
  a.currentTime = 0
  a.play().catch(() => stopPreview())
}

/** ▶ on a reco: start it, or stop it if it's already the playing one. */
export function togglePreview(id: string, url: string, title: string, artist: string): void {
  if (state.playingId === id) {
    stopPreview()
    return
  }
  playPreview(id, url, title, artist)
}

export function stopPreview(): void {
  if (audio) {
    try { audio.pause() } catch { /* ignore */ }
  }
  if (state.playingId !== null) setState({ playingId: null, position: 0, duration: 0 })
}

/** Scrubber drag/click from the pill. */
export function seekPreview(seconds: number): void {
  if (!audio) return
  audio.currentTime = seconds
  setState({ position: seconds })
}
