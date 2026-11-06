/**
 * Pause for video calls — the decision core.
 *
 * Pure: no Electron, no I/O, an injected clock. The shell
 * (pause-for-calls.ts) feeds it three kinds of events and carries out the
 * actions it emits; the whole rulebook is tested against a fake clock in
 * __tests__/pause-for-calls.test.ts.
 *
 * Inputs
 *   mic       — a state line from native/micwatch: which processes are
 *               running audio INPUT (using the microphone) right now
 *   playback  — the renderer's isPlaying (the existing set-playback-active
 *               message main already tracks as playbackActive)
 *   settings  — the on/off decision, re-read by the shell on every mic event
 *
 * Outputs
 *   pause / resume — delivered through the media-key path (index.ts
 *                    sendMediaKeyAction → renderer menu-action 'pause' / 'play')
 *   notice         — a transient strip notice; never a new UI surface
 *
 * Rules (Jake, 2026-10-30: "auto pauses when call starts … auto resumes
 * after call is CONFIRMED complete … on off setting, default on"):
 *   1. Setting off → nothing, ever.
 *   2. A call starts — another process runs input for ≥ CONFIRM_MS (a mic
 *      blip is not a call) — while music is playing → pause + a notice that
 *      names the app when the bundle id is known.
 *   3. Not playing when the call started → nothing, and no resume later.
 *      Music the user did not start is never started.
 *   4. The user presses play during the call → stand down for this call.
 *      The user presses pause → we did not pause, so we never resume.
 *   5. Call confirmed over = nobody else has run input for QUIET_MS. Then,
 *      if we paused, resume + notice. A call starting inside the quiet
 *      period cancels the pending resume (same call; the mic re-opened).
 *   6. JakeTunes' own processes never count (the app records the mic for
 *      Savant and mixtape intros).
 *   7. Helper restarts are the shell's job; this core never changes state
 *      on a respawn — only on a fresh state line.
 *   8. Only an app calls happen in counts: isCallApp below. Jake, 2026-11-05,
 *      9:37 at night: "it keeps pausing for a call that i am not on". macOS's
 *      speech service (com.apple.CoreSpeech) opened the mic within a second of
 *      the music starting and held it 33 s, so "any other process on the mic"
 *      paused, resumed and paused again every 45 s. Dictation, recorders and
 *      voice assistants are not calls either. Missing a call app costs a press
 *      of pause; a false call stops the music for nothing.
 *   9. A mic that comes back right after our resume, twice in a row, is
 *      following the music, not a call: leave the music alone for half an hour.
 */

/** A call is "started" only after the mic has stayed open this long. */
export const CONFIRM_MS = 1500
/** A call is "confirmed complete" after nobody else has run input this long. */
export const QUIET_MS = 12_000
/**
 * How long we wait for the renderer to echo our own pause/play (isPlaying
 * flipping) before an unexplained transition counts as the user's again.
 */
export const ECHO_MS = 3000
/** A "call" starting this soon after our resume came back because we resumed (rule 9). */
export const BOUNCE_MS = 5000
/** Comebacks in a row before we stop believing them (rule 9). */
export const MAX_BOUNCES = 2
/** How long we then leave the music alone (rule 9). */
export const STAND_DOWN_MS = 30 * 60 * 1000
/** Helper respawn schedule; after the last entry the shell gives up. */
export const RESPAWN_BACKOFF_MS: readonly number[] = [1000, 5000, 30_000]
export const PAUSE_NOTICE_MS = 6000
export const RESUME_NOTICE_MS = 3000
/** A stdout line that never ends is garbage, not state. */
export const MAX_PARTIAL_LINE = 64 * 1024

export interface MicState {
  input: boolean
  pids: number[]
  bundles: string[]
}

export type CallEvent =
  | { type: 'mic'; state: MicState }
  | { type: 'playback'; playing: boolean }
  | { type: 'settings'; enabled: boolean }

export type CallAction =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'notice'; text: string; durationMs: number }

export interface CallClock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface CallPauserDeps {
  clock: CallClock
  /** True for JakeTunes' own processes (rule 6). */
  isOwn: (pid: number, bundle: string) => boolean
  emit: (action: CallAction) => void
  /** Initial setting; default on. */
  enabled?: boolean
}

export interface CallPauserSnapshot {
  enabled: boolean
  playing: boolean
  call: null | {
    confirmed: boolean
    autoPaused: boolean
    stoodDown: boolean
    bundles: string[]
    quietPending: boolean
  }
}

export interface CallPauser {
  handle: (event: CallEvent) => void
  snapshot: () => CallPauserSnapshot
  dispose: () => void
}

interface Call {
  startedAt: number
  /** Every bundle id seen using the mic during this call (for the notice). */
  bundles: string[]
  confirmed: boolean
  /** We paused the music; a resume is owed when the call is over. */
  autoPaused: boolean
  /** The user pressed play during the call — hands off until it is over. */
  stoodDown: boolean
  confirmTimer: unknown
  quietTimer: unknown
}

export function createCallPauser(deps: CallPauserDeps): CallPauser {
  const { clock, isOwn, emit } = deps
  let enabled = deps.enabled !== false
  let playing = false
  let call: Call | null = null
  // Our own pause/play awaiting the renderer's echo. Bounded by ECHO_MS so a
  // lost echo can never mis-attribute the user's next press.
  let echoPause: unknown = null
  let echoPlay: unknown = null
  let disposed = false
  // Rule 9.
  let lastResumeAt: number | null = null
  let bounces = 0
  let standDownUntil = 0

  const clear = (handle: unknown): null => {
    if (handle !== null && handle !== undefined) clock.clearTimeout(handle)
    return null
  }

  /** Bundle ids of the call apps running input (rules 6 and 8). */
  const others = (state: MicState): string[] => {
    const out: string[] = []
    state.pids.forEach((pid, i) => {
      const bundle = state.bundles[i] ?? ''
      if (!isOwn(pid, bundle) && isCallApp(bundle)) out.push(bundle)
    })
    return out
  }

  const onConfirm = (): void => {
    if (!call) return
    call.confirmTimer = null
    call.confirmed = true
    if (!enabled || !playing || call.autoPaused || call.stoodDown) return
    call.autoPaused = true
    echoPause = clear(echoPause)
    echoPause = clock.setTimeout(() => { echoPause = null }, ECHO_MS)
    emit({ type: 'pause' })
    emit({
      type: 'notice',
      text: `Paused for ${describeCall(call.bundles)} — it'll resume when the call ends`,
      durationMs: PAUSE_NOTICE_MS,
    })
  }

  const onQuiet = (): void => {
    if (!call) return
    const resume = enabled && call.autoPaused
    call.quietTimer = null
    call = null
    if (!resume) return
    lastResumeAt = clock.now()
    echoPlay = clear(echoPlay)
    echoPlay = clock.setTimeout(() => { echoPlay = null }, ECHO_MS)
    emit({ type: 'resume' })
    emit({ type: 'notice', text: 'Call over — resumed', durationMs: RESUME_NOTICE_MS })
  }

  const onMic = (state: MicState): void => {
    const bundles = others(state)
    if (bundles.length > 0) {
      if (!call) {
        const bounced = lastResumeAt !== null && clock.now() - lastResumeAt < BOUNCE_MS
        bounces = bounced ? bounces + 1 : 0
        if (bounces >= MAX_BOUNCES) standDownUntil = clock.now() + STAND_DOWN_MS
        call = {
          startedAt: clock.now(),
          bundles,
          confirmed: false,
          autoPaused: false,
          stoodDown: clock.now() < standDownUntil,
          confirmTimer: null,
          quietTimer: null,
        }
        call.confirmTimer = clock.setTimeout(onConfirm, CONFIRM_MS)
        return
      }
      // Same call, or a new one inside the quiet period: keep it alive,
      // remember every app seen, cancel any pending resume (rule 5).
      for (const b of bundles) if (!call.bundles.includes(b)) call.bundles.push(b)
      call.quietTimer = clear(call.quietTimer)
      return
    }
    if (!call) return
    if (!call.confirmed) {
      // Quiet again before CONFIRM_MS — a blip, not a call (rule 2).
      call.confirmTimer = clear(call.confirmTimer)
      call = null
      return
    }
    if (call.quietTimer === null) call.quietTimer = clock.setTimeout(onQuiet, QUIET_MS)
  }

  const onPlayback = (next: boolean): void => {
    const prev = playing
    playing = next
    if (next === prev) return
    if (!next) {
      if (echoPause !== null) { echoPause = clear(echoPause); return }   // our pause landed
      // The user (or the end of the queue) stopped the music. We did not
      // pause it, so we never resume it (rule 4).
      if (call) call.autoPaused = false
      return
    }
    if (echoPlay !== null) { echoPlay = clear(echoPlay); return }         // our resume landed
    if (call && call.autoPaused) {
      // The user pressed play during the call: their call, their music (rule 4).
      call.autoPaused = false
      call.stoodDown = true
    }
  }

  const onSettings = (next: boolean): void => {
    enabled = next
    // Off means off: no pause at confirm time, and no resume owed either (rule 1).
    if (!enabled && call) call.autoPaused = false
  }

  return {
    handle(event) {
      if (disposed) return
      switch (event.type) {
        case 'mic': onMic(event.state); break
        case 'playback': onPlayback(event.playing); break
        case 'settings': onSettings(event.enabled); break
      }
    },
    snapshot() {
      return {
        enabled,
        playing,
        call: call
          ? {
              confirmed: call.confirmed,
              autoPaused: call.autoPaused,
              stoodDown: call.stoodDown,
              bundles: [...call.bundles],
              quietPending: call.quietTimer !== null,
            }
          : null,
      }
    },
    dispose() {
      disposed = true
      if (call) {
        clear(call.confirmTimer)
        clear(call.quietTimer)
        call = null
      }
      echoPause = clear(echoPause)
      echoPlay = clear(echoPlay)
    },
  }
}

// ── The apps a call happens in ─────────────────────────────────
// Matched by bundle-id prefix, case-insensitively: Electron and WebKit apps
// capture audio in helper processes whose ids are the parent's plus a
// suffix (com.microsoft.teams2.helper, com.apple.WebKit.GPU, …).

const CALL_APPS: ReadonlyArray<readonly [string, string]> = [
  ['com.apple.facetime', 'FaceTime'],
  ['com.apple.avconferenced', 'FaceTime'],       // where FaceTime's audio runs
  ['com.apple.telephonyutilities', 'phone'],     // a call through the iPhone
  ['us.zoom.', 'Zoom'],
  ['com.microsoft.teams', 'Teams'],              // new Teams (…teams2) and classic
  ['com.webex.meetingmanager', 'Webex'],
  ['cisco-systems.spark', 'Webex'],
  ['com.cisco.webexmeetingsapp', 'Webex'],
  ['com.tinyspeck.slackmacgap', 'Slack'],
  ['com.hnc.discord', 'Discord'],
  ['net.whatsapp.whatsapp', 'WhatsApp'],
  ['desktop.whatsapp', 'WhatsApp'],
  ['org.whispersystems.signal-desktop', 'Signal'],
  ['ru.keepcoder.telegram', 'Telegram'],
  ['org.telegram.', 'Telegram'],
  ['com.skype.skype', 'Skype'],
  ['com.amazon.amazon-chime', 'Chime'],
  ['com.logmein.', 'GoTo'],
  ['com.ringcentral.', 'RingCentral'],
  ['com.bluejeansnet.', 'BlueJeans'],
]

/** Google Meet and every other call that runs in a tab. */
const BROWSERS: ReadonlyArray<readonly [string, string]> = [
  ['com.google.chrome', 'Chrome'],
  ['com.apple.safari', 'Safari'],
  ['com.apple.webkit', 'Safari'],                // Safari captures in its WebKit helpers
  ['company.thebrowser.browser', 'Arc'],
  ['company.thebrowser.dia', 'Dia'],
  ['org.mozilla.', 'Firefox'],
  ['com.microsoft.edgemac', 'Edge'],
  ['com.brave.browser', 'Brave'],
  ['ai.perplexity.comet', 'Comet'],
  ['com.vivaldi.vivaldi', 'Vivaldi'],
  ['com.operasoftware.', 'Opera'],
]

/** Is this a process a call happens in? Rule 8: nothing else stops the music. */
export function isCallApp(bundle: string): boolean {
  const b = bundle.toLowerCase()
  return CALL_APPS.some(([prefix]) => b.startsWith(prefix)) || BROWSERS.some(([prefix]) => b.startsWith(prefix))
}

/**
 * "your Zoom call" / "a call in Chrome" / "your call" — the phrase the pause
 * notice is built around. A known call app wins over a browser when both
 * are using the mic.
 */
export function describeCall(bundles: string[]): string {
  let browser: string | null = null
  for (const raw of bundles) {
    const b = raw.toLowerCase()
    for (const [prefix, name] of CALL_APPS) if (b.startsWith(prefix)) return `your ${name} call`
    if (browser === null) {
      for (const [prefix, name] of BROWSERS) if (b.startsWith(prefix)) { browser = name; break }
    }
  }
  return browser ? `a call in ${browser}` : 'your call'
}

// ── Helper stdout protocol ──────────────────────────────────────────────
// micwatch prints one JSON object per line. A pipe delivers chunks at
// arbitrary boundaries, so parsing keeps the unfinished tail in `rest`.

// ⚠️ TWIN: native/micwatch/micwatch.swift encode() writes exactly this shape
// ({"bundles":[…],"input":bool,"pids":[…]}); change both or neither.
export function parseStateLine(line: string): MicState | null {
  const t = line.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  let parsed: unknown
  try { parsed = JSON.parse(t) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const r = parsed as Record<string, unknown>
  if (typeof r.input !== 'boolean' || !Array.isArray(r.pids) || !Array.isArray(r.bundles)) return null
  const pids: number[] = []
  for (const p of r.pids) {
    if (typeof p !== 'number' || !Number.isInteger(p)) return null
    pids.push(p)
  }
  const bundles = r.bundles.map((b) => (typeof b === 'string' ? b : ''))
  while (bundles.length < pids.length) bundles.push('')
  return { input: r.input, pids, bundles: bundles.slice(0, pids.length) }
}

export function parseHelperChunk(buffer: string, chunk: string): { states: MicState[]; rest: string } {
  const parts = (buffer + chunk).split('\n')
  let rest = parts.pop() ?? ''
  const states: MicState[] = []
  for (const line of parts) {
    const s = parseStateLine(line)
    if (s) states.push(s)
  }
  if (rest.length > MAX_PARTIAL_LINE) rest = ''
  return { states, rest }
}

// ── Helper lifecycle ────────────────────────────────────────────────────

/** Delay before respawn number `attempt` (0-based), or null to give up. */
export function respawnDelay(attempt: number): number | null {
  return attempt >= 0 && attempt < RESPAWN_BACKOFF_MS.length ? RESPAWN_BACKOFF_MS[attempt] : null
}

// ── Setting ─────────────────────────────────────────────────────────────

/**
 * The on/off decision from a parsed app-settings.json. A missing key reads
 * as ON (older settings files). It also reads OFF while the user has set up
 * "Move music to another speaker during calls" (Preferences → Audio): they
 * asked for the music to keep going on a different speaker, so pausing it
 * would defeat what they configured.
 */
export function pauseForCallsEnabled(settings: unknown): boolean {
  const s = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>
  const calls = (s.calls && typeof s.calls === 'object' ? s.calls : {}) as Record<string, unknown>
  // The setting alone decides. "Move music to another speaker during calls"
  // (audio.callRouteEnabled) does not stand this down: Jake's own Mac has
  // that on (BoomAudio), and he asked for pausing, default on — with both
  // on, the music pauses, and the route feature has nothing left to move.
  return calls.pauseForCalls !== false
}
