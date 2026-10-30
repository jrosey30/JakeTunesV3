/**
 * Pause for video calls — the rulebook, end to end, on a fake clock.
 *
 *  - a mic blip shorter than CONFIRM_MS is not a call
 *  - a confirmed call while playing pauses once and names the app
 *  - not playing when the call starts → nothing, and no resume later
 *  - the user's play during the call stands us down; their pause means no resume
 *  - QUIET_MS of nobody on the mic = call over → resume (+ notice)
 *  - a new call inside the quiet period cancels the pending resume
 *  - setting off → nothing ever (also mid-call: no resume owed)
 *  - JakeTunes' own processes never count
 *  - our own pause/play echoes are not mistaken for the user's
 *  - helper protocol parsing survives torn lines and garbage
 *  - respawn backoff schedule, settings reader, app-name mapping
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCallPauser,
  describeCall,
  parseHelperChunk,
  parseStateLine,
  pauseForCallsEnabled,
  respawnDelay,
  CONFIRM_MS,
  QUIET_MS,
  ECHO_MS,
  RESPAWN_BACKOFF_MS,
  type CallAction,
} from '../pause-for-calls-core.ts'

// ── Fake clock: timers fire in due order when time is advanced ──────────

function fakeClock(start = 1_700_000_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle: unknown): void => { timers.delete(handle as number) },
    /** Advance `ms`, firing every due timer in order (fired timers may schedule more). */
    advance(ms: number): void {
      const target = now + ms
      for (;;) {
        let dueId = -1
        let due: { at: number; fn: () => void } | null = null
        for (const [id, t] of timers) {
          if (t.at <= target && (!due || t.at < due.at || (t.at === due.at && id < dueId))) { due = t; dueId = id }
        }
        if (!due) break
        timers.delete(dueId)
        now = due.at
        due.fn()
      }
      now = target
    },
    pending: () => timers.size,
  }
}

const OWN_PID = 4242
const OWN = { pid: OWN_PID, bundle: 'com.jacobrosenbaum.jaketunes' }
const ZOOM = { pid: 812, bundle: 'us.zoom.xos' }
const CHROME = { pid: 913, bundle: 'com.google.Chrome' }
const FACETIME = { pid: 77, bundle: 'com.apple.FaceTime' }

/**
 * A pauser wired to a fake clock. With `echo`, the fake renderer answers
 * our pause/resume with the isPlaying flip the real one would send (50 ms
 * later, through the clock) — that is how the real wire behaves.
 */
function rig(opts: { enabled?: boolean; echo?: boolean } = {}) {
  const clock = fakeClock()
  const actions: CallAction[] = []
  const pauser = createCallPauser({
    clock,
    isOwn: (pid) => pid === OWN_PID,
    enabled: opts.enabled,
    emit: (a) => {
      actions.push(a)
      if (opts.echo && a.type === 'pause') clock.setTimeout(() => pauser.handle({ type: 'playback', playing: false }), 50)
      if (opts.echo && a.type === 'resume') clock.setTimeout(() => pauser.handle({ type: 'playback', playing: true }), 50)
    },
  })
  const mic = (...procs: Array<{ pid: number; bundle: string }>) => pauser.handle({
    type: 'mic',
    state: { input: procs.length > 0, pids: procs.map((p) => p.pid), bundles: procs.map((p) => p.bundle) },
  })
  const play = (playing: boolean) => pauser.handle({ type: 'playback', playing })
  const settings = (enabled: boolean) => pauser.handle({ type: 'settings', enabled })
  const kinds = () => actions.map((a) => a.type)
  const notices = () => actions.filter((a) => a.type === 'notice').map((a) => (a as { text: string }).text)
  return { clock, actions, pauser, mic, play, settings, kinds, notices }
}

describe('call pauser — a call starting', () => {
  test('a mic blip shorter than CONFIRM_MS is not a call', () => {
    const r = rig()
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS - 200)
    r.mic()                               // quiet again before the confirm
    r.clock.advance(60_000)
    assert.deepEqual(r.kinds(), [])
    assert.equal(r.pauser.snapshot().call, null)
    assert.equal(r.clock.pending(), 0, 'the confirm timer was cleared')
  })

  test('a confirmed call while playing pauses once and names the app', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS - 1)
    assert.deepEqual(r.kinds(), [], 'nothing before the confirm')
    r.clock.advance(1)
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
    assert.deepEqual(r.notices(), ["Paused for your Zoom call — it'll resume when the call ends"])
    r.clock.advance(10 * 60_000)          // a long call, mic still open
    assert.deepEqual(r.kinds(), ['pause', 'notice'], 'exactly one pause for one call')
    assert.equal(r.pauser.snapshot().call?.autoPaused, true)
  })

  test('not playing when the call starts → nothing, and no resume later', () => {
    const r = rig({ echo: true })
    r.play(false)
    r.mic(FACETIME)
    r.clock.advance(CONFIRM_MS + 10)
    assert.deepEqual(r.kinds(), [])
    r.mic()
    r.clock.advance(QUIET_MS + 10)
    assert.deepEqual(r.kinds(), [], 'music the user did not start is never started')
    assert.equal(r.pauser.snapshot().call, null)
  })

  test('music the user starts DURING a call is theirs — not paused, not touched at the end', () => {
    const r = rig({ echo: true })
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 10)      // call confirmed, nothing was playing
    r.play(true)                          // user starts music mid-call (sharing a song, say)
    r.clock.advance(30_000)
    assert.deepEqual(r.kinds(), [])
    r.mic()
    r.clock.advance(QUIET_MS + 10)
    assert.deepEqual(r.kinds(), [])
  })

  test('the user pausing before the confirm means we never paused, so we never resume', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(500)
    r.play(false)                         // the user got there first
    r.clock.advance(CONFIRM_MS)
    assert.deepEqual(r.kinds(), [])
    r.mic()
    r.clock.advance(QUIET_MS + 10)
    assert.deepEqual(r.kinds(), [])
  })

  test('two apps on the mic: the pause happens once and a call app beats a browser in the notice', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(CHROME)
    r.clock.advance(500)
    r.mic(CHROME, ZOOM)                   // Zoom joins before the confirm
    r.clock.advance(CONFIRM_MS)
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
    assert.deepEqual(r.notices(), ["Paused for your Zoom call — it'll resume when the call ends"])
  })
})

describe('call pauser — the user during the call', () => {
  test('user presses play → stand down for this call; no second pause, no resume at the end', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)     // paused; echo (isPlaying=false) arrived
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
    r.play(true)                          // the user wants music on this call
    const snap = r.pauser.snapshot()
    assert.equal(snap.call?.stoodDown, true)
    assert.equal(snap.call?.autoPaused, false)
    r.clock.advance(5 * 60_000)
    assert.deepEqual(r.kinds(), ['pause', 'notice'], 'hands off for the rest of the call')
    r.mic()
    r.clock.advance(QUIET_MS + 100)
    assert.deepEqual(r.kinds(), ['pause', 'notice'], 'nothing to resume — they are already playing')
    assert.equal(r.pauser.snapshot().call, null, 'the call is forgotten once over')
  })

  test('user presses play then pause again during the call → still no resume at the end', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)
    r.play(true)                          // stand down
    r.clock.advance(2000)
    r.play(false)                         // their own pause
    r.mic()
    r.clock.advance(QUIET_MS + 100)
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
  })

  test('our own pause echo is not mistaken for the user pausing', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)     // pause + echo
    assert.equal(r.pauser.snapshot().call?.autoPaused, true, 'the echo did not cancel the owed resume')
    r.mic()
    r.clock.advance(QUIET_MS)
    assert.deepEqual(r.kinds(), ['pause', 'notice', 'resume', 'notice'])
  })

  test('a lost echo expires after ECHO_MS, so a later isPlaying=false is the user again', () => {
    const r = rig()                       // no echo at all
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS)
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
    r.clock.advance(ECHO_MS + 1)
    r.play(false)                         // arrives late: counts as the user's
    assert.equal(r.pauser.snapshot().call?.autoPaused, false)
    r.mic()
    r.clock.advance(QUIET_MS + 1)
    assert.deepEqual(r.kinds(), ['pause', 'notice'], 'no resume owed')
  })

  test('duplicate playback reports are not transitions', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)
    r.play(false)                         // a repeat of the echo, not a press
    assert.equal(r.pauser.snapshot().call?.autoPaused, true)
  })
})

describe('call pauser — the call ending', () => {
  test('QUIET_MS of nobody on the mic = call over → resume + notice, once', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)
    r.mic()
    r.clock.advance(QUIET_MS - 1)
    assert.deepEqual(r.kinds(), ['pause', 'notice'], 'not yet confirmed over')
    r.clock.advance(1)
    assert.deepEqual(r.kinds(), ['pause', 'notice', 'resume', 'notice'])
    assert.deepEqual(r.notices(), ["Paused for your Zoom call — it'll resume when the call ends", 'Call over — resumed'])
    r.clock.advance(60_000)               // the resume echo (isPlaying=true) lands; nothing else happens
    assert.equal(r.kinds().length, 4)
    assert.equal(r.pauser.snapshot().call, null)
    assert.equal(r.pauser.snapshot().playing, true)
  })

  test('a new call inside the quiet period cancels the pending resume', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)
    r.mic()                               // hung up …
    r.clock.advance(QUIET_MS - 4000)
    r.mic(ZOOM)                           // … and the mic opens again before the quiet period ends
    r.clock.advance(QUIET_MS)
    assert.deepEqual(r.kinds(), ['pause', 'notice'], 'no resume while the call is back on')
    assert.equal(r.pauser.snapshot().call?.quietPending, false)
    r.mic()
    r.clock.advance(QUIET_MS)
    assert.deepEqual(r.kinds(), ['pause', 'notice', 'resume', 'notice'], 'resumed exactly once, after the real end')
  })

  test('repeated quiet reports do not shorten or restart the quiet period', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)
    r.mic()
    r.clock.advance(6000)
    r.mic()                               // the helper repeats "quiet" (e.g. after a respawn)
    r.clock.advance(QUIET_MS - 6000)
    assert.ok(r.kinds().includes('resume'), 'the original quiet timer stood')
  })
})

describe('call pauser — the setting and own processes', () => {
  test('setting off → nothing, ever', () => {
    const r = rig({ enabled: false, echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 10)
    r.mic()
    r.clock.advance(QUIET_MS + 10)
    assert.deepEqual(r.kinds(), [])
  })

  test('setting turned off while auto-paused → no resume owed', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 100)
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
    r.settings(false)
    r.mic()
    r.clock.advance(QUIET_MS + 10)
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
  })

  test('setting turned on mid-call does not pause retroactively; the next call does', () => {
    const r = rig({ enabled: false, echo: true })
    r.play(true)
    r.mic(ZOOM)
    r.clock.advance(CONFIRM_MS + 10)      // confirmed with the setting off → no pause
    r.settings(true)
    r.clock.advance(30_000)
    assert.deepEqual(r.kinds(), [])
    r.mic()
    r.clock.advance(QUIET_MS + 10)
    r.mic(ZOOM)                           // next call
    r.clock.advance(CONFIRM_MS)
    assert.deepEqual(r.kinds(), ['pause', 'notice'])
  })

  test("JakeTunes' own processes never count as a call", () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(OWN)                            // Savant listening, mixtape intro recording …
    r.clock.advance(60_000)
    assert.deepEqual(r.kinds(), [])
    assert.equal(r.pauser.snapshot().call, null)
  })

  test('own process plus Zoom is a Zoom call', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.mic(OWN, ZOOM)
    r.clock.advance(CONFIRM_MS)
    assert.deepEqual(r.notices(), ["Paused for your Zoom call — it'll resume when the call ends"])
  })

  test('input:true with no pids is not attributed to anyone — no phantom pause', () => {
    const r = rig({ echo: true })
    r.play(true)
    r.pauser.handle({ type: 'mic', state: { input: true, pids: [], bundles: [] } })
    r.clock.advance(CONFIRM_MS + 10)
    assert.deepEqual(r.kinds(), [])
  })

  test('dispose clears every timer and ignores later events', () => {
    const r = rig()
    r.play(true)
    r.mic(ZOOM)
    r.pauser.dispose()
    assert.equal(r.clock.pending(), 0)
    r.clock.advance(CONFIRM_MS + 10)
    r.mic(ZOOM)
    assert.deepEqual(r.kinds(), [])
  })
})

describe('describeCall — the app name in the notice', () => {
  const cases: Array<[string[], string]> = [
    [['com.apple.FaceTime'], 'your FaceTime call'],
    [['us.zoom.xos'], 'your Zoom call'],
    [['com.microsoft.teams2'], 'your Teams call'],
    [['com.microsoft.teams'], 'your Teams call'],
    [['com.microsoft.teams2.helper'], 'your Teams call'],
    [['com.webex.meetingmanager'], 'your Webex call'],
    [['Cisco-Systems.Spark'], 'your Webex call'],
    [['com.tinyspeck.slackmacgap'], 'your Slack call'],
    [['com.hnc.Discord'], 'your Discord call'],
    [['net.whatsapp.WhatsApp'], 'your WhatsApp call'],
    [['org.whispersystems.signal-desktop'], 'your Signal call'],
    [['com.google.Chrome'], 'a call in Chrome'],
    [['com.google.Chrome.helper'], 'a call in Chrome'],
    [['com.apple.Safari'], 'a call in Safari'],
    [['com.apple.WebKit.GPU'], 'a call in Safari'],
    [['company.thebrowser.Browser'], 'a call in Arc'],
    [['org.mozilla.firefox'], 'a call in Firefox'],
    [['com.microsoft.edgemac'], 'a call in Edge'],
    [['com.google.Chrome', 'us.zoom.xos'], 'your Zoom call'],
    [['com.example.unknown'], 'your call'],
    [[''], 'your call'],
    [[], 'your call'],
  ]
  for (const [bundles, expected] of cases) {
    test(`${JSON.stringify(bundles)} → "${expected}"`, () => {
      assert.equal(describeCall(bundles), expected)
    })
  }
})

describe('helper stdout protocol', () => {
  test('torn lines across chunks reassemble into whole states', () => {
    let buf = ''
    const got: unknown[] = []
    const chunks = [
      '{"bundles":["us.zo',
      'om.xos"],"input":true,"pids":[812]}\n{"bundles":[],"inp',
      'ut":false,"pids":[]}\n',
    ]
    for (const c of chunks) {
      const r = parseHelperChunk(buf, c)
      buf = r.rest
      got.push(...r.states)
    }
    assert.deepEqual(got, [
      { input: true, pids: [812], bundles: ['us.zoom.xos'] },
      { input: false, pids: [], bundles: [] },
    ])
    assert.equal(buf, '')
  })

  test('several lines in one chunk, garbage lines ignored, tail kept', () => {
    const r = parseHelperChunk('', 'processes: 59\n{"bundles":["a"],"input":true,"pids":[1]}\nnot json\n{"bundles":[],"input":false,"pids":[]}\n{"bundles":["b"],')
    assert.equal(r.states.length, 2)
    assert.equal(r.rest, '{"bundles":["b"],')
  })

  test('a tail that never ends is dropped, not kept forever', () => {
    const r = parseHelperChunk('', '{'.padEnd(70_000, 'x'))
    assert.equal(r.rest, '')
    assert.deepEqual(r.states, [])
  })

  test('shape validation: wrong types are refused, missing bundles are padded', () => {
    assert.equal(parseStateLine('{"input":"yes","pids":[],"bundles":[]}'), null)
    assert.equal(parseStateLine('{"input":true,"pids":["812"],"bundles":[]}'), null)
    assert.equal(parseStateLine('{"input":true,"pids":[1.5],"bundles":[]}'), null)
    assert.equal(parseStateLine('[1,2,3]'), null)
    assert.equal(parseStateLine(''), null)
    assert.deepEqual(parseStateLine('{"input":true,"pids":[5,6],"bundles":["x"]}'), { input: true, pids: [5, 6], bundles: ['x', ''] })
    assert.deepEqual(parseStateLine('  {"input":false,"pids":[],"bundles":[]}  '), { input: false, pids: [], bundles: [] })
  })
})

describe('helper respawn backoff', () => {
  test('1 s, 5 s, 30 s, then give up', () => {
    assert.deepEqual([...RESPAWN_BACKOFF_MS], [1000, 5000, 30_000])
    assert.equal(respawnDelay(0), 1000)
    assert.equal(respawnDelay(1), 5000)
    assert.equal(respawnDelay(2), 30_000)
    assert.equal(respawnDelay(3), null)
    assert.equal(respawnDelay(-1), null)
  })
})

describe('pauseForCallsEnabled — the setting as read from app-settings.json', () => {
  test('missing key reads as ON (older settings files)', () => {
    assert.equal(pauseForCallsEnabled(undefined), true)
    assert.equal(pauseForCallsEnabled(null), true)
    assert.equal(pauseForCallsEnabled({}), true)
    assert.equal(pauseForCallsEnabled({ calls: {} }), true)
    assert.equal(pauseForCallsEnabled('garbage'), true)
  })
  test('explicit values', () => {
    assert.equal(pauseForCallsEnabled({ calls: { pauseForCalls: true } }), true)
    assert.equal(pauseForCallsEnabled({ calls: { pauseForCalls: false } }), false)
  })
  test('OFF while "move music to another speaker during calls" is configured', () => {
    assert.equal(pauseForCallsEnabled({ audio: { callRouteEnabled: true, callRouteDeviceLabel: 'Kitchen HomePod' } }), false)
    assert.equal(pauseForCallsEnabled({ audio: { callRouteEnabled: true, callRouteDeviceLabel: '' } }), true, 'enabled but no speaker picked = not configured')
    assert.equal(pauseForCallsEnabled({ audio: { callRouteEnabled: false, callRouteDeviceLabel: 'Kitchen HomePod' } }), true)
  })
})
