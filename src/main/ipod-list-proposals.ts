/**
 * The brain's picks waiting for Jake (2026-11-09) — main's half. Contract and
 * the pure rules: common/ipod-list-proposals.ts.
 *
 *   • the decisions: Approve / Skip in the panel go on disk first
 *     (ipod-list-decisions.json in the state dir), then to homemini. A
 *     decision homemini hasn't heard yet (away, off the tailnet) waits there
 *     and goes on the next read of the picks, the next list refresh, or the
 *     5-minute retry (ipc/ipod-lists-ipc.ts), in the order made. homemini
 *     takes the same decision twice without harm, so a retry after a lost
 *     answer is safe. A refusal homemini means (400, 404) drops it.
 *   • the notice: when homemini has a new set of picks for an iPod, one
 *     macOS notification and one phone push ("punkPod: 10 picks to review"),
 *     once per set, from the hub (the MacBook) only. Clicking it opens that
 *     iPod's list. Runs on the same ticks as "ready for an updated sync"
 *     (ipod-sync-ready-start.ts), no timer of its own.
 *
 * Electron-free; every effect is injected (__tests__/ipod-list-proposals.test.ts).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  decideProposalNotice, parseDecisionQueue, proposalNoticeText, queueDecision, waitingProposals,
  type DecisionQueue, type IpodProposal, type IpodProposalSet,
} from '../common/ipod-list-proposals.ts'
import type { IpodDeviceMarker } from '../common/ipod-identity.ts'

export const DECISIONS_FILE = 'ipod-list-decisions.json'
export const PROPOSAL_NOTICE_FILE = 'ipod-proposals-notice.json'

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf-8')) as unknown } catch { return null }
}

async function writeJson(dir: string, path: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, path)
}

export type ProposalsAnswer = { kind: 'ok'; set: IpodProposalSet } | { kind: 'none' } | { kind: 'offline'; error: string } | { kind: 'bad'; error: string }

export interface ProposalsDeps {
  stateDir: string
  /** GET …/proposals (ipod-list-client.ts proposals). */
  get: (deviceId: string) => Promise<ProposalsAnswer>
  /** POST …/proposals/decide (ipod-list-client.ts decide). */
  send: (deviceId: string, d: { approve: number[]; reject: number[] }) => Promise<'done' | 'retry' | 'drop'>
  log?: (msg: string) => void
}

export interface ProposalsView {
  ok: true
  /** The picks still waiting, minus what Jake already decided here. */
  proposals: IpodProposal[]
  proposedAt: string | null
  /** Decisions on this iPod homemini hasn't heard yet. */
  queued: number
  /** homemini didn't answer: the rows are the last ones seen on this Mac. */
  offline: boolean
}

export interface ProposalsDesk {
  /** The panel's rows for one iPod. Sends anything waiting first. */
  view(deviceId: string): Promise<ProposalsView>
  /** Jake's Approve / Skip: on disk, then to homemini. `sent`: homemini has it now. */
  decide(deviceId: string, d: { approve?: number[]; reject?: number[] }): Promise<{ ok: true; sent: boolean } | { ok: false; error: string }>
  /** Send every waiting decision. Resolves with how many iPods are still waiting. */
  flush(): Promise<number>
}

export function createProposalsDesk(deps: ProposalsDeps): ProposalsDesk {
  const log = deps.log ?? ((m: string) => console.warn(m))
  const path = join(deps.stateDir, DECISIONS_FILE)
  /** The last set seen per iPod, so an offline panel still shows the picks. */
  const lastSeen = new Map<string, IpodProposalSet>()
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn)
    chain = next.catch(() => undefined)
    return next
  }
  const readQueue = async (): Promise<DecisionQueue> => parseDecisionQueue(await readJson(path))
  const writeQueue = (q: DecisionQueue): Promise<void> => writeJson(deps.stateDir, path, q)

  /** One pass over the queue, inside the chain. */
  async function flushNow(): Promise<number> {
    const q = await readQueue()
    let next = q
    for (const [deviceId, d] of Object.entries(q)) {
      const r = await deps.send(deviceId, d).catch(() => 'retry' as const)
      if (r === 'retry') continue
      if (r === 'drop') log(`[ipod-proposals] homemini refused the decisions for ${deviceId}; dropped`)
      // Only what was sent leaves the queue; a decision made meanwhile stays.
      const cur = next[deviceId]
      if (!cur) continue
      const left = { approve: cur.approve.filter((id) => !d.approve.includes(id)), reject: cur.reject.filter((id) => !d.reject.includes(id)) }
      next = { ...next }
      if (left.approve.length || left.reject.length) next[deviceId] = left
      else delete next[deviceId]
    }
    if (JSON.stringify(next) !== JSON.stringify(q)) await writeQueue(next)
    return Object.keys(next).length
  }

  return {
    view(deviceId) {
      return serial(async () => {
        await flushNow().catch((err) => log(`[ipod-proposals] send failed: ${(err as Error)?.message ?? err}`))
        const a = await deps.get(deviceId)
        let offline = false
        if (a.kind === 'ok') lastSeen.set(deviceId, a.set)
        else if (a.kind === 'none') lastSeen.delete(deviceId)
        else offline = true
        const set = lastSeen.get(deviceId) ?? null
        const queued = (await readQueue())[deviceId]
        return {
          ok: true as const,
          proposals: waitingProposals(set, queued),
          proposedAt: set?.proposedAt ?? null,
          queued: (queued?.approve.length ?? 0) + (queued?.reject.length ?? 0),
          offline,
        }
      })
    },
    decide(deviceId, d) {
      return serial(async () => {
        const approve = (d.approve ?? []).filter((id) => Number.isInteger(id) && id > 0)
        const reject = (d.reject ?? []).filter((id) => Number.isInteger(id) && id > 0)
        if (!/^[a-z0-9-]{6,64}$/.test(deviceId) || (!approve.length && !reject.length)) return { ok: false as const, error: 'nothing to decide' }
        // On disk first: a quit, a crash or no signal can't lose Jake's tap.
        await writeQueue(queueDecision(await readQueue(), deviceId, { approve, reject }))
        const left = await flushNow().catch(() => 1)
        const still = (await readQueue())[deviceId]
        const sent = !still || (!approve.some((id) => still.approve.includes(id)) && !reject.some((id) => still.reject.includes(id)))
        if (!sent) log(`[ipod-proposals] homemini is away; ${approve.length + reject.length} decision(s) wait on disk (${left} iPod(s) waiting)`)
        return { ok: true as const, sent }
      })
    },
    flush() {
      return serial(() => flushNow())
    },
  }
}

// ── the notice: once per set, hub only ──────────────────────────────────────

export interface ProposalNoticeDeps {
  stateDir: string
  /** Only the hub (the MacBook) tells. Unsure = not the hub. */
  isHub: () => Promise<boolean>
  /** Every iPod registered on this Mac. The Original has no list and is skipped. */
  devices: () => Promise<IpodDeviceMarker[]>
  get: (deviceId: string) => Promise<ProposalsAnswer>
  /** The macOS notification; clicking it opens that iPod's list. */
  notify: (n: { title: string; body: string; deviceId: string }) => void
  /** The phone (ntfy). Best-effort. */
  push: (n: { title: string; body: string }) => Promise<unknown>
  log?: (msg: string) => void
}

export interface ProposalNotice {
  /** One look at every iPod (or only `deviceId`). */
  check(deviceId?: string): Promise<void>
}

export function createProposalNotice(deps: ProposalNoticeDeps): ProposalNotice {
  const log = deps.log ?? ((m: string) => console.log(m))
  const path = join(deps.stateDir, PROPOSAL_NOTICE_FILE)
  let chain: Promise<void> = Promise.resolve()

  async function pass(only?: string): Promise<void> {
    if (!(await deps.isHub().catch(() => false))) return
    const devices = (await deps.devices().catch(() => [] as IpodDeviceMarker[])).filter((d) => !d.primary && (!only || d.id === only))
    if (!devices.length) return
    const raw = await readJson(path)
    const told: Record<string, string> = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : {}
    for (const device of devices) {
      const a = await deps.get(device.id).catch(() => null)
      if (!a || a.kind !== 'ok') continue // away or no list: say nothing, keep the state
      const { notify, told: next } = decideProposalNotice(told[device.id], a.set)
      if (!notify || !next) continue
      // Remember first: a crash after telling must not tell twice.
      told[device.id] = next
      await writeJson(deps.stateDir, path, told)
      const text = proposalNoticeText(device.name, a.set.proposals.length)
      log(`[ipod-proposals] ${device.name}: ${a.set.proposals.length} picks to review — told`)
      try { deps.notify({ ...text, deviceId: device.id }) } catch (err) { log(`[ipod-proposals] notification failed: ${(err as Error)?.message ?? err}`) }
      await Promise.resolve(deps.push(text)).catch((err) => log(`[ipod-proposals] phone push failed: ${(err as Error)?.message ?? err}`))
    }
  }

  return {
    check(deviceId) {
      chain = chain.then(() => pass(deviceId)).catch((err) => log(`[ipod-proposals] check failed: ${(err as Error)?.message ?? err}`))
      return chain
    },
  }
}
