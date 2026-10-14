/**
 * Brief 162 — playback-state persistence: the pure half.
 *
 * PlaybackContext persists { queueIds, queueIndex, trackId, position,
 * volume } into ui-state.json through the EXISTING load/save-ui-state
 * IPC (src/main/ipc/ui-state-ipc.ts — main deep-merges top-level keys,
 * so `playbackState` never clobbers layout state; localStorage is
 * banned in this renderer and is not used). On launch the saved shape
 * is parsed defensively here and resolved against the live library:
 * IDs that no longer exist drop out, the index re-points at the
 * track that was playing, and the position is clamped inside it.
 *
 * The restore is PAUSED by construction — PlaybackContext dispatches
 * it with isPlaying false. No auto-audio on launch, ever.
 *
 * Deliberately structural (no Track import): PlaybackContext passes
 * real Tracks; the unit tests pass minimal fixtures.
 */

export interface RestorableTrack {
  id: number
  /** Milliseconds, as Track.duration carries it. */
  duration?: number
}

export interface PersistedPlayback {
  queueIds: number[]
  queueIndex: number
  trackId: number | null
  /** Seconds. */
  position: number
  /** 0..1. */
  volume: number
  savedAt: number
}

export interface PlaybackSnapshotSource {
  queue: ReadonlyArray<{ id: number }>
  queueIndex: number
  nowPlaying: { id: number } | null
  position: number
  volume: number
}

const MAX_PERSISTED_QUEUE = 1000

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8
}

/** State → the shape stored under ui-state's `playbackState` key. */
export function snapshotPlayback(s: PlaybackSnapshotSource): PersistedPlayback {
  return {
    queueIds: s.queue.map((t) => t.id).slice(0, MAX_PERSISTED_QUEUE),
    queueIndex: s.queueIndex,
    trackId: s.nowPlaying?.id ?? null,
    position: Number.isFinite(s.position) && s.position > 0 ? s.position : 0,
    volume: clampVolume(s.volume),
    savedAt: Date.now(),
  }
}

/**
 * Parse a stored `playbackState` value. Anything malformed → null
 * (nothing to restore is a normal first-run outcome, not an error).
 * An empty queue → null: there is nothing to restore INTO, and the
 * next real save overwrites the key anyway.
 */
export function parsePersistedPlayback(raw: unknown): PersistedPlayback | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o['queueIds'])) return null
  const queueIds = o['queueIds']
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    .slice(0, MAX_PERSISTED_QUEUE)
  if (queueIds.length === 0) return null
  return {
    queueIds,
    queueIndex:
      typeof o['queueIndex'] === 'number' && Number.isFinite(o['queueIndex'])
        ? Math.trunc(o['queueIndex'])
        : -1,
    trackId:
      typeof o['trackId'] === 'number' && Number.isFinite(o['trackId'])
        ? o['trackId']
        : null,
    position:
      typeof o['position'] === 'number' && Number.isFinite(o['position']) && o['position'] > 0
        ? o['position']
        : 0,
    volume: typeof o['volume'] === 'number' ? clampVolume(o['volume']) : 0.8,
    savedAt: typeof o['savedAt'] === 'number' && Number.isFinite(o['savedAt']) ? o['savedAt'] : 0,
  }
}

/**
 * Resolve a persisted snapshot against the live library. Missing IDs
 * drop out silently (tracks get deleted; a restore must not invent
 * them). The index follows the PLAYING track when it survives —
 * indices shift when earlier queue entries drop — and the position
 * clamps to just inside the track's end.
 */
export function resolveRestoredQueue<T extends RestorableTrack>(
  p: PersistedPlayback,
  tracksById: ReadonlyMap<number, T>,
): { queue: T[]; queueIndex: number; track: T; position: number } | null {
  const queue: T[] = []
  for (const id of p.queueIds) {
    const t = tracksById.get(id)
    if (t) queue.push(t)
  }
  if (queue.length === 0) return null
  let idx = p.trackId != null ? queue.findIndex((t) => t.id === p.trackId) : -1
  if (idx < 0) idx = Math.min(Math.max(p.queueIndex, 0), queue.length - 1)
  const track = queue[idx]
  const durSec = (track.duration || 0) / 1000
  const position = durSec > 0 ? Math.min(p.position, Math.max(0, durSec - 1)) : p.position
  return { queue, queueIndex: idx, track, position }
}
