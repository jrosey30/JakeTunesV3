/**
 * Source-shape lock for the last iPod sync success gate.
 *
 * File count and iTunesDB row count are insufficient: Mini 1.4.1 silently
 * hid four of 500 rows whose bitrate/sample-rate/mediatype were zero. Keep
 * the independent semantic validator between cold readback and success.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainDir = join(import.meta.dirname, '..')
const index = readFileSync(join(mainDir, 'index.ts'), 'utf-8')
const verifier = readFileSync(join(mainDir, '../../core/tools/itdb_verify.py'), 'utf-8')

test('sync runs the independent firmware-semantic validator before success reporting', () => {
  const gate = index.indexOf("'core/tools/itdb_verify.py'")
  const green = index.indexOf('firmware-semantic validation GREEN', gate)
  const report = index.indexOf('await writeSyncReport({', green)
  const success = index.indexOf('ok: !activityShortfall', report)

  assert.ok(gate >= 0, 'sync no longer invokes the independent iTunesDB validator')
  assert.ok(green > gate, 'sync no longer requires a GREEN semantic result')
  assert.ok(report > green, 'success report is written before semantic validation')
  assert.ok(success > report, 'sync can return success before its final report')
})

test('validator rejects every firmware field implicated in the 500-to-496 failure', () => {
  assert.match(verifier, /8 <= t\['bitrate'\] <= 2000/)
  assert.match(verifier, /8000 <= t\['srate'\] <= 192000/)
  assert.match(verifier, /t\['mediatype'\] != 1/)
  assert.match(verifier, /unplayable path extension/)
  assert.match(verifier, /ALAC-as-MP3 is the 497-of-500 skip/)
})

test('activity sync refuses success when a catalog row would not list on the Mini', () => {
  assert.match(index, /ipodFirmwareWillList/)
  assert.match(index, /needsIpodAlacTranscode/)
  assert.match(index, /ipodPlayableDestPath/)
})
