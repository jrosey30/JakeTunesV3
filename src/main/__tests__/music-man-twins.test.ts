/**
 * Three files are the same file in two repos: what counts as "I don't know that
 * band", the facts the Music Man is handed, and how an ask goes. JakeTunesV3 and
 * JakeTunesMobile each keep a copy, byte for byte, and each pins the sha256 here.
 *
 * A change to one copy fails this test until the pin moves, and the pin is the
 * same line in both repos: change the file here, copy it there, update both.
 * (2026-11-13: the phone's album page and the desktop's had the same four-phrase
 * filter, copied by hand, and both let "I don't know Twisted Teens" through.)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

const TWINS = [
  { here: 'src/common/non-answer.ts', there: 'backend/src/util/nonAnswer.ts', sha256: 'a1dc59ba5bf24a706b3f17f9b40701c4ccd073a25c798a97ef0c27b3dc3ad04c' },
  { here: 'src/common/music-man-packet.ts', there: 'backend/src/util/musicManPacket.ts', sha256: 'fa030c0e7c5ceff6567758d64bb4a609898e6ba113c1d102f36c8819e33e030e' },
  { here: 'src/common/music-man-ask-prompt.ts', there: 'backend/src/util/musicManAskPrompt.ts', sha256: '782565a2d07d7cc5a73e0a2e99bc5df8db415b34e00e254af2a19ad68facd0db' },
]

describe('the Music Man twins', () => {
  for (const t of TWINS) {
    test(`${t.here} is the file ${t.there} is`, () => {
      const bytes = readFileSync(join(ROOT, t.here))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), t.sha256,
        `${t.here} changed. Copy it to JakeTunesMobile ${t.there} and update the pin in BOTH repos' twin tests.`)
      assert.match(bytes.toString('utf-8'), /⚠️ TWIN: one file, byte for byte, in two repos/)
      // Import-free, or it could not be the same file in two module layouts.
      assert.doesNotMatch(bytes.toString('utf-8'), /^import /m)
    })
  }

  test('the persona twins still agree on who calls whom what', () => {
    const personas = readFileSync(join(ROOT, 'src/main/personas.ts'), 'utf-8')
    // Only Larry calls the Music Man the Funk Man / Marty / Funkhouser (Brief 229); the ask prompt leans on it.
    assert.match(personas, /You call him "the Funk Man", "Funk Man", "Marty" or "Funkhouser"/)
  })
})
