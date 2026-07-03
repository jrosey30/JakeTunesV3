import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { useLibrary } from './LibraryContext'

/**
 * V5 facelift: List / Grid / Cover Flow view-mode state for the flat-table
 * views (Songs, Playlists, Smart Playlists).
 *
 * Deliberately an OBSERVER on top of LibraryContext (do-not-touch), same
 * architectural pattern as NavigationContext: it reads lib.currentView /
 * active ids to derive a per-view scope key, owns its own local state, and
 * makes zero reducer changes.
 *
 * Modes are remembered PER VIEW (Songs can sit in Grid while a playlist
 * stays in List). In-memory only — resets to 'list' each launch. (The
 * renderer can't use localStorage per project rules; if persistence is
 * ever wanted, it goes through electron-store IPC like column state.)
 */

export type ViewMode = 'list' | 'grid' | 'coverflow'

interface ViewModeApi {
  mode: ViewMode
  setMode: (m: ViewMode) => void
}

const ViewModeContext = createContext<ViewModeApi | null>(null)

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const { state: lib } = useLibrary()
  const [modeByView, setModeByView] = useState<Record<string, ViewMode>>({})

  const key = lib.currentView === 'playlist'
    ? `playlist:${lib.activePlaylistId ?? ''}`
    : lib.currentView === 'smart-playlist'
      ? `smart:${lib.activeSmartPlaylist ?? ''}`
      : lib.currentView

  const mode = modeByView[key] ?? 'list'
  const setMode = useCallback((m: ViewMode) => {
    setModeByView(prev => ({ ...prev, [key]: m }))
  }, [key])

  return <ViewModeContext.Provider value={{ mode, setMode }}>{children}</ViewModeContext.Provider>
}

export function useViewMode(): ViewModeApi {
  const ctx = useContext(ViewModeContext)
  if (!ctx) throw new Error('useViewMode must be inside ViewModeProvider')
  return ctx
}
