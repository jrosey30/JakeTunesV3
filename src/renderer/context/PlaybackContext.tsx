import { createContext, useContext, useReducer, useEffect, useRef, ReactNode } from 'react'
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
  // 4.4.56: snapshot of the queue's natural order, captured when
  // shuffle is turned ON, so turning it OFF can honestly restore that
  // order. null whenever there's nothing to restore to.
  originalQueue: Track[] | null
  queueIndex: number
  recentlyPlayed: number[]
  shuffleHistory: number[]
}

type PlaybackAction =
  | { type: 'PLAY_TRACK'; track: Track; queue?: Track[]; queueIndex?: number; skipHistory?: boolean; duration?: number; position?: number }
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
  originalQueue: null,
  queueIndex: -1,
  recentlyPlayed: [],
  shuffleHistory: []
}

function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'PLAY_TRACK': {
      // Brief 015: log every PLAY_TRACK dispatch so we can see what
      // queue gets installed and what repeat state was at that
      // moment. If a Songs-view double-click somehow lands with
      // newQueueLength=1 (instead of ~6195), the queue is being
      // truncated somewhere between SongsView.playTrack and here.
      console.log('[dx.repeat.play-track]', {
        trackTitle: action.track.title,
        trackId: action.track.id,
        newQueueLength: (action.queue ?? state.queue).length,
        newQueueIndex: action.queueIndex ?? state.queueIndex,
        prevRepeat: state.repeat,
      })
      const rp = [action.track.id, ...state.recentlyPlayed.filter(id => id !== action.track.id)].slice(0, 50)
      // Push current index to shuffle history when advancing forward in shuffle mode
      const sh = state.shuffle && state.queueIndex >= 0 && !action.skipHistory
        ? [...state.shuffleHistory, state.queueIndex]
        : action.skipHistory ? state.shuffleHistory : state.shuffleHistory
      return {
        ...state,
        nowPlaying: action.track,
        isPlaying: true,
        // Brief 012: read position/duration from the action if the
        // caller has them already (autoplay paths where the new howl
        // is already loaded). Manual clicks omit both, so they fall
        // back to the 0-reset that gives instant visual feedback.
        // Atomic dispatch eliminates the SET_DURATION→PLAY_TRACK race
        // that caused intermittent 0:00 / -0:00 scrubber on gapless
        // autoplay transitions.
        position: action.position ?? 0,
        duration: action.duration ?? 0,
        queue: action.queue ?? state.queue,
        queueIndex: action.queueIndex ?? state.queueIndex,
        recentlyPlayed: rp,
        shuffleHistory: sh,
        // A fresh play context (new queue passed in) invalidates any
        // pre-shuffle snapshot — it belonged to the previous queue.
        originalQueue: action.queue ? null : state.originalQueue,
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
      // Brief 015: log transitions so we can correlate UI state
      // (toolbar appearance) with actual reducer state. If the toolbar
      // ever shows "off" while state.repeat is 'one', a prior
      // transition wasn't accompanied by a UI update — desync.
      console.log('[dx.repeat.state-change]', { from: state.repeat, to: action.mode })
      return { ...state, repeat: action.mode }
    case 'TOGGLE_SHUFFLE': {
      const newShuffle = !state.shuffle
      if (!newShuffle) {
        // 4.4.56: turning shuffle OFF honestly restores the queue's
        // natural order. Before, it just flipped the flag and left the
        // queue scrambled — "shuffle off" but the Up Next list (and the
        // actual playback order) stayed shuffled. Now we replay the
        // snapshot taken when shuffle went on: keep its original order,
        // drop tracks removed since, append tracks added while shuffled,
        // and re-point queueIndex at whatever's playing now so playback
        // continues seamlessly.
        if (!state.originalQueue) {
          return { ...state, shuffle: false, shuffleHistory: [] }
        }
        const currentIds = new Set(state.queue.map(t => t.id))
        const restored = state.originalQueue.filter(t => currentIds.has(t.id))
        const restoredIds = new Set(restored.map(t => t.id))
        for (const t of state.queue) {
          if (!restoredIds.has(t.id)) restored.push(t)
        }
        const np = state.nowPlaying
        let idx = np ? restored.indexOf(np) : -1
        if (idx < 0 && np) idx = restored.findIndex(t => t.id === np.id)
        return {
          ...state,
          shuffle: false,
          shuffleHistory: [],
          queue: restored,
          queueIndex: idx >= 0 ? idx : Math.min(state.queueIndex, restored.length - 1),
          originalQueue: null,
        }
      }
      // Turning shuffle ON — snapshot the natural order first so OFF can
      // restore it, then Fisher-Yates the upcoming queue so the visible
      // Up Next list reflects the new playback order. Past tracks
      // (queueIndex and earlier) stay put — they're history.
      const upcoming = state.queue.slice(state.queueIndex + 1)
      for (let i = upcoming.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]]
      }
      return {
        ...state,
        shuffle: true,
        shuffleHistory: [],
        originalQueue: [...state.queue],
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

// Brief 015c: wrap playbackReducer so we can see EVERY reducer
// invocation — including ones triggered by dispatch paths the
// existing per-case dx.repeat.* logs don't cover (any action that
// touches queueIndex/queue length/nowPlaying but isn't PLAY_TRACK
// or SET_REPEAT). Hunting an auto-repeat bug whose smoking-gun
// observation (sameTrack=true at advance) means queueIndex was
// reset between PLAY_TRACK and the next natural-end with no
// existing log capturing the reset.
function loggingReducer(prevState: PlaybackState, action: PlaybackAction): PlaybackState {
  const nextState = playbackReducer(prevState, action)
  const queueIdxChanged = prevState.queueIndex !== nextState.queueIndex
  const queueLenChanged = prevState.queue.length !== nextState.queue.length
  const trackChanged = prevState.nowPlaying?.id !== nextState.nowPlaying?.id
  if (queueIdxChanged || queueLenChanged || trackChanged) {
    console.log('[dx.repeat.reducer.call]', {
      src: 'loggingReducer',
      actionType: action.type,
      prev: {
        queueIndex: prevState.queueIndex,
        queueLength: prevState.queue.length,
        nowPlayingId: prevState.nowPlaying?.id ?? null,
        nowPlayingTitle: prevState.nowPlaying?.title ?? null,
      },
      next: {
        queueIndex: nextState.queueIndex,
        queueLength: nextState.queue.length,
        nowPlayingId: nextState.nowPlaying?.id ?? null,
        nowPlayingTitle: nextState.nowPlaying?.title ?? null,
      },
      queueIdxChanged,
      queueLenChanged,
      trackChanged,
    })
  }
  return nextState
}

const PlaybackContext = createContext<{
  state: PlaybackState
  dispatch: React.Dispatch<PlaybackAction>
} | null>(null)

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(loggingReducer, initialState)

  // Brief 015c: every render, compare current state to the previous
  // snapshot. If queueIndex/queue.length/nowPlaying changed without a
  // matching loggingReducer call also logging the same change, we have
  // evidence of state mutation outside the reducer (or a provider re-
  // mount that reset state). No dependency array on purpose — runs on
  // every render so we see every shape change.
  const prevSnapshotRef = useRef<{
    queueIndex: number
    queueLength: number
    nowPlayingId: number | null
    ts: number
  } | null>(null)
  useEffect(() => {
    const snapshot = {
      queueIndex: state.queueIndex,
      queueLength: state.queue.length,
      nowPlayingId: state.nowPlaying?.id ?? null,
      ts: Date.now(),
    }
    const prev = prevSnapshotRef.current
    if (prev) {
      const idxChanged = prev.queueIndex !== snapshot.queueIndex
      const lenChanged = prev.queueLength !== snapshot.queueLength
      const trackChanged = prev.nowPlayingId !== snapshot.nowPlayingId
      if (idxChanged || lenChanged || trackChanged) {
        console.log('[dx.repeat.snapshot.changed]', {
          src: 'renderSnapshotEffect',
          deltaMs: snapshot.ts - prev.ts,
          prev,
          next: snapshot,
          idxChanged,
          lenChanged,
          trackChanged,
        })
      }
    }
    prevSnapshotRef.current = snapshot
  })

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
