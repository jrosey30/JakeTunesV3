/**
 * 4.5.0-78 — Sample-accurate seam scheduler.
 *
 * Why this exists: every pop fix attempted via Howler API tweaks was
 * fighting the same root issue — Howler's `play()` internally calls
 * `AudioBufferSourceNode.start(0)` (start NOW, no absolute-time
 * scheduling). The 3–10 ms of slop between when JS fires the trigger
 * (setTimeout / rAF) and when the audio actually starts is the
 * residual pop, regardless of how the fade duration is timed.
 *
 * This module bypasses Howler for the transition LAYER ONLY:
 *   - `scheduleAbsoluteFadeOut(howl, msUntilEnd)` — uses Howler's own
 *      `fade()` API, which internally calls `gain.linearRampToValueAtTime`
 *      against Web Audio's sample-accurate clock. By calling fade()
 *      with `duration = msUntilEnd`, the ramp completes at the EXACT
 *      sample-EOF of the outgoing buffer. No more setTimeout jitter.
 *   - `decodeUrl(url, ctx)` — fetch + decodeAudioData with a small LRU
 *      cache (3 buffers, ~30 MB) so the same album doesn't re-decode
 *      between tracks.
 *   - `scheduleAbsoluteStart(...)` — creates our own BufferSource +
 *      GainNode and schedules `source.start(absoluteTime)` for the
 *      incoming track. Sample-accurate handoff.
 *
 * Everything else (regular play/seek/pause/volume/EQ) stays on Howler.
 * The BufferSource owns the incoming for ~5 seconds across the seam;
 * after that it's promoted back to a Howl via a contained 50 ms
 * crossfade at the same audio content (inaudible).
 *
 * Connection point: our GainNode → `Howler.ctx.destination`. Same
 * destination Howler drives, so the EQ + visualizer chain (which taps
 * Howler.masterGain) sees our audio too. No EQ regression.
 *
 * Feature-flagged in useAudio.ts via `USE_SAMPLE_ACCURATE_SEAMS`.
 * Flip to false for instant rollback to the pre-78 Howler-only path.
 */

import { Howl } from 'howler'

// ── Decode cache ────────────────────────────────────────────────────
const decodeCache = new Map<string, AudioBuffer>()
const decodeCacheOrder: string[] = []
const MAX_CACHED_BUFFERS = 3
// In-flight dedup: two parallel decodeUrl() calls for the same URL
// share the same Promise rather than each fetching + decoding.
const inFlightDecodes = new Map<string, Promise<AudioBuffer>>()

// ── Encoder priming (2026-08-08) ────────────────────────────────────
// Jake, on an album-length tape: "clearly i can hear the track change."
//
// Every AAC file begins with silence the encoder prepended — 2112 samples
// (47.9 ms) on his library, and the file says so in its own iTunSMPB tag.
// decodeAudioData hands that silence back as real audio, and we were
// starting each incoming buffer at offset 0: landing the next track
// perfectly, then playing 48 ms of nothing. The scheduling was never the
// problem; it was accurately playing the priming.
//
// So each decoded buffer remembers where its MUSIC starts, and the
// scheduler starts there. The lookup rides along with decode (which
// already owns the URL) rather than being threaded through the call site,
// so useAudio.ts — do-not-touch — needs no changes.
//
// A file with no iTunSMPB, or one we can't read, gets 0 and behaves
// exactly as before. Tail padding (4-23 ms) is NOT handled here: skipping
// it means firing the seam earlier, and that timing lives in useAudio.
const headTrimSec = new WeakMap<AudioBuffer, number>()

/** `ipod-audio://<encoded abs path>` → the path ffprobe needs. */
function fsPathFromAudioUrl(url: string): string | null {
  const marker = 'ipod-audio://'
  if (!url.startsWith(marker)) return null
  try { return decodeURIComponent(url.slice(marker.length)) } catch { return null }
}

/** How far into this buffer the actual music starts. 0 when unknown. */
export function headTrimFor(buffer: AudioBuffer): number {
  return headTrimSec.get(buffer) ?? 0
}

export async function decodeUrl(url: string, ctx: AudioContext): Promise<AudioBuffer> {
  const hit = decodeCache.get(url)
  if (hit) {
    // LRU touch
    const i = decodeCacheOrder.indexOf(url)
    if (i >= 0) decodeCacheOrder.splice(i, 1)
    decodeCacheOrder.unshift(url)
    return hit
  }
  const existing = inFlightDecodes.get(url)
  if (existing) return existing
  const p = (async () => {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`)
    const ab = await resp.arrayBuffer()
    const buf = await ctx.decodeAudioData(ab)
    // Ask the file how much priming it carries. Best-effort and never
    // fatal: no answer simply means no trim, i.e. today's behaviour.
    const fsPath = fsPathFromAudioUrl(url)
    if (fsPath) {
      try {
        // Raced with a short timeout: this runs inside the preload, and a
        // slow or wedged probe must never delay the decode it rides on.
        // Losing the race just means no trim for that track.
        const trim = await Promise.race([
          window.electronAPI?.gaplessTrim?.(fsPath),
          new Promise<null>((res) => setTimeout(() => res(null), 1500)),
        ])
        if (trim && trim.delaySec > 0 && trim.delaySec < buf.duration / 2) {
          headTrimSec.set(buf, trim.delaySec)
        }
      } catch { /* no trim */ }
    }
    decodeCache.set(url, buf)
    decodeCacheOrder.unshift(url)
    while (decodeCacheOrder.length > MAX_CACHED_BUFFERS) {
      const evict = decodeCacheOrder.pop()
      if (evict) decodeCache.delete(evict)
    }
    return buf
  })()
  inFlightDecodes.set(url, p)
  p.finally(() => { inFlightDecodes.delete(url) }).catch(() => { /* swallow */ })
  return p
}

export function clearDecodeCache(): void {
  decodeCache.clear()
  decodeCacheOrder.length = 0
}

// ── Outgoing fade-out ───────────────────────────────────────────────
/**
 * Schedule a sample-accurate fade-out so the outgoing buffer reaches
 * gain=0 at its natural EOF. Uses Howler's own `fade()` which
 * internally calls `gain.linearRampToValueAtTime` — sample-accurate.
 * Caller passes the EXACT msUntilEnd so the ramp completes at the
 * buffer's last sample, not "approximately near it."
 *
 * Safe to call on either html5:false or html5:true Howls; Howler's
 * fade abstracts the underlying gain primitive.
 */
/**
 * Duck the outgoing track just before its end — SHORT, not the whole run-up.
 *
 * 2026-08-08. This used to fade over the entire msUntilEnd, which the rAF
 * trigger makes as much as 250 ms. That guaranteed the ramp reached zero
 * exactly at EOF, but the price was a quarter-second fade on the end of
 * every track. Jake heard it on an album meant to run continuously: "theres
 * a slight gap in between tracks... it might only be from track 1 to 2."
 * Track 1 there is 48 seconds and ends cold, so a 250 ms fade is naked;
 * tracks that decay naturally were hiding it.
 *
 * A long fade was never what the pop needed. The pop came from the buffer
 * ending at non-zero amplitude, and ~10-30 ms of ramp is plenty to avoid
 * that — AAC files also end in the encoder's own padding silence, so the
 * ramp is mostly landing on silence anyway.
 *
 * The outgoing is an html5 (streaming) Howl, whose fade Howler steps in JS
 * rather than on Web Audio's clock, so there is no sample-accurate ramp to
 * schedule here. Instead the short fade is fired at (EOF - duration): even
 * with setTimeout's 4-15 ms jitter the ramp still lands within a few ms of
 * EOF, and it now costs ~30 ms of tail instead of 250 ms.
 */
const OUTGOING_DUCK_MS = 30

export function scheduleAbsoluteFadeOut(howl: Howl, msUntilEnd: number): void {
  if (!howl) return
  const total = Math.max(1, Math.floor(msUntilEnd))
  const dur = Math.min(OUTGOING_DUCK_MS, total)
  const delay = Math.max(0, total - dur)
  try {
    const cur = (howl.volume() as number)
    if (delay <= 0) { howl.fade(cur, 0, dur); return }
    setTimeout(() => {
      try {
        const v = (howl.volume() as number)
        howl.fade(v, 0, dur)
      } catch { /* the seam still works; worst case is the old pop */ }
    }, delay)
  } catch {
    /* ignore — caller falls back to no fade, which sounds the same
     * as today's failure mode */
  }
}

// ── Incoming BufferSource scheduling ────────────────────────────────
export interface ScheduledIncoming {
  source: AudioBufferSourceNode
  gain: GainNode
  buffer: AudioBuffer
  /** Absolute Howler.ctx time when the source.start() is scheduled. */
  scheduledStartAt: number
  /** Snapshot of the target volume so promote() can match it. */
  targetVolume: number
  /** Tear down the source + disconnect nodes. Safe to call multiple times. */
  stop: () => void
  /** True once stop() has been called. */
  stopped: boolean
}

/**
 * Schedule the incoming track's BufferSource to start at an absolute
 * Howler.ctx time, with a short fade-in to mask buffer-start amplitude.
 * Returns a handle the caller manages.
 *
 * Connection: source → gain → ctx.destination. We use ctx.destination
 * (same node Howler's masterGain feeds into) so the EQ + visualizer
 * tap on Howler.masterGain still captures the OUTGOING (Howler-owned)
 * audio. The incoming BufferSource bypasses EQ for the ~5s it owns
 * playback; after the seam the promotion to a real Howl restores EQ.
 * This matches the existing trade-off in the gapless preload code.
 */
export function scheduleAbsoluteStart(
  buffer: AudioBuffer,
  ctx: AudioContext,
  absoluteStartTime: number,
  targetVolume: number,
  fadeInMs: number,
): ScheduledIncoming {
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const gain = ctx.createGain()
  source.connect(gain)
  gain.connect(ctx.destination)
  if (fadeInMs > 0) {
    gain.gain.setValueAtTime(0, absoluteStartTime)
    gain.gain.linearRampToValueAtTime(targetVolume, absoluteStartTime + fadeInMs / 1000)
  } else {
    gain.gain.setValueAtTime(targetVolume, absoluteStartTime)
  }
  // Start where the MUSIC starts, not where the file starts — skipping the
  // encoder priming that would otherwise play as ~48 ms of silence at the
  // seam (2026-08-08). 0 for anything without a readable iTunSMPB.
  source.start(absoluteStartTime, headTrimFor(buffer))
  const handle: ScheduledIncoming = {
    source,
    gain,
    buffer,
    scheduledStartAt: absoluteStartTime,
    targetVolume,
    stopped: false,
    stop: () => {
      if (handle.stopped) return
      handle.stopped = true
      try { source.stop() } catch { /* already stopped */ }
      try { source.disconnect() } catch { /* already disconnected */ }
      try { gain.disconnect() } catch { /* already disconnected */ }
    },
  }
  return handle
}

/**
 * After the seam, the BufferSource owns playback. We promote to a real
 * Howl so the rest of useAudio's state machine (pause / seek / volume /
 * EQ / next-track scheduling) keeps working without rewrites.
 *
 * The handoff is masked by a 50 ms internal crossfade at the same audio
 * content (BufferSource fade-out + Howl fade-in start at the same
 * ctx.currentTime). Listener perceives one continuous track because
 * the two sources are playing the same samples at near-aligned offsets.
 *
 * Caller is responsible for creating the Howl and seeking it to the
 * right offset BEFORE calling this function. We just orchestrate the
 * audio crossfade and the cleanup.
 */
export function promoteBufferSourceToHowl(
  scheduled: ScheduledIncoming,
  ctx: AudioContext,
  howl: Howl,
  fadeMs: number = 50,
): void {
  if (scheduled.stopped) return
  const now = ctx.currentTime
  // Fade out the BufferSource.
  try {
    scheduled.gain.gain.cancelScheduledValues(now)
    scheduled.gain.gain.setValueAtTime(scheduled.gain.gain.value, now)
    scheduled.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000)
  } catch { /* ignore */ }
  // Howl fade-in. Howler's fade() is sample-accurate via the same gain
  // primitive on the Howl side.
  try {
    howl.volume(0)
    howl.fade(0, scheduled.targetVolume, fadeMs)
  } catch { /* ignore */ }
  // Stop + disconnect the BufferSource right after the crossfade.
  window.setTimeout(() => scheduled.stop(), fadeMs + 20)
}
