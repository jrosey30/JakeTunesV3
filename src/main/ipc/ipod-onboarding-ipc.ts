/**
 * iPod set-up IPC (2026-11-13) — the plugged-in iPod, step by step
 * (rules: common/ipod-onboarding.ts; disk work: main/ipod-onboarding.ts).
 *
 * ONE look decides everything (`survey`): it reads the device, asks the rules
 * for the step, and every handler that writes then asks the same gate
 * (common's onboardingActionRefusal) with that step. A handler never acts on
 * a step the strip wouldn't be showing.
 *
 *   'ipod-setup:look' ({ listId, name, typed, recheck }) → the facts, the
 *       lists, the next step. A look NEVER writes to the iPod.
 *   'ipod-setup:test' ({ listId, name }) → the small test file. The strip asks
 *       for it by itself once a list is picked; it is still its own step.
 *   'ipod-setup:card-proof' → read back the first and last songs the first sync
 *       wrote (ipod-card-proof.ts). Reads only.
 *   'ipod-setup:same-ipod' ({ typed }) → "this is the same iPod with a new card
 *       or body": only when the record and the device disagree, only with the
 *       typed words; the record takes the new serial and size. Never automatic.
 *   'ipod-setup:prepare' ({ listId, name, color, typed, matchCover }) → only
 *       when the step is 'prepare'. Never formats, never deletes a song.
 *   'ipod-setup:checked' → only at the proof step.
 *   'ipod-setup:readopt-original' → only when the look says "this looks like
 *       your Original": its ID file goes back on, unchanged.
 *   'register-ipod-device' → "This is my original iPod" (no Original on this
 *       Mac yet). Any other iPod goes through the steps above.
 *
 * Which drive: the drive's identity comes from the system (volume UUID + size,
 * and the USB serial), never from its path or name. What the checks found is
 * kept only for that identity, dropped when it changes or the iPod is
 * unplugged, and asked for again immediately before every write.
 *
 * Only the MacBook: a Mac that is a replica, or that can't say whether it is,
 * is refused before anything is read or written.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { ipodStateDirFor, registerIpod, restoreOriginalMarker, setIpodSyncHealthGate } from '../ipod-identity.ts'
import { withCompanionInit } from '../hub-companion.ts'
import { flushCardProof, startCardProof, verifyCardProof } from '../ipod-card-proof.ts'
import type { FetchLike } from '../top1000-client.ts'
import type { IpodSetupSystem } from '../ipod-onboarding-system.ts'
import type { IpodDeviceMarker } from '../../common/ipod-identity.ts'
import type { IpodList } from '../../common/ipod-list-doc.ts'
import { checkIpodName } from '../../common/ipod-name.ts'
import { normalizeIpodColor } from '../../common/ipod-covers.ts'
import {
  STABLE_READS_NEEDED, confirmationMatches, coverMismatch, healthBlindRefusal, healthSyncRefusal, ipodHealthCheck,
  onboardingActionRefusal, onboardingStep, rebindRecord, replacedLabel, sameIpodOffer,
  type IpodDeviceFacts, type OnboardingAction, type OnboardingProgress, type OnboardingStep, type OnboardingTarget,
} from '../../common/ipod-onboarding.ts'
import {
  adoptExistingIpod, currentDriveId, gatherIpodFacts, guard, noteLastSync, prepareIpod, readLastSync, readOnboardingRecords,
  runCardTest, sealOnboarding, stableReads, updateOnboardingRecord, type WriteGuard,
} from '../ipod-onboarding.ts'

export interface IpodOnboardingHost {
  stateDir: string
  getMount: () => string | null
  /** The drive was renamed: same iPod at a new path. */
  followMount: (mount: string) => void
  isSyncInFlight: () => boolean
  onDeviceChanged: () => void
  /** The Original was (re)identified: its plays can come home. */
  onOriginalKnown?: (mount: string) => void
  /** homemini's base URL (no /audio). */
  baseUrl: () => string
  libraryTracks: () => Promise<unknown[]>
  isReplica: () => Promise<boolean>
  system: IpodSetupSystem
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

const NOT_THE_HUB = 'Only the MacBook sets up and syncs iPods. Nothing on the iPod was changed.'
const message = (err: unknown): string => (err instanceof Error ? err.message : 'something went wrong')

interface Survey {
  mount: string
  facts: IpodDeviceFacts
  lists: IpodList[]
  target: OnboardingTarget | null
  step: OnboardingStep
  marker: IpodDeviceMarker | null
  mine: IpodList | null
  last: Awaited<ReturnType<typeof readLastSync>>
}
type LookArg = { listId?: unknown; name?: unknown; typed?: unknown; recheck?: unknown } | undefined

export function registerIpodOnboardingIpc(ipc: IpcRegistrar, host: IpodOnboardingHost): void {
  const fetchImpl: FetchLike = host.fetchImpl ?? (fetch as unknown as FetchLike)
  const client = () => createIpodListClient({ baseUrl: host.baseUrl(), fetchImpl, warn: (m) => console.warn(m) })
  const sleep = host.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // What the checks found, for ONE drive (its system identity + USB serial). Never keyed by path.
  let seen: { key: string; stable: IpodDeviceFacts['stable']; writeTest: IpodDeviceFacts['writeTest'] } | null = null

  /** A Mac that is a replica, or can't say, is not the MacBook. */
  const isHub = (): Promise<boolean> => host.isReplica().then((r) => r !== true, () => false)

  async function readFacts(mount: string, recheck: boolean): Promise<IpodDeviceFacts> {
    const deps = {
      mountTable: host.system.mountTable,
      otherIpods: () => host.system.otherIpods(mount),
      usb: host.system.usb,
      driveId: host.system.driveId,
      stateDir: host.stateDir,
      syncInFlight: host.isSyncInFlight,
      role: 'hub' as const,
    }
    const first = await gatherIpodFacts(mount, deps)
    const key = `${first.driveId ?? ''}|${first.usb?.serial ?? ''}`
    // A different drive (even at the same path, with the same name) starts from nothing.
    if (!first.driveId || !seen || seen.key !== key) seen = first.driveId ? { key, stable: null, writeTest: null } : null
    if (seen && (recheck || !seen.stable)) seen.stable = await stableReads(mount, STABLE_READS_NEEDED, 400, sleep)
    return { ...first, stable: seen?.stable ?? null, writeTest: seen?.writeTest ?? null }
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
      console.warn('[ipod-setup] sizing the list:', message(err))
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
      const res = await fetchImpl(`${host.baseUrl().replace(/\/+$/, '')}/api/bpm-key/summary`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(6000) }) as Record<string, unknown>)
      if (res.status !== 200) return null
      const body = await res.json() as { lists?: Array<{ id?: unknown; songs?: unknown; verified?: unknown; resolved?: unknown }> }
      const row = body.lists?.find((l) => l.id === listId)
      if (!row) return null
      return { checked: (Number(row.verified) || 0) + (Number(row.resolved) || 0), total: Number(row.songs) || 0 }
    } catch {
      return null
    }
  }

  const guardFor = (f: IpodDeviceFacts, mount: string): WriteGuard => ({
    markerAtChecks: f.marker,
    otherIpods: () => host.system.otherIpods(mount),
    syncInFlight: host.isSyncInFlight,
    // The system is asked again, now: is this still the drive the checks ran on?
    sameDrive: async () => f.driveId !== null && (await currentDriveId(mount, host.system)) === f.driveId,
  })

  /**
   * The one look every handler starts from. null = no iPod, or not the MacBook
   * (the caller says which). Reads only, except: an iPod set up before records
   * were kept gets its record (this Mac's own state dir, hub only).
   */
  async function survey(arg: LookArg): Promise<Survey | { refused: OnboardingStep }> {
    const blank: OnboardingProgress = { firstSync: null, listSongs: null, playlists: 'not-built-yet', bpm: null }
    const none = (facts: IpodDeviceFacts | null) => ({ refused: onboardingStep({ facts, target: null, name: null, typed: null, records: [], progress: blank }) })
    if (!(await isHub())) return none({ role: 'replica' } as IpodDeviceFacts)
    const mount = host.getMount()
    if (!mount) { seen = null; return none(null) }
    const facts = await readFacts(mount, arg?.recheck === true)
    const lists = (await client().all()) ?? []
    const target = await targetFor(arg?.listId, lists)
    const marker = facts.marker
    const mine = marker ? lists.find((l) => l.id === marker.id) ?? null : null
    const last = marker ? await readLastSync(ipodStateDirFor(host.stateDir, marker)) : null
    if (marker) {
      await adoptExistingIpod(host.stateDir, facts, new Date().toISOString())
        .then(() => noteLastSync(host.stateDir, marker))
        .catch((err) => console.warn('[ipod-setup] record:', message(err)))
    }
    const records = await readOnboardingRecords(host.stateDir)
    const progress: OnboardingProgress = {
      firstSync: last?.sealed ? { songs: last.songs, at: last.at } : null,
      listSongs: mine?.ids.length ?? null,
      playlists: 'not-built-yet',
      bpm: marker && !marker.primary && !target ? await bpmFor(marker.id) : null,
    }
    const tail = !target && mine && marker && !marker.primary ? await targetFor(mine.id, lists) : null
    const step = onboardingStep({
      facts, target: target ?? tail,
      name: typeof arg?.name === 'string' && arg.name.trim() ? arg.name : null,
      typed: typeof arg?.typed === 'string' ? arg.typed : null,
      records, progress,
    })
    return { mount, facts, lists, target, step, marker, mine, last }
  }

  /** May `action` go ahead now? The survey, then the same rule for every handler. */
  async function mayAct(action: OnboardingAction, arg: LookArg): Promise<{ ok: true; s: Survey } | { ok: false; error: string; step: OnboardingStep }> {
    const s = await survey(arg)
    if ('refused' in s) return { ok: false, error: s.refused.step === 'refused' ? s.refused.line : NOT_THE_HUB, step: s.refused }
    const refusal = onboardingActionRefusal(action, s.step)
    return refusal ? { ok: false, error: refusal, step: s.step } : { ok: true, s }
  }

  async function runTest(s: Survey) {
    const r = await runCardTest(s.mount, guardFor(s.facts, s.mount), { quick: true })
    if (seen) seen.writeTest = r
    return r
  }

  ipc.handle('ipod-setup:look', async (_e, raw) => {
    try {
      const arg = raw as LookArg
      const s = await survey(arg)
      if ('refused' in s) return { ok: true as const, mounted: host.getMount() !== null, step: s.refused, targets: [], cover: null, health: null, record: null }
      const records = await readOnboardingRecords(host.stateDir)
      const record = s.marker ? records.find((r) => r.listId === s.marker!.id) ?? null : null
      return {
        ok: true as const,
        mounted: true,
        step: s.step,
        targets: s.lists.map((l) => ({ listId: l.id, listName: l.name, songs: l.ids.length, model: l.model ?? null, color: l.color ?? null, hasIpod: records.some((r) => r.listId === l.id && !r.released) })),
        cover: coverMismatch(s.target, s.facts),
        health: s.marker ? ipodHealthCheck({ facts: s.facts, record, list: s.mine ? { name: s.mine.name, songs: s.mine.ids.length } : null, lastSync: s.last }) : null,
        sameIpod: sameIpodOffer(s.facts, record),
        record,
      }
    } catch (err) {
      return { ok: false as const, error: `JakeTunes couldn’t look at the iPod (${message(err)}). Nothing on it was changed.` }
    }
  }, { public: true })

  ipc.handle('ipod-setup:test', async (_e, raw) => {
    try {
      const act = await mayAct('test', raw as LookArg)
      if (!act.ok) return act
      return { ok: true, result: await runTest(act.s) }
    } catch (err) {
      return { ok: false, error: `The test couldn’t run (${message(err)}).` }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('ipod-setup:prepare', async (_e, raw) => {
    try {
      const arg = (raw ?? {}) as { listId?: unknown; name?: unknown; color?: unknown; typed?: unknown; matchCover?: unknown }
      const act = await mayAct('prepare', arg)
      if (!act.ok) return act
      const { s } = act
      const { mount, facts: f, target } = s
      if (!target || s.step.step !== 'prepare') return { ok: false, error: 'Pick the list this iPod will carry first. Nothing on the iPod was changed.' }
      const checked = checkIpodName(s.step.name)
      if (!checked.ok) return { ok: false, error: checked.error }
      const color = normalizeIpodColor(arg.color) ?? (target.kind === 'list' ? target.color : null)
      const list = target.kind === 'list' ? s.lists.find((l) => l.id === target.listId) ?? null : null
      const done = await prepareIpod(mount, host.stateDir, guardFor(f, mount), {
        listId: target.kind === 'list' ? target.listId : null,
        name: checked.name, color, purpose: list?.purpose ?? null, facts: f, now: new Date().toISOString(),
        // Only the typed words move an iPod that already carries a list.
        confirmedMove: f.marker !== null && confirmationMatches(replacedLabel(f), arg.typed),
      })
      if (!done.ok) return done
      const notes: string[] = []
      // The drive's own name. The ID file and the record are already right if this fails.
      if ((f.volumeLabel ?? '').toUpperCase() !== checked.macShows) {
        try {
          const moved = await host.system.renameVolume(mount, checked.name)
          if (moved && moved !== mount) host.followMount(moved)
        } catch (err) {
          notes.push(`The Mac kept the drive’s old name (${message(err)}). Rename it from the Device page.`)
        }
      }
      // The list's picture: the real model, and the colour Jake picked.
      const mismatch = coverMismatch(target, f)
      if (target.kind === 'list' && ((color && color !== target.color) || (arg.matchCover === true && mismatch))) {
        const body = { ...(color && color !== target.color ? { color } : {}), ...(arg.matchCover === true && mismatch ? { model: mismatch.model } : {}) }
        const res = await fetchImpl(`${host.baseUrl().replace(/\/+$/, '')}/api/ipod-lists/${encodeURIComponent(target.listId)}`, withCompanionInit({
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
        }) as Record<string, unknown>).catch(() => null)
        if (!res || res.status !== 200) notes.push('homemini didn’t take the new picture just now. Set it from the list’s “iPod color…” menu.')
      }
      host.onDeviceChanged()
      return { ok: true, device: done.device, record: done.record, did: done.did, notes }
    } catch (err) {
      return { ok: false, error: `Setting up didn’t finish (${message(err)}).` }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('ipod-setup:checked', async () => {
    try {
      const act = await mayAct('seal', undefined)
      if (!act.ok) return act
      if (!act.s.marker) return { ok: false, error: 'This iPod isn’t one that was set up here.' }
      // The card check is the last check. A fail, or a check still waiting for a replug, is not a pass;
      // one that can't run at all says so and leaves the play test as the check.
      await flushCardProof().catch((err) => console.warn('[ipod-setup] card check:', message(err)))
      const proof = await verifyCardProof(act.s.mount, act.s.marker.id)
      if (proof.status === 'fail' || proof.status === 'waiting') return { ok: false, error: proof.line, cardProof: proof }
      const r = await sealOnboarding(host.stateDir, act.s.marker, new Date().toISOString())
      if (r.ok) host.onDeviceChanged()
      return r
    } catch (err) {
      return { ok: false, error: `That couldn’t be saved (${message(err)}).` }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('ipod-setup:card-proof', async () => {
    try {
      const s = await survey(undefined)
      if ('refused' in s) return { ok: false, error: s.refused.step === 'refused' ? s.refused.line : NOT_THE_HUB }
      if (!s.marker || s.marker.primary) return { ok: false, error: 'This iPod isn’t one that is being set up.' }
      await flushCardProof().catch((err) => console.warn('[ipod-setup] card check:', message(err)))
      return { ok: true, cardProof: await verifyCardProof(s.mount, s.marker.id) }
    } catch (err) {
      return { ok: false, error: `The card check couldn’t run (${message(err)}).` }
    }
  }, { refuse: REFUSED_SENDER })

  // The same iPod with a new card or body (a bigger card cloned into punkPod). Explicit and
  // typed; the record on this Mac takes the new serial and size. Nothing on the iPod is written.
  ipc.handle('ipod-setup:same-ipod', async (_e, raw) => {
    try {
      const s = await survey(undefined)
      if ('refused' in s) return { ok: false, error: s.refused.step === 'refused' ? s.refused.line : NOT_THE_HUB }
      const marker = s.marker
      const record = marker ? (await readOnboardingRecords(host.stateDir)).find((r) => r.listId === marker.id && !r.released) ?? null : null
      const offer = sameIpodOffer(s.facts, record)
      if (!marker || !record || !offer) return { ok: false, error: 'This iPod is the one on record. There is nothing to confirm.' }
      const typed = (raw as { typed?: unknown } | undefined)?.typed
      if (typeof typed !== 'string' || typed.replace(/\s+/g, ' ').trim() !== offer.phrase) return { ok: false, error: `Type “${offer.phrase}” to confirm. Nothing was changed.` }
      const next = await updateOnboardingRecord(host.stateDir, marker.id, (cur) => (cur ? rebindRecord(cur, s.facts, new Date().toISOString()) : null))
      host.onDeviceChanged()
      return { ok: true, record: next }
    } catch (err) {
      return { ok: false, error: `That couldn’t be saved (${message(err)}).` }
    }
  }, { refuse: REFUSED_SENDER })

  // The Original lost its ID file and the look says so: its own ID goes back on. Never offered,
  // and never done, for a drive the rules don't recognise as the Original.
  ipc.handle('ipod-setup:readopt-original', async () => {
    try {
      const s = await survey(undefined)
      if ('refused' in s) return { ok: false, error: s.refused.step === 'refused' ? s.refused.line : NOT_THE_HUB }
      if (s.step.step !== 'refused' || s.step.why !== 'looks-like-the-original') {
        return { ok: false, error: 'JakeTunes doesn’t recognise this iPod as your Original. Nothing on it was changed.' }
      }
      const refusal = await guard(s.mount, guardFor(s.facts, s.mount))
      if (refusal) return { ok: false, error: refusal }
      const r = await restoreOriginalMarker(s.mount, host.stateDir)
      if (r.ok) { host.onOriginalKnown?.(s.mount); host.onDeviceChanged() }
      return r
    } catch (err) {
      return { ok: false, error: `The ID file couldn’t be written (${message(err)}).` }
    }
  }, { refuse: REFUSED_SENDER })

  // "This is my original iPod": only that. Any other iPod is set up through the steps above
  // (2026-11-14: this handler used to register any iPod with none of the checks).
  ipc.handle('register-ipod-device', async (_e, input: { asOriginal?: boolean } | undefined) => {
    try {
      if (input?.asOriginal !== true) return { ok: false, error: 'Use “Set up this iPod”. Nothing on the iPod was changed.' }
      if (!(await isHub())) return { ok: false, error: NOT_THE_HUB }
      if (host.isSyncInFlight()) return { ok: false, error: 'Wait for the sync to finish.' }
      const mount = host.getMount()
      if (!mount) return { ok: false, error: 'No iPod detected' }
      if (await host.system.otherIpods(mount).catch(() => 1)) return { ok: false, error: 'Two iPods are plugged in. Unplug the one that isn’t your Original. Nothing was changed.' }
      const r = await registerIpod(mount, host.stateDir, { asOriginal: true })
      // Newly identified as the original: its plays can come home now.
      if (r.ok) { host.onOriginalKnown?.(mount); host.onDeviceChanged() }
      return r
    } catch (err) {
      return { ok: false, error: `The ID file couldn’t be written (${message(err)}).` }
    }
  }, { refuse: REFUSED_SENDER })

  // A health "stop" stops a sync (ipod-identity.ts resolveIpodState, forSync). The check is the
  // plug-in check, on fresh facts. On a Mac that isn't the hub nothing syncs an iPod anyway.
  setIpodSyncHealthGate(async (mount, device) => {
    const facts = await gatherIpodFacts(mount, {
      mountTable: host.system.mountTable,
      otherIpods: () => host.system.otherIpods(mount),
      usb: host.system.usb,
      driveId: host.system.driveId,
      syncInFlight: host.isSyncInFlight,
      role: 'hub',
    })
    if (!facts.marker || facts.marker.id !== device.id) return `The iPod changed while it was being checked. The sync was not started.`
    const record = (await readOnboardingRecords(host.stateDir)).find((r) => r.listId === device.id) ?? null
    const blind = healthBlindRefusal(facts, record)
    if (blind) return blind
    const last = await readLastSync(ipodStateDirFor(host.stateDir, device))
    const report = ipodHealthCheck({ facts, record, list: null, lastSync: last })
    // What the sync is about to repair is said, not hidden.
    for (const c of report.checks) if (c.status === 'warn') console.warn(`[ipod-health] ${device.name}: ${c.line}`)
    return healthSyncRefusal(report)
  })

  // The card check samples the copy of any iPod whose set-up isn't sealed yet.
  startCardProof(host.stateDir, async (markerId) => {
    const rec = (await readOnboardingRecords(host.stateDir)).find((r) => r.listId === markerId)
    return !!rec && !rec.released && rec.sealedAt === null
  })
}
