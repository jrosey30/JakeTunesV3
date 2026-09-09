/**
 * The shop's own record player (2026-09-09, Jake: "when i step into the
 * record store i want songs from my library to play in the background as
 * if i am in a record store. with a volume on/off button").
 *
 * Rules a real shop follows, which this one does too:
 *
 *   • It plays what it STOCKS. The needle drops on tracks from the shelves
 *     you're standing in front of, so the room sounds like the room.
 *   • It never plays over YOUR record. The moment the main player starts,
 *     the shop turns its music down and shuts up; when you stop, it fades
 *     back in. A store that fought your headphones would be a bug.
 *   • It stops at the door. Leaving the view kills it — no music following
 *     you into Songs.
 *
 * Deliberately NOT routed through useAudio/Howler: this is a side channel,
 * one plain <audio> element on the ipod-audio:// protocol (the same trick
 * TapeMonitor and MixtapeMic use). Touching the shared Howl would hijack
 * the queue, and touching Howler.ctx is its own documented disaster.
 */
import { useEffect, useRef } from 'react'

/** Background, not foreground: loud enough to fill the room, quiet enough
 *  to talk over. */
export const AMBIENCE_VOLUME = 0.18
/** Fade in/out so the shop never slams on or cuts dead. */
const FADE_MS = 900
const FADE_STEP_MS = 60

export interface AmbienceTrack { id: number; path: string }

/** Shuffle, but never open with the same record twice in a row. Seeded by
 *  nothing — a shop is different every time you walk in. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function useStoreAmbience(opts: {
  enabled: boolean
  tracks: AmbienceTrack[]
  /** True while the user's OWN player is playing — the shop yields to it. */
  userIsPlaying: boolean
}): void {
  const { enabled, tracks, userIsPlaying } = opts
  const elRef = useRef<HTMLAudioElement | null>(null)
  const orderRef = useRef<AmbienceTrack[]>([])
  const idxRef = useRef(0)
  const fadeRef = useRef<number | null>(null)

  // Keep the running order fresh without restarting the music every time
  // the shelves re-render.
  const tracksKey = tracks.map((t) => t.id).join(',')
  useEffect(() => {
    orderRef.current = shuffled(tracks)
    idxRef.current = 0
  }, [tracksKey])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const clearFade = (): void => {
      if (fadeRef.current !== null) { window.clearInterval(fadeRef.current); fadeRef.current = null }
    }
    const fadeTo = (target: number, done?: () => void): void => {
      const el = elRef.current
      if (!el) return
      clearFade()
      const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP_MS))
      const delta = (target - el.volume) / steps
      let n = 0
      fadeRef.current = window.setInterval(() => {
        const cur = elRef.current
        if (!cur) { clearFade(); return }
        n++
        cur.volume = Math.min(1, Math.max(0, cur.volume + delta))
        if (n >= steps) { cur.volume = target; clearFade(); done?.() }
      }, FADE_STEP_MS)
    }

    const stop = (): void => {
      const el = elRef.current
      if (!el) return
      fadeTo(0, () => { try { el.pause() } catch { /* already gone */ } })
    }

    // Nothing to play, switched off, or the user put their own record on.
    if (!enabled || userIsPlaying || orderRef.current.length === 0) {
      stop()
      return () => clearFade()
    }

    const playNext = (): void => {
      const order = orderRef.current
      if (!order.length) return
      const t = order[idxRef.current % order.length]
      idxRef.current++
      let el = elRef.current
      if (!el) {
        el = new Audio()
        el.addEventListener('ended', playNext)
        // A missing or unplayable file must not end the shop's night.
        el.addEventListener('error', playNext)
        elRef.current = el
      }
      el.src = 'ipod-audio://' + encodeURIComponent(t.path)
      el.volume = 0
      void el.play().then(() => fadeTo(AMBIENCE_VOLUME)).catch(() => { /* autoplay refused; the toggle is a gesture */ })
    }

    const el = elRef.current
    if (el && !el.paused) fadeTo(AMBIENCE_VOLUME)
    else if (el && el.src) { void el.play().then(() => fadeTo(AMBIENCE_VOLUME)).catch(() => {}) }
    else playNext()

    return () => clearFade()
  }, [enabled, userIsPlaying, tracksKey])

  // Leaving the shop stops the music — always, even mid-fade.
  useEffect(() => () => {
    if (fadeRef.current !== null) window.clearInterval(fadeRef.current)
    const el = elRef.current
    if (el) {
      try { el.pause() } catch { /* already gone */ }
      el.src = ''
      elRef.current = null
    }
  }, [])
}
