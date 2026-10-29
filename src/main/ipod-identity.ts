/**
 * Which iPod is plugged in — the fs half of common/ipod-identity.ts.
 *
 * The marker on the card is the identity (every Mac reads the same file);
 * `ipod-devices.json` in userData is this Mac's list of iPods it has met,
 * used to know whether an original is already registered here.
 *
 * Every card-writing path (sync, delete mirror, import from iPod) and every
 * card-reading path that writes Jake's data (play-count round trip, the TSA
 * seal check) asks `refuseUnlessOriginalIpod` first. Unknown or non-original
 * iPods fail closed: nothing is written to them, nothing read from them is
 * applied to the library.
 */
import { mkdir, readFile, writeFile, rename, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  IPOD_MARKER_REL, ORIGINAL_DEFAULTS, buildDeviceMarker, catalogMatchesManifest,
  ipodImportRefusal, ipodPoolRel, ipodStateRel, ipodWriteRefusal, parseDeviceMarker, shouldAutoAdoptOriginal,
  type IpodDeviceMarker, type IpodIdentity,
} from '../common/ipod-identity.ts'
import { parseCatalogPaths, uniqueTmpPath } from './sync-engine/roundtrip.ts'

const REGISTRY_FILE = 'ipod-devices.json'

function markerPath(mount: string): string {
  return join(mount, ...IPOD_MARKER_REL)
}

export async function readDeviceMarker(mount: string): Promise<IpodDeviceMarker | null> {
  try {
    return parseDeviceMarker(JSON.parse(await readFile(markerPath(mount), 'utf-8')))
  } catch {
    return null
  }
}

async function writeDeviceMarker(mount: string, marker: IpodDeviceMarker): Promise<void> {
  const path = markerPath(mount)
  const tmp = uniqueTmpPath(path)
  try {
    await writeFile(tmp, JSON.stringify(marker, null, 2), 'utf-8')
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch((e) => console.warn('[ipod-identity] tmp cleanup:', e instanceof Error ? e.message : e))
    throw err
  }
  // Read it back: a card that silently drops writes must not look identified.
  const back = await readDeviceMarker(mount)
  if (!back || back.id !== marker.id) throw new Error('the iPod did not keep the ID file')
}

interface Registry { devices: IpodDeviceMarker[] }

const logRegistryFail = (e: unknown) => console.warn('[ipod-identity] could not update ipod-devices.json:', e instanceof Error ? e.message : e)

/** This Mac's list of iPods it has met (ipod-devices.json); missing or torn = none. */
export async function loadIpodRegistry(stateDir: string): Promise<Registry> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, REGISTRY_FILE), 'utf-8')) as { devices?: unknown[] }
    const devices = (raw.devices || []).map(parseDeviceMarker).filter((d): d is IpodDeviceMarker => d !== null)
    return { devices }
  } catch {
    return { devices: [] }
  }
}
const loadRegistry = loadIpodRegistry

/** Where an iPod's Pool file lives (common/ipod-identity.ts ipodPoolRel): the Original, or no
 *  known iPod, = the legacy root activity-pool.json; any other iPod = ipod-pools/<id>/. */
export function poolFileFor(stateDir: string, device: IpodDeviceMarker | null): string {
  return join(stateDir, ...ipodPoolRel(device))
}

/** Where an iPod's sync state lives (manifest, seal, journal, reports, ledgers, round-trip,
 *  workout-sync state): the root state dir for the Original, ipod-pools/<id>/ for any other. */
export function ipodStateDirFor(stateDir: string, device: IpodDeviceMarker | null): string {
  return join(stateDir, ...ipodStateRel(device))
}

export interface IpodState {
  /** Why the card must not be touched, or null when it may be (any known iPod). */
  refusal: string | null
  device: IpodDeviceMarker | null
  /** The state dir every sync-side file of THIS iPod lives in (created when it is its own). */
  stateDir: string
}

/**
 * Which iPod is this, and where does its state live (step 2b). Every card-writing path (sync,
 * delete mirror) and every card-reading path that writes Jake's data (play-count round trip, the
 * TSA seal check) asks this first. Unknown cards fail closed; a known second iPod gets its own
 * folder; the Original keeps the root.
 */
export async function resolveIpodState(mount: string, stateDir: string): Promise<IpodState> {
  let identity: IpodIdentity
  try {
    identity = await identifyIpod(mount, stateDir)
  } catch {
    return { refusal: 'JakeTunes couldn’t tell which iPod this is, so it left it alone.', device: null, stateDir }
  }
  const refusal = ipodWriteRefusal(identity)
  const device = identity.status === 'known' ? identity.device : null
  const dir = ipodStateDirFor(stateDir, device)
  if (!refusal && dir !== stateDir) await mkdir(dir, { recursive: true }).catch(logRegistryFail)
  return { refusal, device, stateDir: dir }
}

async function rememberDevice(stateDir: string, marker: IpodDeviceMarker): Promise<void> {
  const reg = await loadRegistry(stateDir)
  const i = reg.devices.findIndex((d) => d.id === marker.id)
  if (i >= 0 && JSON.stringify(reg.devices[i]) === JSON.stringify(marker)) return
  if (i >= 0) reg.devices[i] = marker
  else reg.devices.push(marker)
  const path = join(stateDir, REGISTRY_FILE)
  const tmp = uniqueTmpPath(path)
  await writeFile(tmp, JSON.stringify(reg, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** Does the card hold what the last sync put on the original? */
async function cardMatchesLastSync(mount: string, stateDir: string): Promise<boolean> {
  try {
    const db = await readFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const cardPaths = parseCatalogPaths(db)
    if (!cardPaths) return false
    const man = JSON.parse(await readFile(join(stateDir, 'last-sync-manifest.json'), 'utf-8')) as
      { tracks?: Array<{ destPath?: string }> }
    const manPaths = (man.tracks || []).map((t) => String(t.destPath || ''))
    return catalogMatchesManifest(cardPaths, manPaths)
  } catch {
    return false
  }
}

// An unmarked card is re-checked only when its catalog changes; the red
// Mini's whole-library iTunesDB is several MB and the mount poll is 2.5 s.
const unknownCache = new Map<string, { key: string; identity: IpodIdentity }>()

async function catalogKey(mount: string): Promise<string> {
  try {
    const s = await stat(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB'))
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'none'
  }
}

/**
 * One identify per mount at a time (2026-10-28). The mount poll, the plug-in
 * round trip and the device view all ask at plug-in; two concurrent first
 * looks at an unmarked Original both decided to adopt it, wrote the same
 * pid-named tmp file, and one lost with ENOENT — so that caller saw an
 * unknown card and the round trip was skipped. Now the second caller waits
 * and reads the marker the first one wrote.
 */
const identifyQueue = new Map<string, Promise<unknown>>()
export function identifyIpod(mount: string, stateDir: string): Promise<IpodIdentity> {
  const prev = identifyQueue.get(mount) || Promise.resolve()
  const run = prev.then(() => identifyIpodNow(mount, stateDir), () => identifyIpodNow(mount, stateDir))
  const tail = run.then(() => undefined, () => undefined)
  identifyQueue.set(mount, tail)
  void tail.then(() => { if (identifyQueue.get(mount) === tail) identifyQueue.delete(mount) })
  return run
}

async function identifyIpodNow(mount: string, stateDir: string): Promise<IpodIdentity> {
  const marker = await readDeviceMarker(mount)
  if (marker) {
    unknownCache.delete(mount)
    await rememberDevice(stateDir, marker).catch(logRegistryFail)
    return { status: 'known', device: marker }
  }
  const reg = await loadRegistry(stateDir)
  const registryHasPrimary = reg.devices.some((d) => d.primary)
  const key = `${await catalogKey(mount)}:${registryHasPrimary}`
  const cached = unknownCache.get(mount)
  if (cached && cached.key === key) return cached.identity

  if (shouldAutoAdoptOriginal({ registryHasPrimary, catalogMatch: await cardMatchesLastSync(mount, stateDir) })) {
    const adopted = buildDeviceMarker({
      id: `original-${randomUUID().slice(0, 8)}`,
      name: ORIGINAL_DEFAULTS.name,
      purpose: ORIGINAL_DEFAULTS.purpose,
      primary: true,
      now: new Date().toISOString(),
    })
    if (adopted) {
      try {
        await writeDeviceMarker(mount, adopted)
        await rememberDevice(stateDir, adopted)
        console.log(`[ipod-identity] recognised the original iPod at ${mount} (matches the last sync) — ID written`)
        return { status: 'known', device: adopted }
      } catch (err) {
        console.warn('[ipod-identity] could not write the ID file:', err instanceof Error ? err.message : err)
      }
    }
  }
  const identity: IpodIdentity = { status: 'unknown', canBeOriginal: !registryHasPrimary }
  unknownCache.set(mount, { key, identity })
  return identity
}

export async function registerIpod(
  mount: string,
  stateDir: string,
  input: { asOriginal: boolean; name?: unknown; color?: unknown; purpose?: unknown },
): Promise<{ ok: true; device: IpodDeviceMarker } | { ok: false; error: string }> {
  if (await readDeviceMarker(mount)) return { ok: false, error: 'This iPod is already set up.' }
  const reg = await loadRegistry(stateDir)
  if (input.asOriginal && reg.devices.some((d) => d.primary)) {
    return { ok: false, error: 'Another iPod is already your original. Set this one up as a new iPod.' }
  }
  const marker = buildDeviceMarker({
    id: input.asOriginal ? `original-${randomUUID().slice(0, 8)}` : randomUUID(),
    name: input.name ?? (input.asOriginal ? ORIGINAL_DEFAULTS.name : undefined),
    color: input.color,
    purpose: input.purpose ?? (input.asOriginal ? ORIGINAL_DEFAULTS.purpose : undefined),
    primary: input.asOriginal,
    now: new Date().toISOString(),
  })
  if (!marker) return { ok: false, error: 'Give the iPod a name.' }
  try {
    await writeDeviceMarker(mount, marker)
  } catch (err) {
    return { ok: false, error: `Couldn’t write to the iPod: ${err instanceof Error ? err.message : 'write failed'}` }
  }
  await rememberDevice(stateDir, marker).catch(logRegistryFail)
  unknownCache.delete(mount)
  return { ok: true, device: marker }
}

/** null = this is the original iPod; otherwise why songs must not be imported off it (the one
 *  path that stays Original-only after step 2b: another iPod's card is never a source). */
export async function refuseUnlessOriginalIpod(mount: string, stateDir: string): Promise<string | null> {
  try {
    return ipodImportRefusal(await identifyIpod(mount, stateDir))
  } catch {
    return 'JakeTunes couldn’t tell which iPod this is, so it left it alone.'
  }
}
