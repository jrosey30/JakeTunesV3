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
const syncIpc = readFileSync(join(mainDir, 'ipc/sync-ipc.ts'), 'utf-8')

test('sync runs the independent firmware-semantic validator before success reporting', () => {
  const gate = index.indexOf("'core/tools/itdb_verify.py'")
  const green = index.indexOf('firmware-semantic validation GREEN', gate)
  const tsa = index.indexOf('tsaScreen', green)
  const seal = index.indexOf('writeTsaSealFile', tsa)
  const report = index.indexOf('await writeSyncReport({', seal)
  const success = index.indexOf('tsaActivityOk', report)

  assert.ok(gate >= 0, 'sync no longer invokes the independent iTunesDB validator')
  assert.ok(green > gate, 'sync no longer requires a GREEN semantic result')
  assert.ok(tsa > green, 'TSA screen must run after semantic GREEN')
  assert.ok(seal > tsa, 'TSA seal must be written after the screen, not before')
  assert.ok(report > seal, 'success report is written before TSA seal')
  assert.ok(success > report, 'activity success can return before tsaActivityOk')
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

test('activity sync runs TSA by identity and does not auto-delete after the catalog', () => {
  assert.match(index, /tsaAllClear/)
  assert.match(index, /tsaScreen/)
  assert.match(index, /tsaActivityOk/)
  assert.match(index, /tsaDestCollisions/)
  assert.match(index, /tsaRelFromColon/)
  assert.match(index, /status: 'in-flight'/)
  assert.match(index, /status: 'sealed'/)
  assert.match(index, /skipping post-catalog orphan deletes on activity rebuild/)
  assert.match(index, /TSA sealed/)
  assert.doesNotMatch(index, /join\(IPOD_MOUNT, p\.destPath\.replace/)
  assert.match(syncIpc, /tsaRelFromColon/)
  assert.doesNotMatch(syncIpc, /join\(mount, p\.destPath\.replace/)
})

test('after writing iTunesDB, Play Counts is retired before the Mini can boot onto the catalog', () => {
  const written = index.indexOf("title: 'iTunesDB written'")
  const scratch = index.indexOf('retireIpodFirmwareScratch', written)
  const remount = index.indexOf('remountVolume(IPOD_MOUNT)', scratch)
  assert.ok(written >= 0, 'catalog write no longer announces iTunesDB written')
  assert.ok(scratch > written, 'Play Counts must be retired after the catalog write')
  assert.ok(remount > scratch, 'flush remount must not run while Play Counts is still on the card')
  assert.match(index, /firmware scratch retired/)
  assert.doesNotMatch(index, /the device will show \$\{onDevice - missingFiles\}/)
})

test('the iTunesDB is built locally and proven on the CF across two remounts', () => {
  assert.match(index, /--ipod-root/)
  assert.match(index, /--template/)
  assert.match(index, /copyFile\(localDb, ipodDb\)/)
  assert.match(index, /catalogOnCardProven/)
  assert.match(index, /catalogBytesMatch/)
  assert.match(index, /ensureContiguousDb\(localDb/)
  assert.doesNotMatch(index, /ensureContiguousDb\(ipodDb/)
})
