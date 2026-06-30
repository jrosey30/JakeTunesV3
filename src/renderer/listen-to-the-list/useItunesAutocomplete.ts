import { useCallback, useEffect, useRef, useState } from 'react'
import type { ItunesSuggestion } from '../types'

export function useItunesAutocomplete(song: string, artist: string) {
  const [suggestions, setSuggestions] = useState<ItunesSuggestion[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressRef = useRef(false)
  const searchSeqRef = useRef(0)

  useEffect(() => {
    if (suppressRef.current) {
      suppressRef.current = false
      return
    }
    const q = [song.trim(), artist.trim()].filter(Boolean).join(' ')
    if (q.length < 2) {
      setSuggestions([])
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const seq = ++searchSeqRef.current
      setSearching(true)
      try {
        const res = await window.electronAPI.searchItunes(q)
        if (seq !== searchSeqRef.current) return
        setSuggestions(res.ok ? res.results : [])
      } catch {
        if (seq === searchSeqRef.current) setSuggestions([])
      } finally {
        if (seq === searchSeqRef.current) setSearching(false)
      }
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [song, artist])

  const pick = useCallback((s: ItunesSuggestion) => {
    suppressRef.current = true
    setSuggestions([])
    return { song: s.song, artist: s.artist, album: s.album || '' }
  }, [])

  return { suggestions, searching, pick, clearSuggestions: () => setSuggestions([]) }
}
