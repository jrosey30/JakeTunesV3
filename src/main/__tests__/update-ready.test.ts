/**
 * Update ready (2026-10-30) — the rules, the watcher and the wiring.
 *
 *  - core: which markers count (v, sha, gatePid alive, 12 h, not this build)
 *  - module: a marker appearing in a temp userData reaches the renderer as
 *    { sha, version, note }; a dead gate's marker is deleted and null is
 *    pushed; Install pauses FIRST through the media-key path, then writes
 *    update-go with the sha; a stale update-go is removed at start
 *  - wiring: index.ts starts the watcher exactly once with the media-key
 *    pause and the build sha; preload / renderer types are twins; the status
 *    bar draws it; the gate script is in the repo and executable
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcRegistrar, RegisterHandleOptions } from '../ipc-register.ts'
import type { UpdateReadyState } from '../../common/update-ready.ts'
import {
  goFileBody,
  judgeMarker,
  MARKER_MAX_AGE_MS,
  parseMarkerText,
  sameBuild,
  sameState,
  UPDATE_GO_FILE,
  UPDATE_READY_FILE,
} from '../update-ready-core.ts'
import { startUpdateReadyWatcher, processAlive, type UpdateReadyHandle } from '../update-ready.ts'

const SRC = join(import.meta.dirname, '../..')
const ROOT = join(SRC, '..')
const NOW = Date.parse('2026-10-30T18:00:00Z')
const SHA = '0123456789abcdef0123456789abcdef01234567'
const RUNNING = 'fedcba987654'   // build-provenance keeps 12 chars

function marker(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, sha: SHA, version: '6.0.0', note: 'Album page + back pill', stagedAt: '2026-10-30T17:50:00Z', gatePid: 4242, ...over }
}

describe('update-ready core — which markers count', () => {
  const alive = { now: NOW, runningSha: RUNNING, pidAlive: () => true }

  test('a fresh marker from a live gate for another build is ready', () => {
    const v = judgeMarker(marker(), alive)
    assert.equal(v.kind, 'ready')
    if (v.kind === 'ready') {
      assert.deepEqual(v.state, { sha: SHA, version: '6.0.0', note: 'Album page + back pill' })
      assert.equal(v.gatePid, 4242)
    }
  })

  test('missing version / note read as empty strings, never as a rejection', () => {
    const v = judgeMarker(marker({ version: undefined, note: 7 }), alive)
    assert.equal(v.kind, 'ready')
    if (v.kind === 'ready') assert.deepEqual(v.state, { sha: SHA, version: '', note: '' })
  })

  test('shape rejections name their reason', () => {
    assert.deepEqual(judgeMarker(null, alive), { kind: 'invalid', reason: 'shape' })
    assert.deepEqual(judgeMarker('{}', alive), { kind: 'invalid', reason: 'shape' })
    assert.deepEqual(judgeMarker([], alive), { kind: 'invalid', reason: 'shape' })
    assert.deepEqual(judgeMarker(marker({ v: 2 }), alive), { kind: 'invalid', reason: 'v' })
    assert.deepEqual(judgeMarker(marker({ v: '1' }), alive), { kind: 'invalid', reason: 'v' })
    assert.deepEqual(judgeMarker(marker({ sha: '' }), alive), { kind: 'invalid', reason: 'sha' })
    assert.deepEqual(judgeMarker(marker({ sha: '   ' }), alive), { kind: 'invalid', reason: 'sha' })
    assert.deepEqual(judgeMarker(marker({ sha: 42 }), alive), { kind: 'invalid', reason: 'sha' })
    assert.deepEqual(judgeMarker(marker({ gatePid: 0 }), alive), { kind: 'invalid', reason: 'gatePid' })
    assert.deepEqual(judgeMarker(marker({ gatePid: '4242' }), alive), { kind: 'invalid', reason: 'gatePid' })
    assert.deepEqual(judgeMarker(marker({ gatePid: 1.5 }), alive), { kind: 'invalid', reason: 'gatePid' })
    assert.deepEqual(judgeMarker(marker({ stagedAt: 'yesterday' }), alive), { kind: 'invalid', reason: 'stagedAt' })
    assert.deepEqual(judgeMarker(marker({ stagedAt: undefined }), alive), { kind: 'invalid', reason: 'stagedAt' })
  })

  test('a marker older than 12 h is stale (the boundary itself still counts)', () => {
    const edge = new Date(NOW - MARKER_MAX_AGE_MS).toISOString()
    assert.equal(judgeMarker(marker({ stagedAt: edge }), alive).kind, 'ready')
    const over = new Date(NOW - MARKER_MAX_AGE_MS - 1000).toISOString()
    assert.deepEqual(judgeMarker(marker({ stagedAt: over }), alive), { kind: 'invalid', reason: 'stale' })
  })

  test('a dead gate is reported before anything else, so the file gets deleted whatever it says', () => {
    const dead = { ...alive, pidAlive: () => false }
    assert.deepEqual(judgeMarker(marker(), dead), { kind: 'dead-gate', gatePid: 4242 })
    assert.deepEqual(judgeMarker(marker({ sha: RUNNING }), dead), { kind: 'dead-gate', gatePid: 4242 })
    assert.deepEqual(judgeMarker(marker({ stagedAt: '2020-01-01T00:00:00Z' }), dead), { kind: 'dead-gate', gatePid: 4242 })
  })

  test('a marker naming the running build is same-build — the tail of the install that just happened', () => {
    assert.deepEqual(judgeMarker(marker({ sha: RUNNING }), alive), { kind: 'same-build', sha: RUNNING })
    // The gate passes the full sha; build-info keeps 12 chars — still the same build.
    assert.equal(judgeMarker(marker({ sha: `${RUNNING}0011223344556677889900aabbcc` }), alive).kind, 'same-build')
  })

  test('a dev run (no build sha) treats every marker as new', () => {
    assert.equal(judgeMarker(marker({ sha: RUNNING }), { ...alive, runningSha: 'dev' }).kind, 'ready')
    assert.equal(judgeMarker(marker({ sha: RUNNING }), { ...alive, runningSha: null }).kind, 'ready')
  })

  test('sameBuild compares what both sides have, case-insensitively, never on fewer than 7 chars', () => {
    assert.ok(sameBuild(SHA, SHA.slice(0, 12)))
    assert.ok(sameBuild(SHA.slice(0, 12), SHA))
    assert.ok(sameBuild('ABCDEF1234', 'abcdef1234'))
    assert.ok(!sameBuild(SHA, RUNNING))
    assert.ok(!sameBuild('abcdef', 'abcdef'), 'too short to mean anything')
    assert.ok(!sameBuild('', SHA))
  })

  test('parseMarkerText never throws; goFileBody is the bare sha on one line; sameState compares fields', () => {
    assert.equal(parseMarkerText('{not json'), null)
    assert.equal(parseMarkerText(''), null)
    assert.deepEqual(parseMarkerText('{"v":1}'), { v: 1 })
    assert.equal(goFileBody(`  ${SHA} `), `${SHA}\n`)
    const a: UpdateReadyState = { sha: SHA, version: '6.0.0', note: 'x' }
    assert.ok(sameState(a, { ...a }))
    assert.ok(sameState(null, null))
    assert.ok(!sameState(a, null))
    assert.ok(!sameState(a, { ...a, note: 'y' }))
  })

  test('processAlive answers for this process and for a pid nothing owns', () => {
    assert.equal(processAlive(process.pid), true)
    // The largest pid macOS/Linux hand out is far below this; nothing is listening there.
    assert.equal(processAlive(2 ** 22 - 7), false)
  })
})

// ── The module, against a temp userData ─────────────────────────────────

interface Harness {
  dir: string
  handle: UpdateReadyHandle
  sent: Array<UpdateReadyState | null>
  rows: Array<{ tag: string; detail?: unknown }>
  actions: string[]
  alivePids: Set<number>
  invoke: (channel: string) => Promise<unknown>
  write: (m: Record<string, unknown>) => void
  markerPath: string
  goPath: string
  cleanup: () => void
}

function harness(opts: { runningSha?: string; pollMs?: number; preGo?: string; onPause?: () => void } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'jt-update-ready-'))
  const markerPath = join(dir, UPDATE_READY_FILE)
  const goPath = join(dir, UPDATE_GO_FILE)
  if (opts.preGo !== undefined) writeFileSync(goPath, opts.preGo)
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcRegistrar = {
    handle: (channel, listener, options?: RegisterHandleOptions) => {
      assert.ok(options && Object.prototype.hasOwnProperty.call(options, 'refuse'), `${channel} must register with { refuse } (default-deny)`)
      handlers.set(channel, listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)
    },
  }
  const sent: Array<UpdateReadyState | null> = []
  const rows: Array<{ tag: string; detail?: unknown }> = []
  const actions: string[] = []
  const alivePids = new Set<number>([4242])
  const handle = startUpdateReadyWatcher({
    ipc,
    userData: dir,
    runningSha: opts.runningSha ?? RUNNING,
    send: (s) => { sent.push(s) },
    sendAction: (a) => { actions.push(a); opts.onPause?.() },
    record: (tag, detail) => { rows.push({ tag, detail }) },
    now: () => NOW,
    pidAlive: (pid) => alivePids.has(pid),
    pollMs: opts.pollMs ?? 60_000,
    log: () => { /* quiet */ },
  })
  return {
    dir, handle, sent, rows, actions, alivePids, markerPath, goPath,
    invoke: async (channel) => {
      const fn = handlers.get(channel)
      assert.ok(fn, `no handler for ${channel}`)
      return fn({} as IpcMainInvokeEvent)
    },
    write: (m) => writeFileSync(markerPath, JSON.stringify(m)),
    cleanup: () => { handle.stop(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('update-ready watcher — the marker reaches the renderer', () => {
  test('no marker: nothing is pushed, get answers null, Install is refused', async () => {
    const h = harness()
    try {
      await h.handle.check()
      assert.deepEqual(h.sent, [])
      assert.deepEqual(await h.invoke('update-ready:get'), { ok: true, state: null })
      assert.deepEqual(await h.invoke('install-update-now'), { ok: false, error: 'no-update' })
      assert.deepEqual(h.actions, [], 'no pause without an update')
      assert.ok(!existsSync(h.goPath), 'no go-file without an update')
    } finally { h.cleanup() }
  })

  test('a marker appears: one push with { sha, version, note }, a flight-recorder row, get agrees', async () => {
    const h = harness()
    try {
      h.write(marker())
      await h.handle.check()
      await h.handle.check()   // unchanged → no second push
      assert.deepEqual(h.sent, [{ sha: SHA, version: '6.0.0', note: 'Album page + back pill' }])
      assert.deepEqual(h.rows.filter((r) => r.tag === 'update-ready.seen').length, 1)
      assert.deepEqual(await h.invoke('update-ready:get'), { ok: true, state: { sha: SHA, version: '6.0.0', note: 'Album page + back pill' } })
    } finally { h.cleanup() }
  })

  test('the marker goes away (the gate finished or aborted): null is pushed once', async () => {
    const h = harness()
    try {
      h.write(marker())
      await h.handle.check()
      unlinkSync(h.markerPath)
      await h.handle.check()
      await h.handle.check()
      assert.deepEqual(h.sent, [{ sha: SHA, version: '6.0.0', note: 'Album page + back pill' }, null])
      assert.equal(h.rows.filter((r) => r.tag === 'update-ready.gone').length, 1)
    } finally { h.cleanup() }
  })

  test('a dead gate\'s marker is deleted and null is pushed', async () => {
    const h = harness()
    try {
      h.write(marker())
      await h.handle.check()
      h.alivePids.clear()
      await h.handle.check()
      assert.ok(!existsSync(h.markerPath), 'stale file removed')
      assert.deepEqual(h.sent.at(-1), null)
      assert.deepEqual(h.rows.find((r) => r.tag === 'update-ready.dead-gate')?.detail, { gatePid: 4242 })
    } finally { h.cleanup() }
  })

  test('a marker for the running build shows nothing; a dev build shows everything', async () => {
    const same = harness()
    try {
      same.write(marker({ sha: RUNNING }))
      await same.handle.check()
      assert.deepEqual(same.sent, [])
      assert.ok(existsSync(same.markerPath), 'left for the gate to clean up')
    } finally { same.cleanup() }
    const dev = harness({ runningSha: 'dev' })
    try {
      dev.write(marker({ sha: RUNNING }))
      await dev.handle.check()
      assert.equal(dev.sent.length, 1)
      assert.equal(dev.sent[0]?.sha, RUNNING)
    } finally { dev.cleanup() }
  })

  test('a stale or torn marker is ignored and left alone', async () => {
    const h = harness()
    try {
      h.write(marker({ stagedAt: '2026-10-29T00:00:00Z' }))
      await h.handle.check()
      writeFileSync(h.markerPath, '{ "v": 1, "sha": "01')
      await h.handle.check()
      assert.deepEqual(h.sent, [])
      assert.ok(existsSync(h.markerPath))
    } finally { h.cleanup() }
  })

  test('Install: pause goes out through the media-key path FIRST, then update-go holds the sha', async () => {
    let goExistedAtPause: boolean | null = null
    const h = harness({ onPause: () => { goExistedAtPause = existsSync(join(h.dir, UPDATE_GO_FILE)) } })
    try {
      h.write(marker())
      await h.handle.check()
      assert.deepEqual(await h.invoke('install-update-now'), { ok: true })
      assert.deepEqual(h.actions, ['pause'])
      assert.equal(goExistedAtPause, false, 'the music is paused before the gate is told to go')
      assert.equal(readFileSync(h.goPath, 'utf8'), `${SHA}\n`)
      assert.deepEqual(h.rows.find((r) => r.tag === 'update-ready.install-now')?.detail, { sha: SHA, version: '6.0.0' })
      // The gate removes its marker when it exits — the bar follows.
      unlinkSync(h.markerPath)
      await h.handle.check()
      assert.deepEqual(h.sent.at(-1), null)
    } finally { h.cleanup() }
  })

  test('Install re-reads first: a gate that died since the last draw is refused, its marker removed', async () => {
    const h = harness()
    try {
      h.write(marker())
      await h.handle.check()
      h.alivePids.clear()
      assert.deepEqual(await h.invoke('install-update-now'), { ok: false, error: 'no-update' })
      assert.deepEqual(h.actions, [])
      assert.ok(!existsSync(h.goPath))
      assert.ok(!existsSync(h.markerPath))
    } finally { h.cleanup() }
  })

  test('a leftover update-go is removed at start and recorded', async () => {
    const h = harness({ preGo: `${SHA}\n` })
    try {
      await h.handle.check()
      await settle()
      assert.ok(!existsSync(h.goPath))
      assert.equal(h.rows.filter((r) => r.tag === 'update-ready.stale-go-removed').length, 1)
    } finally { h.cleanup() }
    const clean = harness()
    try {
      await clean.handle.check()
      await settle()
      assert.equal(clean.rows.filter((r) => r.tag === 'update-ready.stale-go-removed').length, 0, 'nothing to remove, nothing recorded')
    } finally { clean.cleanup() }
  })

  test('the poll notices a marker (and a dead gate) without being asked; stop() ends it', async () => {
    const h = harness({ pollMs: 40 })
    try {
      h.write(marker())
      const until = Date.now() + 3000
      while (h.sent.length === 0 && Date.now() < until) await settle(20)
      assert.equal(h.sent.length, 1, 'the watcher or the poll saw the file')
      h.alivePids.clear()
      const until2 = Date.now() + 3000
      while (h.sent.length < 2 && Date.now() < until2) await settle(20)
      assert.deepEqual(h.sent.at(-1), null)
      assert.ok(!existsSync(h.markerPath))
      h.handle.stop()
      h.alivePids.add(4242)
      h.write(marker())
      await settle(150)
      assert.equal(h.sent.length, 2, 'nothing after stop()')
    } finally { h.cleanup() }
  })
})

// ── Wiring locks ─────────────────────────────────────────────────────────

describe('update-ready wiring — the tested code is the live code', () => {
  const index = readFileSync(join(SRC, 'main/index.ts'), 'utf-8')
  const preload = readFileSync(join(SRC, 'preload/index.ts'), 'utf-8')
  const types = readFileSync(join(SRC, 'renderer/types.ts'), 'utf-8')
  const statusBar = readFileSync(join(SRC, 'renderer/components/chrome/StatusBar.tsx'), 'utf-8')
  const app = readFileSync(join(SRC, 'renderer/App.tsx'), 'utf-8')

  test('index.ts starts the watcher exactly once, with the media-key pause and the build sha', () => {
    const calls = (index.match(/(?<![\w.])startUpdateReadyWatcher\(/g) || []).length
    assert.equal(calls, 1, `startUpdateReadyWatcher has ${calls} call site(s) in main/index.ts — exactly one, in app.whenReady`)
    assert.match(index, /import \{ startUpdateReadyWatcher \} from '\.\/update-ready\.ts'/)
    const call = index.slice(index.indexOf('startUpdateReadyWatcher({'))
    const line = call.slice(0, call.indexOf('\n'))
    assert.match(line, /sendAction: sendMediaKeyAction/, 'Install must pause through the media-key path (the pause action from #305)')
    assert.match(line, /runningSha: getBuildProvenance\(app\.getVersion\(\)\)\.buildSha/, 'the running build is identified by its build sha, not its version')
    assert.match(line, /userData: app\.getPath\('userData'\)/, 'the markers live in userData, where the gate writes them')
    assert.match(line, /sendToRenderer\('update-ready'/, 'the push channel the preload listens on')
  })

  test('preload and renderer types are twins on the three entry points', () => {
    for (const name of ['onUpdateReady', 'getUpdateReady', 'installUpdateNow']) {
      assert.match(preload, new RegExp(`^  ${name}: `, 'm'), `preload exposes ${name}`)
      assert.match(types, new RegExp(`^      ${name}: `, 'm'), `renderer types declare ${name}`)
    }
    assert.match(preload, /ipcRenderer\.on\('update-ready', handler\)/)
    assert.match(preload, /ipcRenderer\.invoke\('update-ready:get'\)/)
    assert.match(preload, /ipcRenderer\.invoke\('install-update-now'\)/)
    assert.match(preload, /TWIN: src\/renderer\/types\.ts/)
    assert.match(types, /TWIN: src\/preload\/index\.ts \(onUpdateReady/)
  })

  test('the status bar draws the indicator and asks through ConfirmDialog; App mounts the bar once, globally', () => {
    assert.match(statusBar, /useUpdateReady\(\)/)
    assert.match(statusBar, /Update ready · Install/)
    assert.match(statusBar, /Installing — back in a moment/)
    assert.match(statusBar, /message="Install the update\?"/)
    assert.match(statusBar, /JakeTunes will pause, close and come back in about 20 seconds\./)
    assert.match(statusBar, /confirmLabel="Install"/)
    assert.match(statusBar, /cancelLabel="Not now"/)
    assert.doesNotMatch(statusBar, /window\.(alert|confirm|prompt)\s*\(/)
    assert.equal((app.match(/<StatusBar \/>/g) || []).length, 1, 'one StatusBar, in the app grid every view shares')
  })

  test('the gate script is versioned, executable and carries the protocol', () => {
    const path = join(ROOT, 'scripts/install/jaketunes-install-gate.sh')
    assert.ok(existsSync(path), 'scripts/install/jaketunes-install-gate.sh is missing')
    assert.ok((statSync(path).mode & 0o111) !== 0, 'the gate must stay executable')
    const gate = readFileSync(path, 'utf-8')
    assert.match(gate, /update-ready\.json/)
    assert.match(gate, /update-go/)
    assert.match(gate, /trap cleanup_markers EXIT/)
    assert.match(gate, /grep -q "Playing audio"; then echo "playing audio"; return 1; fi/, 'the audio hard stop is unchanged')
    assert.match(gate, /\[ "\$idle" -ge 120 \]/, 'the 120 s idle floor is unchanged')
    assert.ok(existsSync(join(ROOT, 'scripts/install/README.md')), 'the protocol is documented beside the script')
  })
})
