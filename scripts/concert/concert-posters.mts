// The poster rule's headless tools (src/common/concert-poster.ts). No app involved.
//
//   node --experimental-strip-types scripts/concert/concert-posters.mts <command> ...
//
// migrate   The 13 shows declared before the rule. Dry run by default: it prints
//           exactly what --apply would do, and leaves the cover candidates and the
//           built posters in --review-dir for a person to look at. --apply uses those
//           files, backs up first, and is safe to run twice. Quit JakeTunes before
//           --apply: the running app holds live-sets.json and the artwork index in
//           memory and would write its old copy back over the result.
//
//             migrate --review-dir <dir>            # dry run against this Mac's store
//             migrate --review-dir <dir> --apply    # do it
//             migrate --restore <backup-dir>        # undo a run
//
//           Read-only rehearsal against copies:
//             migrate --review-dir <dir> --live-sets <file> --images <dir>
//                     [--index <file>] [--locks <file>] [--library <file>]
//
//           Where the songs' own art is read from: --audio-ssh user@host:/root
//           (default homemini's local copy) or --audio-root <dir>. --no-web skips the
//           cover search.
//
// build     One show's built poster, for a show declared headlessly (the merge-concert
//           recipe). The app does this itself at declare time. Dry run by default: it
//           renders to --out and prints the words.
//
//             build --album-key "<artist|||album>" --out <file.jpg>
//             build --album-key "<artist|||album>" --apply [--rebuild]
//
//           --rebuild redraws a built poster whose words have changed. It never touches
//           a real one: Jake's pick, always.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { declaredConcerts } from '../../src/common/concert-meta.ts'
import { builtPosterSpec, posterWords, type PosterFacts } from '../../src/common/concert-poster.ts'
import { coverFileName, installPosterImage, renderPosterForShow, withPosterKeys } from '../../src/main/concert-poster.ts'
import { imageSize, imageToJpeg, readEdgeMatte } from '../../src/main/concert-poster-render.ts'
import { findCoverOnline, type FetchLike } from '../../src/main/album-cover-lookup.ts'
import {
  applyPlan, describePlan, embeddedArtReader, makePlan, planIsEmpty, restoreBackup, slugOfShow,
  type AudioSource, type MigratePaths, type MigrateTools,
} from '../../src/main/concert-poster-migrate.ts'

const argv = process.argv.slice(2)
const command = argv.shift()
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)

const REPO = resolve(import.meta.dirname, '../..')
const FONT = join(REPO, 'src/renderer/assets/fonts/pixChicago.ttf')
const RUSH = join(REPO, 'scripts/concert/assets/rush-massey-hall-june.jpg')
const APP_DIR = flag('app-dir') ?? join(homedir(), 'Library/Application Support/JakeTunes')
const ARTWORK_DIR = flag('artwork-dir') ?? join(APP_DIR, 'artwork')

function appIsRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', 'JakeTunes'], { stdio: 'ignore' })
    return true
  } catch { return false }
}

/** A rehearsal on a scratch --app-dir holds nothing the running app would write back. */
function refuseWhileAppRuns(): void {
  if (resolve(APP_DIR) !== resolve(homedir(), 'Library/Application Support/JakeTunes') || !appIsRunning()) return
  console.error('JakeTunes is running on this Mac. It holds live-sets.json and the artwork index in memory and would write them back over this. Quit it first (when nothing is playing), then run this again.')
  process.exit(3)
}

function audioSource(): AudioSource {
  const root = flag('audio-root')
  if (root) return { kind: 'local', root }
  const spec = flag('audio-ssh') ?? 'jakerosenbaumnas@homemini:/Users/jakerosenbaumnas/Music/JakeTunesLibrary'
  const at = spec.indexOf(':')
  return { kind: 'ssh', target: spec.slice(0, at), root: spec.slice(at + 1) }
}

function tools(dryRun: boolean): MigrateTools {
  const t: MigrateTools = {
    now: () => Date.now(),
    readMatte: readEdgeMatte,
    imageSize,
    toJpeg: imageToJpeg,
    renderBuilt: (facts: PosterFacts, coverPath, outPath, fontPath) => renderPosterForShow({ facts, coverPath, outPath, fontPath }),
  }
  if (dryRun) {
    t.embeddedArt = embeddedArtReader(audioSource())
    if (!has('no-web')) t.findOnline = (artist, album) => findCoverOnline(artist, album, fetch as unknown as FetchLike, (m) => console.error(`  (web) ${m}`))
  }
  return t
}

async function migrate(): Promise<void> {
  const restore = flag('restore')
  if (restore) {
    refuseWhileAppRuns()
    await restoreBackup(resolve(restore), (l) => console.log(l))
    console.log('Restored. To put homemini back too: bash ~/bin/jaketunes-homemini-sync.sh --homemini-only')
    return
  }
  const reviewDir = flag('review-dir')
  if (!reviewDir) throw new Error('--review-dir <dir> is required: the cover candidates and built posters go there')
  const doApply = has('apply')
  const paths: MigratePaths = {
    liveSets: flag('live-sets') ?? join(APP_DIR, 'live-sets.json'),
    artworkDir: ARTWORK_DIR,
    imagesDir: flag('images'),
    index: flag('index') ?? join(ARTWORK_DIR, 'index.json'),
    locks: flag('locks') ?? join(ARTWORK_DIR, 'user-locked.json'),
    library: flag('library') ?? join(APP_DIR, 'library.json'),
    reviewDir: resolve(reviewDir),
    rushFile: flag('rush-file') ?? RUSH,
    fontPath: FONT,
    backupRoot: join(APP_DIR, 'backups'),
  }
  if (doApply && (paths.imagesDir || flag('live-sets') || flag('index') || flag('locks'))) throw new Error('--apply works on the real store only: drop --images/--live-sets/--index/--locks')
  if (doApply) refuseWhileAppRuns()

  console.log(doApply ? 'Concert posters: APPLYING.' : 'Concert posters: DRY RUN. Nothing is written outside the review folder.')
  console.log(`  live-sets  ${paths.liveSets}`)
  console.log(`  store      ${paths.artworkDir}${paths.imagesDir ? ` (images read from ${paths.imagesDir})` : ''}`)
  console.log(`  index      ${paths.index}`)
  console.log(`  library    ${paths.library}`)
  console.log(`  review     ${paths.reviewDir}\n`)
  await mkdir(paths.reviewDir, { recursive: true })

  const plan = await makePlan(paths, tools(!doApply), { dryRun: !doApply })
  console.log(describePlan(plan))
  if (!doApply) {
    console.log(`\nWould back up first: live-sets.json, artwork/index.json, artwork/user-locked.json, and every file above it replaces, into ${join(paths.backupRoot, 'concert-posters-<time>')}.`)
    console.log(`Look through ${paths.reviewDir} before --apply. Delete a bad cover candidate and that album is left alone; put your own JPEG in its place and that one is used.`)
    return
  }
  if (planIsEmpty(plan)) {
    console.log('\nNothing to do: no file was touched and no backup was made.')
    return
  }
  const result = await applyPlan(plan, paths, (l) => console.log(l))
  const again = await makePlan(paths, tools(false), { dryRun: false })
  if (!planIsEmpty(again)) throw new Error('a second plan right after applying still has work in it: look at the store before going on\n' + describePlan(again))
  console.log(`\nDone: ${result.changed} steps. A second plan finds nothing left to do.`)
  console.log(`Undo: node --experimental-strip-types scripts/concert/concert-posters.mts migrate --restore "${result.backupDir}"`)
  console.log('\nNow get it to homemini, artwork first (this needs ssh over Tailscale, not the home network and not the NAS share):')
  console.log('  bash ~/bin/jaketunes-homemini-sync.sh --homemini-only')
  console.log('Then check the phone\'s view: curl -s http://homemini:3000/api/live-sets | python3 -c "import json,sys; [print(c[\'artworkHash\'], c.get(\'posterSource\'), c.get(\'posterMatte\'), c[\'title\']) for c in json.load(sys.stdin)[\'items\']]"')
}

async function build(): Promise<void> {
  const albumKey = flag('album-key')
  if (!albumKey) throw new Error('--album-key "<artist|||album>" is required')
  const sets = JSON.parse(await readFile(join(APP_DIR, 'live-sets.json'), 'utf-8')) as Record<string, Parameters<typeof declaredConcerts>[0][string] & { concert?: Record<string, unknown> & { posterSource?: string; poster?: string } }>
  const library = JSON.parse(await readFile(join(APP_DIR, 'library.json'), 'utf-8')) as { tracks?: Array<{ id: number; artist?: string; album?: string; year?: number | string }> }
  const rows = new Map((library.tracks ?? []).map((t) => [Number(t.id), t] as const))
  const concert = declaredConcerts(sets, (id) => rows.get(id)).find((c) => c.albumKey === albumKey)
  if (!concert) throw new Error(`no declared concert under "${albumKey}"`)
  const block = sets[albumKey]!.concert
  if (block?.poster && block.posterSource !== 'built') throw new Error(`this show has a real poster (${block.posterSource ?? 'source unrecorded'}): Jake's pick, always. Nothing was done.`)
  if (block?.poster && !has('rebuild')) throw new Error('this show already has its built poster: pass --rebuild to redraw it')

  const facts: PosterFacts = { band: concert.band, show: concert.show, venue: concert.venue, city: concert.city, date: concert.date, year: concert.year || undefined }
  const index = JSON.parse(await readFile(join(ARTWORK_DIR, 'index.json'), 'utf-8').catch(() => '{}')) as Record<string, string>
  const coverName = coverFileName(index[albumKey])
  const coverPath = coverName ? join(ARTWORK_DIR, coverName) : null
  const hasCover = coverPath ? await stat(coverPath).then((s) => s.size > 0, () => false) : false
  const words = builtPosterSpec(posterWords(facts))
  console.log(`${concert.band} / ${concert.show}\n  prints: "${words.band.text}" / "${words.lines.title}" / "${words.lines.details.join(' · ')}"\n  cover: ${hasCover ? coverPath : 'none'}`)

  const doApply = has('apply')
  const out = flag('out') ?? join(tmpdir(), `concert-poster-${process.pid}-${slugOfShow(albumKey)}.jpg`)
  await renderPosterForShow({ facts, coverPath: hasCover ? coverPath : null, outPath: out, fontPath: FONT })
  if (!doApply) {
    console.log(`Dry run: rendered to ${out}. Nothing else was written. Add --apply to install it.`)
    return
  }
  refuseWhileAppRuns()
  const installed = await installPosterImage({ artworkDir: ARTWORK_DIR, albumKey, imagePath: out, source: 'built' })
  await writeAtomicJson(join(ARTWORK_DIR, 'index.json'), withPosterKeys(index, installed))
  sets[albumKey] = { ...sets[albumKey]!, concert: { ...block, ...installed.fields } }
  await writeAtomicJson(join(APP_DIR, 'live-sets.json'), sets)
  if (!flag('out')) await rm(out, { force: true })
  console.log(`Installed ${installed.hash}.jpg as "${installed.key}". Push it with: bash ~/bin/jaketunes-homemini-sync.sh --homemini-only`)
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const { rename } = await import('node:fs/promises')
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await rename(tmp, path)
}

try {
  if (command === 'migrate') await migrate()
  else if (command === 'build') await build()
  else {
    console.error('usage: concert-posters.mts migrate|build ... (see the top of this file)')
    process.exit(2)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
