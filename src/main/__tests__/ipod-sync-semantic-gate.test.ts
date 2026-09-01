/**
 * Source-shape lock for Activity Sync.
 *
 * Activity lives in ipod-activity-engine.ts — not the full-library copy
 * loop. File count and iTunesDB row count are insufficient: Mini 1.4.1
 * silently hid rows whose audio facts were zero. Keep the independent
 * semantic validator between cold readback and success, and refuse any
 * writer that is not an Activity Sync / Full Sync click.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainDir = join(import.meta.dirname, '..')
const index = readFileSync(join(mainDir, 'index.ts'), 'utf-8')
const engine = readFileSync(join(mainDir, 'ipod-activity-engine.ts'), 'utf-8')
const card = readFileSync(join(mainDir, 'ipod-sync-card.ts'), 'utf-8')
const origin = readFileSync(join(mainDir, 'ipod-sync-origin.ts'), 'utf-8')
const verifier = readFileSync(join(mainDir, '../../core/tools/itdb_verify.py'), 'utf-8')
const syncIpc = readFileSync(join(mainDir, 'ipc/sync-ipc.ts'), 'utf-8')
const syncEngine = readFileSync(join(mainDir, 'sync-engine/index.ts'), 'utf-8')
const deviceView = readFileSync(join(mainDir, '../renderer/views/DeviceView.tsx'), 'utf-8')
const app = readFileSync(join(mainDir, '../renderer/App.tsx'), 'utf-8')

test('Activity Sync is a dedicated engine; click-only origin is required', () => {
  // P1C2: the routing moved verbatim into sync-engine/ — the lock follows it.
  assert.match(syncEngine, /runActivitySync/)
  assert.match(syncEngine, /origin === 'activity-click'/)
  assert.match(syncEngine, /refuseIpodSyncUnlessUserClick/)
  assert.match(origin, /activity-click/)
  assert.match(origin, /full-library-click/)
  assert.match(deviceView, /origin: 'activity-click'/)
  assert.match(deviceView, /origin: 'full-library-click'/)
  assert.doesNotMatch(app, /syncToIpod\(/)
  assert.match(app, /progress.phase === 'error'/)
})

test('activity engine runs the independent firmware-semantic validator before TSA seal', () => {
  const gate = engine.indexOf("'core/tools/itdb_verify.py'")
  const green = engine.indexOf('firmware-semantic validation GREEN', gate)
  const tsa = engine.indexOf('tsaScreen', green)
  const seal = engine.indexOf('writeSeal', tsa)
  const ok = engine.indexOf('tsaActivityOk', seal)

  assert.ok(gate >= 0, 'engine no longer invokes the independent iTunesDB validator')
  assert.ok(green > gate, 'engine no longer requires a GREEN semantic result')
  assert.ok(tsa > green, 'TSA screen must run after semantic GREEN')
  assert.ok(seal > tsa, 'TSA seal must be written after the screen, not before')
  assert.ok(ok > seal, 'activity success can return before tsaActivityOk')
})

test('validator rejects every firmware field implicated in the 500-to-496 failure', () => {
  assert.match(verifier, /8 <= t\['bitrate'\] <= 2000/)
  assert.match(verifier, /8000 <= t\['srate'\] <= 192000/)
  assert.match(verifier, /t\['mediatype'\] != 1/)
  assert.match(verifier, /unplayable path extension/)
  assert.match(verifier, /ALAC-as-MP3 is the 497-of-500 skip/)
})

test('activity engine refuses a catalog row the Mini will not list', () => {
  assert.match(engine, /ipodFirmwareWillList/)
  assert.match(engine, /needsIpodAlacTranscode/)
  assert.match(engine, /ipodPlayableDestPath/)
  // 2026-08-31 locks: the sync ledger must exist (picks + result entries),
  // and card-only 8.3 stem shortenings must never be exported as library
  // path rewrites (702-row corruption incident).
  assert.match(engine, /activity-sync-ledger\.jsonl/)
  assert.match(engine, /kind: 'picks'/)
  assert.match(engine, /kind: 'result'/)
  assert.match(engine, /ipodPathExtension\(rawColon\) !== ipodPathExtension\(destColon\)/)
})

test('catalog ids are conformed to firmware binary-search order before the md5 proof', () => {
  // 2026-09-01: Mini 1.4.1 finds songs by binary search on mhit id — the
  // 819-of-1000 root cause. Ids must be re-minted ascending in record
  // order AFTER the artist sort and BEFORE the contiguity/md5 proof.
  assert.match(engine, /conformCatalogIdOrder/)
  const sort = engine.indexOf('orderForIpodCatalog(tracks)')
  const conform = engine.indexOf('await conformCatalogIdOrder(localDb)')
  const contig = engine.indexOf('await ensureContiguousDb(localDb, python)')
  assert.ok(sort >= 0 && conform > sort, 'id conform must run after the artist sort')
  assert.ok(contig > conform, 'id conform must run before the contiguity/md5 proof')
})

test('activity engine runs TSA by identity and does not auto-delete after the catalog', () => {
  assert.match(engine, /tsaAllClear/)
  assert.match(engine, /tsaScreen/)
  assert.match(engine, /tsaActivityOk/)
  assert.match(engine, /tsaDestCollisions/)
  assert.match(engine, /tsaRelFromColon/)
  assert.match(engine, /status: 'in-flight'/)
  assert.match(engine, /status: 'sealed'/)
  assert.match(engine, /TSA sealed/)
  assert.doesNotMatch(engine, /cleanOrphansOnMusicRoot/)
  assert.doesNotMatch(engine, /join\(IPOD_MOUNT, p\.destPath\.replace/)
  assert.match(syncIpc, /tsaRelFromColon/)
  assert.doesNotMatch(syncIpc, /join\(mount, p\.destPath\.replace/)
})

test('after writing iTunesDB, Play Counts is retired before the Mini can boot onto the catalog', () => {
  const written = engine.indexOf("title: 'iTunesDB written'")
  const scratch = engine.indexOf('retireIpodFirmwareScratch', written)
  const remount = engine.indexOf('remountVolume(IPOD_MOUNT)', scratch)
  assert.ok(written >= 0, 'catalog write no longer announces iTunesDB written')
  assert.ok(scratch > written, 'Play Counts must be retired after the catalog write')
  assert.ok(remount > scratch, 'flush remount must not run while Play Counts is still on the card')
  assert.match(card, /firmware scratch retired/)
  assert.doesNotMatch(engine, /the device will show \$\{onDevice - missingFiles\}/)
})

test('the iTunesDB is built locally and proven on the CF across two remounts', () => {
  assert.match(engine, /--ipod-root/)
  assert.match(engine, /--template/)
  assert.match(engine, /copyFile\(localDb, ipodDb\)/)
  assert.match(engine, /catalogOnCardProven/)
  assert.match(engine, /catalogBytesMatch/)
  assert.match(engine, /ensureContiguousDb\(localDb/)
  assert.doesNotMatch(engine, /ensureContiguousDb\(ipodDb/)
  assert.match(engine, /Not writing a catalog/)
})

test('evicted Mac copies are pulled from homemini before wipe — every library song is syncable', () => {
  const ipc = readFileSync(join(mainDir, 'workout-sync-ipc.ts'), 'utf-8')
  const payload = readFileSync(join(mainDir, '../renderer/utils/workoutIpodSync.ts'), 'utf-8')
  const boardable = readFileSync(join(mainDir, 'activity-boardable.ts'), 'utf-8')
  const materialize = readFileSync(join(mainDir, 'ipod-sync-materialize.ts'), 'utf-8')
  assert.match(engine, /materializeTrack/)
  assert.match(engine, /formatHomeminiPullRefuse/)
  assert.match(boardable, /toPull/)
  assert.match(materialize, /never SMB/)
  assert.doesNotMatch(ipc, /filterActivityBoardable/)
  assert.match(payload, /path: t.path/)
})
