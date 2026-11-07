/**
 * Sync History IPC (6.0 Phase 2b) — the back-of-house records, readable.
 *
 * Jake, 2026-08-31: "we need records of this on the back end so that we
 * know what is going in and what is coming off each activity sync." The
 * engine has written those records ever since (activity-sync-ledger.jsonl:
 * a picks entry before the wipe, a result entry only on a sealed sync) and
 * the Round Trip adds arrivals (ipod-roundtrip-ledger.jsonl). This module
 * READS both — it never writes — and pairs them into a newest-first
 * timeline: what went on, what came off, what landed, what came home.
 *
 * A picks entry with no matching result is an aborted/refused run and is
 * shown as such — the ledger's honesty survives into the UI.
 */
import { join } from 'path'
import { readFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'

interface PicksRow {
  kind: 'picks'
  when: string
  target?: number
  pickedIds?: number[]
  added?: number[]
  removed?: number[]
  picked?: Array<{ id: number; t?: string; a?: string }>
  requested?: number
  leftOff?: Array<{ id: number; t?: string; a?: string; why?: string }>
}
interface ResultRow {
  kind: 'result'
  when: string
  picksWhen?: string
  target?: number
  landed?: number
  sealedOk?: boolean
  copied?: number
  copyErrors?: number
  /** Written on the sealed run; also holds songs left off at the conversion step. */
  leftOff?: Array<{ id: number; t?: string; a?: string; why?: string }>
}
interface RoundTripRow {
  kind: 'roundtrip'
  when: string
  plays?: Array<{ id: number; delta: number; lastPlayedMs?: number }>
  otg?: number[][]
  unmatched?: number
}

export interface SyncHistoryEntry {
  kind: 'sync' | 'roundtrip'
  when: string
  target?: number
  landed?: number
  sealedOk?: boolean
  aborted?: boolean
  pickedCount?: number
  added?: Array<{ id: number; t?: string; a?: string }>
  removed?: Array<{ id: number; t?: string; a?: string }>
  /** A list-only iPod: how many were on its list, and each one left off with why. */
  requested?: number
  leftOff?: Array<{ id: number; t?: string; a?: string; why?: string }>
  plays?: Array<{ id: number; delta: number }>
  otgLists?: number
  unmatched?: number
}

function parseLines<T>(text: string, kind: string): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const row = JSON.parse(s) as { kind?: string }
      if (row.kind === kind) out.push(row as T)
    } catch { /* one torn line never hides the rest */ }
  }
  return out
}

/** Pure: pair picks with results (by picksWhen), resolve removed-track
 *  names from the PREVIOUS sync's picked list, interleave round trips. */
export function buildSyncHistory(
  activityLedger: string,
  roundtripLedger: string,
  cap = 50,
): SyncHistoryEntry[] {
  const picks = parseLines<PicksRow>(activityLedger, 'picks')
  const results = parseLines<ResultRow>(activityLedger, 'result')
  const trips = parseLines<RoundTripRow>(roundtripLedger, 'roundtrip')

  const resultByPicks = new Map<string, ResultRow>()
  for (const r of results) if (r.picksWhen) resultByPicks.set(r.picksWhen, r)

  const entries: SyncHistoryEntry[] = []
  picks.forEach((p, i) => {
    const nameOf = new Map((p.picked || []).map((x) => [x.id, x]))
    // removed ids left THIS sync — their names live in the previous picks.
    const prev = i > 0 ? new Map((picks[i - 1].picked || []).map((x) => [x.id, x])) : new Map()
    const res = resultByPicks.get(p.when)
    entries.push({
      kind: 'sync',
      when: p.when,
      target: p.target,
      landed: res?.landed,
      sealedOk: res?.sealedOk,
      aborted: !res,
      pickedCount: p.pickedIds?.length ?? p.picked?.length,
      added: (p.added || []).map((id) => nameOf.get(id) || { id }),
      removed: (p.removed || []).map((id) => prev.get(id) || { id }),
      ...(p.requested != null ? { requested: p.requested } : {}),
      ...((res?.leftOff || p.leftOff || []).length > 0 ? { leftOff: res?.leftOff || p.leftOff } : {}),
    })
  })
  for (const t of trips) {
    entries.push({
      kind: 'roundtrip',
      when: t.when,
      plays: (t.plays || []).map((x) => ({ id: x.id, delta: x.delta })),
      otgLists: (t.otg || []).length,
      unmatched: t.unmatched,
    })
  }
  entries.sort((a, b) => (a.when < b.when ? 1 : -1))
  return entries.slice(0, cap)
}

export function registerSyncHistoryIpc(
  ipc: IpcRegistrar,
  /** `dir`: the plugged-in iPod's own state dir (each iPod keeps its own ledgers,
   *  step 2b) — null for an iPod JakeTunes doesn't know, which has no history.
   *  Absent: `stateDir` (the Original's). */
  host: { stateDir: string; dir?: () => Promise<string | null> },
): void {
  ipc.handle('get-sync-history', async (): Promise<{ ok: boolean; entries: SyncHistoryEntry[] }> => {
    const dir = host.dir ? await host.dir().catch(() => host.stateDir) : host.stateDir
    if (dir === null) return { ok: true, entries: [] }
    const read = (name: string): Promise<string> =>
      readFile(join(dir, name), 'utf-8').catch(() => '')
    const [activity, roundtrip] = await Promise.all([
      read('activity-sync-ledger.jsonl'),
      read('ipod-roundtrip-ledger.jsonl'),
    ])
    return { ok: true, entries: buildSyncHistory(activity, roundtrip) }
  }, { public: true })
}
