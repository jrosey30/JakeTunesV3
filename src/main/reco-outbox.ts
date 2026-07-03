/** Brief 125 — queue-and-replay outbox for recommendation mutations.
 *
 * The homemini mobile backend is the SINGLE writer of the shared
 * recommendations.json / recommendations-deleted.json on the NAS. V3 never
 * writes those files by any path; every mutation goes through the backend
 * HTTP API. When the Mini is unreachable the mutation is queued as an op in
 * STATE_DIR/recommendations-outbox.json (V3-private) and replayed on a later
 * sync. Pure helpers only — file/network IO stays in index.ts.
 */

export interface RecoAddOp {
  op: 'add'
  /** id of the provisional local row shown in the UI until the backend adopts it */
  localId: string
  input: { song?: string; artist?: string; album?: string; note?: string }
  /** recoIdentityKey(song, artist) at enqueue time — lets a later delete cancel this add */
  identity: string | null
  queuedAt: string
}

export interface RecoDeleteOp {
  op: 'delete'
  ids: string[]
  /** song identity being removed — blocks a stale NAS re-import while queued */
  identity: string | null
  queuedAt: string
}

export type RecoOutboxOp = RecoAddOp | RecoDeleteOp

export function parseOutbox(raw: unknown): RecoOutboxOp[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((o): o is RecoOutboxOp => {
    if (!o || typeof o !== 'object') return false
    const op = (o as { op?: unknown }).op
    if (op === 'add') {
      const a = o as RecoAddOp
      return typeof a.localId === 'string' && Boolean(a.input) && typeof a.input === 'object'
    }
    if (op === 'delete') {
      const d = o as RecoDeleteOp
      return Array.isArray(d.ids) && d.ids.every((i) => typeof i === 'string')
    }
    return false
  })
}

/** Deleting locally cancels any queued add of the same row/song; only ids that
 *  may already exist on the backend still need a remote DELETE. Without the
 *  cancel-out, an offline add-then-delete of the same song would replay the
 *  POST after the DELETE and resurrect it. */
export function scrubOutboxForDelete(
  ops: RecoOutboxOp[],
  doomedIds: string[],
  identity: string | null,
): { ops: RecoOutboxOp[]; remoteIds: string[] } {
  const doomed = new Set(doomedIds.map(String))
  const cancelledLocalIds = new Set<string>()
  const kept: RecoOutboxOp[] = []
  for (const o of ops) {
    if (o.op === 'add' && (doomed.has(o.localId) || (identity !== null && o.identity === identity))) {
      cancelledLocalIds.add(o.localId)
      continue
    }
    kept.push(o)
  }
  const remoteIds = doomedIds.map(String).filter((id) => !cancelledLocalIds.has(id))
  return { ops: kept, remoteIds }
}

export function pendingAddLocalIds(ops: RecoOutboxOp[]): Set<string> {
  const out = new Set<string>()
  for (const o of ops) if (o.op === 'add') out.add(o.localId)
  return out
}

export function pendingDeleteIds(ops: RecoOutboxOp[]): Set<string> {
  const out = new Set<string>()
  for (const o of ops) if (o.op === 'delete') for (const id of o.ids) out.add(String(id))
  return out
}

export function pendingDeleteIdentities(ops: RecoOutboxOp[]): Set<string> {
  const out = new Set<string>()
  for (const o of ops) if (o.op === 'delete' && o.identity) out.add(o.identity)
  return out
}
