import { createContext, useContext, useReducer, ReactNode } from 'react'
import { Track, RepeatMode } from '../types'

interface PlaybackState {
  nowPlaying: Track | null
  isPlaying: boolean
  position: number
  duration: number
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  queue: Track[]
  queueIndex: number
  recentlyPlayed: number[]
  shuffleHistory: number[]
}

type PlaybackAction =
  | { type: 'PLAY_TRACK'; track: Track; queue?: Track[]; queueIndex?: number; skipHistory?: boolean }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'SET_POSITION'; position: number }
  | { type: 'SET_DURATION'; duration: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'SET_REPEAT'; mode: RepeatMode }
  | { type: 'TOGGLE_SHUFFLE' }
  | { type: 'NEXT_TRACK' }
  | { type: 'PREV_TRACK' }
  | { type: 'ADD_TO_QUEUE'; tracks: Track[] }
  | { type: 'PLAY_NEXT'; tracks: Track[] }
  | { type: 'REMOVE_FROM_QUEUE'; index: number }
  | { type: 'INSERT_IN_QUEUE'; tracks: Track[]; atIndex: number }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'SHUFFLE_QUEUE' }
  | { type: 'MOVE_IN_QUEUE'; fromIndex: number; toIndex: number }
  | { type: 'SET_SHUFFLE_HISTORY'; history: number[] }

const initialState: PlaybackState = {
  nowPlaying: null,
  isPlaying: false,
  position: 0,
  duration: 0,
  volume: 0.8,
  repeat: 'off',
  shuffle: false,
  queue: [],
  queueIndex: -1,
  recentlyPlayed: [],
  shuffleHistory: []
}

function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'PLAY_TRACK': {
      const rp = [action.track.id, ...state.recentlyPlayed.filter(id => id !== action.track.id)].slice(0, 50)
      // Push current index to shuffle history when advancing forward in shuffle mode
      const sh = state.shuffle && state.queueIndex >= 0 && !action.skipHistory
        ? [...state.shuffleHistory, state.queueIndex]
        : action.skipHistory ? state.shuffleHistory : state.shuffleHistory
      return {
        ...state,
        nowPlaying: action.track,
        isPlaying: true,
        position: 0,
        duration: 0,
        queue: action.queue ?? state.queue,
        queueIndex: action.queueIndex ?? state.queueIndex,
        recentlyPlayed: rp,
        shuffleHistory: sh
      }
    }
    case 'PAUSE':
      return { ...state, isPlaying: false }
    case 'RESUME':
      return { ...state, isPlaying: true }
    case 'STOP':
      return { ...state, isPlaying: false, nowPlaying: null, position: 0, duration: 0 }
    case 'SET_POSITION':
      return { ...state, position: action.position }
    case 'SET_DURATION':
      return { ...state, duration: action.duration }
    case 'SET_VOLUME':
      return { ...state, volume: action.volume }
    case 'SET_REPEAT':
      return { ...state, repeat: action.mode }
    case 'TOGGLE_SHUFFLE': {
      const newShuffle = !state.shuffle
      // When turning shuffle ON, Fisher-Yates the upcoming queue so the
      // visible Up Next list reflects the new playback order. Past tracks
      // (queueIndex and earlier) stay put — they're history. Without this,
      // shuffle was just a flag that picked random tracks per natural-end
      // while the displayed Up Next stayed unchanged — looked like
      // "skipping lots of songs in the queue."
      if (!newShuffle) {
        return { ...state, shuffle: false, shuffleHistory: [] }
      }
      const upcoming = state.queue.slice(state.queueIndex + 1)
      for (let i = upcoming.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]]
      }
      return {
        ...state,
        shuffle: true,
        shuffleHistory: [],
        queue: [...state.queue.slice(0, state.queueIndex + 1), ...upcoming],
      }
    }
    case 'NEXT_TRACK': {
      if (state.queue.length === 0) return state
      let nextIdx = state.queueIndex + 1
      if (nextIdx >= state.queue.length) {
        if (state.repeat === 'all') nextIdx = 0
        else return { ...state, isPlaying: false }
      }
      return {
        ...state,
        nowPlaying: state.queue[nextIdx],
        queueIndex: nextIdx,
        isPlaying: true,
        position: 0,
        duration: 0
      }
    }
    case 'PREV_TRACK': {
      if (state.queue.length === 0) return state
      if (state.position > 3) {
        return { ...state, position: 0 }
      }
      let prevIdx = state.queueIndex - 1
      if (prevIdx < 0) prevIdx = state.repeat === 'all' ? state.queue.length - 1 : 0
      return {
        ...state,
        nowPlaying: state.queue[prevIdx],
        queueIndex: prevIdx,
        isPlaying: true,
        position: 0,
        duration: 0
      }
    }
    case 'ADD_TO_QUEUE': {
      const newQueue = [...state.queue, ...action.tracks]
      return { ...state, queue: newQueue }
    }
    case 'PLAY_NEXT': {
      const insertAt = state.queueIndex + 1
      const newQueue = [...state.queue]
      newQueue.splice(insertAt, 0, ...action.tracks)
      return { ...state, queue: newQueue }
    }
    case 'REMOVE_FROM_QUEUE': {
      const newQueue = state.queue.filter((_, i) => i !== action.index)
      const newIdx = action.index < state.queueIndex ? state.queueIndex - 1 : state.queueIndex
      return { ...state, queue: newQueue, queueIndex: newIdx }
    }
    case 'INSERT_IN_QUEUE': {
      const newQueue = [...state.queue]
      newQueue.splice(action.atIndex, 0, ...action.tracks)
      return { ...state, queue: newQueue }
    }
    case 'CLEAR_QUEUE': {
      // Keep only the currently playing track
      if (state.nowPlaying) {
        return { ...state, queue: [state.nowPlaying], queueIndex: 0 }
      }
      return { ...state, queue: [], queueIndex: -1 }
    }
    case 'SHUFFLE_QUEUE': {
      // Fisher-Yates shuffle of everything after the current track
      const upcoming = state.queue.slice(state.queueIndex + 1)
      for (let i = upcoming.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]]
      }
      return { ...state, queue: [...state.queue.slice(0, state.queueIndex + 1), ...upcoming] }
    }
    case 'MOVE_IN_QUEUE': {
      // Drag-reorder support inside QueuePanel. fromIndex and toIndex
      // are absolute queue positions. toIndex is a "drop slot" — a value
      // of N means "place item before the item currently at index N",
      // so toIndex == queue.length pushes to the end. Adjust queueIndex
      // if the move shifts the currently-playing item or shifts items
      // around it.
      const { fromIndex, toIndex } = action
      if (fromIndex < 0 || fromIndex >= state.queue.length) return state
      if (toIndex < 0 || toIndex > state.queue.length) return state
      if (fromIndex === toIndex || fromIndex + 1 === toIndex) return state
      const newQueue = [...state.queue]
      const [moved] = newQueue.splice(fromIndex, 1)
      const adjustedTo = toIndex > fromIndex ? toIndex - 1 : toIndex
      newQueue.splice(adjustedTo, 0, moved)
      let newQueueIndex = state.queueIndex
      if (fromIndex === state.queueIndex) {
        newQueueIndex = adjustedTo
      } else if (fromIndex < state.queueIndex && adjustedTo >= state.queueIndex) {
        newQueueIndex = state.queueIndex - 1
      } else if (fromIndex > state.queueIndex && adjustedTo <= state.queueIndex) {
        newQueueIndex = state.queueIndex + 1
      }
      return { ...state, queue: newQueue, queueIndex: newQueueIndex }
    }
    case 'SET_SHUFFLE_HISTORY':
      return { ...state, shuffleHistory: action.history }
    default:
      return state
  }
}

const PlaybackContext = createContext<{
  state: PlaybackState
  dispatch: React.Dispatch<PlaybackAction>
} | null>(null)

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(playbackReducer, initialState)
  return (
    <PlaybackContext.Provider value={{ state, dispatch }}>
      {children}
    </PlaybackContext.Provider>
  )
}

export function usePlayback() {
  const ctx = useContext(PlaybackContext)
  if (!ctx) throw new Error('usePlayback must be inside PlaybackProvider')
  return ctx
}
