/**
 * "Apply Overrides to Files…" says how many songs wait for the player (review of #427).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyOverridesSummary, type ApplyOverridesCounts } from '../../common/apply-overrides-summary.ts'

const base: ApplyOverridesCounts = { total: 40, succeeded: 40, failed: 0, waitingForPlayback: 0, skippedNoTrack: 1, skippedFpMismatch: 2, skippedNoWritable: 3, failures: [] }

describe('the result dialog', () => {
  test('nothing playing: as before, with the total', () => {
    assert.equal(applyOverridesSummary(base).message, 'Wrote tags to 40 of 40 files.')
    assert.equal(applyOverridesSummary(base).detail, 'Skipped: 1 missing-track, 2 fingerprint-mismatch, 3 analysis-only.')
  })
  test('songs playing are counted in the total and said to be waiting', () => {
    assert.equal(applyOverridesSummary({ ...base, waitingForPlayback: 2 }).message,
      'Wrote tags to 40 of 42 files. 2 songs are playing and will be written when the player is done with them.')
    assert.equal(applyOverridesSummary({ ...base, waitingForPlayback: 1 }).message,
      'Wrote tags to 40 of 41 files. 1 song is playing and will be written when the player is done with it.')
  })
  test('failures still say so, with the first five', () => {
    const r = applyOverridesSummary({ ...base, total: 1200, succeeded: 1190, failed: 10, waitingForPlayback: 1,
      failures: Array.from({ length: 7 }, (_, i) => ({ filePath: `/m/F0${i}/s${i}.m4a`, error: 'timeout' })) })
    assert.equal(r.message, 'Wrote tags to 1,190 of 1,201 files; 10 failed. 1 song is playing and will be written when the player is done with it.')
    assert.equal(r.detail.split('\n').filter((l) => l.startsWith('•')).length, 5)
  })
  test('App.tsx shows this summary and carries the count from main', () => {
    const app = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'App.tsx'), 'utf8')
    assert.match(app, /message=\{applyOverridesSummary\(applyOverridesResult\)\.message\}/)
    assert.match(app, /waitingForPlayback: r\.waitingForPlayback \?\? 0,/)
  })
})
