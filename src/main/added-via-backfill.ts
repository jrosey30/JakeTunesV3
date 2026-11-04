/**
 * One-shot repair: give library rows back the share source they lost.
 *
 * 2026-11-03: a song shared from TikTok and then downloaded by the DESKTOP
 * landed with source 'streamrip' and no addedVia, so the TikTok playlist never
 * saw it (the forward fix is ltlDownload.ts recoOrigin → import-pipeline.ts).
 * Songs the phone imported before the stamp existed (2026-11-01) never had one.
 *
 * What counts as proof, strongest first:
 *   - a Listen List row's own `via`, or its "via <Label>" note (addedViaOf).
 *     Live rows and the copies the NAS recycle bin keeps of recommendations.json.
 *   - homemini's share log, which predates the note: `[add-resolve] source=tiktok
 *     … q="…"` immediately before `[add-request] song "…" — … → reco <id>`.
 * Tombstones prove nothing here: they are bare ids and identity keys, no source.
 *
 * Text finds the candidates; a person reviews the list; the write is then gated
 * on each row's identity (applyStamps). Pure: no fs, no electron. IO and the
 * write gate live in scripts/backfill-added-via.ts.
 */
import { ADD_SOURCE_LABEL, addedViaOf, shareSourceKey } from '../common/source-playlists.ts'
import { recoIdentityPairKey, recoIdNorm } from './reco-match.ts'

export interface RecoRow {
  id?: string
  song?: string
  artist?: string
  album?: string
  note?: string
  via?: string
  link?: string
  matchedTitle?: string
  matchedArtist?: string
  createdAt?: string
}

export interface ShareEvidence {
  recoId: string
  /** The share source key, as the phone would have stamped it. */
  key: string
  how: 'via' | 'note' | 'log'
  link?: string
  createdAt: string
  identityKeys: string[]
}

const STRENGTH: Record<ShareEvidence['how'], number> = { via: 3, note: 2, log: 1 }

/** Credits are for FINDING a row only: a share says "expectations" by "Olivia
 *  Rodrigo & Chappell Roan", the library says "expectations (feat. Chappell Roan)"
 *  by "Olivia Rodrigo". These keys are never stored or compared at write time;
 *  a person reviews what they find and applyStamps gates on identity. */
function creditless(title: string): string {
  return title
    .replace(/\s*[([]\s*(?:feat|ft|featuring|with)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s+(?:feat|ft|featuring)\.?\s.*$/i, '')
    .trim()
}
function firstCredited(artist: string): string {
  return artist.split(/\s*(?:,|&|;|\sx\s|\sand\s)\s*/i)[0].trim()
}
function findingKeys(title: string | undefined, artist: string | undefined): string[] {
  if (!title || !artist) return []
  const keys = new Set<string>()
  for (const t of [title, creditless(title)]) {
    for (const a of [artist, firstCredited(artist)]) {
      const k = recoIdentityPairKey(t, a)
      if (k) keys.add(k)
    }
  }
  return [...keys]
}

export function evidenceFromRecoRows(rows: readonly RecoRow[]): ShareEvidence[] {
  const out: ShareEvidence[] = []
  for (const r of rows) {
    if (!r?.id || !r.createdAt) continue
    const key = addedViaOf(r, ADD_SOURCE_LABEL)
    if (!key) continue
    out.push({
      recoId: r.id,
      key,
      how: shareSourceKey(r.via) ? 'via' : 'note',
      ...(r.link ? { link: r.link } : {}),
      createdAt: r.createdAt,
      identityKeys: [...new Set([...findingKeys(r.song, r.artist), ...findingKeys(r.matchedTitle, r.matchedArtist)])],
    })
  }
  return out
}

const RESOLVE_LINE = /^(\S+) \[add-resolve\] source=(\S+) status=(\S+) n=\d+ q="((?:[^"\\]|\\.)*)"/
const REQUEST_LINE = /^(\S+) \[add-request\] song "(.*)" — (.*) → reco ([0-9a-f-]{36})(?: \(already listed\))?$/
/** A person picks from the share sheet in seconds. A resolve older than this
 *  belongs to some other share. */
const RESOLVE_TO_REQUEST_MS = 120_000

/** Does the sheet's query name the song it produced? Savant and typed adds log
 *  no resolve of their own, so the line before one can be any earlier share. */
function queryNames(q: string, title: string, artist: string): boolean {
  const nq = recoIdNorm(q), nt = recoIdNorm(title), na = recoIdNorm(artist)
  if (!nq) return false
  return [nt, na].some((name) => name !== '' && (nq.includes(name) || name.includes(nq)))
}

/** Share log lines, oldest first → evidence. A `source=text` resolve is a typed
 *  search, which the phone never stamps from the log (it has no ADD_SOURCE_LABEL
 *  key), so a share given up on and then typed proves nothing. */
export function evidenceFromShareLog(lines: readonly string[]): ShareEvidence[] {
  const seen = new Map<string, ShareEvidence>()
  let last: { at: number; source: string; status: string; q: string } | null = null
  for (const line of lines) {
    const res = RESOLVE_LINE.exec(line)
    if (res) {
      let q = res[4]
      try { q = JSON.parse(`"${res[4]}"`) as string } catch { /* keep the raw text */ }
      last = { at: Date.parse(res[1]), source: res[2], status: res[3], q }
      continue
    }
    const req = REQUEST_LINE.exec(line)
    if (!req) continue
    const [, at, title, artist, recoId] = req
    const resolve = last
    last = null   // one sheet, one add: the next add needs its own resolve
    if (seen.has(recoId) || !resolve) continue
    if (Date.parse(at) - resolve.at > RESOLVE_TO_REQUEST_MS) continue
    if (resolve.status !== 'match' && resolve.status !== 'choose') continue
    const key = shareSourceKey(resolve.source)
    if (!key || !ADD_SOURCE_LABEL[key]) continue
    if (!queryNames(resolve.q, title, artist)) continue
    seen.set(recoId, { recoId, key, how: 'log', createdAt: at, identityKeys: findingKeys(title, artist) })
  }
  return [...seen.values()]
}

/** One record per Listen List row: the strongest proof, keeping a link and the
 *  union of identity keys (a row's matched title can arrive in a later copy). */
export function mergeEvidence(...lists: ReadonlyArray<readonly ShareEvidence[]>): ShareEvidence[] {
  const byReco = new Map<string, ShareEvidence>()
  for (const list of lists) {
    for (const e of list) {
      const prev = byReco.get(e.recoId)
      if (!prev) { byReco.set(e.recoId, { ...e, identityKeys: [...e.identityKeys] }); continue }
      const best = STRENGTH[e.how] > STRENGTH[prev.how] ? e : prev
      const link = prev.link ?? e.link
      byReco.set(e.recoId, {
        ...best,
        ...(link ? { link } : {}),
        identityKeys: [...new Set([...prev.identityKeys, ...e.identityKeys])],
      })
    }
  }
  return [...byReco.values()]
}

export interface LibraryRow {
  id: number
  title?: string
  artist?: string
  album?: string
  dateAdded?: string
  path?: string
  audioFingerprint?: string
  source?: string
  addedVia?: string
}

export type BackfillGroup =
  /** A desktop download of a shared row: the 2026-11-03 bug. */
  | 'desktop'
  /** A phone import from before the stamp, with the Listen List row on file. */
  | 'phone-listed'
  /** A phone import from before the stamp, proven by the share log alone. */
  | 'phone-log'

export interface PlannedStamp {
  id: number
  title: string
  artist: string
  album?: string
  dateAdded: string
  path?: string
  audioFingerprint?: string
  addedVia: string
  group: BackfillGroup
  evidence: { recoId: string; how: ShareEvidence['how']; link?: string; sharedAt: string }
}

export interface ExcludedRow {
  id: number
  title: string
  artist: string
  /** already-owned: the row predates the share, so the share did not bring it
   *  in. ambiguous: two shares name it with different sources. */
  reason: 'already-owned' | 'ambiguous'
  keys: string[]
}

export function planBackfill(tracks: readonly LibraryRow[], evidence: readonly ShareEvidence[]): { stamps: PlannedStamp[]; excluded: ExcludedRow[] } {
  const byKey = new Map<string, ShareEvidence[]>()
  for (const e of evidence) {
    for (const k of e.identityKeys) {
      const list = byKey.get(k)
      if (list) list.push(e)
      else byKey.set(k, [e])
    }
  }
  const stamps: PlannedStamp[] = []
  const excluded: ExcludedRow[] = []
  for (const t of tracks) {
    if (t.addedVia || !t.title || !t.artist) continue
    const found = new Map<string, ShareEvidence>()
    for (const k of findingKeys(t.title, t.artist)) for (const e of byKey.get(k) ?? []) found.set(e.recoId, e)
    if (found.size === 0) continue
    const added = Date.parse(t.dateAdded ?? '')
    const after = [...found.values()].filter((e) => Number.isFinite(added) && added >= Date.parse(e.createdAt))
    const shape = { id: t.id, title: t.title, artist: t.artist }
    if (after.length === 0) {
      excluded.push({ ...shape, reason: 'already-owned', keys: [...new Set([...found.values()].map((e) => e.key))] })
      continue
    }
    const distinct = [...new Set(after.map((e) => e.key))]
    if (distinct.length > 1) {
      excluded.push({ ...shape, reason: 'ambiguous', keys: distinct })
      continue
    }
    const best = after.reduce((a, b) => {
      const byProof = STRENGTH[b.how] - STRENGTH[a.how]
      if (byProof !== 0) return byProof > 0 ? b : a
      return Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a
    })
    stamps.push({
      ...shape,
      ...(t.album ? { album: t.album } : {}),
      dateAdded: t.dateAdded as string,
      ...(t.path ? { path: t.path } : {}),
      ...(t.audioFingerprint ? { audioFingerprint: t.audioFingerprint } : {}),
      addedVia: best.key,
      group: t.source ? 'desktop' : best.how === 'log' ? 'phone-log' : 'phone-listed',
      evidence: { recoId: best.recoId, how: best.how, ...(best.link ? { link: best.link } : {}), sharedAt: best.createdAt },
    })
  }
  stamps.sort((a, b) => a.id - b.id)
  excluded.sort((a, b) => a.id - b.id)
  return { stamps, excluded }
}

export interface ApplyResult<L> {
  library: L
  changed: Array<{ id: number; title: string; artist: string; addedVia: string }>
  /** Already carrying exactly this stamp: nothing to do. */
  already: number[]
  /** Not the row that was reviewed, or a stamp that is not ours to overwrite.
   *  Any entry here means nothing should be written. */
  refused: Array<{ id: number; why: string }>
}

const IDENTITY_FIELDS = ['title', 'artist', 'dateAdded', 'path', 'audioFingerprint'] as const

/** Stamp the reviewed rows, gated on identity: same id AND the same title,
 *  artist, date, path and fingerprint the reviewer saw. Only `addedVia` is added,
 *  only on these rows; every other row and field is the same object. */
export function applyStamps<L extends { tracks: readonly LibraryRow[] }>(library: L, stamps: readonly PlannedStamp[]): ApplyResult<L> {
  const changed: ApplyResult<L>['changed'] = []
  const already: number[] = []
  const refused: ApplyResult<L>['refused'] = []
  const byId = new Map(library.tracks.map((t) => [t.id, t] as const))
  const stamped = new Map<number, LibraryRow>()
  for (const s of stamps) {
    const row = byId.get(s.id)
    if (!row) { refused.push({ id: s.id, why: 'no row with this id' }); continue }
    const moved = IDENTITY_FIELDS.find((f) => (row[f] ?? null) !== (s[f] ?? null))
    if (moved) { refused.push({ id: s.id, why: `${moved} changed since the plan: reviewed ${JSON.stringify(s[moved] ?? null)}, now ${JSON.stringify(row[moved] ?? null)}` }); continue }
    const key = shareSourceKey(s.addedVia)
    if (!key || key !== s.addedVia || !ADD_SOURCE_LABEL[key]) { refused.push({ id: s.id, why: `not a share source key: ${JSON.stringify(s.addedVia)}` }); continue }
    if (row.addedVia === key) { already.push(s.id); continue }
    if (row.addedVia) { refused.push({ id: s.id, why: `already stamped ${JSON.stringify(row.addedVia)}` }); continue }
    stamped.set(s.id, { ...row, addedVia: key })
    changed.push({ id: s.id, title: s.title, artist: s.artist, addedVia: key })
  }
  const next = { ...library, tracks: library.tracks.map((t) => stamped.get(t.id) ?? t) }
  return { library: next, changed, already, refused }
}

/** Proof that a write changes nothing else: the ids whose rows differ, and any
 *  difference that is not a new `addedVia`. Compares whole rows and the rest of
 *  the file, so a stray edit anywhere is caught before it lands. */
export function diffLibraries(before: { tracks: readonly LibraryRow[] } & Record<string, unknown>, after: { tracks: readonly LibraryRow[] } & Record<string, unknown>): { changedIds: number[]; problems: string[] } {
  const problems: string[] = []
  const changedIds: number[] = []
  if (before.tracks.length !== after.tracks.length) problems.push(`row count ${before.tracks.length} → ${after.tracks.length}`)
  const topKeys = new Set([...Object.keys(before), ...Object.keys(after)])
  topKeys.delete('tracks')
  for (const k of topKeys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) problems.push(`top-level "${k}" differs`)
  for (let i = 0; i < Math.min(before.tracks.length, after.tracks.length); i++) {
    const a = before.tracks[i], b = after.tracks[i]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    changedIds.push(b.id)
    const { addedVia: added, ...rest } = b
    if (a.id !== b.id) problems.push(`row ${i}: id ${a.id} → ${b.id}`)
    else if (a.addedVia) problems.push(`row ${a.id}: already had addedVia ${a.addedVia}`)
    else if (!added) problems.push(`row ${a.id}: differs without a new addedVia`)
    else if (JSON.stringify(a) !== JSON.stringify(rest)) problems.push(`row ${a.id}: more than addedVia differs`)
  }
  return { changedIds, problems }
}
