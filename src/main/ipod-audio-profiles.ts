/**
 * Each iPod's stored audio profile, on disk (Brief 265 Part 2). The rules are in
 * common/ipod-audio-format.ts; this file only reads and writes them.
 *
 * Their own file (ipod-audio-profiles.json in the state dir), written only here, one write
 * at a time, by rename. Not ui-state.json: the renderer saves ui-state by loading, spreading
 * and saving the whole object, and an old copy in a save would put an old profile back.
 *
 * A file that exists but can't be read is NOT "no profiles": guessing would fall back to the
 * seeds and could re-copy a whole iPod. The sync refuses instead (readProfileStore → ok:false).
 * A missing file is an empty store (no profile has been set yet).
 */
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  IPOD_AUDIO_PROFILES_FILE, adoptProfile, carryProfileOnMove, parseProfileStore, resolveIpodAudioProfile,
  type IpodAudioProfile, type IpodRef, type ProfileStore,
} from '../common/ipod-audio-format.ts'

export function profileStorePath(stateDir: string): string {
  return join(stateDir, IPOD_AUDIO_PROFILES_FILE)
}

export type StoreRead = { ok: true; store: ProfileStore } | { ok: false; reason: string }

export async function readProfileStore(file: string): Promise<StoreRead> {
  let text: string
  try {
    text = await readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, store: {} }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  try {
    const raw = JSON.parse(text) as { profiles?: unknown }
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the file is not a profile list' }
    return { ok: true, store: parseProfileStore(raw.profiles) }
  } catch (err) {
    return { ok: false, reason: `the file can't be read (${err instanceof Error ? err.message : String(err)})` }
  }
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Change the store under one lock: read, change, write by rename. `change` returning null writes nothing. */
export function updateProfileStore(file: string, change: (store: ProfileStore) => ProfileStore | null): Promise<StoreRead> {
  const run = writeChain.then(async (): Promise<StoreRead> => {
    const cur = await readProfileStore(file)
    if (!cur.ok) return cur
    const next = change(cur.store)
    if (!next) return cur
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify({ version: 1, profiles: next }, null, 2), 'utf-8')
    await rename(tmp, file)
    return { ok: true, store: next }
  })
  writeChain = run.catch((err) => console.warn('[ipod-profiles] write failed:', err instanceof Error ? err.message : err))
  return run
}

/** The sentence a sync shows when the profile file can't be read. */
export function profileStoreRefusal(reason: string): string {
  return `Couldn’t read the iPod format settings on this Mac (${reason}), so the sync did not start. Nothing on the iPod was changed.`
}

/**
 * The profile for a sync: the store read (refusing when it can't be), a list-id entry moved
 * onto the serial key first when both are known, then resolved.
 */
export async function profileForSync(file: string, ipod: IpodRef): Promise<{ ok: true; profile: IpodAudioProfile | null } | { ok: false; reason: string }> {
  const read = ipod.serial
    ? await updateProfileStore(file, (store) => adoptProfile(store, ipod))
    : await readProfileStore(file)
  if (!read.ok) return read
  return { ok: true, profile: resolveIpodAudioProfile(read.store, ipod) }
}

/** iPod set-up moved this card to another list: its profile goes with it. */
export async function carryProfileForMovedCard(file: string, move: { fromId: string; toId: string; serial?: string | null }): Promise<void> {
  const r = await updateProfileStore(file, (store) => carryProfileOnMove(store, move))
  if (!r.ok) console.warn(`[ipod-profiles] couldn't carry the profile to the new list: ${r.reason}`)
}
