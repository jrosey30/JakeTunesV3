/**
 * Tap to hear, for the Top 1000 quiz and its blind check: a 20-second snippet
 * from the song's hook (homemini's hookMs; about a third of the way in when it
 * has none), through the same ipod-audio:// path the player uses, so it works
 * on every Mac. Starting a snippet pauses whatever is playing. Lifted out of
 * Top1000QuizView unchanged so both screens play exactly the same way.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from './useAudio'
import type { QuizSongRef } from '../../common/top1000-doc'
import type { Track } from '../types'

const SNIPPET_MS = 20_000

let musicRoot: string | null = null
async function snippetUrl(colonPath: string): Promise<string | null> {
  if (!colonPath) return null
  if (musicRoot === null) musicRoot = await window.electronAPI.getMusicLibraryPath().catch(() => '')
  return 'ipod-audio://' + encodeURIComponent((musicRoot || '') + colonPath.replace(/:/g, '/'))
}

export function useQuizSnippet(byId: Map<number, Track>): {
  hearing: number | null
  hear: (song: QuizSongRef) => Promise<void>
  stopSnippet: () => void
} {
  const { state: pb } = usePlayback()
  const { togglePlayPause } = useAudio()
  const [hearing, setHearing] = useState<number | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopTimer = useRef<number | null>(null)

  // Every start path below has its stop path here.
  const stopSnippet = useCallback(() => {
    if (stopTimer.current !== null) { window.clearTimeout(stopTimer.current); stopTimer.current = null }
    const a = audioRef.current
    if (a) { a.pause(); a.removeAttribute('src'); a.load() }
    audioRef.current = null
    setHearing(null)
  }, [])

  useEffect(() => stopSnippet, [stopSnippet])

  const hear = useCallback(async (song: QuizSongRef) => {
    if (hearing === song.id) { stopSnippet(); return }
    stopSnippet()
    const url = await snippetUrl(byId.get(song.id)?.path || '')
    if (!url) return
    if (pb.isPlaying) togglePlayPause()
    const a = new Audio(url)
    audioRef.current = a
    setHearing(song.id)
    a.addEventListener('loadedmetadata', () => {
      if (audioRef.current !== a) return
      if (song.hookMs > 0 && Number.isFinite(a.duration) && song.hookMs / 1000 < a.duration - 5) a.currentTime = song.hookMs / 1000
      void a.play().catch(() => { if (audioRef.current === a) stopSnippet() })
    }, { once: true })
    a.addEventListener('ended', () => { if (audioRef.current === a) stopSnippet() }, { once: true })
    a.addEventListener('error', () => { if (audioRef.current === a) stopSnippet() }, { once: true })
    stopTimer.current = window.setTimeout(() => { if (audioRef.current === a) stopSnippet() }, SNIPPET_MS + 4000)
  }, [hearing, stopSnippet, byId, pb.isPlaying, togglePlayPause])

  return { hearing, hear, stopSnippet }
}
