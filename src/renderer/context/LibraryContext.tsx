import { createContext, useContext, useReducer, ReactNode } from 'react'
import { Track, Playlist, ViewName, SmartPlaylistId, SortColumn, SortDirection } from '../types'

interface LibraryState {
  tracks: Track[]
  playlists: Playlist[]
  activePlaylistId: string | null
  activeSmartPlaylist: SmartPlaylistId | null
  currentView: ViewName
  searchQuery: string
  sortColumn: SortColumn
  sortDirection: SortDirection
  selectedTrackIds: Set<number>
  artworkMap: Record<string, string>
}

type LibraryAction =
  | { type: 'SET_TRACKS'; tracks: Track[] }
  | { type: 'ADD_IMPORTED_TRACKS'; tracks: Track[] }
  | { type: 'SET_VIEW'; view: ViewName }
  | { type: 'SET_SEARCH'; query: string }
  | { type: 'SET_SORT'; column: SortColumn }
  | { type: 'SELECT_TRACK'; id: number; multi?: boolean }
  | { type: 'SELECT_RANGE'; ids: number[] }
  | { type: 'SELECT_ALL' }
  | { type: 'SELECT_NONE' }
  | { type: 'UPDATE_TRACKS'; updates: { id: number; field: string; value: string }[] }
  | { type: 'LOAD_PLAYLISTS'; playlists: Playlist[] }
  | { type: 'ADD_PLAYLIST'; playlist: Playlist }
  | { type: 'REMOVE_PLAYLIST'; id: string }
  | { type: 'RENAME_PLAYLIST'; id: string; name: string }
  | { type: 'ADD_TRACKS_TO_PLAYLIST'; playlistId: string; trackIds: number[] }
  | { type: 'REMOVE_TRACKS_FROM_PLAYLIST'; playlistId: string; trackIds: number[] }
  | { type: 'REORDER_PLAYLIST'; playlistId: string; trackIds: number[] }
  | { type: 'RESTORE_TRACKS_TO_PLAYLIST'; playlistId: string; trackIds: number[]; atIndex: number }
  | { type: 'VIEW_PLAYLIST'; id: string }
  | { type: 'VIEW_SMART_PLAYLIST'; id: SmartPlaylistId }
  | { type: 'SET_ARTWORK_MAP'; map: Record<string, string> }
  | { type: 'ADD_ARTWORK'; key: string; hash: string }
  | { type: 'REMOVE_ARTWORK'; key: string }
  | { type: 'DELETE_TRACKS'; ids: number[] }

const initialState: LibraryState = {
  tracks: [],
  playlists: [],
  activePlaylistId: null,
  activeSmartPlaylist: null,
  currentView: 'songs',
  searchQuery: '',
  sortColumn: 'dateAdded',
  sortDirection: 'desc',
  selectedTrackIds: new Set(),
  artworkMap: {}
}

function libraryReducer(state: LibraryState, action: LibraryAction): LibraryState {
  switch (action.type) {
    case 'SET_TRACKS':
      return { ...state, tracks: action.tracks }
    case 'ADD_IMPORTED_TRACKS': {
      const existingIds = new Set(state.tracks.map(t => t.id))
      const newTracks = action.tracks.filter(t => !existingIds.has(t.id))
      return { ...state, tracks: [...state.tracks, ...newTracks] }
    }
    case 'SET_VIEW':
      return { ...state, currentView: action.view }
    case 'SET_SEARCH':
      return { ...state, searchQuery: action.query }
    case 'SET_SORT': {
      const direction =
        state.sortColumn === action.column && state.sortDirection === 'asc' ? 'desc' : 'asc'
      return { ...state, sortColumn: action.column, sortDirection: direction }
    }
    case 'SELECT_TRACK': {
      const next = new Set(action.multi ? state.selectedTrackIds : [])
      if (next.has(action.id) && action.multi) {
        next.delete(action.id)
      } else {
        next.add(action.id)
      }
      return { ...state, selectedTrackIds: next }
    }
    case 'SELECT_RANGE':
      return { ...state, selectedTrackIds: new Set(action.ids) }
    case 'SELECT_ALL':
      return { ...state, selectedTrackIds: new Set(state.tracks.map(t => t.id)) }
    case 'SELECT_NONE':
      return { ...state, selectedTrackIds: new Set() }
    case 'UPDATE_TRACKS': {
      const NUMERIC_FIELDS = new Set(['year', 'trackNumber', 'trackCount', 'discNumber', 'discCount', 'playCount', 'rating', 'duration', 'fileSize'])
      const updateMap = new Map<number, { field: string; value: string }[]>()
      for (const u of action.updates) {
        const list = updateMap.get(u.id) || []
        list.push(u)
        updateMap.set(u.id, list)
      }
      const tracks = state.tracks.map(t => {
        const ups = updateMap.get(t.id)
        if (!ups) return t
        const updated = { ...t }
        for (const u of ups) {
          const val = NUMERIC_FIELDS.has(u.field) ? (Number(u.value) || 0) : u.value;
          (updated as Record<string, unknown>)[u.field] = val
        }
        return updated as Track
      })
      return { ...state, tracks }
    }
    case 'LOAD_PLAYLISTS':
      return { ...state, playlists: action.playlists }
    case 'ADD_PLAYLIST': {
      const exists = state.playlists.some(p => p.id === action.playlist.id)
      if (exists) return state
      return { ...state, playlists: [...state.playlists, action.playlist] }
    }
    case 'REMOVE_PLAYLIST':
      return {
        ...state,
        playlists: state.playlists.filter(p => p.id !== action.id),
        activePlaylistId: state.activePlaylistId === action.id ? null : state.activePlaylistId,
        currentView: state.activePlaylistId === action.id ? 'songs' : state.currentView,
      }
    case 'RENAME_PLAYLIST':
      return {
        ...state,
        playlists: state.playlists.map(p => p.id === action.id ? { ...p, name: action.name } : p),
      }
    case 'ADD_TRACKS_TO_PLAYLIST': {
      const playlists = state.playlists.map(p => {
        if (p.id !== action.playlistId) return p
        const existing = new Set(p.trackIds)
        const newIds = action.trackIds.filter(id => !existing.has(id))
        if (newIds.length === 0) return p
        return { ...p, trackIds: [...newIds, ...p.trackIds] }
      })
      return { ...state, playlists }
    }
    case 'REMOVE_TRACKS_FROM_PLAYLIST': {
      const removeSet = new Set(action.trackIds)
      const playlists = state.playlists.map(p => {
        if (p.id !== action.playlistId) return p
        return { ...p, trackIds: p.trackIds.filter(id => !removeSet.has(id)) }
      })
      return { ...state, playlists }
    }
    case 'REORDER_PLAYLIST': {
      const playlists = state.playlists.map(p => {
        if (p.id !== action.playlistId) return p
        return { ...p, trackIds: action.trackIds }
      })
      return { ...state, playlists }
    }
    case 'RESTORE_TRACKS_TO_PLAYLIST': {
      const playlists = state.playlists.map(p => {
        if (p.id !== action.playlistId) return p
        const newIds = [...p.trackIds]
        newIds.splice(action.atIndex, 0, ...action.trackIds)
        return { ...p, trackIds: newIds }
      })
      return { ...state, playlists }
    }
    case 'VIEW_PLAYLIST':
      return { ...state, currentView: 'playlist', activePlaylistId: action.id, activeSmartPlaylist: null }
    case 'VIEW_SMART_PLAYLIST':
      return { ...state, currentView: 'smart-playlist', activeSmartPlaylist: action.id, activePlaylistId: null }
    case 'SET_ARTWORK_MAP':
      return { ...state, artworkMap: action.map }
    case 'ADD_ARTWORK':
      return { ...state, artworkMap: { ...state.artworkMap, [action.key]: action.hash } }
    case 'REMOVE_ARTWORK': {
      const newMap = { ...state.artworkMap }
      delete newMap[action.key]
      return { ...state, artworkMap: newMap }
    }
    case 'DELETE_TRACKS': {
      const removeSet = new Set(action.ids)
      const tracks = state.tracks.filter(t => !removeSet.has(t.id))
      const playlists = state.playlists.map(p => ({
        ...p,
        trackIds: p.trackIds.filter(id => !removeSet.has(id)),
      }))
      const selectedTrackIds = new Set(
        [...state.selectedTrackIds].filter(id => !removeSet.has(id))
      )
      return { ...state, tracks, playlists, selectedTrackIds }
    }
    default:
      return state
  }
}

const LibraryContext = createContext<{
  state: LibraryState
  dispatch: React.Dispatch<LibraryAction>
} | null>(null)

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(libraryReducer, initialState)
  return (
    <LibraryContext.Provider value={{ state, dispatch }}>
      {children}
    </LibraryContext.Provider>
  )
}

export function useLibrary() {
  const ctx = useContext(LibraryContext)
  if (!ctx) throw new Error('useLibrary must be inside LibraryProvider')
  return ctx
}
