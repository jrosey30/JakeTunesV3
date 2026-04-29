// On-device queue for mobile play-count + skip-count overrides that
// will eventually merge back into the desktop library.
//
// ⚠️ TWIN: src/main/library-overrides.ts (consumer). The desktop
// merge gates application on `audioFingerprint` per the identity
// rule (CLAUDE.md → Identity over text). Anything we put on the queue
// that the desktop reads must keep its meaning across versions; bump
// OVERRIDES_QUEUE_VERSION (mobile/src/types.ts) and the desktop
// counterpart in the same commit if the shape changes.
//
// Race notes: the read-modify-write in `add` is not strictly atomic
// against a concurrent reader/writer on AsyncStorage — but the only
// writer is the playbackService background context (events are
// serialized) and the only readers in this commit are
// SettingsView (display) and the manual export action. If we ever
// add a second concurrent writer, replace this with a lock + journal.

import AsyncStorage from '@react-native-async-storage/async-storage'
import type { MobileTrackOverrides, OverridesQueueFile } from '@/types'
import { OVERRIDES_QUEUE_VERSION } from '@/types'

const KEY_QUEUE = 'jt.overridesQueue'
const KEY_DEVICE_ID = 'jt.deviceId'

async function readQueue(): Promise<MobileTrackOverrides[]> {
  const raw = await AsyncStorage.getItem(KEY_QUEUE)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MobileTrackOverrides[]) : []
  } catch {
    // Corrupt queue is recoverable: log + start fresh. Better than
    // crashing the app on every event.
    console.warn('[overrides] queue parse failed, resetting')
    await AsyncStorage.removeItem(KEY_QUEUE)
    return []
  }
}

async function writeQueue(queue: MobileTrackOverrides[]): Promise<void> {
  await AsyncStorage.setItem(KEY_QUEUE, JSON.stringify(queue))
}

// Returns a stable per-install device id. Generated once on first call.
// Used by the export envelope so the desktop can distinguish "this
// device's queue applied twice" from "two devices played the same
// track." Not a security token — opaque string only.
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(KEY_DEVICE_ID)
  if (id) return id
  // 16-byte random hex. Don't depend on uuid lib — keep this
  // dependency-free.
  const bytes = new Uint8Array(16)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  id = `dev-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
  await AsyncStorage.setItem(KEY_DEVICE_ID, id)
  return id
}

export async function listOverrides(): Promise<MobileTrackOverrides[]> {
  return readQueue()
}

// Append a new override. Counts (playCountDelta, skipCountDelta) are
// additive on the desktop side — multiple plays of the same track
// inside a sync window land as multiple queue entries and the
// desktop sums them. We don't coalesce on insert because keeping
// per-event timestamps lets the desktop reconstruct play history if
// it ever wants to.
export async function addOverride(o: MobileTrackOverrides): Promise<void> {
  const queue = await readQueue()
  queue.push(o)
  await writeQueue(queue)
}

// Drop everything currently queued. Called from the manual "clear
// queue" button after the user confirms the desktop applied the
// export successfully. NOT called automatically on export — Phase 0
// transport is file-based and any step can fail; auto-clear would
// lose plays on a bad transfer.
export async function clearOverrides(): Promise<void> {
  await AsyncStorage.removeItem(KEY_QUEUE)
}

// Build the on-disk envelope for export. Pure: no AsyncStorage write.
// The caller decides where to put it.
export async function buildExportFile(): Promise<OverridesQueueFile> {
  const [overrides, deviceId] = await Promise.all([readQueue(), getDeviceId()])
  return {
    version: OVERRIDES_QUEUE_VERSION,
    deviceId,
    exportedAt: new Date().toISOString(),
    overrides,
  }
}

// Convenience helper for the playbackService: record a natural-end
// completion for a track. Carries audioFingerprint so the desktop
// merge can verify identity per the postmortem rule.
export async function recordPlayCompletion(args: {
  trackId: number
  audioFingerprint?: string
}): Promise<void> {
  await addOverride({
    trackId: args.trackId,
    audioFingerprint: args.audioFingerprint,
    playCountDelta: 1,
    lastPlayedAt: Date.now(),
    queuedAt: Date.now(),
  })
}

// Skip-detection helper. Phase 0 is foreground-only; if needed we
// surface the same primitive from playbackService later.
export async function recordSkip(args: {
  trackId: number
  audioFingerprint?: string
}): Promise<void> {
  await addOverride({
    trackId: args.trackId,
    audioFingerprint: args.audioFingerprint,
    skipCountDelta: 1,
    queuedAt: Date.now(),
  })
}
