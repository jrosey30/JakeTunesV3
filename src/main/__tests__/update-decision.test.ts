/**
 * The weekly release's three answers (2026-11-14): the rules, and the watcher carrying them out.
 *
 *  - core: now / at / skip, a change of mind, cancel, the 7-day window, 3:00 AM tonight, the
 *    launch grace, skip is final, the next release replaces an answer, a torn file is no answer
 *  - module (temp userData, a clock the test moves): a v 2 offer reaches the bar; "at" writes no
 *    go-file before its time, waits while the music plays or an iPod syncs (said once), writes the
 *    bare sha at the first quiet moment; Change and Cancel before that; nothing can change once
 *    it is installing; "skip" hides it and says so to the gate, again after a restart; every
 *    decision is on disk before it acts and is an `update` event for homemini; the next launch
 *    says whether the install landed
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { defaultInstallAt, formatInstallAt, installAtAllowed, INSTALL_AT_MAX_AHEAD_MS, type UpdateReadyState } from '../../common/update-ready.ts'
import { judgeMarker, MARKER_V2_MAX_AGE_MS, UPDATE_GO_FILE, UPDATE_READY_FILE } from '../update-ready-core.ts'
import {
  cancelDecision, decide, dropStale, dueState, EMPTY_DECISIONS, isSkipped, LAUNCH_GRACE_MS, parseDecisionFile, UPDATE_DECISION_FILE, type DecisionFile,
} from '../update-decision-core.ts'
import { startUpdateReadyWatcher } from '../update-ready.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const NEXT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'
const RUNNING = 'fedcba987654'
// A Friday, 10:00 local time.
const T0 = new Date(2026, 10, 13, 10, 0, 0, 0).getTime()
const HOUR = 3600_000

function v2(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2, sha: SHA, version: '6.1.0', note: '', stagedAt: new Date(T0 - 60_000).toISOString(), gatePid: 4242,
    label: 'This week’s fixes', kind: 'weekly', offeredAt: new Date(T0 - 60_000).toISOString(),
    notes: ['Album pages open faster', 'The iPod page counts right'], ...over,
  }
}

describe('update decisions — the rules', () => {
  const file = (): DecisionFile => ({ ...EMPTY_DECISIONS, skipped: [] })

  test('3:00 AM tonight: later today means tomorrow 3 AM; just after midnight means today', () => {
    const d = new Date(defaultInstallAt(T0))
    assert.equal(d.getHours(), 3)
    assert.equal(d.getDate(), 14)
    const late = new Date(2026, 10, 14, 1, 30).getTime()
    assert.equal(new Date(defaultInstallAt(late)).getDate(), 14, 'at 1:30 AM, tonight is today')
    assert.equal(new Date(defaultInstallAt(new Date(2026, 10, 14, 3, 0).getTime())).getDate(), 15, '3:00 AM exactly is past')
  })

  test('"Install at…" is any time in the next 7 days, never the past', () => {
    assert.ok(installAtAllowed(T0 + 1000, T0))
    assert.ok(installAtAllowed(T0 + INSTALL_AT_MAX_AHEAD_MS, T0))
    assert.ok(!installAtAllowed(T0 + INSTALL_AT_MAX_AHEAD_MS + 1, T0))
    assert.ok(!installAtAllowed(T0, T0))
    assert.ok(!installAtAllowed(T0 - HOUR, T0))
    assert.ok(!installAtAllowed(NaN, T0))
  })

  test('the time reads "3:00 AM" for tonight and "Tue 3:00 AM" further out', () => {
    assert.equal(formatInstallAt(defaultInstallAt(T0), T0), '3:00 AM')
    assert.equal(formatInstallAt(new Date(2026, 10, 17, 3, 0).getTime(), T0), 'Tue 3:00 AM')
  })

  test('now, at, a change of mind, cancel', () => {
    const at = new Date(defaultInstallAt(T0)).toISOString()
    let r = decide(file(), SHA, { choice: 'at', at }, T0)
    assert.ok(r.ok)
    if (!r.ok) return
    assert.deepEqual(r.file.current, { sha: SHA, choice: 'at', at, decidedAt: new Date(T0).toISOString() })
    assert.equal(r.was, null)
    const later = new Date(T0 + 30 * HOUR).toISOString()
    const r2 = decide(r.file, SHA, { choice: 'at', at: later }, T0 + 1000)
    assert.ok(r2.ok)
    if (!r2.ok) return
    assert.equal(r2.was?.at, at, 'the change knows what it replaced')
    assert.equal(r2.file.current?.at, later)
    const c = cancelDecision(r2.file, SHA)
    assert.ok(c)
    assert.equal(c?.file.current, null)
    assert.equal(cancelDecision(c!.file, SHA), null, 'nothing left to cancel')
    r = decide(c!.file, SHA, { choice: 'now' }, T0)
    assert.ok(r.ok && r.file.current?.choice === 'now')
  })

  test('a bad time or a bad choice is refused and changes nothing', () => {
    assert.deepEqual(decide(file(), SHA, { choice: 'at', at: new Date(T0 - 1).toISOString() }, T0), { ok: false, error: 'bad-time' })
    assert.deepEqual(decide(file(), SHA, { choice: 'at', at: 'tonight' }, T0), { ok: false, error: 'bad-time' })
    assert.deepEqual(decide(file(), SHA, { choice: 'later' } as never, T0), { ok: false, error: 'bad-choice' })
  })

  test('skip is final for that release and forgets the answer; another release is not skipped', () => {
    const at = new Date(T0 + HOUR).toISOString()
    const a = decide(file(), SHA, { choice: 'at', at }, T0)
    assert.ok(a.ok)
    const s = decide(a.ok ? a.file : file(), SHA, { choice: 'skip' }, T0)
    assert.ok(s.ok)
    if (!s.ok) return
    assert.equal(s.file.current, null)
    assert.ok(isSkipped(s.file, SHA))
    assert.ok(isSkipped(s.file, SHA.slice(0, 12)), 'a short sha is the same build')
    assert.ok(!isSkipped(s.file, NEXT))
    assert.deepEqual(decide(s.file, SHA, { choice: 'now' }, T0), { ok: false, error: 'skipped' })
  })

  test('the next release replaces whatever stood for the last one', () => {
    const a = decide(file(), SHA, { choice: 'at', at: new Date(T0 + HOUR).toISOString() }, T0)
    assert.ok(a.ok)
    if (!a.ok) return
    assert.equal(dropStale(a.file, SHA), a.file, 'same build: kept')
    assert.equal(dropStale(a.file, NEXT).current, null)
  })

  test('due: before the time, at it, while busy, and the launch grace', () => {
    const at = T0 + HOUR
    const d = { sha: SHA, choice: 'at' as const, at: new Date(at).toISOString(), decidedAt: new Date(T0).toISOString() }
    const boot = T0 - HOUR
    assert.deepEqual(dueState(d, T0, boot, null), { kind: 'scheduled', dueAt: at })
    assert.deepEqual(dueState(d, at, boot, null), { kind: 'go' })
    assert.deepEqual(dueState(d, at + 1, boot, 'the music is playing'), { kind: 'waiting', reason: 'the music is playing' })
    // Due while the app was closed: launch is not an idle moment.
    const bootLate = at + 2 * HOUR
    assert.deepEqual(dueState(d, bootLate + 1000, bootLate, null), { kind: 'scheduled', dueAt: bootLate + LAUNCH_GRACE_MS })
    assert.deepEqual(dueState(d, bootLate + LAUNCH_GRACE_MS, bootLate, null), { kind: 'go' })
  })

  test('a torn or foreign file is no answer, never a throw', () => {
    for (const raw of [null, 'x', [], { current: { sha: 'zz', choice: 'now', decidedAt: 'x' } }, { current: { sha: SHA, choice: 'at', at: 'soon', decidedAt: new Date(T0).toISOString() } }]) {
      assert.deepEqual(parseDecisionFile(raw).current, null)
    }
    const kept = parseDecisionFile({ v: 1, current: null, skipped: [{ sha: SHA, at: new Date(T0).toISOString() }, { sha: 'nope', at: 'x' }], started: null })
    assert.deepEqual(kept.skipped, [{ sha: SHA, at: new Date(T0).toISOString() }])
  })

  test('a v 2 marker carries the release and is trusted for 9 days; a v 1 marker reads as a fix', () => {
    const ctx = { now: T0, runningSha: RUNNING, pidAlive: () => true }
    const v = judgeMarker(v2(), ctx)
    assert.equal(v.kind, 'ready')
    if (v.kind === 'ready') {
      assert.equal(v.state.label, 'This week’s fixes')
      assert.equal(v.state.kind, 'weekly')
      assert.deepEqual(v.state.notes, ['Album pages open faster', 'The iPod page counts right'])
      assert.equal(v.state.decides, true)
    }
    const old = new Date(T0 - MARKER_V2_MAX_AGE_MS + 1000).toISOString()
    assert.equal(judgeMarker(v2({ stagedAt: old }), ctx).kind, 'ready')
    assert.equal(judgeMarker(v2({ stagedAt: new Date(T0 - MARKER_V2_MAX_AGE_MS - 1000).toISOString() }), ctx).kind, 'invalid')
    const odd = judgeMarker(v2({ kind: 'someday', notes: ['  one\nline  ', 7, '', 'x'.repeat(500)], label: '' }), ctx)
    if (odd.kind === 'ready') {
      assert.equal(odd.state.kind, 'fix', 'an unknown kind reads as a fix')
      assert.deepEqual(odd.state.notes.map((n) => n.length), [8, 200])
      assert.equal(odd.state.notes[0], 'one line')
      assert.equal(odd.state.label, 'Version 6.1.0')
    } else assert.fail('should be ready')
  })
})

// ── The watcher, with a clock the test moves ─────────────────────────────

interface H {
  dir: string
  clock: { now: number }
  sent: Array<UpdateReadyState | null>
  usage: Array<{ name: string; detail?: Record<string, unknown>; ok?: boolean }>
  actions: string[]
  world: { playing: boolean; sync: boolean; busy: string | null }
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  check: () => Promise<void>
  stop: () => void
  last: () => UpdateReadyState | null
  go: () => string | null
  decisions: () => DecisionFile
  cleanup: () => void
}

function harness(opts: { dir?: string; runningSha?: string; clock?: { now: number } } = {}): H {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'jt-update-decision-'))
  const clock = opts.clock ?? { now: T0 }
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcRegistrar = { handle: (channel, listener) => { handlers.set(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) } }
  const sent: Array<UpdateReadyState | null> = []
  const usage: H['usage'] = []
  const actions: string[] = []
  const world = { playing: false, sync: false, busy: null as string | null }
  const handle = startUpdateReadyWatcher({
    ipc, userData: dir, runningSha: opts.runningSha ?? RUNNING,
    send: (s) => { sent.push(s) },
    sendAction: (a) => { actions.push(a) },
    syncInFlight: () => world.sync,
    playing: () => world.playing,
    busy: () => world.busy,
    record: () => { /* flight recorder */ },
    usage: (name, detail, ok) => { usage.push({ name, detail, ok }) },
    now: () => clock.now,
    pidAlive: (pid) => pid === 4242,
    pollMs: 60_000,
    log: () => { /* quiet */ },
  })
  const goPath = join(dir, UPDATE_GO_FILE)
  return {
    dir, clock, sent, usage, actions, world,
    invoke: async (channel, ...args) => {
      const fn = handlers.get(channel)
      assert.ok(fn, `no handler for ${channel}`)
      return fn({} as IpcMainInvokeEvent, ...args)
    },
    check: () => handle.check(),
    stop: () => handle.stop(),
    last: () => handle.current(),
    go: () => (existsSync(goPath) ? readFileSync(goPath, 'utf8') : null),
    decisions: () => parseDecisionFile(JSON.parse(readFileSync(join(dir, UPDATE_DECISION_FILE), 'utf8'))),
    cleanup: () => { handle.stop(); if (!opts.dir) rmSync(dir, { recursive: true, force: true }) },
  }
}

const offer = (h: H, over: Record<string, unknown> = {}): void => writeFileSync(join(h.dir, UPDATE_READY_FILE), JSON.stringify(v2(over)))

describe('update decisions — the watcher carries them out', () => {
  test('a v 2 offer reaches the bar with its label and notes, and homemini hears it was offered', async () => {
    const h = harness()
    try {
      offer(h)
      await h.check()
      const s = h.last()
      assert.equal(s?.phase, 'offered')
      assert.equal(s?.label, 'This week’s fixes')
      assert.equal(s?.decides, true)
      assert.equal(h.usage.filter((u) => u.name === 'update.offered').length, 1)
      await h.check()
      assert.equal(h.usage.filter((u) => u.name === 'update.offered').length, 1, 'once per release')
      assert.equal(h.go(), null, 'nothing installs without a decision')
    } finally { h.cleanup() }
  })

  test('"Install at…": on disk first, no go-file before the time, waits while playing, then the bare sha', async () => {
    const h = harness()
    try {
      offer(h)
      await h.check()
      const at = defaultInstallAt(T0)
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'at', at: new Date(at).toISOString() }), { ok: true })
      assert.equal(h.decisions().current?.choice, 'at', 'the decision is on disk')
      assert.equal(h.last()?.phase, 'scheduled')
      assert.equal(h.last()?.at, new Date(at).toISOString())
      assert.deepEqual(h.usage.find((u) => u.name === 'update.decide')?.detail?.choice, 'at')
      await h.check()
      assert.equal(h.go(), null)

      // 3:00 AM: the music is playing.
      h.clock.now = at + 1000
      h.world.playing = true
      await h.check()
      await h.check()
      assert.equal(h.go(), null, 'never while the music plays')
      assert.equal(h.last()?.phase, 'waiting')
      assert.equal(h.last()?.waitingFor, 'the music is playing')
      assert.equal(h.usage.filter((u) => u.name === 'update.install.waiting').length, 1, 'said once, not every poll')

      // A sync starts as the music stops.
      h.world.playing = false
      h.world.sync = true
      await h.check()
      assert.equal(h.go(), null)
      assert.equal(h.last()?.waitingFor, 'an iPod sync is running')
      assert.equal(h.usage.filter((u) => u.name === 'update.install.waiting').length, 2)

      // The first quiet moment.
      h.world.sync = false
      h.clock.now = at + 20 * 60_000
      await h.check()
      assert.equal(h.go(), `${SHA}\n`, 'the gate gets the bare sha, the same yes as Install now')
      assert.equal(h.last()?.phase, 'installing')
      assert.deepEqual(h.actions, [], 'nothing to pause: nothing was playing')
      const start = h.usage.find((u) => u.name === 'update.install.start')
      assert.equal(start?.detail?.choice, 'at')
      assert.equal(start?.detail?.lateMs, 20 * 60_000, 'how long after the chosen time it went')
      assert.equal(h.decisions().started?.sha, SHA, 'the next launch will look for it')
      // Too late to change now.
      assert.deepEqual(await h.invoke('update-ready:cancel'), { ok: false, error: 'installing' })
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'skip' }), { ok: false, error: 'installing' })
    } finally { h.cleanup() }
  })

  test('Change and Cancel before the time; a CD rip holds it like a sync', async () => {
    const h = harness()
    try {
      offer(h)
      await h.check()
      const first = T0 + 2 * HOUR
      await h.invoke('update-ready:decide', { choice: 'at', at: new Date(first).toISOString() })
      const second = T0 + 30 * HOUR
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'at', at: new Date(second).toISOString() }), { ok: true })
      const change = h.usage.find((u) => u.name === 'update.change')
      assert.equal(change?.detail?.wasAt, new Date(first).toISOString())
      assert.equal(h.last()?.at, new Date(second).toISOString())
      h.clock.now = first + 1000
      await h.check()
      assert.equal(h.go(), null, 'the old time is gone')
      assert.deepEqual(await h.invoke('update-ready:cancel'), { ok: true })
      assert.equal(h.last()?.phase, 'offered')
      assert.equal(h.decisions().current, null)
      assert.ok(h.usage.some((u) => u.name === 'update.cancel'))
      h.clock.now = second + 1000
      await h.check()
      assert.equal(h.go(), null, 'cancelled: nothing installs')
      // Again, with a rip running at the time.
      await h.invoke('update-ready:decide', { choice: 'at', at: new Date(h.clock.now + HOUR).toISOString() })
      h.clock.now += HOUR + 1
      h.world.busy = 'a CD rip is running'
      await h.check()
      assert.equal(h.last()?.waitingFor, 'a CD rip is running')
      assert.equal(h.go(), null)
    } finally { h.cleanup() }
  })

  test('a bad time is refused and nothing is saved', async () => {
    const h = harness()
    try {
      offer(h)
      await h.check()
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'at', at: new Date(T0 + 8 * 24 * HOUR).toISOString() }), { ok: false, error: 'bad-time' })
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'maybe' }), { ok: false, error: 'bad-choice' })
      assert.ok(!existsSync(join(h.dir, UPDATE_DECISION_FILE)) || h.decisions().current === null)
      assert.equal(h.last()?.phase, 'offered')
    } finally { h.cleanup() }
  })

  test('Install now pauses first and writes the bare sha; during an iPod sync it waits', async () => {
    const h = harness()
    try {
      offer(h)
      await h.check()
      h.world.sync = true
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'now' }), { ok: false, error: 'after the sync' })
      assert.equal(h.go(), null)
      h.world.sync = false
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'now' }), { ok: true })
      assert.deepEqual(h.actions, ['pause'])
      assert.equal(h.go(), `${SHA}\n`)
      assert.equal(h.last()?.phase, 'installing')
    } finally { h.cleanup() }
  })

  test('Skip: hidden at once, the gate is told, and a restart tells it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-update-decision-'))
    const clock = { now: T0 }
    try {
      const h = harness({ dir, clock })
      offer(h)
      await h.check()
      assert.deepEqual(await h.invoke('update-ready:decide', { choice: 'skip' }), { ok: true })
      assert.equal(h.last(), null, 'never offered again on this Mac')
      assert.equal(h.sent.at(-1), null)
      assert.equal(h.go(), `skip ${SHA}\n`)
      assert.ok(h.usage.some((u) => u.name === 'update.decide' && u.detail?.choice === 'skip'))
      h.stop()

      // A restart clears every go-file; the skip is written again from the decision file.
      const again = harness({ dir, clock })
      await again.check()
      await again.check()
      assert.equal(again.last(), null)
      assert.equal(again.go(), `skip ${SHA}\n`)
      assert.ok(!again.usage.some((u) => u.name === 'update.offered'), 'a skipped release is not offered')
      // Next week's release replaces it and is offered as usual.
      offer(again, { sha: NEXT })
      await again.check()
      assert.equal(again.last()?.sha, NEXT)
      assert.equal(again.last()?.phase, 'offered')
      again.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('the next release drops the last one\'s answer (it has to be decided again)', async () => {
    const h = harness()
    try {
      offer(h)
      await h.check()
      await h.invoke('update-ready:decide', { choice: 'at', at: new Date(T0 + HOUR).toISOString() })
      offer(h, { sha: NEXT })
      await h.check()
      assert.equal(h.last()?.sha, NEXT)
      assert.equal(h.last()?.phase, 'offered')
      assert.equal(h.decisions().current, null)
      assert.ok(h.usage.some((u) => u.name === 'update.decision-dropped'))
      h.clock.now = T0 + 2 * HOUR
      await h.check()
      assert.equal(h.go(), null)
    } finally { h.cleanup() }
  })

  test('the gate going away keeps the answer: the same release coming back is still scheduled', async () => {
    const h = harness()
    try {
      offer(h)
      await h.check()
      await h.invoke('update-ready:decide', { choice: 'at', at: new Date(T0 + 5 * HOUR).toISOString() })
      rmSync(join(h.dir, UPDATE_READY_FILE))
      await h.check()
      assert.equal(h.last(), null)
      offer(h)
      await h.check()
      assert.equal(h.last()?.phase, 'scheduled')
    } finally { h.cleanup() }
  })

  test('the next launch says whether the install landed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-update-decision-'))
    try {
      const h = harness({ dir })
      offer(h)
      await h.check()
      await h.invoke('update-ready:decide', { choice: 'now' })
      h.stop()
      const landed = harness({ dir, runningSha: SHA.slice(0, 12) })
      await landed.check()
      const ev = landed.usage.find((u) => u.name === 'update.installed')
      assert.ok(ev, JSON.stringify(landed.usage))
      assert.equal(ev?.ok, true)
      assert.equal(landed.decisions().started, null, 'said once')
      landed.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
