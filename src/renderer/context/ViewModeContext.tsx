import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'
import { useLibrary } from './LibraryContext'
import { parseViewModes, VIEW_MODES_KEY, type ViewMode } from '../utils/viewModes'

export type { ViewMode }

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
 * stays in List), and across launches (V7, 2026-11-24): saved in ui-state
 * under VIEW_MODES_KEY (utils/viewModes.ts), read once at startup. It used to
 * reset to List on every launch.
 */

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

  // The saved choices, once. A choice made before they arrive wins.
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.loadUiState().then((r) => {
      if (cancelled || !r?.ok || !r.state) return
      const saved = parseViewModes((r.state as Record<string, unknown>)[VIEW_MODES_KEY])
      setModeByView((prev) => ({ ...saved, ...prev }))
    }, () => {})
    return () => { cancelled = true }
  }, [])

  const mode = modeByView[key] ?? 'list'
  const setMode = useCallback((m: ViewMode) => {
    setModeByView((prev) => {
      const next = { ...prev, [key]: m }
      // ui-state merges a partial save (main/ipc/ui-state-ipc.ts), so only this key is written.
      void window.electronAPI.saveUiState({ [VIEW_MODES_KEY]: next })
      return next
    })
  }, [key])

  return <ViewModeContext.Provider value={{ mode, setMode }}>{children}</ViewModeContext.Provider>
}

export function useViewMode(): ViewModeApi {
  const ctx = useContext(ViewModeContext)
  if (!ctx) throw new Error('useViewMode must be inside ViewModeProvider')
  return ctx
}
