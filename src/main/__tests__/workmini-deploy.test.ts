/**
 * Rails for the workmini auto-deploy (Dr. Claude/scripts/jaketunes-workmini-deploy.sh,
 * run weekdays 11:30 by launchd through jaketunes-workmini-nightly.sh).
 *
 * From 2026-08-10 to 2026-10-19 it failed every single run: it built the
 * shared ~/JakeTunesV3 checkout (whatever branch another session left it
 * on), and launchd's PATH found node 18, which cannot run `npm test`. These
 * lock the fix: build origin/main in a fresh worktree with a fresh npm ci,
 * prove the installed app is a subset of main before swapping, gate the
 * quit on audio + idle, and put a hard timeout on every remote command.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scripts = join(repoRoot, 'Dr. Claude', 'scripts')
const deploy = readFileSync(join(scripts, 'jaketunes-workmini-deploy.sh'), 'utf-8')
const wrapper = readFileSync(join(scripts, 'jaketunes-workmini-nightly.sh'), 'utf-8')
/** Script lines that are not comments. */
const code = deploy.split('\n').filter((l) => !/^\s*#/.test(l))

// Children must never inherit GIT_* (see vern-share.test.ts: under the
// pre-commit gate they point at the REAL repo, 2026-10-14 core.bare flip).
const childEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
)

function heredoc(src: string, tag: string): string {
  const m = src.match(new RegExp(`<<'${tag}'\\n([\\s\\S]*?)\\n${tag}\\n`))
  assert.ok(m, `heredoc ${tag} missing`)
  return m![1]
}

describe('workmini deploy builds origin/main, never the shared checkout', () => {
  test('a fresh detached worktree at the fetched origin/main commit', () => {
    assert.match(deploy, /fetch --quiet origin main/)
    assert.match(deploy, /worktree add --detach "\$WT" "\$MAIN_SHA"/)
    assert.ok(!code.some((l) => /cd "\$REPO"/.test(l)), 'never cd into ~/JakeTunesV3')
    assert.ok(!code.some((l) => /"\$REPO"?\/(release|Dr\. Claude)/.test(l)), 'never read files from the shared working tree')
  })

  test('a fresh npm ci, never a linked or copied node_modules', () => {
    assert.match(deploy, /step \d+ "npm ci" npm ci\b/)
    assert.match(deploy, /! -L node_modules/)
    assert.ok(!code.some((l) => /(ln -s|cp -c?R).*node_modules/.test(l)))
  })

  test('tests are a hard gate and their output is kept, not discarded', () => {
    assert.match(deploy, /step \d+ tests npm test \|\| build_die/)
    assert.ok(!code.some((l) => /npm test\b.*\/dev\/null/.test(l)), 'a test failure must leave its output somewhere')
  })

  test('the launchd wrapper finds Homebrew node before /usr/local/bin (node 18 cannot run the tests)', () => {
    const path = wrapper.match(/^export PATH="([^"]+)"/m)
    assert.ok(path, 'wrapper sets PATH')
    const dirs = path![1].split(':')
    assert.ok(dirs.indexOf('/opt/homebrew/bin') >= 0 && dirs.indexOf('/opt/homebrew/bin') < dirs.indexOf('/usr/local/bin'))
    assert.match(deploy, /node --experimental-strip-types -e 0/, 'the deploy refuses up front when node cannot run the tests')
  })

  // 2026-10-20: one 3-second ping decided the whole day — workmini was awake
  // and playing, but Tailscale was on a relay and the packet was late.
  test('reachability is ssh, retried; "not there" exits 75 so the wrapper can try again today', () => {
    assert.ok(!code.some((l) => /\bping -c1 -t3\b/.test(l)), 'no single ICMP ping decides the run')
    assert.match(deploy, /reach_workmini\(\) \{[\s\S]*?for i in 1 2 3 4; do[\s\S]*?rsh \d+ true && return 0/)
    assert.match(deploy, /^EX_UNREACHABLE=75$/m)
    assert.match(deploy, /die_unreachable "\$HOST is not reachable/)
    const preflight = deploy.indexOf('if ! reach_workmini; then')
    assert.ok(preflight > 0 && preflight < deploy.indexOf('WM_HOME="$(rsh 20'), 'reachability is settled before anything uses workmini')
  })

  test('the wrapper retries ONLY exit 75, at most 5 more times', () => {
    const run = (codes: number[]) => {
      const home = mkdtempSync(join(tmpdir(), 'wm-wrapper-'))
      try {
        mkdirSync(join(home, 'bin'))
        // A fake deploy: exits with the next code in the list, counting calls.
        writeFileSync(join(home, 'bin', 'jaketunes-workmini-deploy.sh'),
          `#!/bin/bash\nn=$(cat "$HOME/n" 2>/dev/null || echo 0); echo $((n+1)) > "$HOME/n"\ncodes=(${codes.join(' ')})\nlast=\${codes[\${#codes[@]}-1]}\nexit \${codes[$n]:-$last}\n`, { mode: 0o755 })
        const r = spawnSync('bash', [join(scripts, 'jaketunes-workmini-nightly.sh')], {
          env: { ...childEnv, HOME: home, WORKMINI_RETRY_EVERY_S: '0' }, encoding: 'utf-8',
        })
        return { status: r.status, calls: Number(readFileSync(join(home, 'n'), 'utf-8')) }
      } finally { rmSync(home, { recursive: true, force: true }) }
    }
    assert.deepEqual(run([75, 75, 0]), { status: 0, calls: 3 }, 'asleep at 11:30, awake by the second retry')
    assert.deepEqual(run([75]), { status: 75, calls: 6 }, 'gives up after 5 retries')
    assert.deepEqual(run([1]), { status: 1, calls: 1 }, 'a real failure is not retried')
  })
})

describe('workmini deploy proves before it swaps', () => {
  test('installed ⊆ main: ancestry and a clean stamp are checked before the bundle moves', () => {
    const proof = deploy.indexOf('merge-base --is-ancestor "$INST_SHA" "$MAIN_SHA"')
    const dirty = deploy.indexOf('[[ "$INST_DIRTY" != true ]]')
    const swap = deploy.indexOf('mv "$APP" "$HOME/$BK"')
    assert.ok(proof > 0 && dirty > 0 && swap > proof && swap > dirty)
    assert.match(deploy, /no commit stamp .* Refusing/)
  })

  test('the swap aborts if app.asar changed after the proof', () => {
    const guard = deploy.indexOf('[ "$have" = "$WANT_MTIME" ]')
    assert.ok(guard > 0 && guard < deploy.indexOf('mv "$APP" "$HOME/$BK"'))
  })

  test('the audio + idle gate runs right before the quit, and gates the final relaunch', () => {
    const gate = heredoc(deploy, 'GATE')
    assert.match(gate, /grep -q "Playing audio"/)
    assert.match(gate, /coreaudiod/)
    assert.match(gate, /HIDIdleTime/)
    const remoteGate = deploy.indexOf('bash -c "$GATE_SH" gate "$IDLE_MIN"')
    const quit = deploy.indexOf(`quit app id "com.jacobrosenbaum.jaketunes"`)
    assert.ok(remoteGate > 0 && quit > remoteGate)
    const relaunch = deploy.indexOf('Relaunching JakeTunes')
    assert.ok(deploy.indexOf('check_gate)"; then', relaunch) > relaunch, 'the relaunch is a quit too')
  })

  test('the previous bundle is kept outside /Applications, never rm -rf', () => {
    assert.ok(!code.some((l) => /rm -rf \/Applications\/JakeTunes\.app/.test(l)))
    assert.match(deploy, /BK="JakeTunes-prev-auto-/)
  })

  test('every ssh / scp / rsync runs under a hard timeout', () => {
    const raw = code.filter((l) => /(^|[|;&(]|&&|\|\|)\s*(ssh|scp|rsync)\s/.test(l))
    assert.deepEqual(raw, [], 'call rsh / rcp / rsy (or tmo) instead')
    for (const fn of ['rsh', 'rcp', 'rsy']) {
      assert.match(deploy, new RegExp(`^${fn}\\(\\) \\{ local secs="\\$1"; shift; tmo "\\$secs" `, 'm'))
    }
  })
})

describe('the subset proof reads real stamps', () => {
  // The reader is embedded in the script (it also runs on workmini over
  // ssh). Feed it an asar written by @electron/asar itself, not a
  // hand-rolled fixture: the header layout is easy to get 4 bytes wrong.
  test('the embedded asar reader returns sha, dirty and the package count', () => {
    const py = heredoc(deploy, 'PY')
    const dir = mkdtempSync(join(tmpdir(), 'jt-wmdeploy-'))
    try {
      const app = join(dir, 'app')
      const info = { sha: 'a'.repeat(40), commit: 'a'.repeat(40), dirty: false, builtAt: '2026-10-19T00:00:00.000Z', version: '6.0.0' }
      mkdirSync(join(app, 'out', 'main'), { recursive: true })
      writeFileSync(join(app, 'out', 'main', 'build-info.json'), JSON.stringify(info))
      for (const pkg of ['left-pad', '@scope/one', '@scope/two']) {
        mkdirSync(join(app, 'node_modules', pkg), { recursive: true })
        writeFileSync(join(app, 'node_modules', pkg, 'package.json'), '{}')
      }
      mkdirSync(join(app, 'node_modules', 'no-manifest'))
      writeFileSync(join(app, 'node_modules', 'no-manifest', 'index.js'), '')
      const asarCli = join(repoRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')
      const asar = join(dir, 'app.asar')
      const pack = spawnSync(process.execPath, [asarCli, 'pack', app, asar], { encoding: 'utf8' })
      assert.equal(pack.status, 0, pack.stderr)

      const read = (p: string) => spawnSync('python3', ['-c', py, p], { encoding: 'utf8' })
      const out = read(asar)
      assert.equal(out.status, 0, out.stderr)
      assert.match(out.stdout, /^present=true$/m)
      assert.match(out.stdout, new RegExp(`^sha=${'a'.repeat(40)}$`, 'm'))
      assert.match(out.stdout, /^dirty=false$/m)
      assert.match(out.stdout, /^deps=3$/m)
      assert.doesNotMatch(out.stdout, /^error=/m)
      assert.match(read(join(dir, 'missing.asar')).stdout, /^present=false$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('write-build-info stamps dirty only when the build holds uncommitted code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-buildinfo-'))
    try {
      const git = (...args: string[]) => {
        const r = spawnSync('git', args, { cwd: dir, env: childEnv, encoding: 'utf8' })
        assert.equal(r.status, 0, r.stderr)
      }
      mkdirSync(join(dir, 'scripts'))
      mkdirSync(join(dir, 'src'))
      copyFileSync(join(repoRoot, 'scripts', 'write-build-info.mjs'), join(dir, 'scripts', 'write-build-info.mjs'))
      writeFileSync(join(dir, 'package.json'), '{"version":"9.9.9"}')
      writeFileSync(join(dir, '.gitignore'), 'out/\n')
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
      git('init', '-q')
      git('add', '.')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
      const stamp = () => {
        const r = spawnSync(process.execPath, [join(dir, 'scripts', 'write-build-info.mjs')], { cwd: dir, env: childEnv, encoding: 'utf8' })
        assert.equal(r.status, 0, r.stderr)
        return JSON.parse(readFileSync(join(dir, 'out', 'main', 'build-info.json'), 'utf8'))
      }
      assert.equal(stamp().dirty, false, 'clean checkout (out/ is ignored)')
      writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2\n')
      assert.equal(stamp().dirty, true, 'an untracked source file ships in the bundle')
      rmSync(join(dir, 'src', 'b.ts'))
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2\n')
      assert.equal(stamp().dirty, true, 'an edited tracked file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
