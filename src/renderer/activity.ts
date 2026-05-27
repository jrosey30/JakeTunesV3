/**
 * Tiny pub/sub store for "background activity" — things the iTunes-style
 * LCD pill at the top should surface when nothing is playing: CD rip
 * progress, iPod sync progress, drag-drop / Bandcamp imports, and
 * transient failure notices.
 *
 * Stored at module scope so every view can read/write without threading
 * state through props or adding another React context. `subscribe` +
 * `getSnapshot` are shaped to work with `useSyncExternalStore`.
 */

export interface RipActivity {
  active: boolean          // true while mid-rip; flips false when done/cancelled/errored
  current: number          // tracks completed so far
  total: number            // total tracks being ripped
  trackTitle: string       // most recent track title (the one being ripped or just finished)
  errors: number           // count of tracks that failed during this rip
}

export interface SyncActivity {
  active: boolean          // true during an iPod sync
  step: string             // human-readable current step, e.g. "Copying 12 new tracks to iPod..."
}

/** Drag-drop / Bandcamp imports going through the renderer importQueue.
 *  Separate from RipActivity (CD ripping) so concurrent flows don't clobber
 *  each other and so the pill can label them differently. */
export interface ImportActivity {
  active: boolean
  current: number          // integer count of fully-completed items (for the "X of N" label)
  total: number            // total tracks queued (excluding dupes)
  trackTitle: string       // filename or title of the item currently importing
  errors: number           // count of failed items so the pill can flag them
  /** Optional smooth-fill fraction 0..1 for the bar — lets a half-credit
   *  for the currently-running file advance the bar between integer
   *  completions without putting "2.5 of 3" into the label. */
  barFraction?: number
}

// 4.4.12: lightweight transient notice for surfacing failures the user
// would otherwise miss. Used (so far) for set-custom-artwork failures —
// when sips conversion errors out, the IPC returns ok:false and the
// renderer's `if (result.ok)` gate correctly skips ADD_ARTWORK, but
// the user already saw the art in the Get Info modal (localArtHash)
// and assumes it stuck. setNotice surfaces a short LCD-pill message
// so they know it failed and can retry.
export interface NoticeActivity {
  message: string
  kind: 'error' | 'info'
}

/** 4.5.2: Music Man / Megan / DJ commentary rendered live inside the
 *  pill — replaces the floating dj-bubble Jake asked to kill. text is
 *  the full caption; revealedChars is how many characters of it have
 *  been "typed out" so far. The setBroadcast timer advances it ~33
 *  chars/sec to approximate TTS pacing. */
export interface BroadcastActivity {
  speaker: string
  text: string
  revealedChars: number
  /** 4.5: distinguishes "thinking" (model is generating, no words yet)
   *  from "speaking" (text is streaming). The pill renders these
   *  differently — thinking shows pulsing dots with no progress bar;
   *  speaking shows multi-line closed-caption stacking. */
  mode: 'thinking' | 'speaking'
}

let rip: RipActivity | null = null
let sync: SyncActivity | null = null
let importing: ImportActivity | null = null
let notice: NoticeActivity | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null
let broadcast: BroadcastActivity | null = null
let broadcastTimer: ReturnType<typeof setInterval> | null = null

/** 4.5: Radio Mode status. When non-null, the now-playing pill paints
 *  an "ON AIR · WJLR 330.9 · elapsed / remaining" strip inside itself
 *  (replacing the previous external red pill that sat awkwardly next
 *  to the transport row). Toolbar owns the radio-mode source of truth
 *  and pushes here on toggle + on every elapsed-tick. */
export interface RadioStatus {
  active: boolean
  elapsedMs: number
  capMs: number
}
let radio: RadioStatus | null = null
export function getRadio(): RadioStatus | null { return radio }
export function setRadio(next: RadioStatus | null): void {
  // Skip the version bump (and re-render) when the second tick has
  // produced an identical state — happens whenever the elapsed counter
  // ticks but the floored-to-seconds value the pill displays hasn't
  // changed since the last tick.
  if (radio === next) return
  if (radio && next && radio.active === next.active && radio.elapsedMs === next.elapsedMs && radio.capMs === next.capMs) return
  radio = next
  notify()
}

// Bumped on every mutation. `getSnapshot` returns this number, which
// is cheap to compare by reference in React's external-store check.
// The actual fields are read via separate getters.
let version = 0

const listeners = new Set<() => void>()

function notify() {
  version += 1
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getSnapshot(): number {
  return version
}

export function getRip(): RipActivity | null { return rip }
export function getSync(): SyncActivity | null { return sync }
export function getImport(): ImportActivity | null { return importing }
export function getNotice(): NoticeActivity | null { return notice }
export function getBroadcast(): BroadcastActivity | null { return broadcast }

export function setRip(next: RipActivity | null): void {
  rip = next
  notify()
}

export function setSync(next: SyncActivity | null): void {
  sync = next
  notify()
}

export function setImport(next: ImportActivity | null): void {
  // Skip notify if nothing the pill cares about has actually changed —
  // importQueue can fire many notifications per second during an import
  // burst (each queue mutation), and re-rendering the pill on identical
  // state produces visible flicker.
  if (importing === next) return
  if (importing && next &&
      importing.active === next.active &&
      importing.current === next.current &&
      importing.total === next.total &&
      importing.trackTitle === next.trackTitle &&
      importing.errors === next.errors &&
      importing.barFraction === next.barFraction) return
  importing = next
  notify()
}

// 4.4.12: push a transient notice. Auto-clears after `durationMs`
// (default 4 sec). Calling again before the timer fires replaces the
// message and restarts the timer. Pass null to clear immediately.
export function setNotice(message: string | null, opts?: { kind?: 'error' | 'info'; durationMs?: number }): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
    noticeTimer = null
  }
  if (message === null || message === '') {
    notice = null
    notify()
    return
  }
  const kind = opts?.kind || 'info'
  const durationMs = opts?.durationMs ?? 4000
  notice = { message, kind }
  notify()
  noticeTimer = setTimeout(() => {
    notice = null
    noticeTimer = null
    notify()
  }, durationMs)
}

// 4.5.2: start (or replace) a live broadcast caption in the pill.
// The text is revealed character-by-character at ~33 chars/sec — fast
// enough to feel responsive, slow enough to read along as the TTS
// audio plays. Pass null to clear immediately. Passing the same text
// again is idempotent (no timer restart, no re-render). The reveal
// completes regardless of TTS audio finishing; an explicit setBroadcast
// (null) at speech-end clears the caption.
//
// 4.5: tuned for SPEECH RATE not reading rate. 85ms per char ≈ 11.8
// cps ≈ 140 wpm — slightly UNDER natural English speaking pace so the
// caption trails the voice by a beat instead of leading it. Reads as
// "captions following the speaker", not "speaker catching up to
// captions". Pre-4.5 the reveal was 33 cps (400 wpm) which raced
// ahead by seconds; intermediate 65ms was closer but still slightly
// ahead per Jake's ear. 85ms is the comfortable trailing pace.
const CHARS_PER_TICK = 1
const TICK_INTERVAL_MS = 85

// 4.5: streaming variant. Replaces text in-place and pins revealedChars
// to the full length so the typewriter is a no-op — the LLM token rate
// (~50-250 cps) IS the reveal speed, not the 33 cps default. Use this
// when text arrives from a streaming source (Claude messages.stream);
// for static pre-baked text keep using setBroadcast which animates the
// typewriter.
export function streamBroadcast(next: { speaker: string; text: string }): void {
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
  broadcast = {
    speaker: next.speaker,
    text: next.text,
    revealedChars: next.text.length,
    mode: 'speaking',
  }
  notify()
}

// 4.5: typewriter pinned to audio duration. Use when you know the
// exact length of the TTS clip about to play — caption finishes
// exactly when the voice does, no drift on long messages. Tick
// interval is computed as durationMs / text.length so a 30-second
// 360-char message reveals at 12 cps, a 60-second 720-char message
// reveals at 12 cps too — sync regardless of message length.
export function setBroadcastTimed(next: { speaker: string; text: string }, durationMs: number): void {
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
  if (!next.text) {
    if (broadcast === null) return
    broadcast = null
    notify()
    return
  }
  broadcast = { speaker: next.speaker, text: next.text, revealedChars: 0, mode: 'speaking' }
  notify()
  if (durationMs <= 0) {
    // Unknown duration — reveal everything instantly (better than
    // freezing at char 0 forever).
    broadcast = { ...broadcast, revealedChars: next.text.length }
    notify()
    return
  }
  // Floor at 25ms per tick — Howler's own setInterval clamp behavior
  // and our render budget — so very short clips (e.g. "Run it.")
  // don't try to tick every 5ms.
  const tickMs = Math.max(25, Math.floor(durationMs / Math.max(1, next.text.length)))
  broadcastTimer = setInterval(() => {
    if (!broadcast) {
      if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
      return
    }
    const nextChars = Math.min(broadcast.text.length, broadcast.revealedChars + 1)
    if (nextChars === broadcast.revealedChars) {
      if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
      return
    }
    broadcast = { ...broadcast, revealedChars: nextChars }
    notify()
    if (nextChars >= broadcast.text.length) {
      if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
    }
  }, tickMs)
}

export function setBroadcast(next: { speaker: string; text: string; mode?: 'thinking' | 'speaking' } | null): void {
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
  if (!next) {
    if (broadcast === null) return
    broadcast = null
    notify()
    return
  }
  const mode = next.mode || (next.text ? 'speaking' : 'thinking')
  // Thinking state: no text reveal — the pill just renders a label +
  // pulsing dots while the model generates. Idempotent on identical
  // speaker so a tick-by-tick "still thinking" repeat doesn't restart
  // the visual.
  if (mode === 'thinking') {
    if (broadcast && broadcast.mode === 'thinking' && broadcast.speaker === next.speaker) return
    broadcast = { speaker: next.speaker, text: '', revealedChars: 0, mode: 'thinking' }
    notify()
    return
  }
  // Speaking state: typewriter reveal.
  if (broadcast && broadcast.mode === 'speaking' && broadcast.text === next.text && broadcast.speaker === next.speaker) return
  // 4.5: EXTEND case — new text starts with old text + same speaker.
  // Keep the current reveal position so a growing transcript (e.g.
  // per-sentence TTS appending the rest of the message) continues
  // the typewriter from where it was, rather than restarting at char
  // 0 and re-revealing already-spoken text. Restart the timer if it
  // had stopped because the prior text was fully revealed.
  if (
    broadcast &&
    broadcast.mode === 'speaking' &&
    broadcast.speaker === next.speaker &&
    next.text.startsWith(broadcast.text) &&
    next.text.length > broadcast.text.length
  ) {
    const oldReveal = broadcast.revealedChars
    broadcast = { speaker: next.speaker, text: next.text, revealedChars: oldReveal, mode: 'speaking' }
    notify()
    // If the previous typewriter had stopped (reveal had caught up to
    // old text.length), restart it for the new chars.
    if (oldReveal >= broadcast.text.length) return
    broadcastTimer = setInterval(() => {
      if (!broadcast) {
        if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
        return
      }
      const nextChars = Math.min(broadcast.text.length, broadcast.revealedChars + CHARS_PER_TICK)
      if (nextChars === broadcast.revealedChars) {
        if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
        return
      }
      broadcast = { ...broadcast, revealedChars: nextChars }
      notify()
      if (nextChars >= broadcast.text.length) {
        if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
      }
    }, TICK_INTERVAL_MS)
    return
  }
  broadcast = { speaker: next.speaker, text: next.text, revealedChars: 0, mode: 'speaking' }
  notify()
  broadcastTimer = setInterval(() => {
    if (!broadcast) {
      if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
      return
    }
    const nextChars = Math.min(broadcast.text.length, broadcast.revealedChars + CHARS_PER_TICK)
    if (nextChars === broadcast.revealedChars) {
      if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
      return
    }
    broadcast = { ...broadcast, revealedChars: nextChars }
    notify()
    if (nextChars >= broadcast.text.length) {
      if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
    }
  }, TICK_INTERVAL_MS)
}
