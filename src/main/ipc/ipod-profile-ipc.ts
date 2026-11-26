/**
 * The Device page's iPod format setting (Brief 265 Part 2): read and change the audio profile of
 * the iPod plugged in. The rules are common/ipod-audio-format.ts; the file is
 * main/ipod-audio-profiles.ts (main is its only writer).
 *
 *   ipod-audio-profile:get   { ok, ipod: { name, primary } | null, profile, source }
 *                            source: 'stored' (set here), 'seed' (Jake's table), 'device-page'
 *                            (no profile: the Device page's convert setting applies)
 *   ipod-audio-profile:set   { codec, kbps?, enabled? } or { reset: true } (back to the seed),
 *                            with expectedId: the iPod the page showed (a mismatch is refused)
 *
 * Stored under the iPod's serial from its set-up record when it has one, else under the id in
 * its ID file, the same keys a sync reads (profileForSync). Refused while a sync runs.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { readDeviceMarker } from '../ipod-identity.ts'
import { readOnboardingRecords } from '../ipod-onboarding.ts'
import { profileStorePath, readProfileStore, updateProfileStore } from '../ipod-audio-profiles.ts'
import {
  SEED_PROFILES, parseProfile, resolveIpodAudioProfile, serialProfileKey, type IpodAudioProfile, type IpodRef,
} from '../../common/ipod-audio-format.ts'

export interface IpodProfileHost {
  stateDir: string
  getMount: () => string | null
  syncInFlight: () => boolean
}

type ProfileSource = 'stored' | 'seed' | 'device-page'

async function currentIpod(host: IpodProfileHost): Promise<{ ref: IpodRef; id: string; name: string; primary: boolean } | null> {
  const mount = host.getMount()
  if (!mount) return null
  const marker = await readDeviceMarker(mount)
  if (!marker) return null
  const rec = (await readOnboardingRecords(host.stateDir)).find((r) => r.listId === marker.id && !r.released) ?? null
  return { ref: { serial: rec?.serial ?? null, deviceId: marker.id, primary: !!marker.primary }, id: marker.id, name: marker.name, primary: !!marker.primary }
}

/** Where a resolved profile came from, for the page's wording. */
export function profileSource(store: Record<string, IpodAudioProfile>, ref: IpodRef): ProfileSource {
  const sk = serialProfileKey(ref.serial)
  if ((sk && store[sk]) || (ref.deviceId && store[ref.deviceId]) || (ref.listId && store[ref.listId])) return 'stored'
  if ((ref.deviceId && SEED_PROFILES.has(ref.deviceId)) || ref.primary) return 'seed'
  return 'device-page'
}

export function registerIpodProfileIpc(ipc: IpcRegistrar, host: IpodProfileHost): void {
  const file = () => profileStorePath(host.stateDir)

  ipc.handle('ipod-audio-profile:get', async () => {
    const ipod = await currentIpod(host)
    if (!ipod) return { ok: true, ipod: null, profile: null, source: 'device-page' as ProfileSource }
    const read = await readProfileStore(file())
    if (!read.ok) return { ok: false, error: `Couldn’t read the iPod format settings on this Mac (${read.reason}).` }
    return {
      ok: true,
      ipod: { id: ipod.id, name: ipod.name, primary: ipod.primary },
      profile: resolveIpodAudioProfile(read.store, ipod.ref),
      source: profileSource(read.store, ipod.ref),
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('ipod-audio-profile:set', async (_e, raw) => {
    if (host.syncInFlight()) return { ok: false, error: 'An iPod sync is running. Change the format when it’s done.' }
    const ipod = await currentIpod(host)
    if (!ipod) return { ok: false, error: 'Plug in the iPod first.' }
    // Saved only for the iPod the page showed: one swapped in while Options was open is refused.
    const expected = (raw as { expectedId?: unknown } | null)?.expectedId
    if (typeof expected !== 'string' || expected !== ipod.id) return { ok: false, error: 'A different iPod is plugged in now. Open Options again to set its format.' }
    const key = serialProfileKey(ipod.ref.serial) ?? ipod.ref.deviceId ?? null
    if (!key) return { ok: false, error: 'This iPod hasn’t been set up yet.' }
    const arg = (raw ?? {}) as { reset?: unknown; codec?: unknown; kbps?: unknown; enabled?: unknown }
    let profile: IpodAudioProfile | null = null
    if (arg.reset !== true) {
      profile = parseProfile({ codec: arg.codec, kbps: arg.kbps, enabled: arg.enabled !== false })
      if (!profile) return { ok: false, error: 'Pick ALAC, AAC or MP3, and a bitrate for AAC or MP3.' }
    }
    const written = await updateProfileStore(file(), (store) => {
      const next = { ...store }
      // One entry per iPod: under its key, never also under the other one.
      for (const k of [ipod.ref.deviceId, serialProfileKey(ipod.ref.serial)]) if (k && k !== key) delete next[k]
      if (profile) next[key] = profile
      else delete next[key]
      return next
    })
    if (!written.ok) return { ok: false, error: `Couldn’t save the iPod format setting on this Mac (${written.reason}).` }
    console.log(`[ipod-profile] ${ipod.name}: ${profile ? `${profile.codec}${profile.kbps ? ` ${profile.kbps}k` : ''}${profile.enabled ? '' : ' (off)'}` : 'back to its default'} (${key.startsWith('serial:') ? 'by serial' : 'by its ID file'})`)
    return {
      ok: true,
      ipod: { id: ipod.id, name: ipod.name, primary: ipod.primary },
      profile: resolveIpodAudioProfile(written.store, ipod.ref),
      source: profileSource(written.store, ipod.ref),
    }
  }, { refuse: REFUSED_SENDER })
}
