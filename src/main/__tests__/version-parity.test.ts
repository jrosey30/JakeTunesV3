/**
 * Brief 195 — version-parity.mjs against fixture .app trees.
 *
 * Builds fake installs (Info.plist + an app.asar carrying
 * out/main/build-info.json, Brief 192's stamp) in a temp dir and runs
 * the actual script: matching → silent exit 0; stale version, missing
 * install, and same-version/different-build each report. The asar is
 * packed by @electron/asar itself, not hand-rolled: a hand-rolled
 * fixture once shared the reader's 4-byte header error, so the tests
 * passed while every real install read buildSha null.
 * The GitHub Release lookup is seamed off via JT_PARITY_RELEASE_JSON.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'version-parity.mjs')
const asarCli = join(repoRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')

function packAsar(dir: string, buildInfo: string, out: string): void {
  const src = mkdtempSync(join(dir, 'asar-src-'))
  mkdirSync(join(src, 'out', 'main'), { recursive: true })
  // Sorts ahead of build-info.json, so the entry sits at a non-zero data offset as in a real app.
  writeFileSync(join(src, 'out', 'main', 'assets.js'), 'module.exports = {}\n'.repeat(50))
  writeFileSync(join(src, 'out', 'main', 'build-info.json'), buildInfo)
  writeFileSync(join(src, 'package.json'), '{"name":"jaketunes","main":"out/main/index.js"}')
  const pack = spawnSync(process.execPath, [asarCli, 'pack', src, out], { encoding: 'utf8' })
  assert.equal(pack.status, 0, pack.stderr)
}

function makeApp(dir: string, name: string, version: string, sha: string): string {
  const app = join(dir, name)
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`)
  packAsar(dir, JSON.stringify({ sha, builtAt: '2026-10-14T12:00:00.000Z', version }),
    join(app, 'Contents', 'Resources', 'app.asar'))
  return app
}

function run(dir: string, apps: string[], extra: string[] = []) {
  const releaseJson = join(dir, 'release.json')
  writeFileSync(releaseJson, JSON.stringify({ tag_name: 'v6.0.0', published_at: '2026-10-10T00:00:00Z' }))
  return spawnSync(process.execPath, [scriptPath, ...extra, ...apps], {
    env: { ...process.env, JT_PARITY_RELEASE_JSON: releaseJson },
    encoding: 'utf8',
  })
}

describe('Brief 195 — version-parity', () => {
  it('matching installs are silent with exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-parity-'))
    try {
      const a = makeApp(dir, 'A.app', '6.0.0', 'aaaa1111222233334444')
      const b = makeApp(dir, 'B.app', '6.0.0', 'aaaa1111222233334444')
      const r = run(dir, [a, b])
      assert.equal(r.status, 0, r.stdout)
      assert.equal(r.stdout, '')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a stale install and a missing install are reported distinctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-parity-'))
    try {
      const a = makeApp(dir, 'A.app', '6.0.0', 'aaaa1111222233334444')
      const stale = makeApp(dir, 'Stale.app', '5.0.0', 'bbbb1111222233334444')
      const r = run(dir, [a, stale, join(dir, 'Nope.app')])
      assert.equal(r.status, 1)
      assert.match(r.stdout, /Stale\.app: version 5\.0\.0 != newest known 6\.0\.0/)
      assert.match(r.stdout, /Nope\.app: missing/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('same version, different build SHA is a mismatch (the 6.0.0 exhibit)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-parity-'))
    try {
      const a = makeApp(dir, 'A.app', '6.0.0', 'aaaa1111222233334444')
      const d = makeApp(dir, 'D.app', '6.0.0', 'cccc1111222233334444')
      const r = run(dir, [a, d])
      assert.equal(r.status, 1)
      assert.match(r.stdout, /differs across installs/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('--json always emits the payload, provenance read from inside the asar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-parity-'))
    try {
      const a = makeApp(dir, 'A.app', '6.0.0', 'aaaa1111222233334444')
      const r = run(dir, [a], ['--json'])
      assert.equal(r.status, 0, r.stdout)
      const payload = JSON.parse(r.stdout) as { installs: Array<{ buildSha: string }> }
      assert.equal(payload.installs[0].buildSha, 'aaaa11112222')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
