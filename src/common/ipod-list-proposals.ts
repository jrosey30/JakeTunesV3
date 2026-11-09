/**
 * The brain's picks waiting for Jake (2026-11-09). Jake: punkPod's every-other-
 * week additions become proposals he approves; nothing goes on the list
 * without his OK.
 *
 * homemini's grower (JakeTunesMobile backend, brain.mode 'propose') writes its
 * picks to the list's `proposals` instead of onto the list:
 *
 *   GET  /api/ipod-lists/:deviceId/proposals
 *        → { id, name, mode, proposedAt, proposals: [{ id, why, at, artist?, title?, album? }] }
 *   POST /api/ipod-lists/:deviceId/proposals/decide  { approve?: ids, reject?: ids }
 *        approved go on the list; skipped are held for good (never proposed again);
 *        an approval for a song no longer waiting does nothing; the same decision
 *        sent twice changes nothing.
 *
 * This file is the desktop's half, pure (node --test loads it): the parser, the
 * queue of decisions homemini hasn't heard yet, which rows the panel shows, and
 * the notice's words. The panel is renderer/components/IpodProposalsPanel.tsx;
 * the queue's file and the notice live in main (ipod-list-proposals.ts).
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/ipodLists.ts (applyPropose,
 * applyDecide) and routes/ipodLists.ts. Change the shapes together.
 */

export interface IpodProposal {
  id: number
  /** The brain's reason, in plain words ("Pop-Punk, one of your stars"). */
  why: string
  at: string
  artist?: string
  title?: string
  album?: string
}

export interface IpodProposalSet {
  /** The iPod's marker id. */
  id: string
  name: string
  /** When homemini wrote this set; null = never. One notice per value. */
  proposedAt: string | null
  proposals: IpodProposal[]
}

/** homemini never sends more than this many in one set (its MAX_PROPOSALS). */
export const IPOD_PROPOSALS_MAX = 50

const DEVICE_ID = /^[a-z0-9-]{6,64}$/
const isSongId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Read homemini's answer. null = not a proposal set (the wrong iPod, no name,
 * no list of proposals). A bad row is dropped, never guessed at; a repeat is
 * dropped too.
 */
export function parseProposalSet(raw: unknown, expectedId?: string): IpodProposalSet | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !DEVICE_ID.test(r.id)) return null
  if (expectedId !== undefined && r.id !== expectedId) return null
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  if (!Array.isArray(r.proposals)) return null
  const proposals: IpodProposal[] = []
  const seen = new Set<number>()
  for (const e of r.proposals.slice(0, IPOD_PROPOSALS_MAX)) {
    const p = e as Record<string, unknown> | null
    if (!p || typeof p !== 'object' || !isSongId(p.id) || seen.has(p.id) || typeof p.at !== 'string') continue
    seen.add(p.id)
    const artist = text(p.artist)
    const title = text(p.title)
    const album = text(p.album)
    proposals.push({
      id: p.id, why: text(p.why) ?? '', at: p.at,
      ...(artist ? { artist } : {}), ...(title ? { title } : {}), ...(album ? { album } : {}),
    })
  }
  const proposedAt = typeof r.proposedAt === 'string' && Number.isFinite(Date.parse(r.proposedAt)) ? r.proposedAt : null
  return { id: r.id, name: r.name.trim(), proposedAt, proposals }
}

// ── decisions homemini hasn't heard yet ─────────────────────────────────────

export interface QueuedDecision { approve: number[]; reject: number[] }
/** Per iPod (marker id). Kept on disk until homemini answers. */
export type DecisionQueue = Record<string, QueuedDecision>

/**
 * Pure: the queue with Jake's new decisions on one iPod. The last decision on
 * a song wins (approve, then skip = skip). Never mutates `q`.
 */
export function queueDecision(q: DecisionQueue, deviceId: string, d: { approve?: readonly number[]; reject?: readonly number[] }): DecisionQueue {
  const prev = q[deviceId] ?? { approve: [], reject: [] }
  const approve = (d.approve ?? []).filter(isSongId)
  const reject = (d.reject ?? []).filter(isSongId).filter((id) => !approve.includes(id))
  const nextApprove = [...prev.approve.filter((id) => !reject.includes(id) && !approve.includes(id)), ...approve]
  const nextReject = [...prev.reject.filter((id) => !approve.includes(id) && !reject.includes(id)), ...reject]
  const out: DecisionQueue = { ...q }
  if (nextApprove.length || nextReject.length) out[deviceId] = { approve: nextApprove, reject: nextReject }
  else delete out[deviceId]
  return out
}

/** A queue read from disk: anything that isn't one is an empty queue (never a crash). */
export function parseDecisionQueue(raw: unknown): DecisionQueue {
  const out: DecisionQueue = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!DEVICE_ID.test(k) || !v || typeof v !== 'object') continue
    const d = v as Record<string, unknown>
    const approve = Array.isArray(d.approve) ? d.approve.filter(isSongId) : []
    const reject = Array.isArray(d.reject) ? d.reject.filter(isSongId).filter((id) => !approve.includes(id)) : []
    if (approve.length || reject.length) out[k] = { approve: [...new Set(approve)], reject: [...new Set(reject)] }
  }
  return out
}

/** The rows the panel shows: the set, minus what Jake already decided and homemini hasn't heard yet. */
export function waitingProposals(set: IpodProposalSet | null, queued: QueuedDecision | undefined): IpodProposal[] {
  if (!set) return []
  const done = new Set([...(queued?.approve ?? []), ...(queued?.reject ?? [])])
  return set.proposals.filter((p) => !done.has(p.id))
}

// ── the words ───────────────────────────────────────────────────────────────

/** "Picks to review (10)". */
export function proposalsHeading(n: number): string {
  return `Picks to review (${n.toLocaleString('en-US')})`
}

/** One proposal's line: "Artist — Title", from homemini's names, else the library's. */
export function proposalLine(p: IpodProposal, fromLibrary?: { artist?: string; title?: string }): string {
  const artist = p.artist ?? fromLibrary?.artist
  const title = p.title ?? fromLibrary?.title
  if (artist && title) return `${artist} — ${title}`
  return title ?? artist ?? `Song ${p.id}`
}

/** The notice: "punkPod: 10 picks to review". */
export function proposalNoticeText(ipodName: string, n: number): { title: string; body: string } {
  return { title: 'JakeTunes', body: `${ipodName}: ${n.toLocaleString('en-US')} ${n === 1 ? 'pick' : 'picks'} to review` }
}

/**
 * Pure: tell Jake about this set? Once per set (homemini's `proposedAt`), and
 * only when something is waiting. `told`: the set last told for this iPod.
 */
export function decideProposalNotice(told: string | undefined, set: IpodProposalSet): { notify: boolean; told: string | undefined } {
  if (!set.proposedAt || set.proposals.length === 0) return { notify: false, told }
  if (set.proposedAt === told) return { notify: false, told }
  return { notify: true, told: set.proposedAt }
}

/** The notification's click: the menu action that opens this iPod's list (App.tsx). */
export const OPEN_IPOD_LIST_ACTION = 'open-ipod-list:'
export function openIpodListAction(deviceId: string): string {
  return `${OPEN_IPOD_LIST_ACTION}${deviceId}`
}
export function parseOpenIpodListAction(action: string): string | null {
  if (!action.startsWith(OPEN_IPOD_LIST_ACTION)) return null
  const id = action.slice(OPEN_IPOD_LIST_ACTION.length)
  return DEVICE_ID.test(id) ? id : null
}
