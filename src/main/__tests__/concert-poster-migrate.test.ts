/**
 * The poster migration, against a scratch store with stand-in tools: no ffmpeg, no
 * osascript, no network, nothing real. What it must do for the 13 shows: move each
 * poster onto its own key, put the album's own cover back, record source and matte,
 * back up first, and find nothing to do the second time.
 */
import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergedAlbumArtworkKey, posterArtworkKey } from '../../common/concert-poster.ts'
import { installPosterImage, md5Hex, posterArtworkHash, posterInStore } from '../concert-poster.ts'
import {
  applyPlan, describePlan, makePlan, planIsEmpty, restoreBackup, SHOW_RULES, RUSH_JULY_SHA256, RUSH_JUNE_SHA256,
  type MigratePaths, type MigrateTools, type PlanAction, type ShowPlan,
} from '../concert-poster-migrate.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'concert-poster-migrate-'))
after(() => rmSync(ROOT, { recursive: true, force: true }))

const jpeg = (label: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(label)])
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const UNPLUGGED = 'nirvana|||mtv unplugged in new york'      // a pick, and the album is visible (promoted)
const PARADISO = "nirvana|||amsterdam '91 - come as you are [live]"   // a pick, hidden, no cover anywhere
const HILLS = 'geese|||getting killed again (live at forest hills, new york, oct 3rd, 2026)'  // a gig poster, art in the file
const WINTER = 'cameron winter|||live at carnegie hall'    // built
const RUSH = "rush|||all the world's a stage [live]"       // the corrected file
const NEWER = 'somebody|||declared since'                   // not one of the 13

const POSTERS: Record<string, Buffer> = {
  [UNPLUGGED]: jpeg('unplugged poster'),
  [PARADISO]: jpeg('paradiso poster'),
  [HILLS]: jpeg('forest hills poster'),
  [RUSH]: jpeg('rush poster, JULY'),
}
const COVER_WINTER = jpeg('cameron winter square cover')
const RUSH_JUNE = jpeg('rush poster, JUNE')
const PINS = { july: sha(POSTERS[RUSH]!), june: sha(RUSH_JUNE) }

type World = { dir: string; paths: MigratePaths; tools: MigrateTools; online: Map<string, string>; embedded: Map<string, Buffer> }

let counter = 0
function world(): World {
  const dir = join(ROOT, `w${counter++}`)
  const artworkDir = join(dir, 'app', 'artwork')
  mkdirSync(join(artworkDir, 'locked-backup'), { recursive: true })
  const index: Record<string, string> = {}
  const locks: string[] = ['someone|||else']
  for (const [key, bytes] of Object.entries(POSTERS)) {
    const bare = md5Hex(key)
    writeFileSync(join(artworkDir, `${bare}.jpg`), bytes)
    writeFileSync(join(artworkDir, 'locked-backup', `${bare}.jpg`), bytes)
    writeFileSync(join(artworkDir, `${bare}.meta.json`), JSON.stringify({ key, source: 'user-custom' }))
    index[key] = `${bare}_1788389396248`
    index[mergedAlbumArtworkKey(key)] = `${bare}_1788389396248`
    locks.push(key)
  }
  writeFileSync(join(artworkDir, `${md5Hex(WINTER)}.jpg`), COVER_WINTER)
  index[WINTER] = `${md5Hex(WINTER)}_1791593715538`
  index['someone|||else'] = 'abc_1'
  writeFileSync(join(artworkDir, 'index.json'), JSON.stringify(index, null, 2))
  writeFileSync(join(artworkDir, 'user-locked.json'), JSON.stringify(locks))

  const cue = (trackId: number, artist: string) => ({ trackId, title: 'Song (Live)', artist, startMs: 0, durationMs: 1000 })
  const sets = {
    [UNPLUGGED]: { mergedTrackId: 1, cues: [cue(11, 'Nirvana')], totalDurationMs: 1000, promotedTrackIds: [11], concert: { venue: 'Sony Music Studios', city: 'New York, NY', date: 'November 18, 1993', facts: ['A fact.'] } },
    [PARADISO]: { mergedTrackId: 2, cues: [cue(21, 'Nirvana')], totalDurationMs: 1000, concert: { poster: '', venue: 'Paradiso', notes: 'Jake was not there.' } },
    [HILLS]: { mergedTrackId: 3, cues: [cue(31, 'Geese')], totalDurationMs: 1000, concert: { venue: 'Forest Hills Stadium', notes: 'I was there.' } },
    [WINTER]: { mergedTrackId: 4, cues: [cue(41, 'Cameron Winter')], totalDurationMs: 1000, concert: { venue: 'Carnegie Hall', city: 'New York, NY', date: 'December 11, 2025' } },
    [RUSH]: { mergedTrackId: 5, cues: [cue(51, 'Rush')], totalDurationMs: 1000, concert: { venue: 'Massey Hall', date: 'June 11-13, 1976' } },
    [NEWER]: { mergedTrackId: 6, cues: [cue(61, 'Somebody')], totalDurationMs: 1000 },
  }
  const liveSets = join(dir, 'app', 'live-sets.json')
  writeFileSync(liveSets, JSON.stringify(sets, null, 2))
  const row = (id: number, artist: string, album: string) => ({ id, artist, album, path: `:iPod_Control:Music:F00:${id}.m4a`, year: 2026 })
  const library = join(dir, 'app', 'library.json')
  writeFileSync(library, JSON.stringify({ tracks: [
    row(1, 'Nirvana', 'MTV Unplugged In New York (Live Set)'), row(11, 'Nirvana', 'MTV Unplugged In New York'),
    row(2, 'Nirvana', "Amsterdam '91 - Come As You Are [Live] (Live Set)"), row(21, 'Nirvana', "Amsterdam '91 - Come As You Are [Live]"),
    row(3, 'Geese', 'Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026) (Live Set)'), row(31, 'Geese', 'Getting Killed Again (Live at Forest Hills, New York, Oct 3rd, 2026)'),
    row(4, 'Cameron Winter', 'Live at Carnegie Hall (Live Set)'), row(41, 'Cameron Winter', 'Live at Carnegie Hall'),
    row(5, 'Rush', "All The World's A Stage [Live] (Live Set)"), row(51, 'Rush', "All The World's A Stage [Live]"),
    row(6, 'Somebody', 'Declared Since (Live Set)'), row(61, 'Somebody', 'Declared Since'),
  ] }))
  const rushFile = join(dir, 'rush-june.jpg')
  writeFileSync(rushFile, RUSH_JUNE)

  const paths: MigratePaths = {
    liveSets, artworkDir, index: join(artworkDir, 'index.json'), locks: join(artworkDir, 'user-locked.json'), library,
    reviewDir: join(dir, 'review'), rushFile, fontPath: null, backupRoot: join(dir, 'app', 'backups'),
  }
  const online = new Map<string, string>([
    ['Nirvana|MTV Unplugged In New York', 'unplugged cover from the web'],
    ["Rush|All The World's A Stage [Live]", 'rush cover from the web'],
  ])
  const embedded = new Map<string, Buffer>([[':iPod_Control:Music:F00:31.m4a', jpeg('forest hills cover from the file')]])
  const tools: MigrateTools = {
    now: () => 1793953995163,
    readMatte: async () => '#123456',
    imageSize: async () => ({ w: 100, h: 150 }),
    toJpeg: async (src, dest) => { writeFileSync(dest, readFileSync(src)) },
    renderBuilt: async (facts, _cover, out) => { writeFileSync(out, jpeg(`built: ${facts.band} / ${facts.show}`)) },
    embeddedArt: async (p) => embedded.get(p) ?? null,
    findOnline: async (artist, album) => {
      const hit = online.get(`${artist}|${album}`)
      return hit ? { candidate: { provider: 'itunes', url: `https://x/${encodeURIComponent(album)}`, matched: `${artist} - ${album}` }, bytes: jpeg(hit) } : null
    },
  }
  return { dir, paths, tools, online, embedded }
}

const applyTools = (w: World): MigrateTools => ({ ...w.tools, embeddedArt: undefined, findOnline: undefined })
const plan = (w: World, dryRun = true) => makePlan(w.paths, dryRun ? w.tools : applyTools(w), { dryRun, rushPins: PINS })
const showOf = (shows: ShowPlan[], key: string): ShowPlan => shows.find((s) => s.albumKey === key)!
const acts = <D extends PlanAction['do']>(s: ShowPlan, d: D): Array<Extract<PlanAction, { do: D }>> => s.actions.filter((a): a is Extract<PlanAction, { do: D }> => a.do === d)
const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf-8')) as T
const artFile = (w: World, key: string): string => join(w.paths.artworkDir, `${md5Hex(key)}.jpg`)
const posterFile = (w: World, key: string): string => join(w.paths.artworkDir, `${posterArtworkHash(key)}.jpg`)

/** Every file under a folder, with its bytes and mtime: a run that writes nothing leaves this equal. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    if (!existsSync(d)) return
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out[p] = `${sha(readFileSync(p))}:${st.mtimeMs}`
    }
  }
  walk(dir)
  return out
}

async function dryRunThenApply(w: World) {
  await plan(w, true)
  const p = await plan(w, false)
  return { plan: p, result: await applyPlan(p, w.paths) }
}

describe('the table', () => {
  test('names all 13 shows, with the sources Jake approved', () => {
    assert.equal(Object.keys(SHOW_RULES).length, 13)
    const by = (s: string) => Object.values(SHOW_RULES).filter((r) => r.source === s).length
    assert.equal(by('jake-pick'), 6, 'Jake keeps all six September picks')
    assert.equal(by('gig-poster'), 2)
    assert.equal(by('film-one-sheet'), 2)
    assert.equal(by('built'), 3)
  })
  test('the pins are the real files', () => {
    const asset = join(import.meta.dirname, '..', '..', '..', 'scripts', 'concert', 'assets', 'rush-massey-hall-june.jpg')
    assert.equal(sha(readFileSync(asset)), RUSH_JUNE_SHA256, 'the corrected Rush poster travels with the repo')
    assert.equal(RUSH_JULY_SHA256.length, 64)
  })
})

describe('the dry run', () => {
  let w: World
  beforeEach(() => { w = world() })

  test('writes nothing outside the review folder', async () => {
    const before = snapshot(join(w.dir, 'app'))
    await plan(w, true)
    assert.deepEqual(snapshot(join(w.dir, 'app')), before)
    assert.ok(existsSync(join(w.paths.reviewDir, 'covers')), 'the candidates are in the review folder')
  })

  test('says exactly what --apply would do, show by show', async () => {
    const p = await plan(w, true)
    const s = showOf(p.shows, UNPLUGGED)
    assert.deepEqual(s.actions.map((a) => a.do), ['poster-copy', 'cover-restore', 'unlock', 'drop-backup-copy', 'index', 'index', 'index', 'concert'])
    const text = describePlan(p)
    assert.match(text, /poster {3}copy /)
    assert.match(text, /gets the album's own cover from itunes "Nirvana - MTV Unplugged In New York"/)
    assert.match(text, /gets the album's own cover from the file's embedded art \(track 31\)/)
    assert.match(text, /poster {3}build .* from .*: "CAMERON WINTER" \/ "LIVE AT CARNEGIE HALL" \/ "NEW YORK, NY · 2025"/)
    assert.match(text, /poster {3}install rush-june\.jpg/)
    assert.match(text, /no cover in the files or on the web\. The album key keeps today's image: the album is hidden/)
    assert.match(text, /Summary: 6 shows\. Posters: 3 moved onto their own key, 1 built, 1 corrected file\. Album covers: 3 put back \(1 from the files, 2 from the web\), 1 with no cover found\./)
  })

  test('the file\'s own art comes first; the web is only for an album with none', async () => {
    const p = await plan(w, true)
    assert.equal(acts(showOf(p.shows, HILLS), 'cover-restore')[0]?.provider, 'embedded')
    assert.equal(acts(showOf(p.shows, UNPLUGGED), 'cover-restore')[0]?.provider, 'itunes')
  })

  test('a built show keeps its cover on its own key: nothing to restore', async () => {
    const p = await plan(w, true)
    const s = showOf(p.shows, WINTER)
    assert.deepEqual(s.actions.map((a) => a.do), ['poster-built', 'index', 'index', 'concert'])
  })

  test('a show that is not one of the 13 is left alone', async () => {
    const s = showOf((await plan(w, true)).shows, NEWER)
    assert.deepEqual(s.actions, [])
    assert.match(s.notes[0]!, /not one of the 13/)
  })

  test('a file a person put in the review folder is not overwritten by a second dry run', async () => {
    await plan(w, true)
    const cand = join(w.paths.reviewDir, 'covers', `${md5Hex(UNPLUGGED)}.jpg`)
    writeFileSync(cand, jpeg('Jake chose this one'))
    await plan(w, true)
    assert.ok(readFileSync(cand).equals(jpeg('Jake chose this one')))
  })
})

describe('--apply', () => {
  let w: World
  beforeEach(() => { w = world() })

  test('moves the poster onto its own key and gives the album its own cover back', async () => {
    await dryRunThenApply(w)
    assert.ok(readFileSync(posterFile(w, UNPLUGGED)).equals(POSTERS[UNPLUGGED]!), 'the poster, byte for byte, under its own key')
    assert.ok(readFileSync(artFile(w, UNPLUGGED)).equals(jpeg('unplugged cover from the web')), 'the Albums tab draws this')
    assert.ok(readFileSync(artFile(w, HILLS)).equals(jpeg('forest hills cover from the file')))
  })

  test('the store says where each thing came from', async () => {
    await dryRunThenApply(w)
    const web = json<Record<string, unknown>>(artFile(w, UNPLUGGED).replace(/\.jpg$/, '.meta.json'))
    assert.equal(web.source, 'fetched', 'cover-vault trusts only "embedded": this keeps that word true')
    assert.equal(web.key, UNPLUGGED)
    const file = json<Record<string, unknown>>(artFile(w, HILLS).replace(/\.jpg$/, '.meta.json'))
    assert.equal(file.source, 'embedded')
    const poster = json<Record<string, unknown>>(posterFile(w, UNPLUGGED).replace(/\.jpg$/, '.meta.json'))
    assert.equal(poster.key, posterArtworkKey(UNPLUGGED), 'a replica merges the key from this')
    assert.equal(poster.posterSource, 'jake-pick')
  })

  test('the index: poster key, merged row and album key each point at the right file', async () => {
    await dryRunThenApply(w)
    const index = json<Record<string, string>>(w.paths.index)
    const hash = posterArtworkHash(UNPLUGGED)
    assert.equal(index[posterArtworkKey(UNPLUGGED)], `${hash}_1793953995163`)
    assert.equal(index[mergedAlbumArtworkKey(UNPLUGGED)], `${hash}_1793953995163`, 'the merged row draws the poster')
    assert.equal(index[UNPLUGGED], `${md5Hex(UNPLUGGED)}_1793953995163`, 'a new version, so the old poster cannot stay cached')
    assert.equal(index['someone|||else'], 'abc_1', 'every other line untouched')
  })

  test('the album key is unlocked and its locked-backup copy gone, or the next launch re-locks the poster', async () => {
    await dryRunThenApply(w)
    const locks = json<string[]>(w.paths.locks)
    assert.ok(!locks.includes(UNPLUGGED))
    assert.ok(locks.includes('someone|||else'))
    assert.ok(!existsSync(join(w.paths.artworkDir, 'locked-backup', `${md5Hex(UNPLUGGED)}.jpg`)))
  })

  test('the concert block gets poster, source and matte, and keeps everything else', async () => {
    await dryRunThenApply(w)
    const sets = json<Record<string, { promotedTrackIds?: number[]; concert: Record<string, unknown> }>>(w.paths.liveSets)
    assert.deepEqual(
      { p: sets[UNPLUGGED]!.concert.poster, s: sets[UNPLUGGED]!.concert.posterSource, m: sets[UNPLUGGED]!.concert.posterMatte },
      { p: posterArtworkHash(UNPLUGGED), s: 'jake-pick', m: '#123456' },
    )
    assert.deepEqual(sets[UNPLUGGED]!.concert.facts, ['A fact.'])
    assert.deepEqual(sets[UNPLUGGED]!.promotedTrackIds, [11])
    assert.equal(sets[HILLS]!.concert.notes, 'I was there.', 'Jake\'s own note survives')
    assert.equal(sets[HILLS]!.concert.posterSource, 'gig-poster')
    assert.equal(sets[WINTER]!.concert.posterSource, 'built')
    assert.equal(sets[WINTER]!.concert.posterMatte, '#0B0B0A', 'a built poster\'s matte is its ground, exactly')
    assert.equal(sets[RUSH]!.concert.posterSource, 'jake-pick')
    assert.equal(sets[NEWER]!.concert, undefined, 'a show that is not one of the 13 is not touched')
  })

  test('a built poster lands; the album\'s own cover is not touched', async () => {
    await dryRunThenApply(w)
    assert.ok(readFileSync(posterFile(w, WINTER)).equals(jpeg('built: Cameron Winter / Live at Carnegie Hall')))
    assert.ok(readFileSync(artFile(w, WINTER)).equals(COVER_WINTER))
  })

  test('Rush: the corrected poster lands and the July one leaves the album key', async () => {
    await dryRunThenApply(w)
    assert.ok(readFileSync(posterFile(w, RUSH)).equals(RUSH_JUNE))
    assert.ok(readFileSync(artFile(w, RUSH)).equals(jpeg('rush cover from the web')))
  })

  test('no cover found: the poster still moves, the album key is left exactly as it was', async () => {
    const before = readFileSync(artFile(w, PARADISO))
    await dryRunThenApply(w)
    assert.ok(readFileSync(posterFile(w, PARADISO)).equals(POSTERS[PARADISO]!))
    assert.ok(readFileSync(artFile(w, PARADISO)).equals(before))
    assert.ok(json<string[]>(w.paths.locks).includes(PARADISO), 'still locked: nothing replaced it')
    assert.ok(existsSync(join(w.paths.artworkDir, 'locked-backup', `${md5Hex(PARADISO)}.jpg`)))
  })

  test('a candidate deleted from the review folder leaves that album alone, and says when it shows', async () => {
    await plan(w, true)
    rmSync(join(w.paths.reviewDir, 'covers', `${md5Hex(UNPLUGGED)}.jpg`))
    const before = readFileSync(artFile(w, UNPLUGGED))
    const p = await plan(w, false)
    assert.match(describePlan(p), /this album IS visible \(promoted songs\): look at it/)
    await applyPlan(p, w.paths)
    assert.ok(readFileSync(artFile(w, UNPLUGGED)).equals(before))
  })

  test('backs up everything it replaces, proven by sha256, before the first write', async () => {
    const liveSetsBefore = readFileSync(w.paths.liveSets)
    const albumBefore = readFileSync(artFile(w, UNPLUGGED))
    const { result } = await dryRunThenApply(w)
    assert.ok(result.backupDir)
    const manifest = json<{ files: Array<{ path: string; name: string }>; created: string[] }>(join(result.backupDir!, 'manifest.json'))
    const saved = new Map(manifest.files.map((f) => [f.path, readFileSync(join(result.backupDir!, f.name))]))
    assert.ok(saved.get(w.paths.liveSets)?.equals(liveSetsBefore))
    assert.ok(saved.get(artFile(w, UNPLUGGED))?.equals(albumBefore))
    assert.ok(saved.has(w.paths.index))
    assert.ok(saved.has(w.paths.locks))
    assert.ok(saved.has(join(w.paths.artworkDir, 'locked-backup', `${md5Hex(UNPLUGGED)}.jpg`)))
    assert.ok(manifest.created.includes(posterFile(w, UNPLUGGED)))
  })

  test('a copy of the images cannot be applied: only the real store', async () => {
    const p = await plan(w, true)
    await assert.rejects(applyPlan(p, { ...w.paths, imagesDir: '/some/copy' }), /real store/)
  })
})

describe('safe to run twice', () => {
  let w: World
  beforeEach(() => { w = world() })

  test('the second run finds nothing, writes nothing and makes no backup', async () => {
    await dryRunThenApply(w)
    const before = snapshot(join(w.dir, 'app'))
    const again = await plan(w, false)
    assert.ok(planIsEmpty(again), describePlan(again))
    const r = await applyPlan(again, w.paths)
    assert.equal(r.backupDir, null)
    assert.equal(r.changed, 0)
    assert.deepEqual(snapshot(join(w.dir, 'app')), before, 'not one byte, not one mtime')
  })

  test('a crash before the index and live-sets were written is finished by running it again', async () => {
    const { result } = await dryRunThenApply(w)
    const manifest = json<{ files: Array<{ path: string; name: string }> }>(join(result.backupDir!, 'manifest.json'))
    for (const f of manifest.files) {
      if (f.path === w.paths.index || f.path === w.paths.liveSets || f.path === w.paths.locks) writeFileSync(f.path, readFileSync(join(result.backupDir!, f.name)))
    }
    const p = await plan(w, false)
    assert.deepEqual(acts(showOf(p.shows, UNPLUGGED), 'poster-copy'), [], 'the poster is already under its own key')
    assert.deepEqual(acts(showOf(p.shows, UNPLUGGED), 'cover-restore'), [], 'the album already has its cover: a cover must never be copied over the poster')
    await applyPlan(p, w.paths)
    assert.ok(readFileSync(posterFile(w, UNPLUGGED)).equals(POSTERS[UNPLUGGED]!))
    assert.equal(json<Record<string, { concert: { poster?: string } }>>(w.paths.liveSets)[UNPLUGGED]!.concert.poster, posterArtworkHash(UNPLUGGED))
    assert.ok(planIsEmpty(await plan(w, false)))
  })

  test('a crash between the poster and the album key: the album key is still restored', async () => {
    await plan(w, true)
    mkdirSync(w.paths.artworkDir, { recursive: true })
    writeFileSync(posterFile(w, UNPLUGGED), POSTERS[UNPLUGGED]!)
    const p = await plan(w, false)
    assert.equal(acts(showOf(p.shows, UNPLUGGED), 'poster-copy').length, 0)
    assert.equal(acts(showOf(p.shows, UNPLUGGED), 'cover-restore').length, 1, 'still byte-identical to the poster, so it still holds the poster')
    await applyPlan(p, w.paths)
    assert.ok(readFileSync(artFile(w, UNPLUGGED)).equals(jpeg('unplugged cover from the web')))
  })
})

describe('identity gates: never overwrite what it cannot prove', () => {
  let w: World
  beforeEach(() => { w = world() })

  test('an album key that no longer matches the poster is left alone', async () => {
    await plan(w, true)
    writeFileSync(posterFile(w, UNPLUGGED), POSTERS[UNPLUGGED]!)
    writeFileSync(artFile(w, UNPLUGGED), jpeg('Jake set a new album cover since'))
    const p = await plan(w, false)
    assert.deepEqual(acts(showOf(p.shows, UNPLUGGED), 'cover-restore'), [])
    await applyPlan(p, w.paths)
    assert.ok(readFileSync(artFile(w, UNPLUGGED)).equals(jpeg('Jake set a new album cover since')))
  })

  test('Rush: if the album key is not the July image, a person decides', async () => {
    writeFileSync(artFile(w, RUSH), jpeg('someone changed it'))
    const s = showOf((await plan(w, true)).shows, RUSH)
    assert.deepEqual(s.actions, [])
    assert.match(s.notes[0]!, /does not hold the July poster/)
  })

  test('Rush: a corrected file that is not the pinned one is refused', async () => {
    writeFileSync(w.paths.rushFile, jpeg('not the corrected poster'))
    const s = showOf((await plan(w, true)).shows, RUSH)
    assert.deepEqual(s.actions, [])
    assert.match(s.notes[0]!, /not the corrected poster/)
  })

  test('a show already naming another poster is left alone', async () => {
    const sets = json<Record<string, { concert: Record<string, unknown> }>>(w.paths.liveSets)
    sets[UNPLUGGED]!.concert.poster = 'feedfacefeedfacefeedfacefeedface'
    writeFileSync(w.paths.liveSets, JSON.stringify(sets))
    const s = showOf((await plan(w, true)).shows, UNPLUGGED)
    assert.deepEqual(s.actions, [])
    assert.match(s.notes[0]!, /already names another image/)
  })

  test('a review file changed after the plan stops the run before it lands', async () => {
    await plan(w, true)
    const p = await plan(w, false)
    writeFileSync(join(w.paths.reviewDir, 'covers', `${md5Hex(UNPLUGGED)}.jpg`), jpeg('swapped under it'))
    await assert.rejects(applyPlan(p, w.paths), /changed since the plan was made/)
  })
})

describe('--restore', () => {
  test('puts it all back, and takes away what the run created', async () => {
    const w = world()
    const before = Object.fromEntries(Object.entries(snapshot(join(w.dir, 'app'))).map(([k, v]) => [k, v.split(':')[0]]))
    const { result } = await dryRunThenApply(w)
    await restoreBackup(result.backupDir!)
    const after = Object.fromEntries(Object.entries(snapshot(join(w.dir, 'app')))
      .filter(([k]) => !k.startsWith(w.paths.backupRoot))
      .map(([k, v]) => [k, v.split(':')[0]]))
    assert.deepEqual(after, before)
  })
})

describe('a poster already in the store', () => {
  test('is found again after an undeclare, source and matte intact, so a re-declare cannot build over Jake\'s pick', async () => {
    const w = world()
    const src = join(w.dir, 'pick.jpg')
    writeFileSync(src, jpeg('a pick'))
    assert.equal(await posterInStore(w.paths.artworkDir, UNPLUGGED), null)
    await installPosterImage({ artworkDir: w.paths.artworkDir, albumKey: UNPLUGGED, imagePath: src, source: 'jake-pick', matte: '#abcdef', now: 5 })
    const kept = await posterInStore(w.paths.artworkDir, UNPLUGGED, 9)
    assert.equal(kept?.hash, posterArtworkHash(UNPLUGGED))
    assert.equal(kept?.versioned, `${posterArtworkHash(UNPLUGGED)}_9`)
    assert.deepEqual(kept?.fields, { poster: posterArtworkHash(UNPLUGGED), posterSource: 'jake-pick', posterMatte: '#abcdef' })
  })
  test('an image whose edge cannot be read still lands, on the plain ground', async () => {
    const w = world()
    const src = join(w.dir, 'odd.jpg')
    writeFileSync(src, jpeg('not really decodable'))
    const got = await installPosterImage({ artworkDir: w.paths.artworkDir, albumKey: PARADISO, imagePath: src, source: 'jake-pick', now: 5 })
    assert.equal(got.fields.posterMatte, '#0B0B0A')
    assert.ok(readFileSync(posterFile(w, PARADISO)).equals(jpeg('not really decodable')))
  })
  test('the app checks before it builds', () => {
    const ipc = readFileSync(join(import.meta.dirname, '..', 'ipc', 'live-sets-ipc.ts'), 'utf-8')
    const start = ipc.indexOf("ipc.handle('ensure-concert-poster'")
    const kept = ipc.indexOf('posterInStore(dir, albumKey)', start)
    const render = ipc.indexOf('renderPosterForShow(', start)
    assert.ok(kept > start && kept < render)
  })
})
