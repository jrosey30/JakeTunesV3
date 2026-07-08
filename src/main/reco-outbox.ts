/** Brief 125 — queue-and-replay outbox for recommendation mutations.
 *  Brief 126 — sync protocol v2: ops carry the FULL identity-key set
 *  (recordIdentityKeys) instead of a single pair key, so deletes transmit
 *  every key over the wire and artist-less jots are protected too.
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
  input: { song?: string; artist?: string; album?: string; note?: string; kind?: string; externalId?: string }
  /** recordIdentityKeys at enqueue time — lets a later delete cancel this add */
  identities: string[]
  queuedAt: string
}

export interface RecoDeleteOp {
  op: 'delete'
  ids: string[]
  /** every identity key being removed — transmitted with the DELETE and
   *  blocking a stale NAS re-import while queued */
  identities: string[]
  queuedAt: string
}

export type RecoOutboxOp = RecoAddOp | RecoDeleteOp

/** Accepts both the v2 shape (identities: string[]) and the legacy v1 shape
 *  (identity: string|null) — ops queued by the previous build may still be
 *  on disk when this one boots. */
export function parseOutbox(raw: unknown): RecoOutboxOp[] {
  if (!Array.isArray(raw)) return []
  const out: RecoOutboxOp[] = []
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue
    const rec = o as Record<string, unknown>
    const identities = Array.isArray(rec.identities)
      ? (rec.identities as unknown[]).filter((k): k is string => typeof k === 'string')
      : typeof rec.identity === 'string' && rec.identity
        ? [rec.identity]
        : []
    if (rec.op === 'add' && typeof rec.localId === 'string' && rec.input && typeof rec.input === 'object') {
      out.push({
        op: 'add',
        localId: rec.localId,
        input: rec.input as RecoAddOp['input'],
        identities,
        queuedAt: typeof rec.queuedAt === 'string' ? rec.queuedAt : '',
      })
    } else if (rec.op === 'delete' && Array.isArray(rec.ids) && (rec.ids as unknown[]).every((i) => typeof i === 'string')) {
      out.push({
        op: 'delete',
        ids: rec.ids as string[],
        identities,
        queuedAt: typeof rec.queuedAt === 'string' ? rec.queuedAt : '',
      })
    }
  }
  return out
}

/** Deleting locally cancels any queued add of the same row/song; only ids that
 *  may already exist on the backend still need a remote DELETE. Without the
 *  cancel-out, an offline add-then-delete of the same song would replay the
 *  POST after the DELETE and resurrect it. */
export function scrubOutboxForDelete(
  ops: RecoOutboxOp[],
  doomedIds: string[],
  identities: string[],
): { ops: RecoOutboxOp[]; remoteIds: string[] } {
  const doomed = new Set(doomedIds.map(String))
  const identitySet = new Set(identities)
  const cancelledLocalIds = new Set<string>()
  const kept: RecoOutboxOp[] = []
  for (const o of ops) {
    if (o.op === 'add' && (doomed.has(o.localId) || o.identities.some((k) => identitySet.has(k)))) {
      cancelledLocalIds.add(o.localId)
      continue
    }
    kept.push(o)
  }
  const remoteIds = doomedIds.map(String).filter((id) => !cancelledLocalIds.has(id))
  return { ops: kept, remoteIds }
}

/** One-time reset scrub (Brief 126): drop queued ADDS whose identity is
 *  already live on the backend (dupe) or tombstoned there (exactly the
 *  stray-migration residue that used to resurrect deletes). Keeps genuine
 *  offline adds and every delete op. */
export function scrubOutboxAgainstBackend(
  ops: RecoOutboxOp[],
  backendIdentityKeys: ReadonlySet<string>,
  tombstoneEntries: ReadonlySet<string>,
): { ops: RecoOutboxOp[]; dropped: RecoOutboxOp[] } {
  const kept: RecoOutboxOp[] = []
  const dropped: RecoOutboxOp[] = []
  for (const o of ops) {
    if (o.op !== 'add') { kept.push(o); continue }
    const live = o.identities.some((k) => backendIdentityKeys.has(k))
    const dead = o.identities.some((k) => tombstoneEntries.has(`identity:${k}`))
    if (live || dead) dropped.push(o)
    else kept.push(o)
  }
  return { ops: kept, dropped }
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
  for (const o of ops) if (o.op === 'delete') for (const k of o.identities) out.add(k)
  return out
}
