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
  // 2026-08-31 locks: the sync ledger must exist (picks + result entries).
  assert.match(engine, /activity-sync-ledger\.jsonl/)
  assert.match(engine, /kind: 'picks'/)
  assert.match(engine, /kind: 'result'/)
  // 2026-10-26: card names never reach the library. The 8/31 guard kept
  // exporting a rewrite when the EXTENSION changed, and the 2026-09-19 sync
  // wrote 8 FLAC imports into library.json as `F04:12004.m4a` (five weeks of
  // 404s). The engine still sets track.path to the card path for the DB
  // payload; its result carries no library path rewrites at all.
  assert.match(engine, /Card names never reach the library/)
  assert.doesNotMatch(engine, /pathRewrites\.push/)
  assert.doesNotMatch(engine, /pathRewrites: pathRewrites/)
})

test('the full sync returns only smart-match re-links, never converted or playable card names (twin of the activity engine)', () => {
  // 2026-10-26: convertedPathRewrites / playablePathRewrites are the card's
  // names for masters the library never renamed; they drive the iTunesDB
  // payload and the verify set, not library.json. The library snapshot must
  // be taken BEFORE those merges and be the only thing returned.
  const snapshot = syncEngine.indexOf('const libraryPathRewrites = pathRewrites.map(')
  const mergeConverted = syncEngine.indexOf('pathRewrites.push(...convertedPathRewrites)')
  const mergePlayable = syncEngine.indexOf('pathRewrites.push(...playablePathRewrites)')
  assert.ok(snapshot >= 0, 'library snapshot of the smart-match rewrites is missing')
  assert.ok(mergeConverted > snapshot && mergePlayable > snapshot, 'the snapshot must be taken before the card-name merges')
  assert.match(syncEngine, /pathRewrites: libraryPathRewrites,/)
  assert.doesNotMatch(syncEngine, /pathRewrites: pathRewrites\.map/)
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

test('evicted Mac copies are probed before wipe and staged at copy — the library symlink stays', () => {
  const ipc = readFileSync(join(mainDir, 'workout-sync-ipc.ts'), 'utf-8')
  const payload = readFileSync(join(mainDir, '../renderer/utils/workoutIpodSync.ts'), 'utf-8')
  const boardable = readFileSync(join(mainDir, 'activity-boardable.ts'), 'utf-8')
  const materialize = readFileSync(join(mainDir, 'ipod-sync-materialize.ts'), 'utf-8')
  const sync = readFileSync(join(mainDir, 'sync-engine/index.ts'), 'utf-8')
  assert.match(engine, /probeHomeminiTrack/)
  assert.match(engine, /stageTrack/)
  assert.match(engine, /formatHomeminiPullRefuse/)
  assert.match(engine, /Nothing was wiped/)
  assert.match(boardable, /toPull/)
  assert.match(materialize, /never SMB/)
  assert.match(materialize, /stageDir/)
  assert.match(sync, /stageLibraryTrack/)
  assert.match(sync, /probeHomeminiTrack/)
  assert.doesNotMatch(engine, /materializeTrack\(/)
  assert.doesNotMatch(sync, /materializeLibraryTrack\(/)
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
  // The activity-sync host is wired in sync-engine/ (P1C2 cut), not index.ts.
  assert.match(readFileSync(join(mainDir, 'sync-engine/index.ts'), 'utf-8'), /loadReplacementTracks: bindActivityReplacements\(/)
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

test('activity sync converts hi-res / multichannel ALAC, not only .flac (twin of the full sync)', () => {
  // 2026-10-17: six hi-res streamrip ALAC .m4a downloads (2840–5137 kbps)
  // rode an Activity Sync raw — the engine only checked the .flac
  // extension — and the firmware-semantic gate refused all 1000 songs
  // ("6/1000 track(s) have out-of-range bitrate"). The full sync has had
  // the ceiling check since 2026-09-07; both engines must route over-ceiling
  // lossless through the iPod-safe ALAC mirror.
  assert.match(engine, /exceedsIpodPlayableCeiling\(sourceBytes, Number\(track\.duration/)
  assert.match(engine, /needsIpodAlacTranscode\(localFile\) \|\| overCeiling\)/)
  assert.match(engine, /\|\| \(overCeiling && srcToCopy === localFile\)\)/)
  assert.match(syncEngine, /exceedsIpodPlayableCeiling/)
  // The mirror path is the card only: no mirror rewrites the library path,
  // not even when the extension changed (2026-10-26).
  assert.match(engine, /track\.codec = 'alac'\n(\s+\/\/.*\n)*\s+cardOnlyIds\.add\(id\)/)
})

test('a damaged song is skipped and replaced from reserve, not the reason a sync stops', () => {
  // 2026-10-17: "Jermango Dreaming — Breeze" (a damaged ALAC import, one of
  // 44 from 10/10–10/11) could not be converted, and the primary-pick
  // branch refused the whole 1000-song sync. A primary that cannot be
  // converted is now dropped like an unplayable row; reserves fill N.
  assert.doesNotMatch(engine, /return fail\(\{ copied: 0, error: `Could not build an iPod-safe ALAC for/)
  assert.doesNotMatch(engine, /return fail\(\{ copied: 0, error: `FLAC→ALAC failed for/)
  assert.match(engine, /skipUnconvertible\(title, String\(track\.artist \|\| ''\), id, 'no iPod-safe ALAC'\)/)
  // Not enough reserves still refuses — before the wipe, naming the songs.
  assert.match(engine, /if \(plan\.length < target\) \{/)
  assert.ok(engine.indexOf('if (plan.length < target) {') < engine.indexOf('── 2b. Keep plan'))
})
