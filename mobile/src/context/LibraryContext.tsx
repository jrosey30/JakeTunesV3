// In-memory library state, hydrated from on-device cache first, then
// refreshed from the NAS-hosted library.json. Mirrors the desktop's
// LibraryContext shape (tracks, playlists) so view code reads the
// same way.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { LibrarySnapshot, Playlist, Track } from '@/types'
import { storage } from '@/services/storage'
import { fetchLibrarySnapshot } from '@/services/nas/libraryFetcher'
import { useConnection } from '@/context/ConnectionContext'

interface LibraryContextValue {
  tracks: Track[]
  playlists: Playlist[]
  loading: boolean
  lastRefreshedAt: string | null
  error: string | null
  refresh: () => Promise<void>
}

const Ctx = createContext<LibraryContextValue | null>(null)

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const { client, state } = useConnection()
  const [tracks, setTracks] = useState<Track[]>([])
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Hydrate from cache on mount so the user sees something instantly
  // even when offline. Server refresh runs in the background.
  useEffect(() => {
    void (async () => {
      const cached = (await storage.loadLibraryCache()) as LibrarySnapshot | null
      if (cached) {
        setTracks(cached.tracks)
        setPlaylists(cached.playlists)
        setLastRefreshedAt(cached.exportedAt)
      }
    })()
  }, [])

  const refresh = useCallback(async () => {
    if (!client) {
      setError('Not configured: open Settings → NAS to point at your Synology')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await fetchLibrarySnapshot(client)
      if (!result.ok || !result.snapshot) {
        setError(result.error ?? 'Unknown error')
        return
      }
      setTracks(result.snapshot.tracks)
      setPlaylists(result.snapshot.playlists)
      setLastRefreshedAt(result.snapshot.exportedAt)
      await storage.saveLibraryCache(result.snapshot)
    } finally {
      setLoading(false)
    }
  }, [client])

  // Auto-refresh once we transition to connected.
  useEffect(() => {
    if (state.status === 'connected') void refresh()
  }, [state.status, refresh])

  const value = useMemo<LibraryContextValue>(
    () => ({ tracks, playlists, loading, lastRefreshedAt, error, refresh }),
    [tracks, playlists, loading, lastRefreshedAt, error, refresh],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useLibrary(): LibraryContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useLibrary must be used inside <LibraryProvider>')
  return v
}
