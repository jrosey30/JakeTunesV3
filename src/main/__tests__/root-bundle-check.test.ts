/**
 * Brief 192 — the root-bundle guard fails on a reappeared bundle and
 * passes on a clean tree. Runs the real check script against fixture
 * roots (JT_ROOT_BUNDLE_CHECK_DIR), never the live repo.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'check-no-root-bundle.mjs')

function run(root: string) {
  return spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, JT_ROOT_BUNDLE_CHECK_DIR: root },
    encoding: 'utf8',
  })
}

describe('Brief 192 — check-no-root-bundle', () => {
  it('passes on a tree with no root index.js', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-root-bundle-'))
    try {
      const r = run(dir)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /no root bundle/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails when a bundle reappears at the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-root-bundle-'))
    try {
      writeFileSync(join(dir, 'index.js'), '"use strict"; /* stale bundle */\n')
      const r = run(dir)
      assert.equal(r.status, 1)
      assert.match(r.stderr, /Brief 192/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
