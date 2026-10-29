/**
 * iPod plays are never lost (2026-10-28).
 *
 * What happened: Jake plugged in the Original iPod mini and ran an Activity
 * Sync. It landed 1000/1000 and sealed, but `retireIpodFirmwareScratch`
 * deleted the firmware's 20 KB `Play Counts` with no copy kept, and the
 * plug-in round trip had not recorded it (the state file was last written
 * 10/17). Whether those plays were already home or never read can't be
 * known, because the file is gone. That is the bug.
 *
 * Two rules, enforced here:
 *   1. securePlaysBeforeSync — before any sync path wipes or rewrites the
 *      card, archive the scratch files, ingest the archived bytes through
 *      the shared round-trip logic against the PRE-sync catalog + manifest,
 *      and confirm the snapshot is in this iPod's round-trip state. If the
 *      plays can't be matched, the sync stops before touching the card.
 *   2. ensureScratchArchived — nothing deletes firmware scratch without a
 *      copy in `<device state dir>/ipod-plays-archive/<timestamp>/`.
 *      retireIpodFirmwareScratch calls it first; an archive failure throws
 *      and nothing is deleted. Archives are never deleted automatically.
 *
 * Archive layout (re-ingestable with scripts/ipod-plays-reingest.ts):
 *   <stamp>/iTunes/{Play Counts, OTGPlaylistInfo*, iTunesDB, ...}  card bytes
 *   <stamp>/last-sync-manifest.json                                 device manifest
 *   <stamp>/ipod-roundtrip-state.before.json                        round-trip state at archive time
 *   <stamp>/archive.json                                            written LAST: a folder without it is incomplete
 *   <stamp>/ingest.json                                             what the gate / a re-ingest did with it
 *
 * Per-device: stateDir is resolveIpodState(...).stateDir — the root state
 * dir for the Original (legacy files never move; the archive is a new
 * sibling folder), ipod-pools/<id>/ for any other iPod.
 */

import { createHash, randomUUID } from 'crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { IPOD_FIRMWARE_SCRATCH_NAMES, isIpodFirmwareScratchName } from './ipod-reconcile.ts'
import {
  ROUNDTRIP_STATE_FILE,
  applyRoundTripPlan,
  describeRoundTripOutcome,
  ingestRoundTripSnapshot,
  planRoundTrip,
  readRoundTripSnapshot,
  readRoundTripState,
  roundTripSnapshotId,
  uniqueTmpPath,
  type ManifestLike,
  type RoundTripHost,
  type RoundTripOutcome,
  type RoundTripPlan,
  type RoundTripSnapshot,
} from './sync-engine/roundtrip.ts'

export const PLAYS_ARCHIVE_DIR = 'ipod-plays-archive'
const META_FILE = 'archive.json'
const INGEST_FILE = 'ingest.json'
const MANIFEST_FILE = 'last-sync-manifest.json'

export interface ArchivedFile { name: string; bytes: number; sha1: string }
export interface PlaysArchiveMeta {
  version: 1
  archivedAt: string
  reason: string
  mount: string
  /** Card files under iTunes/ (scratch + the catalog they are positional against). */
  card: ArchivedFile[]
  /** True when the device's last-sync-manifest.json was copied alongside. */
  manifest: boolean
}

const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex')
const itunesDirOf = (mount: string): string => join(mount, 'iPod_Control', 'iTunes')

/** Folder name for an archive: sortable UTC time + a salt so two in one ms can't collide. */
export function archiveFolderName(now: Date, salt: string): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${salt}`
}

/** Firmware scratch files present on the card, sorted. */
export async function listFirmwareScratch(mount: string): Promise<string[]> {
  const itunes = itunesDirOf(mount)
  try {
    return (await readdir(itunes)).filter(isIpodFirmwareScratchName).sort()
  } catch {
    // Listing failed: fall back to the fixed names so a flaky readdir can't
    // make a real Play Counts invisible to the archive step.
    const found: string[] = []
    for (const n of IPOD_FIRMWARE_SCRATCH_NAMES) {
      if (await stat(join(itunes, n)).then(() => true, () => false)) found.push(n)
    }
    return found
  }
}

async function writeJsonAtomicLocal(path: string, value: unknown): Promise<void> {
  const tmp = uniqueTmpPath(path)
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** Copy bytes and prove the copy: read back, compare sha1. */
async function copyVerified(src: Buffer, dst: string): Promise<ArchivedFile> {
  await writeFile(dst, src)
  const back = await readFile(dst)
  const want = sha1(src)
  if (back.length !== src.length || sha1(back) !== want) throw new Error(`archive copy of ${dst} did not read back intact`)
  return { name: '', bytes: src.length, sha1: want }
}

/**
 * Copy Play Counts, every OTG file, the card's iTunesDB and the device's
 * last-sync-manifest into a new timestamped archive folder. Throws on any
 * failure — a caller that was about to delete must not delete.
 */
export async function archiveIpodScratch(
  mount: string,
  stateDir: string,
  reason: string,
  now: Date = new Date(),
): Promise<{ dir: string; meta: PlaysArchiveMeta }> {
  const itunes = itunesDirOf(mount)
  const names = await listFirmwareScratch(mount)
  if (await stat(join(itunes, 'iTunesDB')).then(() => true, () => false)) names.push('iTunesDB')
  const dir = join(stateDir, PLAYS_ARCHIVE_DIR, archiveFolderName(now, randomUUID().slice(0, 6)))
  await mkdir(join(dir, 'iTunes'), { recursive: true })
  const card: ArchivedFile[] = []
  for (const name of names) {
    const bytes = await readFile(join(itunes, name))
    card.push({ ...(await copyVerified(bytes, join(dir, 'iTunes', name))), name })
  }
  const manifestBytes = await readFile(join(stateDir, MANIFEST_FILE)).catch(() => null)
  if (manifestBytes) await copyVerified(manifestBytes, join(dir, MANIFEST_FILE))
  const stateBytes = await readFile(join(stateDir, ROUNDTRIP_STATE_FILE)).catch(() => null)
  if (stateBytes) await copyVerified(stateBytes, join(dir, 'ipod-roundtrip-state.before.json'))
  const meta: PlaysArchiveMeta = {
    version: 1, archivedAt: now.toISOString(), reason, mount, card, manifest: !!manifestBytes,
  }
  await writeJsonAtomicLocal(join(dir, META_FILE), meta)
  console.warn(`[plays-archive] kept a copy of ${card.map((f) => f.name).join(', ') || 'nothing'} → ${dir} (${reason})`)
  return { dir, meta }
}

/** Every complete archive under a device state dir, oldest first. */
export async function listPlaysArchives(stateDir: string): Promise<Array<{ dir: string; meta: PlaysArchiveMeta }>> {
  const root = join(stateDir, PLAYS_ARCHIVE_DIR)
  const names = (await readdir(root).catch(() => [] as string[])).sort()
  const out: Array<{ dir: string; meta: PlaysArchiveMeta }> = []
  for (const n of names) {
    try {
      const meta = JSON.parse(await readFile(join(root, n, META_FILE), 'utf-8')) as PlaysArchiveMeta
      if (meta && Array.isArray(meta.card)) out.push({ dir: join(root, n), meta })
    } catch { /* incomplete archive (no archive.json yet) — not a copy we can count on */ }
  }
  return out
}

/** The newest archived manifest that was kept with this exact catalog (iTunesDB sha1) and can map it. */
export async function manifestForCatalog(stateDir: string, catalogSha1: string): Promise<ManifestLike> {
  const archives = (await listPlaysArchives(stateDir)).reverse()
  for (const a of archives) {
    if (!a.meta.manifest || !a.meta.card.some((f) => f.name === 'iTunesDB' && f.sha1 === catalogSha1)) continue
    try {
      const m = JSON.parse(await readFile(join(a.dir, MANIFEST_FILE), 'utf-8')) as ManifestLike
      if (m && Array.isArray(m.tracks) && m.tracks.some((t) => typeof t.destPath === 'string' && t.destPath)) return m
    } catch { /* unreadable archived manifest — try an older one */ }
  }
  return null
}

/** Pure: is every present scratch file (name + bytes) already inside some archive? */
export function scratchAlreadyArchived(
  present: Array<{ name: string; sha1: string }>,
  archives: Array<{ dir: string; meta: PlaysArchiveMeta }>,
): string | null {
  const known = new Map<string, string>()
  for (const a of archives) for (const f of a.meta.card) known.set(`${f.name}\u0000${f.sha1}`, a.dir)
  let dir: string | null = null
  for (const p of present) {
    const hit = known.get(`${p.name}\u0000${p.sha1}`)
    if (!hit) return null
    dir = hit
  }
  return dir
}

/**
 * The precondition of every scratch delete. Returns the scratch names present
 * and the archive that holds them (an existing one when these exact bytes were
 * already kept — the pre-sync gate's — otherwise a new one). Throws if a copy
 * can't be made; the caller must then not delete.
 */
export async function ensureScratchArchived(
  mount: string,
  stateDir: string,
  reason: string,
): Promise<{ present: string[]; archiveDir: string | null }> {
  const present = await listFirmwareScratch(mount)
  if (present.length === 0) return { present, archiveDir: null }
  const hashed: Array<{ name: string; sha1: string }> = []
  for (const name of present) {
    const b = await readFile(join(itunesDirOf(mount), name)).catch(() => null)
    if (b) hashed.push({ name, sha1: sha1(b) })
  }
  const existing = scratchAlreadyArchived(hashed, await listPlaysArchives(stateDir))
  if (existing) return { present, archiveDir: existing }
  const { dir } = await archiveIpodScratch(mount, stateDir, reason)
  return { present, archiveDir: dir }
}

async function recordIngest(dir: string, outcome: RoundTripOutcome, by: string): Promise<void> {
  const path = join(dir, INGEST_FILE)
  let log: Array<Record<string, unknown>> = []
  try { log = JSON.parse(await readFile(path, 'utf-8')) as typeof log } catch { log = [] }
  log.push({ at: new Date().toISOString(), by, outcome })
  await writeJsonAtomicLocal(path, log)
}

export type SecurePlaysResult =
  | { ok: true; archiveDir: string | null; outcome: RoundTripOutcome }
  | { ok: false; archiveDir: string | null; outcome?: RoundTripOutcome; error: string }

/** Plain words for a sync that stopped to protect plays. */
export function securePlaysRefusal(outcome: RoundTripOutcome | null, archiveDir: string | null, why?: string): string {
  const kept = archiveDir ? ` A copy of the iPod’s play log is saved in ${archiveDir}.` : ''
  if (!outcome) return `JakeTunes stopped before touching the iPod: it couldn’t save a copy of the plays on it (${why || 'unknown error'}).`
  if (outcome.kind === 'cannot-map') {
    return `JakeTunes stopped before touching the iPod: it holds ${outcome.plays || 'some'} play${outcome.plays === 1 ? '' : 's'} that can’t be brought home, because ${outcome.reason}.${kept}`
  }
  if (outcome.kind === 'failed') return `JakeTunes stopped before touching the iPod: bringing its plays home failed (${outcome.reason}).${kept}`
  return `JakeTunes stopped before touching the iPod: it couldn’t confirm the iPod’s plays were recorded${why ? ` (${why})` : ''}.${kept}`
}

/**
 * The pre-sync gate. Every path that wipes or rewrites the card runs this
 * after resolveIpodState (so `host.stateDir` is this iPod's state dir) and
 * before its first card write. ok:false = do not touch the card.
 */
export async function securePlaysBeforeSync(mount: string, host: RoundTripHost, reason: string): Promise<SecurePlaysResult> {
  const finish = (r: SecurePlaysResult): SecurePlaysResult => {
    const what = r.outcome ? describeRoundTripOutcome(r.outcome) : 'no outcome'
    console.warn(`[roundtrip] before ${reason} (${host.stateDir}): ${what}` +
      (r.archiveDir ? ` — copy kept in ${r.archiveDir}` : '') + (r.ok ? '' : ` — SYNC STOPPED: ${r.error}`))
    return r
  }
  const present = await listFirmwareScratch(mount)
  if (present.length === 0) return finish({ ok: true, archiveDir: null, outcome: { kind: 'nothing-on-card' } })

  let archiveDir: string
  try {
    archiveDir = (await archiveIpodScratch(mount, host.stateDir, `before ${reason}`)).dir
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return finish({ ok: false, archiveDir: null, error: securePlaysRefusal(null, null, why) })
  }
  // Ingest the ARCHIVED bytes: what is recorded is exactly what is kept.
  const snap = await readRoundTripSnapshot(join(archiveDir, 'iTunes'))
  const outcome = await ingestRoundTripSnapshot(snap, {
    ...host,
    fallbackManifest: host.fallbackManifest ?? ((sha) => manifestForCatalog(host.stateDir, sha)),
  })
  await recordIngest(archiveDir, outcome, `pre-sync gate: ${reason}`)
    .catch((err) => console.warn('[plays-archive] could not note the ingest in the archive:', err instanceof Error ? err.message : err))
  switch (outcome.kind) {
    case 'nothing-on-card':
    case 'no-plays':
      return finish({ ok: true, archiveDir, outcome })
    case 'nothing-new':
    case 'brought-home': {
      const state = await readRoundTripState(host.stateDir)
      if (state && state.snapshot === roundTripSnapshotId(snap)) return finish({ ok: true, archiveDir, outcome })
      return finish({ ok: false, archiveDir, outcome, error: securePlaysRefusal(outcome, archiveDir, 'the round-trip state does not show this play log') })
    }
    default:
      return finish({ ok: false, archiveDir, outcome, error: securePlaysRefusal(outcome, archiveDir) })
  }
}

// ── Re-ingest an archive later (scripts/ipod-plays-reingest.ts) ─────────

export interface LoadedPlaysArchive {
  dir: string
  meta: PlaysArchiveMeta
  snap: RoundTripSnapshot
  manifest: ManifestLike
  ingests: Array<{ at?: string; by?: string; outcome?: RoundTripOutcome }>
}

export async function loadPlaysArchive(dir: string): Promise<LoadedPlaysArchive> {
  const meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf-8')) as PlaysArchiveMeta
  const snap = await readRoundTripSnapshot(join(dir, 'iTunes'))
  let manifest: ManifestLike = null
  try { manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf-8')) as ManifestLike } catch { manifest = null }
  let ingests: LoadedPlaysArchive['ingests'] = []
  try { ingests = JSON.parse(await readFile(join(dir, INGEST_FILE), 'utf-8')) as typeof ingests } catch { ingests = [] }
  return { dir, meta, snap, manifest, ingests }
}

export type ReingestPlan =
  | { kind: 'already-home'; why: string }
  | { kind: 'nothing'; why: string }
  | { kind: 'cannot-map'; why: string }
  | { kind: 'plan'; plan: Extract<RoundTripPlan, { kind: 'plan' }> }

/**
 * Pure. What re-ingesting an archive would bring home, given the device's
 * current round-trip state and its ledger text. Refuses to double count:
 * an archive whose snapshot an earlier ingest recorded (in the archive's
 * ingest.json, the live state, or a ledger line) is already home.
 * `manifestOverride` maps with a different manifest when the archive has none.
 */
export function planArchiveReingest(
  archive: Pick<LoadedPlaysArchive, 'snap' | 'manifest' | 'ingests'>,
  currentState: { generation: string; snapshot: string; ingested: Record<string, number> } | null,
  ledgerText: string,
  manifestOverride?: ManifestLike,
): ReingestPlan {
  const snapshot = roundTripSnapshotId(archive.snap)
  const done = archive.ingests.find((i) => i.outcome && (i.outcome.kind === 'brought-home' || i.outcome.kind === 'nothing-new'))
  if (done) return { kind: 'already-home', why: `${done.by || 'an earlier ingest'} recorded it (${describeRoundTripOutcome(done.outcome!)})` }
  if (currentState && currentState.snapshot === snapshot) return { kind: 'already-home', why: 'the device’s round-trip state already holds this play log' }
  if (snapshot && ledgerText.includes(`"snapshot":"${snapshot.slice(0, 12)}"`)) return { kind: 'already-home', why: 'the round-trip ledger already holds this play log' }
  // Map against the archive's own generation only: the live state belongs to
  // whatever catalog is on the card now.
  const prior = currentState && archive.snap.catalog && currentState.generation === sha1(archive.snap.catalog) ? currentState : null
  const plan = planRoundTrip(archive.snap, manifestOverride ?? archive.manifest, prior)
  switch (plan.kind) {
    case 'empty': return { kind: 'nothing', why: 'the archive holds no Play Counts or On-The-Go files' }
    case 'no-plays': return { kind: 'nothing', why: 'the archived play log has no plays' }
    case 'already-recorded': return { kind: 'already-home', why: 'the device’s round-trip state already holds this play log' }
    case 'cannot-map': return { kind: 'cannot-map', why: plan.reason }
    case 'plan': return { kind: 'plan', plan }
  }
}

/** Apply a re-ingest plan: ledger + play events + updates, never the live state. */
export async function applyArchiveReingest(
  archiveDir: string,
  plan: Extract<RoundTripPlan, { kind: 'plan' }>,
  host: RoundTripHost,
): Promise<RoundTripOutcome> {
  const outcome = await applyRoundTripPlan(plan, host, { ledgerKind: 'roundtrip-reingest', writeState: false })
  await recordIngest(archiveDir, outcome, 'reingest script')
  return outcome
}
