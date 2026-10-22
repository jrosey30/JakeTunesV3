/**
 * User-edit journal (2026-10-20) — the edits a PERSON made on one Mac, with
 * the time each one was made. The pure half; src/main/user-edits-sync.ts is
 * the wiring.
 *
 * Why: a star or a Get Info edit Jake made on workmini never left workmini.
 * Its metadata-overrides.json could not carry it upstream, because that file
 * is mostly an old copy of the MacBook's: nothing in it says which fields
 * Jake changed there and which were copied from the hub (and at workmini's
 * boot that copy laid 2,452 stale genres back over the hub's — Steely Dan
 * "Yacht Rock" on workmini, "Classic Rock" on the MacBook). So every Mac now
 * keeps a journal, written ONLY by the save-metadata-override handler (Jake's
 * clicks: Get Info, stars, Cynthia applies). Sync, hub adoption, robots
 * (genre filer, analysis, Cynthia's sweep) and the daily deploy never write it.
 *
 *   user-edits.json  { version: 1, since, edits: { [id]: { [field]: { v, at, … } } } }
 *
 * `since` is when this Mac started keeping the journal: an edit made here
 * before it was never timed. The journal keeps the newest edit per
 * (song, field) and travels to homemini with the sync (SYNC_FILES): the
 * MacBook's beside its state, each replica's in replicas/<name>/. The backend
 * serves them all at GET /api/user-edits.
 *
 * THE RULES — newest real edit wins, and nothing else may win:
 *   - The HUB (the MacBook) absorbs replica edits into its own overrides
 *     (planHubAbsorb) and then publishes them the usual way (library.json →
 *     homemini → phone and replicas). Per (song, field):
 *       · its own journal entry at the same time or later → the hub stands;
 *       · a star the phone or the MacBook took back AFTER the replica's edit
 *         (the star sidecar's timestamps) → the hub stands;
 *       · an edit older than the hub's journal, where the hub had already
 *         decided that field (an override, or any star-sidecar trace) → the
 *         hub stands, because its decision has no time to compare against;
 *       · otherwise the replica's edit is written, through the same override
 *         writer a local Get Info edit uses.
 *     Every decision is recorded in the hub's journal (absorbed: the replica's
 *     time and value; kept: the hub's value, one ms after the replica's edit)
 *     so it is made once, and so the replica learns the verdict.
 *   - A REPLICA (workmini) never lets its own overrides file beat the hub for
 *     a field the hub catalog carries (replicaOverlay: HUB_CATALOG_FIELDS
 *     always; HUB_DETAIL_FIELDS whenever the hub knows a value). Only its
 *     journal can, and only until the hub's journal has something newer for
 *     that field. The same standing edits are pinned onto the hub catalog's
 *     rows before a merge (pinPendingEdits), so the full snapshot every
 *     launch asks for cannot undo an edit the hub has not absorbed yet.
 *   - Identity is the track id. The duration (Get Info cannot change it) is
 *     the guard against an id that now names a different song.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/userEditsDoc.ts (the same
 * document, validated before it is served).
 */

export const USER_EDITS_FILE = 'user-edits.json'
/** A replica's copy of the hub's journal, kept for boots while homemini is away. */
export const USER_EDITS_HUB_CACHE_FILE = 'user-edits-hub.desktop-cache.json'
export const USER_EDITS_PATH = '/api/user-edits'
export const USER_EDITS_VERSION = 1

/**
 * Fields a person sets by hand: Get Info (incl. origin), stars, Cynthia
 * applies. NOT here: play counters (playCount/lastPlayedAt/skipCount travel
 * as play events), audio analysis, the subgenre taxonomy — measured or
 * machine-written, never an edit.
 */
export const USER_EDIT_FIELDS: readonly string[] = [
  'title', 'artist', 'albumArtist', 'album', 'genre', 'origin', 'year',
  'trackNumber', 'trackCount', 'discNumber', 'discCount', 'rating', 'starredAt',
]
const USER_FIELD_SET = new Set(USER_EDIT_FIELDS)
export function isUserEditField(field: string): boolean { return USER_FIELD_SET.has(field) }

const STAR_FIELDS = new Set(['rating', 'starredAt'])
/** Library rows hold these as numbers (override values are strings). */
const NUMERIC_EDIT_FIELDS = new Set(['rating', 'starredAt', 'year', 'trackNumber', 'trackCount', 'discNumber', 'discCount'])

export interface UserEdit {
  /** the value as saved (override values are strings) */
  v: string
  /** epoch ms the edit was made */
  at: number
  /** duration (ms) of the song when it was edited — the identity guard */
  dur?: number
  /** hub only: the replica this was absorbed from */
  from?: string
  /** hub only: the replica's edit lost; `v` is the hub's value that stood */
  kept?: boolean
  /** a backfilled star (evidence: starredAt in the old overrides file) */
  seed?: boolean
}

export interface UserEditsDoc {
  version: 1
  /** epoch ms this Mac started keeping the journal */
  since: number
  edits: Record<string, Record<string, UserEdit>>
}

export function emptyUserEdits(now: number): UserEditsDoc {
  return { version: USER_EDITS_VERSION, since: now, edits: {} }
}

const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** The journal, or null when `raw` is not one. Bad entries are dropped, never guessed. */
export function parseUserEdits(raw: unknown): UserEditsDoc | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== USER_EDITS_VERSION || !isTime(o.since)) return null
  const rawEdits = o.edits
  if (!rawEdits || typeof rawEdits !== 'object' || Array.isArray(rawEdits)) return null
  const edits: UserEditsDoc['edits'] = {}
  for (const [id, fields] of Object.entries(rawEdits as Record<string, unknown>)) {
    if (!id || !fields || typeof fields !== 'object' || Array.isArray(fields)) continue
    for (const [field, e] of Object.entries(fields as Record<string, unknown>)) {
      if (!isUserEditField(field) || !e || typeof e !== 'object') continue
      const r = e as Record<string, unknown>
      if (typeof r.v !== 'string' || !isTime(r.at)) continue
      const out: UserEdit = { v: r.v, at: r.at }
      if (isTime(r.dur)) out.dur = r.dur
      if (typeof r.from === 'string' && r.from) out.from = r.from
      if (r.kept === true) out.kept = true
      if (r.seed === true) out.seed = true
      ;(edits[id] ??= {})[field] = out
    }
  }
  return { version: USER_EDITS_VERSION, since: o.since, edits }
}

export function getUserEdit(doc: UserEditsDoc | null | undefined, id: string, field: string): UserEdit | undefined {
  return doc?.edits[id]?.[field]
}

/**
 * Record one edit (newest per song + field). Returns the SAME document when
 * nothing changed — a field that is not a user field, or an older edit.
 */
export function recordUserEdit(
  doc: UserEditsDoc, id: string | number, field: string, value: string, at: number,
  extra: Omit<UserEdit, 'v' | 'at'> = {},
): UserEditsDoc {
  const key = String(id)
  if (!key || !isUserEditField(field) || !isTime(at)) return doc
  const cur = doc.edits[key]?.[field]
  if (cur && cur.at > at) return doc
  const next: UserEdit = { v: String(value), at, ...extra }
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return doc
  return { ...doc, edits: { ...doc.edits, [key]: { ...(doc.edits[key] ?? {}), [field]: next } } }
}

// ── shared helpers ─────────────────────────────────────────────────────────

export interface OverrideEntryLike { fp?: string; fields?: Record<string, string> }
export interface RowLike { title?: unknown; artist?: unknown; duration?: unknown; [field: string]: unknown }

/** title|artist|duration — the renderer's override fingerprint, same formula. */
export function rowFingerprint(row: RowLike): string {
  return `${String(row.title ?? '').toLowerCase().trim()}|${String(row.artist ?? '').toLowerCase().trim()}|${Number(row.duration) || 0}`
}

function v2(entry: unknown): OverrideEntryLike | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as OverrideEntryLike
  return e.fields && typeof e.fields === 'object' ? e : null
}

/**
 * Values compare as text; numbers by number (an override "5" equals a row's
 * 5); empty and "0" are both "not set" (an un-star "0" on a song the hub never
 * rated is no change).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  const s = (x: unknown) => (x === undefined || x === null ? '' : String(x).trim())
  const sa = s(a), sb = s(b)
  if (sa === sb) return true
  const unset = (x: string) => x === '' || x === '0'
  if (unset(sa) && unset(sb)) return true
  if (sa !== '' && sb !== '' && !Number.isNaN(Number(sa)) && !Number.isNaN(Number(sb))) return Number(sa) === Number(sb)
  return false
}

const DURATION_SLACK_MS = 2000

/** Same song? The id says so; a duration that disagrees by >2 s says the id moved. */
function sameSong(edit: UserEdit, row: RowLike): boolean {
  const d = Number(row.duration) || 0
  if (!edit.dur || !d) return true
  return Math.abs(edit.dur - d) <= DURATION_SLACK_MS
}

// ── backfill (replica, once) ───────────────────────────────────────────────

/**
 * The first journal on a replica: the stars it set before journals existed.
 * The only timed evidence in the old overrides file is `starredAt`, stamped
 * by a person's star-ON and nothing else, so only stars come back: rating > 0
 * with a starredAt, on an entry that applied here (fingerprint matches the
 * row). Un-stars carry no time and cannot be backfilled. The hub decides with
 * its pre-journal rule — a song it had already decided keeps the hub's value.
 */
export function seedStarsFromOverrides(
  doc: UserEditsDoc,
  overrides: Record<string, unknown>,
  rows: ReadonlyMap<string, RowLike>,
  now: number,
): { doc: UserEditsDoc; seeded: number } {
  let next = doc
  let seeded = 0
  for (const [id, raw] of Object.entries(overrides)) {
    const entry = v2(raw)
    const row = rows.get(id)
    if (!entry || !row || entry.fp !== rowFingerprint(row)) continue
    const rating = Number(entry.fields!.rating)
    const at = Number(entry.fields!.starredAt)
    if (!(rating > 0) || !isTime(at) || at > now) continue
    if (getUserEdit(next, id, 'rating') || getUserEdit(next, id, 'starredAt')) continue
    const dur = Number(row.duration) || undefined
    next = recordUserEdit(next, id, 'rating', String(entry.fields!.rating), at, { seed: true, ...(dur ? { dur } : {}) })
    next = recordUserEdit(next, id, 'starredAt', String(entry.fields!.starredAt), at, { seed: true, ...(dur ? { dur } : {}) })
    seeded++
  }
  return { doc: next, seeded }
}

// ── the hub absorbs ────────────────────────────────────────────────────────

export interface StarEventsLike { trackIds: readonly string[]; removed: Readonly<Record<string, number>>; added: Readonly<Record<string, number>> }

export interface AbsorbInput {
  replicas: ReadonlyArray<{ name: string; doc: UserEditsDoc }>
  /** the hub's own journal */
  hub: UserEditsDoc
  /** the hub's metadata-overrides.json */
  overrides: Record<string, unknown>
  /** the hub's library rows by id (library.json as saved) */
  rows: ReadonlyMap<string, RowLike>
  /** the hub's star sidecar (mobile-stars.json v2) */
  stars: StarEventsLike
}

export interface AbsorbWrite { id: string; field: string; value: string; at: number; from: string }

export type AbsorbDecision =
  | 'absorbed' | 'same-value' | 'hub-newer' | 'star-newer-elsewhere' | 'hub-decided-earlier'
  | 'legacy-entry' | 'held-not-on-hub' | 'held-different-song'

export interface AbsorbPlan {
  /** override fields to write on the hub, oldest edit first */
  writes: AbsorbWrite[]
  /** the hub's journal with every new decision recorded */
  hub: UserEditsDoc
  counts: Partial<Record<AbsorbDecision, number>>
}

/** What the hub shows: its override, else its row — and a star in its sidecar shows as 5. */
function effectiveValue(overrides: Record<string, unknown>, row: RowLike, id: string, field: string, starred: ReadonlySet<string>): string {
  const f = v2(overrides[id])?.fields
  let v: string
  if (f && Object.prototype.hasOwnProperty.call(f, field)) v = String(f[field] ?? '')
  else v = row[field] === undefined || row[field] === null ? '' : String(row[field])
  if (field === 'rating' && !(Number(v) > 0) && starred.has(id)) return '5'
  return v
}


export function planHubAbsorb(input: AbsorbInput): AbsorbPlan {
  const candidates: Array<{ from: string; id: string; field: string; e: UserEdit }> = []
  for (const { name, doc } of input.replicas) {
    for (const [id, fields] of Object.entries(doc.edits)) {
      for (const [field, e] of Object.entries(fields)) {
        if (isUserEditField(field) && !e.kept) candidates.push({ from: name, id, field, e })
      }
    }
  }
  candidates.sort((a, b) => a.e.at - b.e.at || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.field < b.field ? -1 : 1))

  let hub = input.hub
  const writes: AbsorbWrite[] = []
  const counts: AbsorbPlan['counts'] = {}
  const count = (d: AbsorbDecision) => { counts[d] = (counts[d] ?? 0) + 1 }
  // Writes land in this working copy so a later edit to the same field sees
  // the earlier one as the hub's current value.
  const pending = new Map<string, string>()
  const listed = new Set(input.stars.trackIds)
  const starLost = new Set<string>()   // `${replica}|${id}` whose rating edit lost

  for (const { from, id, field, e } of candidates) {
    const row = input.rows.get(id)
    if (!row) { count('held-not-on-hub'); continue }
    if (!sameSong(e, row)) { count('held-different-song'); continue }
    const starKey = `${from}|${id}`
    const mine = getUserEdit(hub, id, field)
    if (mine && mine.at >= e.at) {
      const sameEvent = mine.from === from && mine.at === e.at && !mine.kept   // absorbed on an earlier tick
      if (field === 'rating' && !sameEvent) starLost.add(starKey)
      count('hub-newer')
      continue
    }
    const rawEntry = input.overrides[id]
    const cur = pending.get(`${id}|${field}`) ?? effectiveValue(input.overrides, row, id, field, listed)
    const keep = (why: AbsorbDecision) => {
      hub = recordUserEdit(hub, id, field, cur, e.at + 1, { from, kept: true })
      if (field === 'rating') starLost.add(starKey)
      count(why)
    }
    // rating and starredAt are one star: when the replica's star lost, its
    // starredAt stamp loses with it
    if (field === 'starredAt' && starLost.has(starKey)) { keep('star-newer-elsewhere'); continue }
    if (sameValue(cur, e.v)) {
      hub = recordUserEdit(hub, id, field, e.v, e.at, { from })
      count('same-value')
      continue
    }
    if (rawEntry !== undefined && !v2(rawEntry)) { keep('legacy-entry'); continue }
    if (STAR_FIELDS.has(field)) {
      const starOn = field === 'starredAt' || Number(e.v) > 0
      const later = starOn ? input.stars.removed[id] : input.stars.added[id]
      if (later !== undefined && later > e.at) { keep('star-newer-elsewhere'); continue }
    }
    if (e.at < hub.since) {
      const f = v2(rawEntry)?.fields
      const has = (k: string) => !!f && Object.prototype.hasOwnProperty.call(f, k)
      const decided = STAR_FIELDS.has(field)
        ? has('rating') || has('starredAt') || listed.has(id) || id in input.stars.added || id in input.stars.removed
        : has(field)
      if (decided) { keep('hub-decided-earlier'); continue }
    }
    writes.push({ id, field, value: e.v, at: e.at, from })
    pending.set(`${id}|${field}`, e.v)
    hub = recordUserEdit(hub, id, field, e.v, e.at, { from })
    count('absorbed')
  }
  return { writes, hub, counts }
}

// ── a phone un-star lowers the hub's rating ────────────────────────────────

/** Songs one pass may lower. A bigger backlog is finished by the next pass, 5 minutes on. */
export const PHONE_UNSTAR_CAP = 100

export interface PhoneUnstarInput {
  /** the hub's star sidecar AFTER the phone's copy was merged in (mobile-stars.json v2) */
  stars: StarEventsLike
  /** the hub's metadata-overrides.json */
  overrides: Record<string, unknown>
  /** the hub's library rows by id (library.json as saved) */
  rows: ReadonlyMap<string, RowLike>
  /** the hub's own journal */
  hub: UserEditsDoc
  /** songs one pass may lower (default PHONE_UNSTAR_CAP) */
  cap?: number
}

export type PhoneUnstarDecision = 'lowered' | 'starred-now' | 'not-on-hub' | 'already-unstarred' | 'hub-star-newer'

export interface PhoneUnstarPlan {
  /** rating → '0' at the tombstone's own time, oldest first */
  writes: Array<{ id: string; at: number }>
  /** more songs than the cap: left for the next pass */
  deferred: number
  counts: Partial<Record<PhoneUnstarDecision, number>>
}

/**
 * "Unstar everywhere" (Jake, 2026-10-22): an un-star on the phone, or on a
 * Mac, un-stars the song on every device, newest event wins.
 *
 * The star sidecar already settles WHETHER a song is starred, per song, newest
 * event first. What it could not do was lower a rating this Mac already held:
 * a song rated in library.json or an override stayed rated, whatever the phone
 * said, because the renderer's boot pass only ever RAISES ratings and nothing
 * turned a tombstone into a lower rating. This is that step, planned purely.
 *
 * A song is lowered to 0 when ALL of:
 *   - the sidecar holds a tombstone for it and it is not starred now (a newer
 *     star, here or elsewhere, already won);
 *   - this Mac still shows it rated (its override, else its row);
 *   - this Mac's own latest star is not newer than the tombstone. Evidence of
 *     that star: the journal (a rating above 0 or a starredAt stamp; the
 *     entries the hub wrote itself as verdicts, `kept`, carry an artificial
 *     time and do not count), the override's starredAt, the row's starredAt. A
 *     tie goes to the tombstone.
 * A song with no tombstone is never touched: nothing un-starred it, so
 * multi-star ratings survive and a misread file cannot wipe the library. At
 * most `cap` songs per pass.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/starOverlay.ts applyStarOverlay —
 * the phone and workmini read the same rule from homemini in the meantime.
 * Change the rule in one place, change it in both.
 */
export function planPhoneUnstars(input: PhoneUnstarInput): PhoneUnstarPlan {
  const counts: PhoneUnstarPlan['counts'] = {}
  const count = (d: PhoneUnstarDecision) => { counts[d] = (counts[d] ?? 0) + 1 }
  const listed = new Set(input.stars.trackIds)
  const ordered = Object.entries(input.stars.removed)
    .filter(([id, at]) => !!id && isTime(at))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
  const cap = Math.max(0, input.cap ?? PHONE_UNSTAR_CAP)
  const writes: PhoneUnstarPlan['writes'] = []
  let deferred = 0

  for (const [id, at] of ordered) {
    if (listed.has(id)) { count('starred-now'); continue }
    const row = input.rows.get(id)
    if (!row) { count('not-on-hub'); continue }
    const fields = v2(input.overrides[id])?.fields
    const has = (k: string) => !!fields && Object.prototype.hasOwnProperty.call(fields, k)
    const shown = has('rating') ? fields!.rating : row.rating
    if (!(Number(shown) > 0)) { count('already-unstarred'); continue }
    const journalStar = (field: string): number => {
      const e = getUserEdit(input.hub, id, field)
      if (!e || e.kept) return 0
      return field === 'rating' && !(Number(e.v) > 0) ? 0 : e.at
    }
    const stamp = (x: unknown): number => { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 0 }
    const hubStar = Math.max(journalStar('rating'), journalStar('starredAt'), stamp(has('starredAt') ? fields!.starredAt : 0), stamp(row.starredAt))
    if (hubStar > at) { count('hub-star-newer'); continue }
    if (writes.length >= cap) { deferred++; continue }
    writes.push({ id, at })
    count('lowered')
  }
  return { writes, deferred, counts }
}

// ── a replica's view ───────────────────────────────────────────────────────

/** The value a replica shows for a journaled field, or undefined (the hub's rules). */
export function replicaJournalValue(mine: UserEdit | undefined, hubEdit: UserEdit | undefined, isHubField: boolean): string | undefined {
  if (mine) return hubEdit && hubEdit.at > mine.at ? hubEdit.v : mine.v
  // A field the hub catalog does not carry (origin, starredAt) only reaches
  // a replica through the hub's journal.
  if (hubEdit && !isHubField) return hubEdit.v
  return undefined
}

/**
 * A replica's overrides at load: its own file and the phone overlay lose
 * every field the hub catalog carries (`hubFields`) — the catalog it adopted
 * already has the hub's and the phone's values — and its journal, checked
 * against the hub's, puts back the edits Jake made here that still stand.
 * Entries whose fingerprint no longer matches the row were skipped by the
 * renderer anyway; a journal field on such a song gets a fresh entry.
 * Pure: the file on disk is never rewritten.
 */
export function replicaOverlay(
  merged: Record<string, unknown>,
  opts: {
    hubFields: ReadonlySet<string>
    /** details the catalog carries when the hub knows them (a blank never erases) */
    hubDetailFields?: ReadonlySet<string>
    rows: ReadonlyMap<string, RowLike>; mine: UserEditsDoc | null; hub: UserEditsDoc | null
  },
): { overrides: Record<string, unknown>; droppedFields: number; journalFields: number } {
  const detail = opts.hubDetailFields ?? new Set<string>()
  const carried = (f: string) => opts.hubFields.has(f) || detail.has(f)
  const out: Record<string, unknown> = {}
  let droppedFields = 0
  for (const [id, raw] of Object.entries(merged)) {
    const entry = v2(raw)
    if (!entry) { out[id] = raw; continue }
    const row = opts.rows.get(id)
    const fields: Record<string, string> = {}
    for (const [f, val] of Object.entries(entry.fields!)) {
      const rv = row?.[f]
      const hubKnows = rv !== undefined && rv !== null && rv !== ''
      if (opts.hubFields.has(f) || (detail.has(f) && hubKnows)) droppedFields++
      else fields[f] = val
    }
    out[id] = { fp: entry.fp ?? '', fields }
  }
  let journalFields = 0
  const keys = new Set<string>()
  for (const doc of [opts.mine, opts.hub]) {
    if (!doc) continue
    for (const [id, fields] of Object.entries(doc.edits)) for (const f of Object.keys(fields)) keys.add(`${id}\u0000${f}`)
  }
  for (const key of keys) {
    const [id, field] = key.split('\u0000')
    const row = opts.rows.get(id)
    if (!row) continue
    const mine = getUserEdit(opts.mine, id, field)
    const hubEdit = getUserEdit(opts.hub, id, field)
    if (mine && !sameSong(mine, row)) continue
    const value = replicaJournalValue(mine, hubEdit, carried(field))
    if (value === undefined) continue
    const fp = rowFingerprint(row)
    const cur = v2(out[id])
    if (cur && cur.fp === fp) cur.fields![field] = value
    else out[id] = { fp, fields: { [field]: value } }
    journalFields++
  }
  return { overrides: out, droppedFields, journalFields }
}

/**
 * Live updates for a replica when a newer copy of the hub's journal arrives:
 * every journaled field whose shown value it changes. The renderer applies
 * them the way it applies any field edit.
 */
export function replicaLiveUpdates(
  prevHub: UserEditsDoc | null, nextHub: UserEditsDoc | null, mine: UserEditsDoc | null,
  hubFields: ReadonlySet<string>,
): Array<{ id: string; field: string; value: string }> {
  const out: Array<{ id: string; field: string; value: string }> = []
  if (!nextHub) return out
  for (const [id, fields] of Object.entries(nextHub.edits)) {
    for (const [field, h] of Object.entries(fields)) {
      const before = getUserEdit(prevHub, id, field)
      if (before && before.at === h.at && before.v === h.v) continue
      const m = getUserEdit(mine, id, field)
      const was = replicaJournalValue(m, before, hubFields.has(field))
      const now = replicaJournalValue(m, h, hubFields.has(field))
      if (now !== undefined && now !== was) out.push({ id, field, value: now })
    }
  }
  return out
}

/**
 * A replica's own edits that still stand (its journal entry is not older
 * than the hub's), pinned onto the hub catalog's rows before they are
 * merged — so a full snapshot (the first poll of every launch) cannot undo
 * an edit the hub has not absorbed yet. `carried`: the fields the merge
 * takes from the hub. Rows are copied, never mutated.
 */
export function pinPendingEdits<T extends { id?: unknown }>(
  upserts: readonly T[], mine: UserEditsDoc | null, hub: UserEditsDoc | null, carried: ReadonlySet<string>,
): { upserts: T[]; pinned: number } {
  if (!mine) return { upserts: [...upserts], pinned: 0 }
  let pinned = 0
  const out = upserts.map((u) => {
    const id = String(u?.id ?? '')
    const edits = mine.edits[id]
    if (!edits) return u
    let next: Record<string, unknown> | null = null
    for (const [field, e] of Object.entries(edits)) {
      if (!carried.has(field)) continue
      const h = getUserEdit(hub, id, field)
      if (h && h.at > e.at) continue
      if (!sameSong(e, u as RowLike)) continue
      const cur = (u as Record<string, unknown>)[field]
      if (sameValue(cur, e.v)) continue
      next ??= { ...(u as Record<string, unknown>) }
      next[field] = NUMERIC_EDIT_FIELDS.has(field) ? Number(e.v) || 0 : e.v
      pinned++
    }
    return (next ?? u) as T
  })
  return { upserts: out, pinned }
}
