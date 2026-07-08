/** Brief 126 — sync protocol v2: the desktop's PURE merge engine.
 *
 * Server-authoritative mirror. The homemini backend is the only source of
 * truth; the local file is a cache of the backend's list overlaid with this
 * machine's outbox. THE RULE THAT KILLS THE RESURRECTIONS (forensics
 * 2026-07-07, H1): **nothing is inferred from absence** — a local row that
 * is not on the backend and not in the outbox was deleted elsewhere, and it
 * is simply dropped. The old "stray migration" (local-but-absent must be an
 * offline add → re-POST it) is what un-deleted every phone delete on the
 * next desktop sync; no such branch exists in this module, structurally.
 *
 * Pure functions only — file/network IO stays in index.ts (same split as
 * reco-outbox.ts). Unit-tested in __tests__/reco-sync.test.ts, including the
 * H1 regression test.
 */
import {
  recoDedupeKey,
  recordIdentityKeys,
  isTombstonedRecord,
  pickBetterReco,
  type RecoIdentityInput,
} from './reco-match.ts'
import {
  pendingAddLocalIds,
  pendingDeleteIds,
  pendingDeleteIdentities,
  type RecoOutboxOp,
} from './reco-outbox.ts'

export interface RecoSyncRow extends RecoIdentityInput {
  id: string
  createdAt?: string
}

/** The online merge:
 *  merged = dedupe( preferLocalEnrichment(backend − outboxDeletes) ∪ outboxAddRows )
 *  Local rows are only an ENRICHMENT overlay (same id) or outbox-pending
 *  adds — never a source of existence. dupeDeleteIds = backend rows the
 *  identity-dedupe collapsed; the caller queues id-only heal deletes for
 *  them (no identity keys — the song stays alive). */
export function computeMirror<T extends RecoSyncRow>(args: {
  backend: T[]
  local: T[]
  ops: RecoOutboxOp[]
}): { merged: T[]; dupeDeleteIds: string[] } {
  const { backend, local, ops } = args
  const delIds = pendingDeleteIds(ops)
  const delIdentities = pendingDeleteIdentities(ops)
  const pendingAdds = pendingAddLocalIds(ops)
  const localById = new Map(local.map((r) => [String(r.id), r] as const))

  const fromBackend = backend
    .filter((r) => {
      if (!r?.id || delIds.has(String(r.id))) return false
      return !recordIdentityKeys(r).some((k) => delIdentities.has(k))
    })
    .map((r) => localById.get(String(r.id)) ?? r)

  const pendingRows = local.filter((r) => pendingAdds.has(String(r.id)))

  const byKey = new Map<string, T>()
  for (const r of [...fromBackend, ...pendingRows]) {
    const k = recoDedupeKey(r)
    const prev = byKey.get(k)
    byKey.set(k, prev ? pickBetterReco(prev, r) : r)
  }
  const merged = [...byKey.values()]
  const keptIds = new Set(merged.map((r) => String(r.id)))
  const dupeDeleteIds = fromBackend
    .map((r) => String(r.id))
    .filter((id) => !keptIds.has(id))
  return { merged, dupeDeleteIds }
}

/** Backend unreachable: additive display import from the read-only NAS copy,
 *  gated by the backend's LIVE tombstones (read off the NAS too) and this
 *  machine's queued deletes. Returns only the rows to APPEND. */
export function computeNasFallback<T extends RecoSyncRow>(args: {
  local: T[]
  nas: T[]
  nasTombstones: ReadonlySet<string>
  ops: RecoOutboxOp[]
}): T[] {
  const { local, nas, nasTombstones, ops } = args
  const delIds = pendingDeleteIds(ops)
  const delIdentities = pendingDeleteIdentities(ops)
  const localIds = new Set(local.map((r) => String(r.id)))
  const localKeys = new Set(local.flatMap((r) => recordIdentityKeys(r)))
  return nas.filter((r) => {
    if (!r?.id) return false
    const id = String(r.id)
    if (localIds.has(id) || delIds.has(id)) return false
    if (isTombstonedRecord(nasTombstones, r)) return false
    const keys = recordIdentityKeys(r)
    if (keys.some((k) => localKeys.has(k) || delIdentities.has(k))) return false
    return true
  })
}

/** A user delete of one row dooms every local row that IS that song, and
 *  yields the identity keys the DELETE transmits to the backend. */
export function identitiesForDelete<T extends RecoSyncRow>(
  target: T,
  allRows: T[],
): { doomedIds: string[]; identities: string[] } {
  const identities = recordIdentityKeys(target)
  const keySet = new Set(identities)
  const doomedIds = allRows
    .filter((r) => String(r.id) === String(target.id) || (keySet.size > 0 && recordIdentityKeys(r).some((k) => keySet.has(k))))
    .map((r) => String(r.id))
  if (!doomedIds.includes(String(target.id))) doomedIds.push(String(target.id))
  return { doomedIds, identities }
}
