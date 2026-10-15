/**
 * Brief 192 — build provenance must degrade, never break: a dev run
 * has no build-info.json, a damaged one is worse than none, and in
 * both cases the answer is version + "dev", not a boot failure.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBuildProvenance, parseBuildInfo, formatBuildProvenance } from '../build-provenance.ts'

describe('build provenance (Brief 192)', () => {
  test('a stamped build reports its sha and time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-prov-'))
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ sha: '12bb43b24d49a146bc73489d945f34092878f707', builtAt: '2026-10-14T12:00:00.000Z' }))
    const p = getBuildProvenance('6.0.0', dir)
    assert.equal(p.version, '6.0.0')
    assert.equal(p.buildSha, '12bb43b24d49')
    assert.equal(p.builtAt, '2026-10-14T12:00:00.000Z')
    assert.match(formatBuildProvenance(p), /JakeTunes 6\.0\.0 \(build 12bb43b24d49, built 2026-10-14/)
  })

  test('missing build-info.json degrades to dev', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-prov-'))
    const p = getBuildProvenance('6.0.0', dir)
    assert.deepEqual(p, { version: '6.0.0', buildSha: 'dev', builtAt: null })
    assert.equal(formatBuildProvenance(p), 'JakeTunes 6.0.0 (build dev)')
  })

  test('a corrupt build-info.json degrades to dev, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-prov-'))
    writeFileSync(join(dir, 'build-info.json'), '{not json')
    assert.equal(getBuildProvenance('6.0.0', dir).buildSha, 'dev')
  })

  test('a shapeless build-info.json degrades to dev', () => {
    assert.equal(parseBuildInfo({ sha: 42 }, '6.0.0').buildSha, 'dev')
    assert.equal(parseBuildInfo(null, '6.0.0').buildSha, 'dev')
    assert.equal(parseBuildInfo('nope', '6.0.0').buildSha, 'dev')
  })
})
