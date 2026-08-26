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
const deviceView = readFileSync(join(mainDir, '../renderer/views/DeviceView.tsx'), 'utf-8')
const app = readFileSync(join(mainDir, '../renderer/App.tsx'), 'utf-8')

test('Activity Sync is a dedicated engine; click-only origin is required', () => {
  assert.match(index, /runActivitySync/)
  assert.match(index, /origin === 'activity-click'/)
  assert.match(index, /refuseIpodSyncUnlessUserClick/)
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

test('activity sync writes artists A–Z and fills copy misses so N means N', () => {
  const fill = readFileSync(join(mainDir, 'activity-fill.ts'), 'utf-8')
  const sort = readFileSync(join(mainDir, 'ipod-artist-sort.ts'), 'utf-8')
  const writer = readFileSync(join(mainDir, '../../core/db_reader.py'), 'utf-8')
  assert.match(engine, /orderTracksForIpodTitleIndex/)
  assert.match(engine, /stampIpodSortArtist/)
  assert.match(engine, /loadReplacementTracks/)
  assert.match(engine, /bindActivityReplacements/)
  assert.match(index, /bindActivityReplacements/)
  assert.match(fill, /queueActivityCandidates/)
  assert.match(sort, /ipodArtistSortKey/)
  assert.match(sort, /ipodFirmwareFold/)
  assert.match(sort, /orderTracksForIpodTitleIndex/)
  assert.match(writer, /album_tuples_for_itunesdb/)
  assert.match(writer, /ipod_artist_sort_label/)
  assert.match(writer, /mhods \+= build_string_mhod\(22, ipod_artist_sort_label/)
  assert.match(writer, /music_menu_sort_keys/)
  assert.match(writer, /REQUIRED_MUSIC_SORT_KEYS/)
  assert.match(writer, /unique_genre_names_az/)
  assert.match(writer, /firmware_sort_text/)
})
