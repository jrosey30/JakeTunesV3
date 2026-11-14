/**
 * iPod set-up IPC (2026-11-13) — the plugged-in iPod, step by step
 * (rules: common/ipod-onboarding.ts; disk work: main/ipod-onboarding.ts).
 *
 *   'ipod-setup:look' ({ listId, name, typed, recheck }) → what the app can
 *       read off the iPod, the lists it could carry, and the next step. Reads
 *       only. `recheck` asks the connection check to run again.
 *   'ipod-setup:test' → the small write-and-read-back test (its own folder,
 *       removed afterwards).
 *   'ipod-setup:prepare' ({ listId, name, color, typed, matchCover }) → only
 *       when the steps say 'prepare' for THIS look at the device: folders, a
 *       blank song database when there is none, the ID file, the drive's name,
 *       the record. Never formats, never deletes a song.
 *   'ipod-setup:checked' → Jake went through the checklist on the iPod.
 *
 * Registered from ipod-ipc.ts (the mount lives behind its host), so index.ts
 * stays as it is apart from the host's one new field.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { safeIpcError } from '../safe-ipc-error.ts'
import { IS_MAC, isIpodMount, listMountPoints, volumeNameFromMount } from '../platform.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { ipodStateDirFor } from '../ipod-identity.ts'
import { renameMacVolume } from '../ipod-rename.ts'
import { withCompanionInit } from '../hub-companion.ts'
import type { IpodList } from '../../common/ipod-list-doc.ts'
import { checkIpodName } from '../../common/ipod-name.ts'
import { normalizeIpodColor } from '../../common/ipod-covers.ts'
import {
  STABLE_READS_NEEDED, coverMismatch, ipodHealthCheck, onboardingStep,
  type IpodDeviceFacts, type IpodUsbFacts, type OnboardingProgress, type OnboardingTarget,
} from '../../common/ipod-onboarding.ts'
import {
  adoptExistingIpod, gatherIpodFacts, noteLastSync, prepareIpod, readLastSync, readOnboardingRecords, runCardTest, sealOnboarding,
  stableReads, usbFactsFromProfile, type WriteGuard,
} from '../ipod-onboarding.ts'

const execP = promisify(execFile)

export interface IpodOnboardingHost {
  stateDir: string
  getMount: () => string | null
  /** The drive was renamed: same iPod at a new path. */
  followMount: (mount: string) => void
  isSyncInFlight: () => boolean
  onDeviceChanged: () => void
  /** homemini's base URL (no /audio). */
  baseUrl: () => string
  libraryTracks: () => Promise<unknown[]>
  isReplica: () => Promise<boolean>
}

/** The USB side of the disk at `mount`. Best-effort: any trouble is null. */
async function readUsb(mount: string): Promise<IpodUsbFacts | null> {
  if (!IS_MAC) return null
  try {
    const info = await execP('diskutil', ['info', '-plist', mount], { timeout: 10_000 })
    const whole = /<key>ParentWholeDisk<\/key>\s*<string>(disk\d+)<\/string>/.exec(info.stdout)?.[1]
    if (!whole) return null
    for (const type of ['SPUSBDataType', 'SPUSBHostDataType']) {
      const out = await execP('system_profiler', [type, '-json'], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }).catch(() => null)
      const hit = out ? usbFactsFromProfile(JSON.parse(out.stdout), whole) : null
      if (hit) return hit
    }
    return null
  } catch (err) {
    console.warn('[ipod-setup] USB facts:', err instanceof Error ? err.message : err)
    return null
  }
}

export function registerIpodOnboardingIpc(ipc: IpcRegistrar, host: IpodOnboardingHost): void {
  const client = () => createIpodListClient({ baseUrl: host.baseUrl(), warn: (m) => console.warn(m) })
  // What the checks found, kept only while the same drive stays plugged in.
  let seen: { mount: string; stable: IpodDeviceFacts['stable']; writeTest: IpodDeviceFacts['writeTest']; usb?: IpodUsbFacts | null } | null = null
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const otherIpods = async (mount: string): Promise<number> => {
    let n = 0
    for (const m of await listMountPoints()) if (m !== mount && await isIpodMount(m)) n++
    return n
  }

  async function facts(mount: string, recheck: boolean): Promise<IpodDeviceFacts> {
    if (!seen || seen.mount !== mount) seen = { mount, stable: null, writeTest: null }
    if (recheck || !seen.stable) seen.stable = await stableReads(mount, STABLE_READS_NEEDED, 400, sleep)
    const replica = await host.isReplica().catch(() => false)
    return gatherIpodFacts(mount, {
      mountTable: async () => (IS_MAC ? (await execP('/sbin/mount', [], { timeout: 5000 })).stdout : ''),
      otherIpods: () => otherIpods(mount),
      // The USB report takes a second or two; one per plug-in is enough.
      usb: async (m) => {
        if (seen && seen.mount === m && seen.usb !== undefined && !recheck) return seen.usb
        const usb = await readUsb(m)
        if (seen && seen.mount === m) seen.usb = usb
        return usb
      },
      syncInFlight: host.isSyncInFlight,
      role: replica ? 'replica' : 'hub',
    }, seen)
  }

  async function listBytes(list: IpodList): Promise<number | null> {
    try {
      const want = new Set(list.ids)
      let bytes = 0
      let found = 0
      for (const t of await host.libraryTracks()) {
        const r = t as { id?: unknown; fileSize?: unknown } | null
        if (r && want.has(Number(r.id)) && Number(r.fileSize) > 0) { bytes += Number(r.fileSize); found++ }
      }
      return found > 0 ? bytes : null
    } catch (err) {
      console.warn('[ipod-setup] sizing the list:', err instanceof Error ? err.message : err)
      return null
    }
  }

  async function targetFor(listId: unknown, lists: IpodList[]): Promise<OnboardingTarget | null> {
    if (listId === 'new') return { kind: 'new' }
    const list = typeof listId === 'string' ? lists.find((l) => l.id === listId) : undefined
    if (!list) return null
    return { kind: 'list', listId: list.id, listName: list.name, songs: list.ids.length, bytes: await listBytes(list), model: list.model ?? null, color: list.color ?? null }
  }

  async function bpmFor(listId: string): Promise<OnboardingProgress['bpm']> {
    try {
      const res = await fetch(`${host.baseUrl().replace(/\/+$/, '')}/api/bpm-key/summary`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(6000) }) as RequestInit)
      if (res.status !== 200) return null
      const body = await res.json() as { lists?: Array<{ id?: unknown; songs?: unknown; verified?: unknown; resolved?: unknown }> }
      const row = body.lists?.find((l) => l.id === listId)
      if (!row) return null
      return { checked: (Number(row.verified) || 0) + (Number(row.resolved) || 0), total: Number(row.songs) || 0 }
    } catch {
      return null
    }
  }

  async function look(arg: { listId?: unknown; name?: unknown; typed?: unknown; recheck?: unknown } | undefined) {
    const mount = host.getMount()
    const records = await readOnboardingRecords(host.stateDir)
    const blank: OnboardingProgress = { firstSync: null, listSongs: null, playlists: 'not-built-yet', bpm: null }
    if (!mount) {
      const replica = await host.isReplica().catch(() => false)
      return { ok: true as const, mounted: false, step: onboardingStep({ facts: replica ? ({ role: 'replica' } as IpodDeviceFacts) : null, target: null, name: null, typed: null, records, progress: blank }), targets: [], cover: null, health: null, record: null }
    }
    const f = await facts(mount, arg?.recheck === true)
    const lists = (await client().all()) ?? []
    const target = await targetFor(arg?.listId, lists)
    const marker = f.marker
    const mine = marker ? lists.find((l) => l.id === marker.id) ?? null : null
    const last = marker ? await readLastSync(ipodStateDirFor(host.stateDir, marker)) : null
    if (marker && !marker.primary) {
      // An iPod from before records were kept gets one now; a sealed sync seen here goes onto it.
      await adoptExistingIpod(host.stateDir, f, new Date().toISOString())
        .then(() => noteLastSync(host.stateDir, marker))
        .catch((err) => console.warn('[ipod-setup] record:', err instanceof Error ? err.message : err))
    }
    const fresh = marker ? await readOnboardingRecords(host.stateDir) : records
    const progress: OnboardingProgress = {
      firstSync: last?.sealed ? { songs: last.songs, at: last.at } : null,
      listSongs: mine?.ids.length ?? null,
      playlists: 'not-built-yet',
      bpm: marker && !marker.primary && !target ? await bpmFor(marker.id) : null,
    }
    const tailTarget = !target && mine ? await targetFor(mine.id, lists) : target
    const step = onboardingStep({
      facts: f, target: target ?? (marker && !marker.primary ? tailTarget : null),
      name: typeof arg?.name === 'string' && arg.name.trim() ? arg.name : null,
      typed: typeof arg?.typed === 'string' ? arg.typed : null,
      records: fresh, progress,
    })
    const record = marker ? fresh.find((r) => r.listId === marker.id) ?? null : null
    return {
      ok: true as const,
      mounted: true,
      step,
      targets: lists.map((l) => ({ listId: l.id, listName: l.name, songs: l.ids.length, model: l.model ?? null, color: l.color ?? null, hasIpod: fresh.some((r) => r.listId === l.id && !r.released) })),
      cover: coverMismatch(target, f),
      health: marker ? ipodHealthCheck({ facts: f, record, list: mine ? { name: mine.name, songs: mine.ids.length } : null, lastSync: last }) : null,
      record,
    }
  }

  const guardFor = (f: IpodDeviceFacts, mount: string): WriteGuard =>
    ({ markerAtChecks: f.marker, otherIpods: () => otherIpods(mount), syncInFlight: host.isSyncInFlight })

  ipc.handle('ipod-setup:look', async (_e, arg) => {
    try { return await look(arg as Parameters<typeof look>[0]) } catch (err) { return { ok: false as const, error: safeIpcError(err, 'io-failed') } }
  }, { public: true })

  ipc.handle('ipod-setup:test', async () => {
    try {
      const mount = host.getMount()
      if (!mount) return { ok: false, error: 'No iPod is plugged in.' }
      const f = await facts(mount, false)
      const r = await runCardTest(mount, guardFor(f, mount), { quick: true })
      if (seen && seen.mount === mount) seen.writeTest = r
      return { ok: true, result: r }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('ipod-setup:prepare', async (_e, raw) => {
    try {
      const arg = (raw ?? {}) as { listId?: unknown; name?: unknown; color?: unknown; typed?: unknown; matchCover?: unknown }
      const mount = host.getMount()
      if (!mount) return { ok: false, error: 'No iPod is plugged in.' }
      const f = await facts(mount, false)
      const lists = (await client().all()) ?? []
      const target = await targetFor(arg.listId, lists)
      if (!target) return { ok: false, error: 'Pick the list this iPod will carry first. homemini may not be answering; nothing on the iPod was changed.' }
      const records = await readOnboardingRecords(host.stateDir)
      const name = typeof arg.name === 'string' && arg.name.trim() ? arg.name : null
      const step = onboardingStep({
        facts: f, target, name, typed: typeof arg.typed === 'string' ? arg.typed : null, records,
        progress: { firstSync: null, listSongs: null, playlists: 'not-built-yet', bpm: null },
      })
      // The rules, asked again against the device as it is now, must say 'prepare'.
      if (step.step !== 'prepare') {
        const why = step.step === 'refused' || step.step === 'checks' || step.step === 'name' ? step.line : step.step === 'confirm' ? `Type “${step.phrase}” to go on.` : 'This iPod isn’t at the set-up step.'
        return { ok: false, error: `${why} Nothing on the iPod was changed.`, step }
      }
      const checked = checkIpodName(name ?? (target.kind === 'list' ? target.listName : null))
      if (!checked.ok) return { ok: false, error: checked.error }
      const color = normalizeIpodColor(arg.color) ?? (target.kind === 'list' ? target.color : null)
      const list = target.kind === 'list' ? lists.find((l) => l.id === target.listId) ?? null : null
      const done = await prepareIpod(mount, host.stateDir, guardFor(f, mount), {
        listId: target.kind === 'list' ? target.listId : null,
        name: checked.name, color, purpose: list?.purpose ?? null, facts: f, now: new Date().toISOString(),
      })
      if (!done.ok) return done
      const notes: string[] = []
      // The drive's own name. The ID file and the record are already right if this fails.
      if (IS_MAC && volumeNameFromMount(mount).toUpperCase() !== checked.macShows) {
        try {
          const moved = await renameMacVolume(mount, checked.name)
          if (moved && moved !== mount) { host.followMount(moved); seen = null }
        } catch (err) {
          notes.push(`The Mac kept the drive’s old name (${err instanceof Error ? err.message : 'diskutil refused'}). Rename it from the Device page.`)
        }
      }
      // The list's picture: the real model, and the colour Jake picked.
      const mismatch = coverMismatch(target, f)
      if (target.kind === 'list' && (color !== target.color || (arg.matchCover === true && mismatch))) {
        const body = { ...(color && color !== target.color ? { color } : {}), ...(arg.matchCover === true && mismatch ? { model: mismatch.model } : {}) }
        const res = await fetch(`${host.baseUrl().replace(/\/+$/, '')}/api/ipod-lists/${encodeURIComponent(target.listId)}`, withCompanionInit({
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
        }) as RequestInit).catch(() => null)
        if (!res || res.status !== 200) notes.push('homemini didn’t take the new picture just now. Set it from the list’s “iPod color…” menu.')
      }
      host.onDeviceChanged()
      return { ok: true, device: done.device, record: done.record, did: done.did, notes }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('ipod-setup:checked', async () => {
    try {
      const mount = host.getMount()
      if (!mount) return { ok: false, error: 'No iPod is plugged in.' }
      const f = await facts(mount, false)
      if (!f.marker || f.marker.primary) return { ok: false, error: 'This iPod isn’t one that was set up here.' }
      const r = await sealOnboarding(host.stateDir, f.marker, new Date().toISOString())
      if (r.ok) host.onDeviceChanged()
      return r
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })
}
