/**
 * The poster rule's one-time migration for the 13 shows declared before it
 * (2026-11-06). scripts/concert/concert-posters.mts is its command line.
 *
 * What it does, per show:
 *   - moves the poster onto its OWN artwork key (`concert poster|||…`), with its
 *     source and matte in the show's concert block;
 *   - builds a poster for the three shows that only had a square cover;
 *   - installs the corrected Rush poster (JUNE 11-13, 1976);
 *   - gives the album's key its own cover back, and unlocks it.
 *
 * How it stays safe:
 *   - A plan is made first, and the dry run prints exactly that plan. --apply walks
 *     the same plan. Cover bytes and built posters land in a review folder during
 *     the dry run and --apply uses those files: it never touches the network, so
 *     what a person looked at is what lands. Delete a bad candidate from the folder
 *     and that album is left alone.
 *   - Everything it will overwrite is copied to a backup folder and checked by
 *     sha256 before the first write.
 *   - Identity, not names (the Code Hygiene rule): the album's key is only
 *     overwritten while its file is byte-identical to the show's poster, or is the
 *     pinned July Rush image. A second run finds nothing left to do and writes
 *     nothing. A run that stops part-way leaves a marker beside the backups, and
 *     the next run finishes exactly what it left (unlock, backup copy, index) and
 *     keeps the first run's backup, which is the one that undoes everything.
 *
 * Electron-free: every path and every tool is passed in, so the tests run against a
 * scratch store and need no ffmpeg, no osascript and no network.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { declaredConcerts } from '../common/concert-meta.ts'
import {
  isMatteColour, isPosterSource, mergedAlbumArtworkKey, posterArtworkKey, POSTER_GROUND,
  builtPosterSpec, posterWords, type PosterFacts, type PosterSource,
} from '../common/concert-poster.ts'
import { fetchedArtworkSidecar, type ArtworkFetchProvider } from './artwork-provenance.ts'
import { installPosterImage, md5Hex } from './concert-poster.ts'
import { isJpegBytes } from './concert-poster-render.ts'

// ── Which show gets what (the Posters mock Jake approved) ───────────────

export type ShowRule = { source: PosterSource; from: 'album-key' | 'rush-file' | 'built' }

export const SHOW_RULES: Readonly<Record<string, ShowRule>> = {
  // Real posters: gig posters, and film one-sheets where the recording is that film.
  'geese|||getting killed again (live at forest hills, new york, oct 3rd, 2026)': { source: 'gig-poster', from: 'album-key' },
  'grateful dead|||go to nassau: may 15 & 16, 1980': { source: 'gig-poster', from: 'album-key' },
  'talking heads|||stop making sense': { source: 'film-one-sheet', from: 'album-key' },
  'led zeppelin|||the song remains the same [live]': { source: 'film-one-sheet', from: 'album-key' },
  // Jake's picks from September: all six stay.
  'the postal service|||everything will change (live)': { source: 'jake-pick', from: 'album-key' },
  'paul mccartney|||good evening new york city (live at citi field, nyc, 2009)': { source: 'jake-pick', from: 'album-key' },
  'daft punk|||alive 2007': { source: 'jake-pick', from: 'album-key' },
  "nirvana|||amsterdam '91 - come as you are [live]": { source: 'jake-pick', from: 'album-key' },
  'nirvana|||mtv unplugged in new york': { source: 'jake-pick', from: 'album-key' },
  "rush|||all the world's a stage [live]": { source: 'jake-pick', from: 'rush-file' },
  // No poster found: built once.
  'cameron winter|||live at carnegie hall': { source: 'built', from: 'built' },
  'geese|||alive & in person': { source: 'built', from: 'built' },
  'queens of the stone age|||alive in the catacombs': { source: 'built', from: 'built' },
}

/** Jake's pick as it was: it prints JULY 11-13, 1976. The shows were June 11-13. */
export const RUSH_JULY_SHA256 = 'd6c00a98ef8d420b6d6da265ded8af3a9d26c451c254658faaf8f1bd70b076e4'
/** scripts/concert/assets/rush-massey-hall-june.jpg: the same art, reading JUNE. */
export const RUSH_JUNE_SHA256 = 'b218a7e17d418b75f6e5c597884026a3b502957f43b247e587722f4ed89c9b27'

// ── What a plan is made of ──────────────────────────────────────────────

export interface MigratePaths {
  liveSets: string
  /** The store: `<hash>.jpg`, `<hash>.meta.json`, locked-backup/. */
  artworkDir: string
  /** A read-only copy of the images named `<anything>-<hash>.jpg`. Dry run only. */
  imagesDir?: string
  index: string
  locks: string
  library: string
  /** The dry run's output: covers/ and built/. --apply reads it. */
  reviewDir: string
  rushFile: string
  fontPath: string | null
  /** Where --apply makes its backup folder. */
  backupRoot: string
}

/** Stands from the moment the backup is proven until the last write is done. */
const markerPath = (paths: MigratePaths): string => join(paths.backupRoot, 'concert-posters.in-progress.json')
const readMarker = (paths: MigratePaths): Promise<{ backupDir: string } | null> =>
  readJson<{ backupDir: string } | null>(markerPath(paths), null)

export interface MigrateTools {
  now: () => number
  readMatte: (imagePath: string) => Promise<string>
  imageSize: (imagePath: string) => Promise<{ w: number; h: number } | null>
  renderBuilt: (facts: PosterFacts, coverPath: string | null, outPath: string, fontPath: string | null) => Promise<unknown>
  /** Any image → a JPEG at dest (sips, for the odd PNG). */
  toJpeg: (src: string, dest: string) => Promise<void>
  /** Dry run only: the cover in a file's own tags, or null. */
  embeddedArt?: (colonPath: string) => Promise<Buffer | null>
  /** Dry run only: the cover on the web, or null. */
  findOnline?: (artist: string, album: string) => Promise<{ candidate: { provider: ArtworkFetchProvider; url: string; matched: string }; bytes: Buffer } | null>
}

export type PlanAction =
  | { do: 'poster-copy'; src: string; dest: string; sha256: string; bytes: number; size: string; matte: string; source: PosterSource }
  | { do: 'poster-file'; src: string; dest: string; sha256: string; bytes: number; size: string; matte: string; source: PosterSource }
  | { do: 'poster-built'; src: string; dest: string; fromCover: string | null; lines: string[]; matte: string }
  | { do: 'cover-restore'; src: string; dest: string; sha256: string; bytes: number; size: string; provider: 'embedded' | ArtworkFetchProvider; url?: string; matched?: string; trackId?: number }
  | { do: 'cover-missing'; dest: string; why: string }
  | { do: 'unlock'; key: string }
  | { do: 'drop-backup-copy'; path: string }
  | { do: 'index'; key: string; value: string }
  | { do: 'concert'; fields: { poster: string; posterSource: string; posterMatte: string } }

export interface ShowPlan {
  albumKey: string
  band: string
  show: string
  rule: ShowRule | null
  actions: PlanAction[]
  /** Said out loud but not an action: why a show was left alone. */
  notes: string[]
}

export interface Plan {
  shows: ShowPlan[]
  now: number
}

type LiveSets = Record<string, {
  mergedTrackId: number
  cues: Array<{ trackId: number; title?: string; artist?: string }>
  promotedTrackIds?: number[]
  concert?: Record<string, unknown> & { poster?: string; posterSource?: string; posterMatte?: string; venue?: string; city?: string; date?: string }
}>
type Row = { id: number; path?: string; artist?: string; album?: string; year?: number | string }

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const sha256File = async (p: string): Promise<string> => sha256(await readFile(p))
const exists = async (p: string): Promise<boolean> => stat(p).then((s) => s.size > 0, () => false)
const short = (hash: string): string => hash.slice(0, 8)

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf-8')) as T } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback
    throw new Error(`${path}: ${err instanceof Error ? err.message : err}`)
  }
}

export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export function slugOfShow(albumKey: string): string {
  return albumKey.replace('|||', '-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}

async function imageIn(paths: MigratePaths, bare: string): Promise<string | null> {
  if (paths.imagesDir) {
    const name = (await readdir(paths.imagesDir)).find((n) => n.endsWith(`-${bare}.jpg`))
    if (name) return join(paths.imagesDir, name)
  }
  const inStore = join(paths.artworkDir, `${bare}.jpg`)
  return (await exists(inStore)) ? inStore : null
}

/** A cover candidate as this album's review file: the dry run's output, --apply's input. */
const coverReviewPath = (paths: MigratePaths, albumBare: string): string => join(paths.reviewDir, 'covers', `${albumBare}.jpg`)
const coverReviewInfo = (paths: MigratePaths, albumBare: string): string => join(paths.reviewDir, 'covers', `${albumBare}.json`)
const builtReviewPath = (paths: MigratePaths, albumKey: string): string => join(paths.reviewDir, 'built', `${slugOfShow(albumKey)}.jpg`)

interface CoverInfo { provider: 'embedded' | ArtworkFetchProvider; url?: string; matched?: string; trackId?: number }

/** Find this album's own cover and leave it in the review folder. */
async function findCover(
  paths: MigratePaths, tools: MigrateTools, entry: LiveSets[string], rows: Map<number, Row>, band: string, show: string, albumBare: string,
): Promise<void> {
  const dest = coverReviewPath(paths, albumBare)
  await mkdir(dirname(dest), { recursive: true })
  let bytes: Buffer | null = null
  let info: CoverInfo | null = null
  // The files first. Art is album-wide (the 2026-10-12 census asked one track per
  // album), so the first three songs answer for the album.
  if (tools.embeddedArt) {
    for (const cue of entry.cues.slice(0, 3)) {
      const path = rows.get(cue.trackId)?.path
      if (!path) continue
      const art = await tools.embeddedArt(path).catch(() => null)
      if (art && art.length > 0) { bytes = art; info = { provider: 'embedded', trackId: cue.trackId }; break }
    }
  }
  if (!bytes && tools.findOnline) {
    const hit = await tools.findOnline(band, show)
    if (hit) { bytes = hit.bytes; info = { provider: hit.candidate.provider, url: hit.candidate.url, matched: hit.candidate.matched } }
  }
  if (!bytes || !info) return
  if (isJpegBytes(bytes)) await writeAtomic(dest, bytes)
  else {
    const raw = `${dest}.raw`
    await writeFile(raw, bytes)
    try { await tools.toJpeg(raw, dest) } finally { await rm(raw, { force: true }) }
  }
  await writeAtomic(coverReviewInfo(paths, albumBare), JSON.stringify(info, null, 2))
}

// ── The plan ────────────────────────────────────────────────────────────

/**
 * Work out everything that would change. Writes only inside the review folder, and
 * only in the dry run (`tools.embeddedArt` / `findOnline` given): --apply plans again
 * from the same store and the same review files.
 */
export async function makePlan(paths: MigratePaths, tools: MigrateTools, opts: { dryRun: boolean; rushPins?: { july: string; june: string } }): Promise<Plan> {
  const now = tools.now()
  const pins = opts.rushPins ?? { july: RUSH_JULY_SHA256, june: RUSH_JUNE_SHA256 }
  const sets = await readJson<LiveSets>(paths.liveSets, {})
  const index = await readJson<Record<string, string>>(paths.index, {})
  const locks = new Set(await readJson<string[]>(paths.locks, []))
  const library = await readJson<{ tracks?: Row[] }>(paths.library, {})
  const rows = new Map((library.tracks ?? []).map((t) => [Number(t.id), t] as const))
  const resuming = (await readMarker(paths)) !== null
  const concerts = new Map(declaredConcerts(sets, (id) => rows.get(id)).map((c) => [c.albumKey, c] as const))
  const shows: ShowPlan[] = []

  for (const [albumKey, entry] of Object.entries(sets)) {
    const concert = concerts.get(albumKey)
    const band = concert?.band ?? entry.cues[0]?.artist ?? albumKey.split('|||')[0] ?? ''
    const show = concert?.show ?? albumKey.split('|||')[1] ?? ''
    const rule = SHOW_RULES[albumKey] ?? null
    const plan: ShowPlan = { albumKey, band, show, rule, actions: [], notes: [] }
    shows.push(plan)
    if (!rule) { plan.notes.push('not one of the 13: a show declared since the rule gets its poster at declare time'); continue }

    const posterKey = posterArtworkKey(albumKey)
    const posterHash = md5Hex(posterKey)
    const aliasKey = mergedAlbumArtworkKey(albumKey)
    const albumBare = (index[albumKey] ?? md5Hex(albumKey)).replace(/_\d+$/, '')
    const albumFile = await imageIn(paths, albumBare)
    const posterStoreFile = join(paths.artworkDir, `${posterHash}.jpg`)
    const posterThere = await exists(posterStoreFile)
    const concertBlock = entry.concert ?? {}

    if (concertBlock.poster && concertBlock.poster !== posterHash) {
      plan.notes.push(`left alone: concert.poster already names another image (${concertBlock.poster})`)
      continue
    }

    // 1. The poster's bytes, under its own key.
    let matte = isMatteColour(concertBlock.posterMatte) ? concertBlock.posterMatte : null
    if (!posterThere) {
      if (rule.from === 'album-key') {
        if (!albumFile) { plan.notes.push(`left alone: no image for the album key (${albumBare}.jpg)`); continue }
        const bytes = await readFile(albumFile)
        matte = await tools.readMatte(albumFile)
        const size = await tools.imageSize(albumFile)
        plan.actions.push({
          do: 'poster-copy', src: albumFile, dest: posterStoreFile, sha256: sha256(bytes), bytes: bytes.length,
          size: size ? `${size.w}x${size.h}` : '?', matte, source: rule.source,
        })
      } else if (rule.from === 'rush-file') {
        const fileSha = await sha256File(paths.rushFile).catch(() => '')
        if (fileSha !== pins.june) { plan.notes.push(`left alone: ${paths.rushFile} is not the corrected poster (sha256 ${short(fileSha) || 'unreadable'})`); continue }
        const held = albumFile ? await sha256File(albumFile) : ''
        if (held !== pins.july) { plan.notes.push(`left alone: the album key does not hold the July poster (sha256 ${short(held) || 'none'}), so someone has changed it: this one is a person's call`); continue }
        const bytes = await readFile(paths.rushFile)
        matte = await tools.readMatte(paths.rushFile)
        const size = await tools.imageSize(paths.rushFile)
        plan.actions.push({
          do: 'poster-file', src: paths.rushFile, dest: posterStoreFile, sha256: fileSha, bytes: bytes.length,
          size: size ? `${size.w}x${size.h}` : '?', matte, source: rule.source,
        })
      } else {
        const out = builtReviewPath(paths, albumKey)
        const facts: PosterFacts = {
          band, show, venue: concert?.venue ?? concertBlock.venue, city: concert?.city ?? concertBlock.city,
          date: concert?.date ?? concertBlock.date, year: concert?.year || undefined,
        }
        if (opts.dryRun || !(await exists(out))) {
          await mkdir(dirname(out), { recursive: true })
          await tools.renderBuilt(facts, albumFile, out, paths.fontPath)
        }
        matte = POSTER_GROUND
        const spec = builtPosterSpec(posterWords(facts))
        plan.actions.push({
          do: 'poster-built', src: out, dest: posterStoreFile, fromCover: albumFile ? basename(albumFile) : null,
          lines: [spec.band.text, spec.lines.title, spec.lines.details.join(' · ')], matte,
        })
      }
    } else if (!matte) {
      matte = rule.from === 'built' ? POSTER_GROUND : await tools.readMatte(posterStoreFile)
    }

    // 2. The album's key gets its own cover back, only while it still holds the poster.
    if (rule.from !== 'built' && albumFile) {
      const held = await sha256File(albumFile)
      let holdsPoster: boolean
      if (rule.from === 'rush-file') holdsPoster = held === pins.july
      else if (posterThere) holdsPoster = held === (await sha256File(posterStoreFile))
      else holdsPoster = true
      const albumDest = join(paths.artworkDir, `${albumBare}.jpg`)
      const review = coverReviewPath(paths, albumBare)
      const backupCopy = join(paths.artworkDir, 'locked-backup', `${albumBare}.jpg`)
      // A run that stopped part-way: the cover is back, what goes with it may not be.
      // Only with the marker standing, so a finished migration never unlocks a lock
      // Jake made afterwards.
      const coverLanded = !holdsPoster && resuming && (await exists(review)) && held === (await sha256File(review))
      if (holdsPoster) {
        // A file already in the review folder stands: it may be a person's own choice.
        if (opts.dryRun && !(await exists(review))) await findCover(paths, tools, entry, rows, band, show, albumBare)
      }
      if ((holdsPoster || coverLanded) && (await exists(review))) {
        const said = coverLanded ? await readJson<{ key?: string; importedAt?: string } | null>(albumDest.replace(/\.jpg$/, '.meta.json'), null) : null
        const saidAt = said?.key === albumKey && said.importedAt ? Date.parse(said.importedAt) : Number.NaN
        if (!Number.isFinite(saidAt)) {
          const bytes = await readFile(review)
          const size = await tools.imageSize(review)
          const info = await readJson<CoverInfo>(coverReviewInfo(paths, albumBare), { provider: 'embedded' })
          plan.actions.push({ do: 'cover-restore', src: review, dest: albumDest, sha256: sha256(bytes), bytes: bytes.length, size: size ? `${size.w}x${size.h}` : '?', ...info })
        }
        if (locks.has(albumKey)) plan.actions.push({ do: 'unlock', key: albumKey })
        if (await exists(backupCopy)) plan.actions.push({ do: 'drop-backup-copy', path: backupCopy })
        // The same stamp the cover's sidecar carries, so finishing a run is one answer.
        const value = `${albumBare}_${Number.isFinite(saidAt) ? saidAt : now}`
        if (index[albumKey] !== value) plan.actions.push({ do: 'index', key: albumKey, value })
      } else if (holdsPoster) {
        plan.actions.push({
          do: 'cover-missing', dest: albumDest,
          why: `no cover in the files or on the web. The album key keeps today's image${entry.promotedTrackIds?.length ? ' and this album IS visible (promoted songs): look at it' : ': the album is hidden by its concert, so nothing draws it'}`,
        })
      }
    }

    // 3. The index: the poster's key, and the merged row's key pointing at it.
    const pointsAtPoster = (k: string): boolean => (index[k] ?? '').replace(/_\d+$/, '') === posterHash
    if (!pointsAtPoster(posterKey)) plan.actions.push({ do: 'index', key: posterKey, value: `${posterHash}_${now}` })
    if (!pointsAtPoster(aliasKey)) plan.actions.push({ do: 'index', key: aliasKey, value: `${posterHash}_${now}` })

    // 4. The show's concert block. Written last by --apply.
    const fieldsDone = concertBlock.poster === posterHash && isPosterSource(concertBlock.posterSource) && isMatteColour(concertBlock.posterMatte)
    if (!fieldsDone) {
      plan.actions.push({ do: 'concert', fields: { poster: posterHash, posterSource: isPosterSource(concertBlock.posterSource) ? concertBlock.posterSource : rule.source, posterMatte: matte ?? POSTER_GROUND } })
    }
  }
  return { shows, now }
}

// ── Saying it out loud ──────────────────────────────────────────────────

export function describeAction(a: PlanAction): string {
  switch (a.do) {
    case 'poster-copy':
      return `poster   copy ${basename(a.src)} (${a.size}, ${a.bytes} B, sha256 ${short(a.sha256)}) to ${basename(a.dest)}: source ${a.source}, matte ${a.matte}`
    case 'poster-file':
      return `poster   install ${basename(a.src)} (${a.size}, ${a.bytes} B, sha256 ${short(a.sha256)}) as ${basename(a.dest)}: source ${a.source}, matte ${a.matte}`
    case 'poster-built':
      return `poster   build ${basename(a.dest)} from ${a.fromCover ?? 'no cover'}: "${a.lines.join('" / "')}", source built, matte ${a.matte} [${a.src}]`
    case 'cover-restore': {
      const from = a.provider === 'embedded' ? `the file's embedded art (track ${a.trackId})` : `${a.provider} "${a.matched}" ${a.url}`
      return `cover    ${basename(a.dest)} gets the album's own cover from ${from} (${a.size}, ${a.bytes} B, sha256 ${short(a.sha256)}) [${a.src}]`
    }
    case 'cover-missing':
      return `cover    ${basename(a.dest)}: ${a.why}`
    case 'unlock':
      return `unlock   "${a.key}" (the poster drop locked it)`
    case 'drop-backup-copy':
      return `locked   remove ${basename(dirname(a.path))}/${basename(a.path)}: it holds the poster and would re-lock the album on the next launch (kept in this run's backup)`
    case 'index':
      return `index    "${a.key}" -> ${a.value}`
    case 'concert':
      return `concert  poster=${a.fields.poster} posterSource=${a.fields.posterSource} posterMatte=${a.fields.posterMatte}`
  }
}

export function describePlan(plan: Plan): string {
  const out: string[] = []
  for (const s of plan.shows) {
    out.push(`${s.albumKey}`)
    out.push(`  ${s.band} / ${s.show}`)
    for (const n of s.notes) out.push(`  note     ${n}`)
    for (const a of s.actions) out.push(`  ${describeAction(a)}`)
    if (!s.notes.length && !s.actions.length) out.push('  done     nothing to do')
    out.push('')
  }
  const all = plan.shows.flatMap((s) => s.actions)
  const n = (d: PlanAction['do']): number => all.filter((a) => a.do === d).length
  const restored = all.filter((a): a is Extract<PlanAction, { do: 'cover-restore' }> => a.do === 'cover-restore')
  out.push(`Summary: ${plan.shows.length} shows. Posters: ${n('poster-copy')} moved onto their own key, ${n('poster-built')} built, ${n('poster-file')} corrected file. ` +
    `Album covers: ${restored.length} put back (${restored.filter((a) => a.provider === 'embedded').length} from the files, ${restored.filter((a) => a.provider !== 'embedded').length} from the web), ${n('cover-missing')} with no cover found. ` +
    `Writes: ${n('index')} index lines, ${n('unlock')} unlocks, ${n('concert')} concert blocks.`)
  return out.join('\n')
}

export const planIsEmpty = (plan: Plan): boolean =>
  plan.shows.every((s) => s.actions.every((a) => a.do === 'cover-missing'))

// ── Applying it ─────────────────────────────────────────────────────────

export type ApplyStage = 'posters' | 'covers' | 'index' | 'locks' | 'live-sets'

export interface ApplyResult {
  backupDir: string | null
  changed: number
}

/** Copy `file` into the backup at its name, and prove the copy by sha256. */
async function backUp(file: string, into: string, seen: Map<string, string>): Promise<void> {
  if (seen.has(file) || !(await exists(file))) return
  const name = `${String(seen.size).padStart(3, '0')}-${basename(file)}`
  const dest = join(into, name)
  await copyFile(file, dest)
  const [a, b] = await Promise.all([sha256File(file), sha256File(dest)])
  if (a !== b) throw new Error(`backup of ${file} does not match it: stopping before any write`)
  seen.set(file, name)
}

async function backUpEverything(plan: Plan, paths: MigratePaths, work: PlanAction[], log: (line: string) => void): Promise<string> {
  const stamp = new Date(plan.now).toISOString().replace(/[:.]/g, '-')
  const backupDir = join(paths.backupRoot, `concert-posters-${stamp}`)
  await mkdir(backupDir, { recursive: true })
  const saved = new Map<string, string>()
  const created: string[] = []
  await backUp(paths.liveSets, backupDir, saved)
  await backUp(paths.index, backupDir, saved)
  await backUp(paths.locks, backupDir, saved)
  for (const a of work) {
    if (a.do === 'cover-restore') {
      await backUp(a.dest, backupDir, saved)
      await backUp(a.dest.replace(/\.jpg$/, '.meta.json'), backupDir, saved)
    } else if (a.do === 'drop-backup-copy') {
      await backUp(a.path, backupDir, saved)
    } else if (a.do === 'poster-copy' || a.do === 'poster-file' || a.do === 'poster-built') {
      created.push(a.dest, a.dest.replace(/\.jpg$/, '.meta.json'), join(dirname(a.dest), 'locked-backup', basename(a.dest)))
    }
  }
  const manifest = { made: new Date(plan.now).toISOString(), files: [...saved].map(([path, name]) => ({ path, name })), created }
  await writeAtomic(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  log(`Backed up ${saved.size} files to ${backupDir} (checked by sha256).`)
  return backupDir
}

/**
 * Do what the plan says. Back up first and stop if the backup does not check out.
 * Posters land before any album key is touched, so a poster's bytes are never in
 * one place only; live-sets.json goes last, and each step is safe to repeat.
 */
export async function applyPlan(
  plan: Plan, paths: MigratePaths, log: (line: string) => void = () => {},
  /** Tests stop a run here, the way a crash or a locked file would. */
  stage: (name: ApplyStage) => void | Promise<void> = () => {},
): Promise<ApplyResult> {
  if (paths.imagesDir) throw new Error('--apply needs the real store, not a copy of the images')
  const actions = plan.shows.flatMap((s) => s.actions.map((a) => ({ a, albumKey: s.albumKey, band: s.band, show: s.show })))
  const work = actions.filter(({ a }) => a.do !== 'cover-missing')
  const marker = await readMarker(paths)
  if (work.length === 0) {
    await rm(markerPath(paths), { force: true })
    return { backupDir: marker?.backupDir ?? null, changed: 0 }
  }

  let backupDir: string
  if (marker) {
    // The first run's backup holds the store as it was. One taken now would hold the
    // half-finished store, and undoing to that is no undo.
    backupDir = marker.backupDir
    log(`An earlier run stopped part-way: finishing it. Its backup stays the one to undo with: ${backupDir}`)
  } else {
    backupDir = await backUpEverything(plan, paths, work.map(({ a }) => a), log)
    await mkdir(paths.backupRoot, { recursive: true })
    await writeAtomic(markerPath(paths), JSON.stringify({ backupDir }, null, 2))
  }
  // Posters first: the bytes are under their own key before any album key changes.
  for (const { a, albumKey } of work) {
    if (a.do === 'poster-copy' || a.do === 'poster-file' || a.do === 'poster-built') {
      const source = a.do === 'poster-built' ? 'built' : a.source
      await installPosterImage({ artworkDir: paths.artworkDir, albumKey, imagePath: a.src, source, now: plan.now, matte: a.matte })
      if (a.do !== 'poster-built' && (await sha256File(a.dest)) !== a.sha256) throw new Error(`${a.dest} does not match its source: stopping before any album key is touched`)
      log(`wrote ${basename(a.dest)}`)
    }
  }
  await stage('posters')
  // Album keys: the album's own cover, and what says where it came from.
  for (const { a, albumKey, band, show } of work) {
    if (a.do === 'cover-restore') {
      if ((await sha256File(a.src)) !== a.sha256) throw new Error(`${a.src} changed since the plan was made`)
      await writeAtomic(a.dest, await readFile(a.src))
      const sidecar = a.provider === 'embedded'
        ? { artist: band.trim(), album: show.trim(), key: albumKey, source: 'embedded', bytes: a.bytes, importedAt: new Date(plan.now).toISOString() }
        : { ...fetchedArtworkSidecar(band, show, a.provider, a.url ?? '', a.bytes, new Date(plan.now)), key: albumKey }
      await writeAtomic(a.dest.replace(/\.jpg$/, '.meta.json'), JSON.stringify(sidecar, null, 2))
      log(`wrote ${basename(a.dest)}`)
    } else if (a.do === 'drop-backup-copy') {
      await rm(a.path, { force: true })
    }
  }
  await stage('covers')
  // Index + locks.
  const index = await readJson<Record<string, string>>(paths.index, {})
  let touchedIndex = false
  for (const { a } of work) if (a.do === 'index') { index[a.key] = a.value; touchedIndex = true }
  if (touchedIndex) await writeAtomic(paths.index, JSON.stringify(index, null, 2))
  await stage('index')
  const unlocks = work.flatMap(({ a }) => (a.do === 'unlock' ? [a.key] : []))
  if (unlocks.length) {
    const locks = new Set(await readJson<string[]>(paths.locks, []))
    for (const k of unlocks) locks.delete(k)
    await writeAtomic(paths.locks, JSON.stringify([...locks], null, 2))
  }
  await stage('locks')
  // live-sets.json last.
  const sets = await readJson<LiveSets>(paths.liveSets, {})
  let touchedSets = false
  for (const { a, albumKey } of work) {
    if (a.do === 'concert' && sets[albumKey]) {
      sets[albumKey] = { ...sets[albumKey]!, concert: { ...sets[albumKey]!.concert, ...a.fields } }
      touchedSets = true
    }
  }
  if (touchedSets) await writeAtomic(paths.liveSets, JSON.stringify(sets, null, 2))
  await stage('live-sets')
  await rm(markerPath(paths), { force: true })
  return { backupDir, changed: work.length }
}

/** Put everything back from a backup folder, and take away what the run created. */
export async function restoreBackup(backupDir: string, log: (line: string) => void = () => {}): Promise<void> {
  const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf-8')) as { files: Array<{ path: string; name: string }>; created: string[] }
  for (const f of manifest.created) await rm(f, { force: true })
  for (const f of manifest.files) {
    await mkdir(dirname(f.path), { recursive: true })
    await copyFile(join(backupDir, f.name), f.path)
    log(`restored ${f.path}`)
  }
  // Undone: there is no half-finished run left for the next one to finish.
  await rm(join(dirname(backupDir), 'concert-posters.in-progress.json'), { force: true })
}

// ── Reading a file's own art ────────────────────────────────────────────

export type AudioSource = { kind: 'ssh'; target: string; root: string } | { kind: 'local'; root: string }

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The cover in a song's own tags, read with ffmpeg where the audio is. Over ssh by
 * default: homemini's local copy needs no NAS and no hub request, so it neither
 * waits on the share nor stamps "audio went out" for the jobs that yield to playback.
 */
export function embeddedArtReader(source: AudioSource): (colonPath: string) => Promise<Buffer | null> {
  return (colonPath) => new Promise((resolve) => {
    const file = `${source.root}${colonPath.replace(/:/g, '/')}`
    const args = ['-v', 'error', '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'image2pipe', '-']
    const opts = { encoding: 'buffer' as const, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }
    const done = (err: Error | null, stdout: Buffer): void => resolve(err || stdout.length === 0 ? null : stdout)
    if (source.kind === 'ssh') {
      execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', source.target,
        `/opt/homebrew/bin/ffmpeg -v error -i ${shq(file)} -map 0:v:0 -c:v copy -f image2pipe -`], opts, done)
    } else {
      execFile('ffmpeg', args, opts, done)
    }
  })
}
