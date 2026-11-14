/**
 * Setting up a new iPod — the half that reads and writes (rules and words:
 * common/ipod-onboarding.ts).
 *
 * Reading: `gatherIpodFacts` looks at a mounted iPod without writing a byte.
 * Writing, three things only, each behind `guard` (the ID file as it is on the
 * card at that moment, common's onboardingWriteRefusal):
 *   • `runCardTest`  — test files in their own folder, read back, removed;
 *   • `prepareIpod`  — the folders, a blank song database when there is none,
 *                      and the ID file carrying the list's id;
 *   • the record     — ipod-onboarding.json in the state dir (this Mac's disk).
 * Nothing here formats, erases, ejects or deletes a song. The tests run all of
 * it against folders in the temp dir standing in for an iPod.
 */
import { constants as FS } from 'fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, statfs, unlink, writeFile } from 'fs/promises'
import { join, sep } from 'path'
import { IPOD_MARKER_REL, parseDeviceMarker, type IpodDeviceMarker } from '../common/ipod-identity.ts'
import {
  ONBOARDING_FILE, buildOnboardingRecord, cardTestPlan, deviceSerial, looksLikeOriginal, onboardingWriteRefusal, parseOnboardingDoc, parseSysInfo,
  type IpodDeviceFacts, type IpodFs, type IpodOnboardingRecord, type IpodUsbFacts, type OnboardingEvent,
} from '../common/ipod-onboarding.ts'
import { forgetIpod, ipodStateDirFor, loadIpodRegistry, registerIpod } from './ipod-identity.ts'
import { buildBlankCatalog, catalogArtists, readCatalogSummary } from './ipod-blank-catalog.ts'
import { parseCatalogPaths, uniqueTmpPath } from './sync-engine/roundtrip.ts'
import { LAST_SYNC_MANIFEST_FILE } from './ipod-swap-sync.ts'

const AUDIO = /\.(m4a|mp3|aac|wav|aif|aiff|m4p|m4b)$/i
const warn = (what: string, err: unknown) => console.warn(`[ipod-onboarding] ${what}:`, err instanceof Error ? err.message : err)

// ── Reading ──────────────────────────────────────────────────────────────────

/** `mount`'s filesystem from the text of `/sbin/mount`. null = not in the table. */
export function fsFromMountTable(table: string, mount: string): IpodFs | null {
  const at = mount.replace(/\/+$/, '')
  for (const line of table.split('\n')) {
    const m = / on (\/.+?) \(([a-z0-9_]+)[,)]/i.exec(line)
    if (!m || m[1].trim() !== at) continue
    const t = m[2].toLowerCase()
    if (t === 'msdos' || t === 'fat32' || t === 'vfat') return 'fat32'
    if (t === 'hfs') return 'hfs'
    if (t === 'exfat') return 'exfat'
    if (t === 'apfs') return 'apfs'
    return 'other'
  }
  return null
}

/**
 * The USB side of a disk from `system_profiler SPUSBDataType -json` (or the
 * newer SPUSBHostDataType): the device whose media carries `wholeDisk`
 * ("disk9"). UNPROVEN ON AN iPOD: the shape is Apple's documented one and the
 * test feeds it a hand-made report; every field is optional on purpose.
 */
export function usbFactsFromProfile(raw: unknown, wholeDisk: string): IpodUsbFacts | null {
  const hex = (v: unknown): number | null => {
    const m = typeof v === 'string' ? /0x([0-9a-f]{1,4})/i.exec(v) : null
    return m ? parseInt(m[1], 16) : null
  }
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const carries = (node: Record<string, unknown>): boolean => {
    const media = node.Media
    return Array.isArray(media) && media.some((m) => (m as Record<string, unknown> | null)?.bsd_name === wholeDisk)
  }
  const walk = (node: unknown, depth: number): IpodUsbFacts | null => {
    if (!node || typeof node !== 'object' || depth > 12) return null
    if (Array.isArray(node)) {
      for (const n of node) { const hit = walk(n, depth + 1); if (hit) return hit }
      return null
    }
    const n = node as Record<string, unknown>
    if (carries(n)) {
      return {
        vendor: text(n.manufacturer) ?? text(n.vendor_id) ?? text(n._name),
        productId: hex(n.product_id),
        serial: text(n.serial_num),
      }
    }
    for (const v of Object.values(n)) {
      if (v && typeof v === 'object') { const hit = walk(v, depth + 1); if (hit) return hit }
    }
    return null
  }
  return walk(raw, 0)
}

export interface FactsDeps {
  /** The text of `/sbin/mount`. */
  mountTable: () => Promise<string>
  /** Every other mounted iPod (the hub's own detector), this one excluded by the caller. */
  otherIpods: () => Promise<number>
  /** USB facts for this mount; absent or null = couldn't read. */
  usb?: (mount: string) => Promise<IpodUsbFacts | null>
  /** The drive's identity from the system (volume UUID, serial, size); null = it wouldn't say. */
  driveId: (mount: string) => Promise<string | null>
  /** This Mac's state dir, to tell an Original that lost its ID file; absent = not asked. */
  stateDir?: string
  syncInFlight: () => boolean
  role: 'hub' | 'replica'
  sleep?: (ms: number) => Promise<void>
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

async function readMarker(mount: string): Promise<IpodDeviceMarker | null> {
  try {
    return parseDeviceMarker(JSON.parse(await readFile(join(mount, ...IPOD_MARKER_REL), 'utf-8')))
  } catch {
    return null
  }
}

async function countMusic(mount: string): Promise<number | null> {
  const root = join(mount, 'iPod_Control', 'Music')
  let dirs: string[]
  try { dirs = await readdir(root) } catch { return (await exists(join(mount, 'iPod_Control'))) ? 0 : null }
  let n = 0
  for (const d of dirs) {
    if (!/^F\d\d$/i.test(d)) continue
    try { n += (await readdir(join(root, d))).filter((f) => AUDIO.test(f) && !f.startsWith('._')).length } catch (err) { warn(`reading ${d}`, err); return null }
  }
  return n
}

/** Ask for the drive `tries` times, `gapMs` apart. A drive that flaps in and out fails this. */
export async function stableReads(mount: string, tries: number, gapMs: number, sleep: (ms: number) => Promise<void>): Promise<{ tried: number; ok: number }> {
  let ok = 0
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(gapMs)
    if (await exists(join(mount, 'iPod_Control'))) ok++
  }
  return { tried: tries, ok }
}

/** Everything set-up needs to know about the iPod at `mount`. Reads only. */
export async function gatherIpodFacts(
  mount: string,
  deps: FactsDeps,
  prior: { stable?: IpodDeviceFacts['stable']; writeTest?: IpodDeviceFacts['writeTest'] } = {},
): Promise<IpodDeviceFacts> {
  const itunes = join(mount, 'iPod_Control', 'iTunes')
  const [table, space, sysText, marker, dbBuf, music, usb, others, driveId] = await Promise.all([
    deps.mountTable().catch(() => ''),
    statfs(mount).then((s) => ({ total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) }), () => null),
    readFile(join(mount, 'iPod_Control', 'Device', 'SysInfo'), 'utf-8').catch(() => null),
    readMarker(mount),
    readFile(join(itunes, 'iTunesDB')).catch(() => null),
    countMusic(mount),
    deps.usb ? deps.usb(mount).catch(() => null) : Promise.resolve(null),
    // A failed look for other iPods counts as "one might be there".
    deps.otherIpods().catch(() => 1),
    deps.driveId(mount).catch(() => null),
  ])
  const summary = dbBuf ? readCatalogSummary(dbBuf) : null
  const firmwareFiles = (await exists(join(itunes, 'iTunesPrefs'))) || (await exists(join(itunes, 'iTunesControl')))
  const rockbox = (await exists(join(mount, '.rockbox'))) || /rockbox/i.test(usb?.vendor ?? '')
  const serial = deviceSerial({ usb, sysInfo: sysText === null ? null : parseSysInfo(sysText) })?.serial ?? null
  const total = space && space.total > 0 ? space.total : null
  const originalEvidence = deps.stateDir && !marker
    ? await originalEvidenceFor(deps.stateDir, { serial, totalBytes: total, catalogName: summary?.name ?? null, cardPaths: (dbBuf && parseCatalogPaths(dbBuf)) || [] })
    : null
  return {
    driveId,
    originalEvidence,
    volumeLabel: mount.replace(/\/+$/, '').split('/').pop() || null,
    fs: fsFromMountTable(table, mount),
    totalBytes: space && space.total > 0 ? space.total : null,
    freeBytes: space && space.total > 0 ? space.free : null,
    sysInfo: sysText === null ? null : parseSysInfo(sysText),
    usb,
    marker,
    catalog: { present: dbBuf !== null, readable: summary !== null, songs: summary?.songs ?? null, name: summary?.name ?? null, artists: dbBuf && summary ? catalogArtists(dbBuf) : [] },
    musicFiles: music,
    firmwareFiles,
    rockbox,
    stable: prior.stable ?? null,
    writeTest: prior.writeTest ?? null,
    otherIpods: others,
    syncInFlight: deps.syncInFlight(),
    role: deps.role,
  }
}

/** Is this unmarked card the Original? (common's looksLikeOriginal, fed from this Mac's own files.) */
async function originalEvidenceFor(
  stateDir: string,
  card: { serial: string | null; totalBytes: number | null; catalogName: string | null; cardPaths: string[] },
): Promise<string | null> {
  try {
    const original = (await loadIpodRegistry(stateDir)).devices.find((d) => d.primary)
    if (!original) return null
    const rec = (await readOnboardingRecords(stateDir)).find((r) => r.listId === original.id) ?? null
    let lastSyncPaths: string[] = []
    try {
      const man = JSON.parse(await readFile(join(stateDir, LAST_SYNC_MANIFEST_FILE), 'utf-8')) as { tracks?: Array<{ destPath?: unknown }> }
      lastSyncPaths = (man.tracks ?? []).map((t) => String(t?.destPath ?? ''))
    } catch { /* no last sync on this Mac: the other evidence still counts */ }
    return looksLikeOriginal({
      marker: null,
      original: { name: original.name, serial: rec?.serial ?? null, capacityBytes: rec?.capacityBytes ?? null },
      ...card,
      lastSyncPaths,
    })
  } catch (err) {
    warn('looking for the Original', err)
    return null
  }
}

// ── The write guard ──────────────────────────────────────────────────────────

export interface WriteGuard {
  /** The ID file the checks saw; a different one now means a different card. */
  markerAtChecks: IpodDeviceMarker | null
  otherIpods: () => Promise<number>
  syncInFlight: () => boolean
  /** Asks the system again: is the drive at this path still the one the checks ran on? */
  sameDrive: () => Promise<boolean>
}

/** Is `path` really inside `mount`, with no symlink leading out of it? */
async function insideVolume(mount: string, path: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([realpath(mount), realpath(path)])
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)
  } catch {
    return false
  }
}

/**
 * null = this write may go ahead. Asked immediately before EVERY write: it
 * reads the ID file off the card and asks the system for the drive's identity
 * again each time, so a drive swapped at the same path is caught.
 */
export async function guard(mount: string, g: WriteGuard): Promise<string | null> {
  if (!(await exists(join(mount, 'iPod_Control')))) return 'The iPod isn’t there any more. Nothing on it was changed.'
  if (!(await insideVolume(mount, join(mount, 'iPod_Control')))) return 'This drive’s iPod folder points somewhere else. JakeTunes won’t write through it. Nothing was changed.'
  return onboardingWriteRefusal({
    markerNow: await readMarker(mount),
    markerAtChecks: g.markerAtChecks,
    otherIpods: await g.otherIpods().catch(() => 1),
    syncInFlight: g.syncInFlight(),
    sameDrive: await g.sameDrive().catch(() => false),
  })
}

// ── The card test ────────────────────────────────────────────────────────────

export const CARD_TEST_DIR = 'jaketunes-setup-test'
const TEST_FILE = (i: number) => `jt-test-${String(i).padStart(5, '0')}.bin`
const BLOCK = 1024 * 1024

/** The bytes of one block, worked out from where it sits: the same every time it is asked. */
export function testBlock(seed: number, file: number, block: number, size = BLOCK): Buffer {
  const buf = Buffer.allocUnsafe(size)
  let x = (seed ^ Math.imul(file + 1, 0x9e3779b1) ^ Math.imul(block + 1, 0x85ebca6b)) >>> 0 || 0x1234567
  let i = 0
  for (; i + 4 <= size; i += 4) {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    buf.writeUInt32LE(x, i)
  }
  for (; i < size; i++) buf[i] = (x >>> ((i & 3) * 8)) & 0xff
  return buf
}

export interface CardTestResult { ok: boolean; bytes: number; reason?: string }

const NOFOLLOW = FS.O_NOFOLLOW ?? 0
const TEST_NAME = /^jt-test-\d{5}\.bin$/

/**
 * A test folder left behind (the app was killed mid-test): remove the test's
 * own files and the folder. A symlink in its place is never followed and never
 * removed-through: 'symlink' is returned and the caller refuses.
 */
export async function cleanLeftoverTest(mount: string): Promise<'none' | 'cleaned' | 'symlink' | 'not-ours'> {
  const dir = join(mount, CARD_TEST_DIR)
  let st
  try { st = await lstat(dir) } catch { return 'none' }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'symlink'
  let foreign = false
  for (const name of await readdir(dir)) {
    const f = await lstat(join(dir, name))
    if (TEST_NAME.test(name) && f.isFile()) await unlink(join(dir, name))
    else foreign = true
  }
  if (foreign) return 'not-ours'
  await rmdir(dir)
  return 'cleaned'
}

/**
 * Write the plan's test files, read every one back only after ALL are written
 * (a card that wraps around overwrites the first ones with the last), remove
 * them. Only ever touches its own folder. `between` is for the tests: it runs
 * after the writing and before the reading.
 */
export async function runCardTest(
  mount: string,
  g: WriteGuard,
  opts: { quick: boolean; seed?: number; between?: (dir: string) => Promise<void>; onProgress?: (done: number, total: number, phase: 'write' | 'read') => void; freeBytes?: number; fileBytes?: number },
): Promise<CardTestResult> {
  const refusal = await guard(mount, g)
  if (refusal) return { ok: false, bytes: 0, reason: refusal }
  const free = opts.freeBytes ?? await statfs(mount).then((s) => Number(s.bavail) * Number(s.bsize), () => 0)
  const plan = cardTestPlan(free, { quick: opts.quick, fileBytes: opts.fileBytes })
  if (!plan) return { ok: false, bytes: 0, reason: 'there isn’t enough free space on the iPod to test' }
  const seed = opts.seed ?? (Date.now() >>> 0)
  const dir = join(mount, CARD_TEST_DIR)
  const blocks = Math.floor(plan.fileBytes / BLOCK)
  const tail = plan.fileBytes - blocks * BLOCK
  const sizeOf = (b: number) => (b < blocks ? BLOCK : tail)
  const perFile = blocks + (tail ? 1 : 0)
  const total = plan.files * perFile
  let result: CardTestResult = { ok: true, bytes: plan.totalBytes }
  // The folder is made new, by this test, inside the volume: never a symlink, never someone else's.
  const leftover = await cleanLeftoverTest(mount).catch(() => 'symlink' as const)
  if (leftover === 'symlink' || leftover === 'not-ours') {
    return { ok: false, bytes: 0, reason: `there is something named ${CARD_TEST_DIR} on the iPod that isn’t JakeTunes’ own test folder, so the test wasn’t written` }
  }
  try {
    await mkdir(dir)
    if ((await lstat(dir)).isSymbolicLink() || !(await insideVolume(mount, dir))) throw new Error('the test folder isn’t on the iPod')
    let done = 0
    for (let f = 0; f < plan.files; f++) {
      const fh = await open(join(dir, TEST_FILE(f)), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | NOFOLLOW)
      try {
        for (let b = 0; b < perFile; b++) {
          await fh.write(testBlock(seed, f, b, sizeOf(b)))
          opts.onProgress?.(++done, total, 'write')
        }
        await fh.sync()
      } finally {
        await fh.close()
      }
    }
    await opts.between?.(dir)
    done = 0
    outer: for (let f = 0; f < plan.files; f++) {
      const fh = await open(join(dir, TEST_FILE(f)), FS.O_RDONLY | NOFOLLOW)
      try {
        for (let b = 0; b < perFile; b++) {
          const want = testBlock(seed, f, b, sizeOf(b))
          const got = Buffer.alloc(want.length)
          const { bytesRead } = await fh.read(got, 0, want.length, b * BLOCK)
          if (bytesRead !== want.length || !got.equals(want)) {
            result = { ok: false, bytes: plan.totalBytes, reason: `test file ${f + 1} of ${plan.files} came back different ${Math.round((b * BLOCK) / 1048576)} MB in` }
            break outer
          }
          opts.onProgress?.(++done, total, 'read')
        }
      } finally {
        await fh.close()
      }
    }
  } catch (err) {
    result = { ok: false, bytes: plan.totalBytes, reason: err instanceof Error ? err.message : 'the test couldn’t be written' }
  }
  // Remove only what this test made; the folder goes only if nothing else is in it.
  await cleanLeftoverTest(mount).catch((err) => warn('removing the test folder', err))
  return result
}

// ── The record ───────────────────────────────────────────────────────────────

export async function readOnboardingRecords(stateDir: string): Promise<IpodOnboardingRecord[]> {
  try {
    return parseOnboardingDoc(JSON.parse(await readFile(join(stateDir, ONBOARDING_FILE), 'utf-8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') warn('reading the record', err)
    return []
  }
}

async function writeOnboardingRecords(stateDir: string, devices: IpodOnboardingRecord[]): Promise<void> {
  const path = join(stateDir, ONBOARDING_FILE)
  const tmp = uniqueTmpPath(path)
  await writeFile(tmp, JSON.stringify({ version: 1, devices }, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** Change one list's record (or add it); the others are written back as they were. */
export async function updateOnboardingRecord(
  stateDir: string,
  listId: string,
  change: (current: IpodOnboardingRecord | null) => IpodOnboardingRecord | null,
): Promise<IpodOnboardingRecord | null> {
  const all = await readOnboardingRecords(stateDir)
  const i = all.findIndex((r) => r.listId === listId)
  const next = change(i >= 0 ? all[i] : null)
  if (!next) return i >= 0 ? all[i] : null
  if (i >= 0) all[i] = next
  else all.push(next)
  await writeOnboardingRecords(stateDir, all)
  return next
}

const event = (rec: IpodOnboardingRecord, at: string, e: OnboardingEvent, note: string): IpodOnboardingRecord =>
  ({ ...rec, history: [...rec.history, { at, event: e, note }].slice(-50) })

/** The last sync of the iPod whose state lives in `ipodStateDir`, as this Mac recorded it. */
export async function readLastSync(ipodStateDir: string): Promise<{ sealed: boolean; songs: number; at: string } | null> {
  try {
    const m = JSON.parse(await readFile(join(ipodStateDir, LAST_SYNC_MANIFEST_FILE), 'utf-8')) as Record<string, unknown>
    const songs = Array.isArray(m.tracks) ? m.tracks.length : Number(m.count) || 0
    return { sealed: m.sealed === true, songs, at: typeof m.syncedAt === 'string' ? m.syncedAt : '' }
  } catch {
    return null
  }
}

/** A sealed sync seen at plug-in goes onto the record (the "last synced" every Mac and the phone show). */
export async function noteLastSync(stateDir: string, device: IpodDeviceMarker): Promise<IpodOnboardingRecord | null> {
  if (device.primary) return null
  const last = await readLastSync(ipodStateDirFor(stateDir, device))
  return updateOnboardingRecord(stateDir, device.id, (cur) => {
    if (!cur || !last?.sealed || !last.at || (cur.lastSyncedAt === last.at && cur.lastSyncSongs === last.songs)) return null
    return { ...cur, lastSyncedAt: last.at, lastSyncSongs: last.songs }
  })
}

/** Jake went through the checklist on the iPod itself. Only after a sealed sync. */
export async function sealOnboarding(stateDir: string, device: IpodDeviceMarker, now: string): Promise<{ ok: true; record: IpodOnboardingRecord } | { ok: false; error: string }> {
  if (device.primary) return { ok: false, error: `${device.name} is your Original. It has no set-up to check off.` }
  const last = await readLastSync(ipodStateDirFor(stateDir, device))
  if (!last?.sealed) return { ok: false, error: `${device.name} hasn’t finished a sync yet. Sync it first, then check it.` }
  const rec = await updateOnboardingRecord(stateDir, device.id, (cur) =>
    cur ? event({ ...cur, sealedAt: now, lastSyncedAt: last.at || cur.lastSyncedAt, lastSyncSongs: last.songs }, now, 'checked', `${last.songs} songs, checked on the iPod`) : null)
  return rec?.sealedAt ? { ok: true, record: rec } : { ok: false, error: `${device.name} has no set-up record on this Mac.` }
}

// ── Preparing the iPod ───────────────────────────────────────────────────────

export interface PrepareInput {
  /** The homemini list this iPod takes over; null = a brand-new iPod (a fresh id). */
  listId: string | null
  /** The iPod's own name (checked by the caller: common/ipod-name.ts). */
  name: string
  color: string | null
  purpose: string | null
  /** The facts the checks ran on. */
  facts: IpodDeviceFacts
  now: string
}

export type PrepareResult =
  | { ok: true; device: IpodDeviceMarker; record: IpodOnboardingRecord; did: string[] }
  | { ok: false; error: string; did: string[] }

/**
 * Make the iPod ready for its first sync. In order, stopping at the first
 * failure and saying what was already done: folders, a blank song database
 * (only when there is none), the ID file, the record. Deletes nothing.
 */
export async function prepareIpod(
  mount: string, stateDir: string, g: WriteGuard, input: PrepareInput,
  /** For the tests: how the blank database is read back (a card that drops writes). */
  io: { readBack: (path: string) => Promise<Buffer> } = { readBack: (p) => readFile(p) },
): Promise<PrepareResult> {
  const did: string[] = []
  const refusal = await guard(mount, g)
  if (refusal) return { ok: false, error: refusal, did }
  const stopped = (why: string): PrepareResult =>
    ({ ok: false, error: `${why}${did.length ? ` Already done: ${did.join('; ')}.` : ''}`, did })
  const fail = (what: string, err: unknown): PrepareResult =>
    ({ ok: false, error: `${what} (${err instanceof Error ? err.message : 'the write failed'}). ${did.length ? `Already done: ${did.join('; ')}.` : 'Nothing on the iPod was changed.'}`, did })

  const itunes = join(mount, 'iPod_Control', 'iTunes')
  try {
    await mkdir(itunes, { recursive: true })
    await mkdir(join(mount, 'iPod_Control', 'Device'), { recursive: true })
    for (let i = 0; i < 50; i++) await mkdir(join(mount, 'iPod_Control', 'Music', `F${String(i).padStart(2, '0')}`), { recursive: true })
    did.push('the folders are there')
  } catch (err) {
    return fail('JakeTunes couldn’t make the iPod’s folders', err)
  }

  const dbPath = join(itunes, 'iTunesDB')
  if (!(await exists(dbPath))) {
    const again = await guard(mount, g)
    if (again) return stopped(again)
    const tmp = uniqueTmpPath(dbPath)
    try {
      const fh = await open(tmp, 'w')
      try { await fh.write(buildBlankCatalog(input.name)); await fh.sync() } finally { await fh.close() }
      await rename(tmp, dbPath)
      // Read it back: a card that drops writes must not look prepared.
      const back = readCatalogSummary(await io.readBack(dbPath))
      if (!back || back.songs !== 0 || back.name !== input.name) throw new Error('the blank song database didn’t read back')
      did.push('a blank song database was written')
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      return fail('JakeTunes couldn’t write the blank song database', err)
    }
  }

  const moving = g.markerAtChecks && !g.markerAtChecks.primary ? g.markerAtChecks : null
  const last = await guard(mount, g)
  if (last) return stopped(last)
  const reg = await registerIpod(mount, stateDir, {
    asOriginal: false, name: input.name, color: input.color, purpose: input.purpose,
    ...(input.listId ? { id: input.listId } : {}),
    replace: moving !== null,
  })
  if (!reg.ok) return fail('JakeTunes couldn’t write its ID file', new Error(reg.error))
  did.push('the ID file was written')

  try {
    if (moving && moving.id !== reg.device.id) {
      await forgetIpod(stateDir, moving.id)
      await updateOnboardingRecord(stateDir, moving.id, (cur) =>
        cur ? event({ ...cur, released: true }, input.now, 'released', `the iPod became ${input.name}`) : null)
    }
    const record = await updateOnboardingRecord(stateDir, reg.device.id, (cur) => {
      const built = buildOnboardingRecord({ listId: reg.device.id, name: input.name, facts: input.facts, now: input.now, previous: cur })
      return moving && moving.id !== reg.device.id ? event(built, input.now, 'moved-to-another-list', `was ${moving.name}`) : built
    })
    if (!record) throw new Error('the record came back empty')
    did.push('the iPod was recorded')
    return { ok: true, device: reg.device, record, did }
  } catch (err) {
    return fail('The iPod is set up, but JakeTunes couldn’t keep its record on this Mac', err)
  }
}

/**
 * An iPod that was set up before these records existed (punkPod, 2026-11-07):
 * it gets a record from what is true today, so it isn't asked to prove itself
 * again. Its set-up date is the ID file's; it counts as checked when its last
 * sync is sealed (that is what "About reads 829" settled by hand).
 */
export async function adoptExistingIpod(
  stateDir: string,
  facts: IpodDeviceFacts,
  now: string,
): Promise<IpodOnboardingRecord | null> {
  const marker = facts.marker
  if (!marker) return null
  // The Original is recorded too (its serial and size are how it is known again without its ID file).
  const last = await readLastSync(ipodStateDirFor(stateDir, marker))
  return updateOnboardingRecord(stateDir, marker.id, (cur) => {
    if (cur) return null
    const built = buildOnboardingRecord({ listId: marker.id, name: marker.name, facts, now: marker.createdAt || now })
    return {
      ...built,
      // The Original has no set-up to check off; its record is only how it is known again.
      sealedAt: !marker.primary && last?.sealed ? last.at || now : null,
      lastSyncedAt: last?.sealed ? last.at || null : null,
      lastSyncSongs: last?.sealed ? last.songs : null,
      history: [{ at: now, event: 'set-up', note: 'set up before records were kept; recorded from the iPod as it is' }],
    }
  })
}
