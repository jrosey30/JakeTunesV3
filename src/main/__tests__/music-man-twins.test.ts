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
  { here: 'src/common/non-answer.ts', there: 'backend/src/util/nonAnswer.ts', sha256: '64eb06d25b2d67fbc607e6fee46b4c47400c9b36483f3f81c1c80a834ddac38e' },
  { here: 'src/common/music-man-packet.ts', there: 'backend/src/util/musicManPacket.ts', sha256: 'a7e9569f93ac0830154146bf029687a03ecf50d2ffc92dc448689084028273f8' },
  { here: 'src/common/music-man-ask-prompt.ts', there: 'backend/src/util/musicManAskPrompt.ts', sha256: '0e87c45a990c981a770acff5eeb175f0c3f5be870c4a2c7e13c1d65b4e1621d2' },
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
