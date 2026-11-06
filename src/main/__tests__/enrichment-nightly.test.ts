// The nightly lyrics + CLAP catch-up (Brief 177 driver, 2026-10-20 install).
// lyrics.json and the CLAP index both stopped on 9/1: the job sat "proposed"
// in jobs.json and was never installed. These lock how it runs now: from its
// own origin/main worktree (never the shared checkout), CLAP skipped while
// music plays, and an installer that can install this ONE job (a bare
// --apply installs the homemini jobs on whichever Mac runs it).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const launchd = join(repoRoot, 'scripts', 'launchd')
const wrapper = readFileSync(join(launchd, 'enrichment-nightly.sh'), 'utf-8')
const template = readFileSync(join(launchd, 'templates', 'com.jaketunes.enrichment-catchup.plist.template'), 'utf-8')
const code = (src: string) => src.split('\n').filter((l) => !/^\s*#/.test(l))
const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

describe('enrichment nightly', () => {
  test('launchd runs the ~/bin wrapper, never a script inside the shared checkout', () => {
    assert.match(template, /<string>__HOME__\/bin\/jaketunes-enrichment-nightly\.sh<\/string>/)
    assert.doesNotMatch(template, /__REPO__/)
    const manifest = JSON.parse(readFileSync(join(launchd, 'jobs.json'), 'utf-8')) as { jobs: Array<{ label: string; proposed?: boolean }> }
    assert.equal(manifest.jobs.find((j) => j.label === 'com.jaketunes.enrichment-catchup')?.proposed, false)
  })

  test('the wrapper runs origin/main from its own worktree and skips CLAP while music plays', () => {
    const lines = code(wrapper)
    assert.ok(lines.some((l) => /worktree add --quiet --detach "\$WT" origin\/main/.test(l)))
    assert.ok(lines.some((l) => /checkout --quiet --force --detach origin\/main/.test(l)))
    assert.ok(!lines.some((l) => /cd "\$REPO"/.test(l)), 'never cd into the shared checkout')
    assert.ok(lines.some((l) => /"\$NODE" "\$WT\/scripts\/enrichment-catchup\.mjs"/.test(l)), 'runs the worktree copy')
    assert.ok(lines.some((l) => /^\/usr\/bin\/caffeinate -i "\$NODE" "\$WT\/scripts\/enrichment-catchup\.mjs"/.test(l)), 'keeps the Mac awake while the driver runs')
    assert.match(wrapper, /grep -q "Playing audio"[\s\S]*?ARGS\+=\(--skip-clap\)/)
  })

  test('--skip-clap: the driver plans lyrics only', () => {
    const state = mkdtempSync(join(tmpdir(), 'enrich-'))
    try {
      writeFileSync(join(state, 'library.json'), JSON.stringify({ tracks: [{ id: 1, title: 'A', artist: 'B', duration: 200000 }] }))
      const run = (extra: string[]) => spawnSync(process.execPath, [join(repoRoot, 'scripts', 'enrichment-catchup.mjs'), '--dry-run', ...extra], {
        env: { ...childEnv, JT_STATE_DIR: state }, encoding: 'utf-8',
      })
      const skipped = run(['--skip-clap'])
      assert.equal(skipped.status, 0, skipped.stderr)
      assert.match(skipped.stdout, /would skip CLAP \(--skip-clap\)/)
      assert.match(skipped.stdout, /would run: node .*lyrics-fetch\.mjs/)
      assert.match(run([]).stdout, /would run: .*audio-embed\.py --limit 1/, 'without the flag the CLAP delta runs')
      assert.deepEqual(readdirSync(state), ['library.json'], 'a dry run writes nothing')
    } finally { rmSync(state, { recursive: true, force: true }) }
  })

  // 2026-10-27: on 10/26 and 10/27 the 300-song CLAP phase took 112 and 139
  // minutes against a 60-minute budget, so lyrics were "skipped — front of
  // tomorrow's run" two nights running, and tomorrow ran CLAP first again.
  // The cheap, network-light lyrics batch now runs FIRST; CLAP gets the rest.
  test('lyrics run before CLAP, in the plan and in the code', () => {
    const state = mkdtempSync(join(tmpdir(), 'enrich-'))
    try {
      writeFileSync(join(state, 'library.json'), JSON.stringify({ tracks: [{ id: 1, title: 'A', artist: 'B', duration: 200000 }] }))
      const plan = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'enrichment-catchup.mjs'), '--dry-run'], {
        env: { ...childEnv, JT_STATE_DIR: state }, encoding: 'utf-8',
      })
      assert.equal(plan.status, 0, plan.stderr)
      const lyricsAt = plan.stdout.indexOf('lyrics-fetch.mjs')
      const clapAt = plan.stdout.indexOf('audio-embed.py')
      assert.ok(lyricsAt >= 0 && clapAt >= 0 && lyricsAt < clapAt, `plan lists lyrics before CLAP:\n${plan.stdout}`)
    } finally { rmSync(state, { recursive: true, force: true }) }
    const driver = readFileSync(join(repoRoot, 'scripts', 'enrichment-catchup.mjs'), 'utf-8')
    const lyricsSpawn = driver.indexOf('spawnSync(lyricsCmd[0]')
    const clapSpawn = driver.indexOf('spawnSync(clapCmd[0]')
    assert.ok(lyricsSpawn >= 0 && clapSpawn >= 0 && lyricsSpawn < clapSpawn, 'the lyrics phase is spawned before the CLAP phase')
    assert.doesNotMatch(driver, /lyrics phase skipped/, 'lyrics are never the phase that gets skipped')
  })

  // LAUNCHAGENTS_DIR only moves the plist: the reload reaches launchd by label. With the
  // real launchctl on PATH, every test run booted out the real 04:30 job and reloaded it
  // from a temp folder that was then deleted (found 2026-11-06, when a sandboxed run let
  // the bootout through, failed the bootstrap and left the job unloaded).
  test('install-launchagents --only installs one job; an unknown label is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-'))
    try {
      const agents = join(root, 'agents')
      const bin = join(root, 'bin')
      const calls = join(root, 'launchctl-calls')
      mkdirSync(bin)
      writeFileSync(join(bin, 'launchctl'), '#!/bin/bash\necho "$*" >> "$LAUNCHCTL_CALLS"\n', { mode: 0o755 })
      writeFileSync(calls, '')
      const run = (args: string[]) => spawnSync('bash', [join(launchd, 'install-launchagents.sh'), ...args], {
        env: { ...childEnv, LAUNCHAGENTS_DIR: agents, LAUNCHCTL_CALLS: calls, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf-8',
      })
      const one = run(['--apply', '--only', 'com.jaketunes.enrichment-catchup'])
      assert.equal(one.status, 0, one.stderr)
      assert.deepEqual(readdirSync(agents), ['com.jaketunes.enrichment-catchup.plist'], 'only the named job lands')
      const domain = `gui/${process.getuid!()}`
      assert.deepEqual(readFileSync(calls, 'utf-8').split('\n').filter(Boolean), [
        `bootout ${domain}/com.jaketunes.enrichment-catchup`,
        `bootstrap ${domain} ${join(agents, 'com.jaketunes.enrichment-catchup.plist')}`,
      ], 'the fake launchctl reloads the installed plist; no calls here means the real one got them')
      assert.notEqual(run(['--apply', '--only', 'com.jaketunes.nope']).status, 0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a test that runs the installer fakes launchctl', () => {
    const offenders = readdirSync(import.meta.dirname).filter((f) => {
      if (!f.endsWith('.ts')) return false
      const src = readFileSync(join(import.meta.dirname, f), 'utf-8')
      return src.includes('install-launchagents.sh') && !src.includes("join(bin, 'launchctl')")
    })
    assert.deepEqual(offenders, [], 'the real launchctl reloads the real job, whatever LAUNCHAGENTS_DIR says')
  })
})
