/**
 * The phone's listening log (plays + skips) reaches the MacBook (2026-10-20).
 *
 * The backend writes mobile-listening-log.jsonl in its STATE_DIR — the NAS
 * share as homemini mounts it. The pull only tried homemini's ~/JakeTunesState
 * and App Support, where the file never lives, so the MacBook's copy froze on
 * 9/13 while the real one grew to 529 KB. Lock: the backend's state dir is
 * tried FIRST, and the old two remain as fallbacks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const script = readFileSync(join(import.meta.dirname, '..', '..', '..', 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh'), 'utf-8')

test('the phone listening log is pulled from the backend state dir first', () => {
  assert.match(script, /PHONE_STATE_DIR_ON_HOMEMINI="\$\{JT_PHONE_STATE_DIR:-\/Volumes\/JakeShared\/JakeTunesState\}"/)
  const pulls = script.split('\n').filter((l) => /^rsync_optional .*mobile-listening-log\.jsonl/.test(l))
  assert.equal(pulls.length, 3)
  assert.match(pulls[0], /\$HOMEMINI:\$PHONE_STATE_DIR_ON_HOMEMINI\/mobile-listening-log\.jsonl/)
  assert.match(pulls[1], /\$HOMEMINI:JakeTunesState\/mobile-listening-log\.jsonl/)
  assert.match(pulls[2], /rremote "\$JT_DATA_REMOTE\/mobile-listening-log\.jsonl"/)
})
