/**
 * Brief 196 — vern --share redaction.
 *
 * Runs the real scripts/vern-redact.py over synthetic captures whose
 * secrets are built by concatenation (so this file itself never
 * contains a credential-shaped literal), plus a fail-closed check
 * that vern --share without its redactor writes no share file.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const redactor = join(repoRoot, 'scripts', 'vern-redact.py')

const FAKE_GHP = 'gh' + 'p_' + 'A1'.repeat(18)
const FAKE_SK = 'sk' + '-ant-' + 'x9'.repeat(12)
const FAKE_AKIA = 'AK' + 'IA' + 'Z7'.repeat(8)

describe('Brief 196 — vern-redact.py', () => {
  it('redacts tokens, secrets and home paths; keeps SHAs and versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-vern-share-'))
    try {
      const input = join(dir, 'in.md')
      const output = join(dir, 'out.md')
      writeFileSync(input, [
        '**Repo:** /Users/someone/JakeTunesV3',
        'home file: /home/testuser/notes.md',
        `t1: ${FAKE_GHP}`,
        `t2: ${FAKE_SK}`,
        `t3: ${FAKE_AKIA}`,
        'password: hunter2supersecret',
        'sha 12bb43b24d49a146bc73489d945f34092878f707 stays',
        'version 6.0.0 stays',
        '',
      ].join('\n'))
      const r = spawnSync('python3', [redactor, input, output, '/home/testuser', '/Users/someone/JakeTunesV3'], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.ok(Number(r.stdout.trim()) >= 6, `expected >=6 redactions, got ${r.stdout}`)
      const out = readFileSync(output, 'utf8')
      for (const leak of [FAKE_GHP, FAKE_SK, FAKE_AKIA, 'hunter2supersecret', '/Users/someone', '/home/testuser']) {
        assert.equal(out.includes(leak), false, `leaked: ${leak.slice(0, 16)}`)
      }
      assert.ok(out.includes('12bb43b24d49a146bc73489d945f34092878f707'), 'git SHA is diagnostic value — kept')
      assert.ok(out.includes('6.0.0'), 'version kept')
      assert.ok(out.includes('<repo>'), 'repo path placeholder')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('vern --share fails closed when the redactor is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-vern-noredact-'))
    try {
      const scripts = join(dir, 'scripts')
      mkdirSync(scripts, { recursive: true })
      mkdirSync(join(dir, 'src'), { recursive: true })
      // Copy ONLY vern — vern-redact.py deliberately absent.
      const vernSrc = readFileSync(join(repoRoot, 'scripts', 'vern'), 'utf8')
      writeFileSync(join(scripts, 'vern'), vernSrc)
      writeFileSync(join(dir, 'package.json'), '{"name":"JakeTunes","version":"6.0.0"}')
      const init = spawnSync('git', ['init', '-q', '.'], { cwd: dir })
      assert.equal(init.status, 0)
      spawnSync('git', ['add', '-A'], { cwd: dir })
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
      const r = spawnSync('/bin/bash', [join(scripts, 'vern'), '--share'], {
        cwd: dir,
        env: { ...process.env, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 240_000,
      })
      assert.equal(r.status, 1, r.stdout)
      assert.match(r.stderr + r.stdout, /--share FAILED/)
      assert.equal(existsSync(join(dir, 'diagnostics', 'vern-share-latest.md')), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
