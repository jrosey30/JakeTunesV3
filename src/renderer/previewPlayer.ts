// Brief 122 — dedicated 30-second preview player for Listen to the List.
// Separate from Howler/useAudio so previews never touch the queue or play counts.

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
  a.addEventListener('error', () => stopPreview())
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
  a.src = url
  a.currentTime = 0
  setState({ playingId: id, title, artist, position: 0, duration: 0 })
  a.play().catch(() => stopPreview())
}

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

export function seekPreview(seconds: number): void {
  if (!audio) return
  audio.currentTime = seconds
  setState({ position: seconds })
}
