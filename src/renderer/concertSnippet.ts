/**
 * Concert card snippets (2026-10-29, Jake: "make the concerts row more fun").
 * A click on a Home concert card plays 15 s of the act's most-played song he
 * owns, from about a third of the way in, through the same ipod-audio:// path
 * the Top 1000 quiz's snippets use, on its own <audio> (never the Howler
 * engine, the queue or play counts). One at a time; a second click, another
 * card, the card leaving the screen or the Home unmounting stops it.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/ConcertFun.swift ConcertSnippet.
 */
export const SNIPPET_MS = 15_000

let playingId: string | null = null
let audio: HTMLAudioElement | null = null
let timer: number | null = null
const listeners = new Set<() => void>()
let musicRoot: string | null = null

const emit = (): void => { for (const l of listeners) l() }

export function subscribeSnippet(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function snippetPlaying(): string | null {
  return playingId
}

/** Every start path below has its stop here. */
export function stopSnippet(id?: string): void {
  if (id !== undefined && id !== playingId) return
  if (timer !== null) { window.clearTimeout(timer); timer = null }
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }
  audio = null
  if (playingId !== null) { playingId = null; emit() }
}

/** Start (or, for the playing card, stop) a card's snippet. `pauseMain`
 *  pauses the user's music first, like the quiz. */
export async function toggleSnippet(id: string, track: { path?: string; duration?: number } | null, pauseMain: () => void): Promise<void> {
  if (playingId === id) { stopSnippet(); return }
  stopSnippet()
  if (!track?.path) return
  if (musicRoot === null) musicRoot = await window.electronAPI.getMusicLibraryPath().catch(() => '')
  const url = 'ipod-audio://' + encodeURIComponent((musicRoot || '') + track.path.replace(/:/g, '/'))
  pauseMain()
  const a = new Audio(url)
  audio = a
  playingId = id
  emit()
  const durS = (Number(track.duration) || 0) / 1000
  const start = durS > 30 ? durS / 3 : 0
  a.addEventListener('loadedmetadata', () => {
    if (audio !== a) return
    if (start > 0 && Number.isFinite(a.duration) && start < a.duration - 5) a.currentTime = start
    void a.play().catch(() => { if (audio === a) stopSnippet() })
  }, { once: true })
  a.addEventListener('ended', () => { if (audio === a) stopSnippet() }, { once: true })
  a.addEventListener('error', () => { if (audio === a) stopSnippet() }, { once: true })
  // Fifteen seconds of sound, counted from when it starts playing; a stream
  // that never starts gives up after a few seconds more.
  timer = window.setTimeout(() => { if (audio === a) stopSnippet() }, SNIPPET_MS + 6000)
  a.addEventListener('playing', () => {
    if (audio !== a) return
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => { if (audio === a) stopSnippet() }, SNIPPET_MS)
  }, { once: true })
}
