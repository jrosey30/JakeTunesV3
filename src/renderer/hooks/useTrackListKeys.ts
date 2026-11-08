/**
 * ↑/↓ (⇧ extends), Enter, Space and type-to-find on a song list — the keys
 * SongsView always had, shared so every list behaves the same (Jake,
 * 2026-11-07: "i cant go up and down any playlist with the up down
 * arrows!!!"). Rules and the pure part: utils/trackListKeys.ts.
 *
 * A capture-phase window listener, like SongsView's was: it runs before
 * App.tsx's document handler, and ↑/↓ are CLAIMED (stopPropagation) so the
 * global ↑/↓ = volume doesn't also fire. ←/→ are never touched (transport,
 * or an on-screen Cover Flow's — utils/arrowKeyOwner.ts).
 *
 * The caller owns the refs (its click handler sets them too) and says how
 * selecting, scrolling and playing work for its list. `enabled` must be
 * false unless this list is the view on screen, in list mode.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import type { Track } from '../types'
import { listKeyIntent, nextListIndex, shiftRange, typeToFindIndex, isTypingTarget } from '../utils/trackListKeys'

export interface TrackListKeysOptions {
  enabled: boolean
  /** The rows in the order on screen (the view's current sort). */
  tracks: Track[]
  /** The keyboard cursor (-1 = nothing yet). */
  focusedIdx: MutableRefObject<number>
  /** The ⇧ anchor — the same ref the click handler uses. */
  lastClickedIdx: MutableRefObject<number>
  selectOne: (id: number) => void
  selectRange: (ids: number[]) => void
  scrollToIdx: (idx: number) => void
  play: (idx: number) => void
  /** Currently selected ids (read at key time). */
  getSelectedIds: () => ReadonlySet<number>
  /** Something is loaded in the player (Space then stays play/pause). */
  hasNowPlaying: () => boolean
}

export function useTrackListKeys(opts: TrackListKeysOptions): void {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const typeBuffer = useRef('')
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { enabled } = opts

  useEffect(() => {
    if (!enabled) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('.getinfo-overlay')) return
      if (isTypingTarget(e.target as HTMLElement | null)) return
      const intent = listKeyIntent(e)
      if (!intent) return
      const o = optsRef.current
      const tracks = o.tracks

      if (intent.kind === 'move') {
        e.preventDefault()
        // Claim ↑/↓: without this App.tsx's global handler moves the volume too.
        e.stopPropagation()
        const next = nextListIndex(o.focusedIdx.current, intent.dir, tracks.length)
        const track = next >= 0 ? tracks[next] : undefined
        if (!track) return
        o.focusedIdx.current = next
        if (intent.extend) {
          const { from, to } = shiftRange(o.lastClickedIdx.current, next)
          o.selectRange(tracks.slice(from, to + 1).map(t => t.id))
        } else {
          o.selectOne(track.id)
          o.lastClickedIdx.current = next
        }
        o.scrollToIdx(next)
        return
      }

      if (intent.kind === 'enter') {
        const idx = o.focusedIdx.current
        if (idx >= 0 && tracks[idx]) {
          e.preventDefault()
          o.play(idx)
        }
        return
      }

      if (intent.kind === 'space') {
        // Mid type-to-find, a space is part of the title being typed.
        if (typeBuffer.current !== '') {
          handleChar(' ')
          return
        }
        // Nothing loaded: Space plays the highlighted row (the iTunes way).
        // Something loaded: leave it to the global play/pause.
        if (!o.hasNowPlaying()) {
          const sel = o.getSelectedIds()
          const idx = o.focusedIdx.current >= 0
            ? o.focusedIdx.current
            : tracks.findIndex(t => sel.has(t.id))
          if (idx >= 0 && tracks[idx]) {
            e.preventDefault()
            e.stopPropagation()   // we're starting playback; App.tsx must not also toggle
            o.focusedIdx.current = idx
            o.play(idx)
          }
        }
        return
      }

      handleChar(intent.char)
    }

    const handleChar = (ch: string) => {
      const o = optsRef.current
      typeBuffer.current += ch
      if (typeTimer.current) clearTimeout(typeTimer.current)
      typeTimer.current = setTimeout(() => { typeBuffer.current = '' }, 800)
      const idx = typeToFindIndex(o.tracks, typeBuffer.current)
      if (idx >= 0) {
        o.focusedIdx.current = idx
        o.lastClickedIdx.current = idx
        o.selectOne(o.tracks[idx].id)
        o.scrollToIdx(idx)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      if (typeTimer.current) clearTimeout(typeTimer.current)
      typeBuffer.current = ''
    }
  }, [enabled])
}
