/**
 * The weekly release's install side on each Mac (2026-11-14): jaketunes-offer-update.sh stages and
 * offers; jaketunes-update-agent.sh, run by launchd, starts the gate when it should. Both shipped
 * scripts run here for real, under a temp HOME, with a fake gate that records how it was called and
 * ends when the test says. No launchd job is ever loaded: launchctl is a fake that writes down
 * what it was asked.
 *
 * The agent detaches its gate on purpose (a real one must outlive the agent's run), so nothing but
 * this file ends a fake one: after() ends every process the tests started and fails the run if one
 * is still going, and a fake gate gives up by itself once the test process is gone (a run killed
 * before its after()). Until 2026-11-19 the cleanup wrote each gate's word and deleted its folder in
 * the same breath, which a gate that looks every 50 ms often missed: 27 of them, from four runs on
 * 2026-11-14, ran for five days on Jake's MacBook, each starting `sleep` 20 times a second.
 *
 * What these prove:
 *  - offer: refuses a bad sha, bundle, signature or release file and stages nothing; stages under a
 *    hidden name; installs the agent and gate; writes the plist once and loads it once, then only
 *    asks it to look (idempotent); staging the same sha again keeps the copy
 *  - agent: the newest staged release wins; a decide Mac gets the release file (v 2 gate), homemini
 *    gets none (idle install, as today); a waiting gate is left alone; a reboot (a dead or reused
 *    pid, no answer) starts it again; a skip is final; 3 ABORTs and it gives up; a timeout or a
 *    newer marker restarts it uncounted; installed means nothing to do and the last two staged
 *    releases kept; two agents at once start one gate; on an idle Mac an older waiting gate is stopped
 *  - the agent's lock: an agent that finds it just taken never gets past it (until 2026-11-19 the
 *    moment between taking it and naming its holder let agents through); one left by an agent that
 *    is gone is taken over
 *  - the gate log: a usual run writes nothing to stderr, which launchd puts in that log; a policy
 *    file that is there but can't be read still says so
 *  - never go back (2026-11-19, workmini): a staged release older than the running app (an ancestor
 *    of its commit, else built earlier) is never offered and is removed, a leftover "installed" answer
 *    included; a newer one, or one either side has no provenance for, is offered as before; a gate
 *    waiting for a superseded release is stopped; a staged commit a checkout has not fetched is never older
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { deviceFromHostname } from '../../common/usage-log.ts'
import { HUNG_MS, waitFor } from './wait-for.ts'

const run = promisify(execFile)
const ROOT = join(import.meta.dirname, '..', '..', '..')
const AGENT = join(ROOT, 'scripts/install/jaketunes-update-agent.sh')
const OFFER = join(ROOT, 'scripts/install/jaketunes-offer-update.sh')
const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccccccccccccccccccccccccccc'
const RELEASE = JSON.stringify({ label: 'This week’s fixes', kind: 'weekly', notes: ['Album pages open faster'] })

const worlds: string[] = []

/** Every process still running from these worlds: a fake gate, or the wrapper the agent started it in.
 *  Both name their world's folder on their command line. */
function running(roots: string[]): Array<{ pid: number; command: string }> {
  const ps = execFileSync('/bin/ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8' })
  return ps.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    return m && roots.some((r) => m[2].includes(`${r}/`)) ? [{ pid: Number(m[1]), command: m[2] }] : []
  })
}

/** Ends every process these worlds started and waits until they are gone: TERM, and whatever has not
 *  gone in 5 s gets KILL, which nothing refuses, then as long as a busy Mac needs (wait-for.ts).
 *  Returns what is still running: nothing, unless a kill did not work. */
async function endAll(roots: string[]): Promise<string[]> {
  for (const [signal, ms] of [['SIGTERM', 5_000], ['SIGKILL', HUNG_MS]] as const) {
    for (const p of running(roots)) { try { process.kill(p.pid, signal) } catch { /* already gone */ } }
    const until = Date.now() + ms
    while (running(roots).length > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  }
  return running(roots).map((p) => `${p.pid} ${p.command}`)
}

after(async () => {
  // A gate still waiting here was left by a test that failed before releasing it, or started where a
  // test expected none. End them all before the folders go, and fail the run if any is left.
  const left = await endAll(worlds)
  for (const w of worlds) rmSync(w, { recursive: true, force: true })
  assert.deepEqual(left, [], 'every process the tests started has ended')
})

interface World {
  root: string
  home: string
  data: string
  stage: string
  fake: string
  log: string
  app: string
  /** Stage a release as the offer script would leave it (staged-at in epoch seconds). */
  stage_: (sha: string, at: number) => void
  installedIs: (sha: string) => void
  /** One run of the agent. `hold`: a folder; the agent stops right after taking its lock, writes
   *  `held` there and goes on once `go` is there (JT_AGENT_LOCK_HOLD). */
  agent: (opts?: { host?: string; hold?: string; repo?: string }) => Promise<{ stdout: string; stderr: string }>
  gateCalls: () => string[]
  /** Every gate started so far ends with this code. */
  gatesEnd: (code: number) => void
  dir: (sha: string) => string
}

/** `owner`: the process whose end ends this world's gates (the test process; a test of that rule
 *  passes one it can kill). */
function world(opts: { owner?: number } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'jt-update-agent-'))
  worlds.push(root)
  const home = join(root, 'home')
  const data = join(home, 'Library', 'Application Support', 'JakeTunes')
  const stage = join(data, 'staged-updates')
  const fake = join(root, 'fake')
  const app = join(root, 'Applications', 'JakeTunes.app')
  mkdirSync(stage, { recursive: true })
  mkdirSync(fake)
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Resources', 'app.asar'), `old build ${'0'.repeat(12)}`)
  // The fake gate: writes down how it was called, then waits for the test's word. With the test
  // process gone nobody will ever give it, so it ends.
  const gate = join(fake, 'gate.sh')
  writeFileSync(gate, `#!/bin/bash
printf '%s\t' "$@" >> "${fake}/gate-calls"; echo >> "${fake}/gate-calls"
while [ ! -f "${fake}/gate-exit" ]; do
  kill -0 ${opts.owner ?? process.pid} 2>/dev/null || exit 3
  sleep 0.05
done
exit $(cat "${fake}/gate-exit")
`)
  chmodSync(gate, 0o755)
  const log = join(home, 'Library', 'Logs', 'jaketunes-update-gate.log')
  return {
    root, home, data, stage, fake, log, app,
    stage_: (sha, at) => {
      const d = join(stage, sha)
      mkdirSync(join(d, 'JakeTunes.app', 'Contents'), { recursive: true })
      writeFileSync(join(d, 'release.json'), RELEASE)
      writeFileSync(join(d, 'staged-at'), `${at}\n`)
    },
    installedIs: (sha) => writeFileSync(join(app, 'Contents', 'Resources', 'app.asar'), `bytes {"sha":"${sha}"} bytes`),
    agent: async (opts = {}) => {
      const r = await run('/bin/bash', [AGENT], {
        env: {
          HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          JT_AGENT_GATE: gate, JT_AGENT_APP: app, JT_AGENT_HOSTNAME: opts.host ?? 'Jakes-MacBook-Pro-2458',
          ...(opts.hold ? { JT_AGENT_LOCK_HOLD: opts.hold } : {}),
          ...(opts.repo ? { JT_AGENT_REPO: opts.repo } : {}),
        },
      })
      return { stdout: r.stdout, stderr: r.stderr }
    },
    gateCalls: () => (existsSync(join(fake, 'gate-calls')) ? readFileSync(join(fake, 'gate-calls'), 'utf8').split('\n').filter(Boolean) : []),
    gatesEnd: (code) => writeFileSync(join(fake, 'gate-exit'), String(code)),
    dir: (sha) => join(stage, sha),
  }
}

const exitWritten = (w: World, sha: string): Promise<true> => waitFor(() => existsSync(join(w.dir(sha), 'gate.exit')) || null, `${sha.slice(0, 4)}'s gate to end`) as Promise<true>
const releaseGates = async (w: World, sha: string, code: number): Promise<void> => {
  w.gatesEnd(code)
  await exitWritten(w, sha)
  rmSync(join(w.fake, 'gate-exit'))
}

describe('update agent — what it starts, and when', () => {
  it('nothing staged: nothing happens', async () => {
    const w = world()
    await w.agent()
    assert.deepEqual(w.gateCalls(), [])
  })

  it('a decide Mac: the newest staged release gets a v 2 gate with its release file; a waiting gate is left alone', async () => {
    const w = world()
    w.stage_(A, 1000)
    w.stage_(B, 2000)
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    const args = w.gateCalls()[0].split('\t')
    assert.equal(args[0], join(w.dir(B), 'JakeTunes.app'), 'the newest staged release wins')
    assert.match(args[1], /^JakeTunes-prev-bbbbbbbbbbbb-\d+\.app$/)
    assert.equal(args[2], '11520', 'eight days to decide')
    assert.equal(args[3], B)
    assert.equal(w.gateCalls()[0].endsWith(`${join(w.dir(B), 'release.json')}\t`), true, 'the release file: nothing installs without a decision')
    await w.agent()
    await w.agent()
    assert.equal(w.gateCalls().length, 1, 'one gate, however often launchd looks')
    await releaseGates(w, B, 3)
  })

  it('homemini (by its host name, or the policy file) gets no release file: it installs when idle, as today', async () => {
    for (const host of ['Jakes-Mini-6224', 'Jakes-Mac-mini', 'homemini']) {
      const w = world()
      w.stage_(B, 2000)
      await w.agent({ host })
      await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
      const call = w.gateCalls()[0]
      assert.doesNotMatch(call, /release\.json/, `${host}: no release file`)
      assert.equal(call.split('\t')[2], '180', `${host}: the idle gate's wait`)
      await releaseGates(w, B, 3)
    }
    // The setting wins over the name, both ways.
    const w = world()
    mkdirSync(join(w.home, '.config', 'jaketunes'), { recursive: true })
    writeFileSync(join(w.home, '.config', 'jaketunes', 'update-policy'), 'decide\n')
    w.stage_(B, 2000)
    await w.agent({ host: 'Jakes-Mini-6224' })
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    assert.match(w.gateCalls()[0], /release\.json\t$/, 'update-policy "decide" on homemini: Jake decides there too')
    await releaseGates(w, B, 3)
    const w2 = world()
    mkdirSync(join(w2.home, '.config', 'jaketunes'), { recursive: true })
    writeFileSync(join(w2.home, '.config', 'jaketunes', 'update-policy'), 'idle')
    w2.stage_(B, 2000)
    await w2.agent({ host: 'Workmini' })
    await waitFor(() => w2.gateCalls().length === 1 || null, 'the gate to start')
    assert.doesNotMatch(w2.gateCalls()[0], /release\.json/)
    await releaseGates(w2, B, 3)
  })

  it('the agent\'s idea of homemini is the app\'s (twin of deviceFromHostname)', async () => {
    for (const host of ['Jakes-Mini-6224', 'Jakes-Mac-mini.local', 'Workmini', 'Jakes-MacBook-Pro-2458', 'homemini']) {
      const w = world()
      w.stage_(B, 2000)
      await w.agent({ host })
      await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
      const idle = !/release\.json/.test(w.gateCalls()[0])
      assert.equal(idle, deviceFromHostname(host) === 'homemini', host)
      await releaseGates(w, B, 3)
    }
  })

  it('a reboot: the gate is gone with no answer (dead pid, or a pid now someone else\'s) — it starts again', async () => {
    const w = world()
    w.stage_(B, 2000)
    // A pid that existed and is gone.
    const dead = spawn('/usr/bin/true')
    await new Promise((r) => dead.on('exit', r))
    writeFileSync(join(w.dir(B), 'gate.pid'), `${dead.pid}\n`)
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start again')
    await releaseGates(w, B, 143)
    // After a reboot a pid can belong to anything: this one is the test runner, not a gate.
    writeFileSync(join(w.dir(B), 'gate.pid'), `${process.pid}\n`)
    rmSync(join(w.dir(B), 'gate.exit'), { force: true })
    await w.agent()
    await waitFor(() => w.gateCalls().length === 2 || null, 'the gate to start again')
    assert.match(readFileSync(w.log, 'utf8'), /gone without an answer \(a restart\?\)/)
    assert.ok(!existsSync(join(w.dir(B), 'tries')) || readFileSync(join(w.dir(B), 'tries'), 'utf8').trim() === '0', 'a reboot is not a failure')
    await releaseGates(w, B, 3)
  })

  it('a skip (exit 5) is final: never started again', async () => {
    const w = world()
    w.stage_(B, 2000)
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    await releaseGates(w, B, 5)
    await w.agent()
    await w.agent()
    assert.equal(w.gateCalls().length, 1)
    assert.ok(existsSync(join(w.dir(B), 'skipped')))
  })

  it('a skip stays final on every later run, a stale pid or a lost exit file included', async () => {
    const w = world()
    w.stage_(B, 2000)
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    await releaseGates(w, B, 5)
    await w.agent()
    assert.ok(existsSync(join(w.dir(B), 'skipped')))
    // Whatever the folder looks like afterwards, a skipped release is never started again.
    const dead = spawn('/usr/bin/true')
    await new Promise((r) => dead.on('exit', r))
    writeFileSync(join(w.dir(B), 'gate.pid'), `${dead.pid}\n`)
    for (let i = 0; i < 4; i++) await w.agent()
    writeFileSync(join(w.dir(B), 'gate.exit'), '3\n')
    await w.agent()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(w.gateCalls().length, 1)
  })

  it('pruning never removes a release whose gate is running', async () => {
    const w = world()
    w.stage_(A, 1000)
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'A\'s gate')
    w.stage_(B, 2000)
    w.stage_(C, 3000)
    w.installedIs(C)
    await w.agent()
    assert.ok(existsSync(join(w.dir(A), 'JakeTunes.app')), 'A is third newest but its gate is still running: kept')
    assert.ok(existsSync(w.dir(B)) && existsSync(w.dir(C)))
    await releaseGates(w, A, 3)
    await w.agent()
    assert.ok(!existsSync(w.dir(A)), 'once its gate has ended it goes')
  })

  it('timeouts, a newer marker and kills restart uncounted; three ABORTs and it gives up', async () => {
    const w = world()
    w.stage_(B, 2000)
    let n = 0
    for (const code of [3, 6, 143, 1, 1, 1]) {
      await w.agent()
      n++
      await waitFor(() => w.gateCalls().length === n || null, `gate ${n} to start`)
      await releaseGates(w, B, code)
    }
    await w.agent()
    await w.agent()
    assert.equal(w.gateCalls().length, 6, 'no seventh try')
    assert.ok(existsSync(join(w.dir(B), 'gave-up')))
    assert.match(readFileSync(w.log, 'utf8'), /3 failed tries — not trying again/)
  })

  it('installed: nothing to start; the last two staged releases and the newest rollback bundle are kept', async () => {
    const w = world()
    w.stage_(A, 1000)
    w.stage_(B, 2000)
    w.stage_(C, 3000)
    w.installedIs(C)
    mkdirSync(join(w.home, 'JakeTunes-prev-aaaa-1.app'))
    await new Promise((r) => setTimeout(r, 1100))
    mkdirSync(join(w.home, 'JakeTunes-prev-bbbb-2.app'))
    await w.agent()
    assert.deepEqual(w.gateCalls(), [])
    assert.deepEqual(readdirSync(w.stage).filter((f) => !f.startsWith('.')).sort(), [B, C])
    assert.deepEqual(readdirSync(w.home).filter((f) => f.startsWith('JakeTunes-prev-')), ['JakeTunes-prev-bbbb-2.app'])
  })

  it('two agents at once start one gate', async () => {
    const w = world()
    w.stage_(B, 2000)
    await Promise.all([w.agent(), w.agent(), w.agent()])
    await waitFor(() => w.gateCalls().length >= 1 || null, 'a gate to start')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(w.gateCalls().length, 1)
    await releaseGates(w, B, 3)
  })

  it('an agent that finds the lock just taken never gets past it', async () => {
    // Until 2026-11-19 the lock was a folder whose holder wrote its pid into it a moment after making
    // it. An agent that looked in between found no pid, took the lock as left behind and went on: on
    // 2026-11-14 three agents started together on a busy Mac each started a gate. Here the first
    // agent stops right after taking the lock, and two more run while it holds it.
    const w = world()
    w.stage_(B, 2000)
    const hold = join(w.root, 'hold')
    mkdirSync(hold)
    const first = w.agent({ hold })
    try {
      await waitFor(() => existsSync(join(hold, 'held')) || null, 'the first agent to take the lock')
      await Promise.all([w.agent(), w.agent()])
      assert.ok(!existsSync(join(w.dir(B), 'gate.pid')), 'no gate started while the first agent holds the lock')
    } finally {
      writeFileSync(join(hold, 'go'), '')
      await first
    }
    await waitFor(() => w.gateCalls().length === 1 || null, 'the first agent\'s gate')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(w.gateCalls().length, 1)
    await releaseGates(w, B, 3)
  })

  it('a lock left by an agent that is gone (killed, or the Mac lost power) is taken over', async () => {
    const w = world()
    w.stage_(B, 2000)
    const dead = spawn('/usr/bin/true')
    await new Promise((r) => dead.on('exit', r))
    // The lock as such an agent leaves it: a link naming its pid.
    symlinkSync(String(dead.pid), join(w.stage, '.agent-lock'))
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    assert.match(readFileSync(w.log, 'utf8'), new RegExp(`took over a lock left by pid ${dead.pid}$`, 'm'))
    assert.ok(!readdirSync(w.stage).includes('.agent-lock'), 'and let go of it when done')
    await releaseGates(w, B, 3)
  })

  it('a newer release staged while an older gate waits: the newest gets its gate; on an idle Mac the older one is stopped', async () => {
    const w = world()
    w.stage_(A, 1000)
    await w.agent({ host: 'Jakes-Mini-6224' })
    await waitFor(() => w.gateCalls().length === 1 || null, 'A\'s gate')
    w.stage_(B, 2000)
    await w.agent({ host: 'Jakes-Mini-6224' })
    await waitFor(() => w.gateCalls().length === 2 || null, 'B\'s gate')
    assert.equal(w.gateCalls()[1].split('\t')[3], B)
    // A's gate got TERM: its wrapper writes how it ended.
    await waitFor(() => existsSync(join(w.dir(A), 'gate.exit')) || null, 'A\'s gate to be stopped')
    assert.match(readFileSync(w.log, 'utf8'), /newer release bbbb.* staged — stopped its gate|aaaa.*stopped its gate/)
    await releaseGates(w, B, 3)
  })
})

describe('update agent — the gate log (launchd puts its stderr there)', () => {
  it('a usual run writes nothing to stderr: no policy file and no tries file are the usual case', async () => {
    // Until 2026-11-19 reading either missing file put "No such file or directory" in the log: 510
    // lines on the MacBook by then.
    const w = world()
    w.stage_(B, 2000)
    const starts = await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    const waits = await w.agent()
    assert.deepEqual([starts.stderr, waits.stderr], ['', ''], 'starting a gate, and finding it waiting')
    await releaseGates(w, B, 3)
  })

  it('a policy file that is there but cannot be read still says so, and the host name decides', async () => {
    const w = world()
    const file = join(w.home, '.config', 'jaketunes', 'update-policy')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'idle\n')
    chmodSync(file, 0o000)
    w.stage_(B, 2000)
    const r = await w.agent()
    assert.match(r.stderr, /update-policy: Permission denied/)
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    assert.match(w.gateCalls()[0], /release\.json\t$/, 'a MacBook decides, as with no file')
    await releaseGates(w, B, 3)
  })
})

/** An app.asar as electron-builder leaves it: Brief 192's build-info.json, pretty-printed, among other files. */
const asarWith = (sha: string, builtAt: string): string =>
  `\0\0header{"files":{}}\n"use strict";\nconst sha = "${'f'.repeat(40)}";\n` +
  JSON.stringify({ sha, commit: sha, dirty: false, builtAt, version: '6.0.0' }, null, 2) + '\n"use strict";\n'
const runningIs = (w: World, sha: string, builtAt: string): void =>
  writeFileSync(join(w.app, 'Contents', 'Resources', 'app.asar'), asarWith(sha, builtAt))
const stagedBuilt = (w: World, sha: string, builtAt: string): void => {
  mkdirSync(join(w.dir(sha), 'JakeTunes.app', 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(w.dir(sha), 'JakeTunes.app', 'Contents', 'Resources', 'app.asar'), asarWith(sha, builtAt))
}
/** git in a temp repo, with no GIT_* from the environment. Under a pre-commit hook GIT_DIR and
 *  GIT_INDEX_FILE name the real repo: `git init` there re-initialised it with core.bare = true
 *  (2026-11-19, this file's first run under the hook), which stopped every worktree. */
function gitIn(repo: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env }).trim()
}
/** A git repo whose first commit is the parent of the second: [older, newer]. */
function repoOfTwo(root: string): [string, string] {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): string => gitIn(repo, args)
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'one')
  const older = git('rev-parse', 'HEAD')
  git('commit', '-q', '--allow-empty', '-m', 'two')
  return [older, git('rev-parse', 'HEAD')]
}

describe('update agent — never go back to an older build', () => {
  it('the workmini incident: an older staged build, once installed, then replaced by hand with a newer one, is never offered again', async () => {
    const w = world()
    w.stage_(A, 1000)
    stagedBuilt(w, A, '2026-11-18T01:05:32.405Z')
    // It was offered and installed: the gate's answer and the agent's mark are still in its folder.
    writeFileSync(join(w.dir(A), 'gate.exit'), '0\n')
    writeFileSync(join(w.dir(A), 'installed'), '')
    // Then a newer build went on by hand, without being staged.
    runningIs(w, B, '2026-11-19T02:00:00.000Z')
    await w.agent()
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(w.gateCalls(), [], 'no gate for the older build')
    assert.equal(existsSync(w.dir(A)), false, 'the superseded release is removed')
    const log = readFileSync(w.log, 'utf8')
    assert.match(log, /aaaa+: superseded — built 2026-11-18T01:05:32.405Z, before the running build bbbbbbbbbbbb/)
    assert.doesNotMatch(log, /the gate said installed/)
    await w.agent()
    assert.deepEqual(w.gateCalls(), [], 'and never on a later run')
  })

  it('a staged build newer than the running one is offered as before; the older one beside it is dropped', async () => {
    const w = world()
    runningIs(w, B, '2026-11-19T02:00:00.000Z')
    w.stage_(A, 3000) // staged last, but built first: staged-at order is not build order
    stagedBuilt(w, A, '2026-11-18T01:05:32.405Z')
    w.stage_(C, 2000)
    stagedBuilt(w, C, '2026-11-19T17:31:18.184Z')
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'C\'s gate')
    assert.equal(w.gateCalls()[0].split('\t')[3], C)
    assert.equal(existsSync(w.dir(A)), false)
    await releaseGates(w, C, 3)
  })

  it('git ancestry wins over build times when a checkout has both commits', async () => {
    const w = world()
    const [older, newer] = repoOfTwo(w.root)
    // The older commit rebuilt later: its builtAt is newer, but it is still the past.
    runningIs(w, newer, '2026-11-19T02:00:00.000Z')
    w.stage_(older, 2000)
    stagedBuilt(w, older, '2026-11-20T09:00:00.000Z')
    await w.agent({ repo: join(w.root, 'repo') })
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(w.gateCalls(), [])
    assert.match(readFileSync(w.log, 'utf8'), /superseded — an ancestor of the running build/)

    // The other way round: a descendant built on a Mac whose clock ran behind is still newer.
    const w2 = world()
    const [o2, n2] = repoOfTwo(w2.root)
    runningIs(w2, o2, '2026-11-19T02:00:00.000Z')
    w2.stage_(n2, 2000)
    stagedBuilt(w2, n2, '2026-11-18T00:00:00.000Z')
    await w2.agent({ repo: join(w2.root, 'repo') })
    await waitFor(() => w2.gateCalls().length === 1 || null, 'the descendant\'s gate')
    await releaseGates(w2, n2, 3)
  })

  it('no provenance on either side: the agent cannot tell, and offers as before', async () => {
    const w = world()
    runningIs(w, B, '2026-11-19T02:00:00.000Z')
    w.stage_(A, 1000) // a staged copy with no build-info.json
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'A\'s gate')
    await releaseGates(w, A, 3)

    const w2 = world() // the running app has none (the fake one every other test uses)
    w2.stage_(A, 1000)
    stagedBuilt(w2, A, '2026-11-18T01:05:32.405Z')
    await w2.agent()
    await waitFor(() => w2.gateCalls().length === 1 || null, 'A\'s gate')
    await releaseGates(w2, A, 3)
  })

  it('a plain build-info.json beside app.asar counts too', async () => {
    const w = world()
    writeFileSync(join(w.app, 'Contents', 'Resources', 'build-info.json'), JSON.stringify({ sha: B, builtAt: '2026-11-19T02:00:00.000Z' }))
    w.stage_(A, 1000)
    stagedBuilt(w, A, '2026-11-18T01:05:32.405Z')
    await w.agent()
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(w.gateCalls(), [])
    assert.equal(existsSync(w.dir(A)), false)
  })

  for (const host of ['Jakes-MacBook-Pro-2458', 'Jakes-Mini-6224']) {
    it(`a gate waiting for a release that becomes superseded is stopped, and its folder goes once it has ended (${host})`, async () => {
      const w = world()
      w.stage_(A, 1000)
      stagedBuilt(w, A, '2026-11-18T01:05:32.405Z')
      await w.agent({ host })
      await waitFor(() => w.gateCalls().length === 1 || null, 'A\'s gate')
      // A newer build by hand while it waits (on a decide Mac or an idle one, with nothing newer staged:
      // a gate started after such an install took it as its baseline, so only the agent can stop it).
      runningIs(w, B, '2026-11-19T02:00:00.000Z')
      await w.agent({ host })
      assert.equal(existsSync(join(w.dir(A), 'superseded')), true)
      await waitFor(() => existsSync(join(w.dir(A), 'gate.exit')) || null, 'A\'s gate to be stopped')
      assert.match(readFileSync(w.log, 'utf8'), /aaaa+: superseded — stopped its gate/)
      await w.agent({ host })
      assert.equal(existsSync(w.dir(A)), false, 'removed once its gate is gone')
      assert.equal(w.gateCalls().length, 1, 'never a second gate')
    })
  }

  it('a checkout that has the running commit but not the staged one (not fetched yet): never called older', async () => {
    const w = world()
    const [older] = repoOfTwo(w.root)
    runningIs(w, older, '2026-11-19T10:00:00.000Z') // a hand build of a commit the checkout has
    w.stage_(C, 2000) // the release job's build, from a commit this checkout has not fetched
    stagedBuilt(w, C, '2026-11-19T09:00:00.000Z')
    await w.agent({ repo: join(w.root, 'repo') })
    await waitFor(() => w.gateCalls().length === 1 || null, 'C\'s gate')
    assert.equal(existsSync(join(w.dir(C), 'superseded')), false)
    await releaseGates(w, C, 3)
  })

  it('two commits on different branches: the earlier build is older', async () => {
    const w = world()
    const repo = join(w.root, 'repo')
    const [base, main] = repoOfTwo(w.root)
    const git = (...args: string[]): string => gitIn(repo, args)
    git('checkout', '-q', '-b', 'side', base)
    git('commit', '-q', '--allow-empty', '-m', 'side')
    const side = git('rev-parse', 'HEAD')
    runningIs(w, side, '2026-11-19T10:00:00.000Z')
    w.stage_(main, 2000)
    stagedBuilt(w, main, '2026-11-19T09:00:00.000Z')
    await w.agent({ repo })
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(w.gateCalls(), [])
    assert.match(readFileSync(w.log, 'utf8'), /superseded — built 2026-11-19T09:00:00.000Z, before the running build/)
  })
})

// ── The offer script ────────────────────────────────────────────────────

interface Offer { w: World; bundle: string; release: string; calls: () => string[]; offer: (args?: string[]) => Promise<{ code: number; out: string }>; plist: string }

function offerWorld(opts: { loaded?: boolean; codesign?: number } = {}): Offer {
  const w = world()
  const bundle = join(w.root, 'built', 'JakeTunes.app')
  mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(bundle, 'Contents', 'Resources', 'app.asar'), `new ${B}`)
  const release = join(w.root, 'release.json')
  writeFileSync(release, RELEASE)
  const lc = join(w.fake, 'launchctl')
  writeFileSync(lc, `#!/bin/bash
echo "$*" >> "${w.fake}/launchctl-calls"
if [ "$1" = print ]; then [ -f "${w.fake}/loaded" ]; exit $?; fi
if [ "$1" = bootstrap ]; then touch "${w.fake}/loaded"; fi
exit 0
`)
  chmodSync(lc, 0o755)
  if (opts.loaded) writeFileSync(join(w.fake, 'loaded'), '')
  const cs = join(w.fake, 'codesign')
  writeFileSync(cs, `#!/bin/bash\nexit ${opts.codesign ?? 0}\n`)
  chmodSync(cs, 0o755)
  const plist = join(w.home, 'Library', 'LaunchAgents', 'com.jaketunes.update-gate.plist')
  return {
    w, bundle, release, plist,
    calls: () => (existsSync(join(w.fake, 'launchctl-calls')) ? readFileSync(join(w.fake, 'launchctl-calls'), 'utf8').trim().split('\n') : []),
    offer: async (args = [bundle, B, release]) => {
      try {
        const r = await run('/bin/bash', [OFFER, ...args], { env: { HOME: w.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', JT_OFFER_LAUNCHCTL: lc, JT_OFFER_CODESIGN: cs } })
        return { code: 0, out: r.stdout }
      } catch (err) {
        const e = err as { code?: number; stdout?: string }
        return { code: e.code ?? -1, out: e.stdout ?? '' }
      }
    },
  }
}

describe('offer — stage, install the agent, load it once', () => {
  it('stages the build, installs the agent and the gate, writes and loads the job; a second run only kicks it', async () => {
    const o = offerWorld()
    const r = await o.offer()
    assert.equal(r.code, 0, r.out)
    const d = o.w.dir(B)
    assert.equal(readFileSync(join(d, 'JakeTunes.app', 'Contents', 'Resources', 'app.asar'), 'utf8'), `new ${B}`)
    assert.equal(readFileSync(join(d, 'release.json'), 'utf8'), RELEASE)
    assert.match(readFileSync(join(d, 'staged-at'), 'utf8'), /^\d+\n$/)
    assert.deepEqual(readdirSync(o.w.stage).filter((f) => f.startsWith('.incoming')), [], 'no half copy left')
    for (const f of ['jaketunes-update-agent.sh', 'jaketunes-install-gate.sh']) {
      assert.equal(readFileSync(join(o.w.data, 'update-agent', f), 'utf8'), readFileSync(join(ROOT, 'scripts/install', f), 'utf8'))
    }
    const plist = readFileSync(o.plist, 'utf8')
    assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/)
    assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/, 'the gate outlives the agent\'s run')
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/, 'after a reboot it looks at once')
    assert.match(plist, /jaketunes-update-gate\.log/)
    assert.deepEqual(o.calls().map((c) => c.split(' ')[0]), ['bootout', 'bootstrap'])

    const again = await o.offer()
    assert.equal(again.code, 0)
    assert.match(again.out, /already staged/)
    assert.deepEqual(o.calls().map((c) => c.split(' ')[0]), ['bootout', 'bootstrap', 'print', 'kickstart'], 'unchanged and loaded: only asked to look')
  })

  it('a job that is not loaded (after a logout, say) is loaded again even with the same plist', async () => {
    const o = offerWorld()
    await o.offer()
    rmSync(join(o.w.fake, 'loaded'))
    await o.offer()
    assert.deepEqual(o.calls().map((c) => c.split(' ')[0]).slice(-3), ['print', 'bootout', 'bootstrap'])
  })

  it('refuses a bad sha, bundle, signature or release file, and stages nothing', async () => {
    const o = offerWorld()
    const bad = join(o.w.root, 'bad.json')
    const cases: Array<[string[], RegExp, string?]> = [
      [[o.bundle, 'NOT-A-SHA', o.release], /sha must be/],
      [[join(o.w.root, 'nope.app'), B, o.release], /no bundle/],
      [[o.bundle, B, bad], /no label|kind|notes/, JSON.stringify({ label: 'x', kind: 'someday', notes: [] })],
      [[o.bundle, B, bad], /notes must be a list/, JSON.stringify({ label: 'x', kind: 'fix', notes: 'one' })],
      [[o.bundle, B, bad], /no label/, '{ "label": '],
    ]
    for (const [args, re, body] of cases) {
      if (body !== undefined) writeFileSync(bad, body)
      const r = await o.offer(args)
      assert.equal(r.code, 1, r.out)
      assert.match(r.out, re)
    }
    assert.deepEqual(readdirSync(o.w.stage), [])
    assert.deepEqual(o.calls(), [], 'nothing loaded')
    const unsigned = offerWorld({ codesign: 1 })
    const r = await unsigned.offer()
    assert.equal(r.code, 1)
    assert.match(r.out, /signature does not verify/)
  })

  it('a build skipped on this Mac and staged again is not offered again', async () => {
    const o = offerWorld()
    await o.offer()
    await o.w.agent()
    await waitFor(() => o.w.gateCalls().length === 1 || null, 'the gate to start')
    await releaseGates(o.w, B, 5)
    await o.w.agent()
    const again = await o.offer()
    assert.equal(again.code, 0)
    assert.match(again.out, /was skipped on this Mac — it stays skipped/)
    await o.w.agent()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(o.w.gateCalls().length, 1, 'no second gate for a skipped build')
  })

  it('offer then agent, end to end: the staged copy is what the gate is handed', async () => {
    const o = offerWorld()
    await o.offer()
    await o.w.agent()
    await waitFor(() => o.w.gateCalls().length === 1 || null, 'the gate to start')
    assert.equal(o.w.gateCalls()[0].split('\t')[0], join(o.w.dir(B), 'JakeTunes.app'))
    await releaseGates(o.w, B, 3)
  })
})

// ── This file leaves nothing running ────────────────────────────────────

describe('the tests leave nothing running', () => {
  it('a gate a test leaves waiting (a failed test does) is ended by the teardown', async () => {
    const w = world()
    w.stage_(B, 2000)
    await w.agent()
    await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
    assert.ok(running([w.root]).length > 0, 'the gate is waiting')
    assert.deepEqual(await endAll([w.root]), [])
  })

  it('a fake gate ends by itself once the test process is gone (a run killed before its after())', async () => {
    const owner = spawn('/bin/sleep', ['600'])
    try {
      const w = world({ owner: owner.pid })
      w.stage_(B, 2000)
      await w.agent()
      await waitFor(() => w.gateCalls().length === 1 || null, 'the gate to start')
      assert.ok(running([w.root]).length > 0, 'the gate is waiting')
      const gone = new Promise((r) => owner.on('exit', r))
      owner.kill('SIGKILL')
      await gone
      await waitFor(() => running([w.root]).length === 0 || null, 'the gate to end by itself')
    } finally {
      owner.kill('SIGKILL')
    }
  })
})
