/**
 * The genre filer (2026-10-11). New songs used to keep whatever genre the
 * store shipped — "Alternatif et Indé, Rock, Pop", "Funk, Soul, R&B", "Hip-
 * Hop/Rap" — and slowly refill the junk drawers Jake just emptied. While the
 * app runs, this files every song whose genre isn't on his list
 * (src/common/genre-vocab.ts), and sets where the artist is from (`origin`).
 *
 * His rules, enforced HERE in code (each one learned the hard way on 10/11 —
 * prompt instructions alone let Level 42 become Jazz Fusion):
 *   1. A specific list genre already on the song stands. Only catch-alls
 *      (Alternative, Rock, Pop…) and tags off the list get filed.
 *   2. An artist he already has goes on that artist's shelf — instantly, no
 *      lookups. One shelf per artist; PER_ALBUM artists are judged per album.
 *   3. A new artist gets real evidence: MusicBrainz artist + album tags, and
 *      music press when MusicBrainz is thin (the Telescreens lesson — never a
 *      guess from a band's name). The AI picks ONLY from the list.
 *   4. Rock stays rock: a song tagged Rock / Classic Rock only moves to a rock shelf.
 *   5. Unsure → his check list (Settings → Library), never a guess.
 *
 * Pure decisions + injected effects, so the rules are tested directly.
 */
import { GENRES, GENRE_NAMES, CATCH_ALL, ROCK_FAMILY, PER_ALBUM_ARTISTS, isListGenre } from '../common/genre-vocab.ts'
import { normName } from './taste-profile.ts'
import { originNames, type OriginLookup, type OriginSource } from './origin-lookup.ts'

export interface FilerTrack {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  genre?: string
  origin?: string
  duration?: number
  compilation?: boolean
  /** The genre is in his edits file — set by the practice run, by him, or by
   *  this filer. A catch-all genre ("Rock") only counts as filed when approved;
   *  the same word straight from a store gets filed. */
  genreApproved?: boolean
}

export interface FilerUnit { key: string; artist: string; album: string; title?: string; comp: boolean; ids: number[]; tag: string }

export interface Decision {
  genre: string | null          // null = leave the genre alone (on the check list)
  origin?: string
  how: 'artist-home' | 'specific-tag' | 'evidence' | 'check'
  why: string
  suggested?: string
}

export interface Evidence { artistTags: string[]; albumTags: string[]; origin?: string; press: string }

// Artist/album keys keep every script — see normName (Молчат Дома ≠ ברי סחרוף).
const norm = (s: string | undefined): string => normName(s)
const HEBREW = /\p{Script=Hebrew}/u
/** origin-lookups.json key: the filer's artist key, in any script (it was
 *  [a-z0-9], so "Молчат Дома & X" and "ברי סחרוף & X" shared "x"). A name
 *  that folds to nothing ("!!!") keys as itself. */
export const originCacheKey = (artist: string): string => norm(artist) || artist.trim().toLowerCase()
const isVarious = (a: string): boolean => /^(various|various artists|va)$/i.test(a.trim())

/** The fingerprint App.tsx validates overrides against.
 *  ⚠️ TWIN: src/renderer/App.tsx override fp (`${title}|${artist}|${duration||0}`, lowercased, trimmed). */
export function trackFingerprint(t: FilerTrack): string {
  return `${String(t.title || '').toLowerCase().trim()}|${String(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`
}

/** A genre that needs no filing: a specific list genre, or a catch-all he approved. */
export function isSettled(t: FilerTrack): boolean {
  return isListGenre(t.genre) && (!!t.genreApproved || !CATCH_ALL.has(t.genre!.trim()))
}

/** Songs to file — off the list, or an unapproved catch-all — one unit per album (compilations per song). */
export function unfiledUnits(tracks: FilerTrack[]): FilerUnit[] {
  const units = new Map<string, FilerUnit>()
  for (const t of tracks) {
    if (isSettled(t)) continue
    const albumArtist = (t.albumArtist || t.artist || '').trim()
    const comp = !!t.compilation || isVarious(albumArtist)
    const key = comp ? `song:${t.id}` : `album:${norm(albumArtist)}|${norm(t.album)}`
    const u = units.get(key) ?? { key, artist: comp ? (t.artist || '').trim() : albumArtist, album: (t.album || '').trim(), title: comp ? t.title : undefined, comp, ids: [], tag: (t.genre || '').trim() }
    u.ids.push(t.id)
    units.set(key, u)
  }
  return [...units.values()]
}

/** Each artist's shelf (most common list genre across their songs) and origin. */
export function artistHomes(tracks: FilerTrack[]): Map<string, { genre: string; origin?: string }> {
  const g = new Map<string, Map<string, number>>()
  const o = new Map<string, Map<string, number>>()
  const bump = (m: Map<string, Map<string, number>>, k: string, v: string): void => {
    const c = m.get(k) ?? new Map<string, number>(); c.set(v, (c.get(v) ?? 0) + 1); m.set(k, c)
  }
  for (const t of tracks) {
    const a = (t.albumArtist || t.artist || '').trim()
    if (!a || isVarious(a)) continue
    if (isSettled(t)) bump(g, norm(a), t.genre!.trim())   // homes come from settled genres only
    if (t.origin) bump(o, norm(a), t.origin)
  }
  const top = (c: Map<string, number> | undefined): string | undefined =>
    c ? [...c.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] : undefined
  const out = new Map<string, { genre: string; origin?: string }>()
  for (const [a, c] of g) out.set(a, { genre: top(c)!, origin: top(o.get(a)) })
  return out
}

/** Rules 1 and 2: decisions that need no lookup. null = needs evidence. */
export function decideByRules(u: FilerUnit, homes: Map<string, { genre: string; origin?: string }>): Decision | null {
  const home = homes.get(norm(u.artist))
  if (home && !PER_ALBUM_ARTISTS.has(u.artist)) return { genre: home.genre, origin: home.origin, how: 'artist-home', why: `${u.artist} already lives on ${home.genre}` }
  if (isListGenre(u.tag) && !CATCH_ALL.has(u.tag)) return { genre: u.tag, origin: home?.origin, how: 'specific-tag', why: 'its tag is already a specific genre on the list' }
  return null
}

/** Rules 4 and 5 applied to the AI's pick. */
export function enforce(u: FilerUnit, pick: { genre?: string; confidence?: string; why?: string }, origin?: string): Decision {
  const g = (pick.genre || '').trim()
  const why = String(pick.why || '').slice(0, 140)
  if (!GENRE_NAMES.has(g)) return { genre: null, origin, how: 'check', why: `not on the list: ${g || 'no answer'}`, suggested: undefined }
  if ((u.tag === 'Rock' || u.tag === 'Classic Rock') && !ROCK_FAMILY.has(g)) return { genre: null, origin, how: 'check', why: `rock stays rock (suggested ${g})`, suggested: g }
  if (pick.confidence === 'low') return { genre: null, origin, how: 'check', why: why || 'not sure', suggested: g }
  return { genre: g, origin, how: 'evidence', why }
}

export function filerSystemPrompt(): string {
  let area = ''
  const list = GENRES.map((g) => { const head = g.area !== area ? `\n## ${(area = g.area)}\n` : ''; return `${head}- ${g.name}: ${g.strict ? 'STRICT — ' : ''}${g.definition}` }).join('\n')
  return `You file new albums into Jake's record collection. Each album gets EXACTLY ONE genre from his list — copy the name exactly; never invent or combine.
Rules: ROCK IS CONSERVATIVE (an album tagged Rock or Classic Rock stays on a rock, punk or metal shelf). Alternative, Pop and R&B are STRICT (Alternative = real 80s–90s alternative rock only). Rap is shelved by region or style. Judge the artist's mainstream identity and this record's sound: what would most music listeners file it under?
Evidence, most trusted first: MusicBrainz album tags, MusicBrainz artist tags (the FIRST tags describe the artist; a minor tag never wins), music press. If the evidence is thin or contradictory, answer confidence "low" — never guess from a band's name.
Answer with ONLY a JSON array: [{"id": "<id>", "genre": "<exact list name>", "confidence": "high"|"medium"|"low", "why": "<12 words max, name the evidence>"}]

JAKE'S GENRE LIST
${list}`
}

export function evidenceLine(id: string, u: FilerUnit, e: Evidence): string {
  const parts = [`id=${id}`, `${u.artist} — "${u.comp ? u.title : u.album}"`, `store tag: ${u.tag || '(none)'}`]
  if (e.albumTags.length) parts.push(`MB album tags: ${e.albumTags.slice(0, 6).join(', ')}`)
  if (e.artistTags.length) parts.push(`MB artist tags (most-voted first): ${e.artistTags.slice(0, 6).join(', ')}`)
  if (e.press) parts.push(`press: ${e.press.replace(/\s+/g, ' ').slice(0, 600)}`)
  if (!e.albumTags.length && !e.artistTags.length && !e.press) parts.push('no evidence found')
  return parts.join(' | ')
}

export function parseReply(text: string): Array<{ id: string; genre?: string; confidence?: string; why?: string }> {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    return Array.isArray(arr) ? arr.filter((x): x is { id: string } => !!x && typeof x === 'object' && 'id' in x).map((x) => ({ ...(x as object), id: String((x as { id: unknown }).id) })) : []
  } catch { return [] }
}

export interface CheckEntry { key: string; artist: string; album: string; ids: number[]; tag: string; suggested?: string; why: string; at: string }

export interface FilerDeps {
  tracks(): Promise<FilerTrack[]>                 // effective tracks (overrides applied)
  persist(t: FilerTrack, fields: Record<string, string>): Promise<void>
  applied(updates: Array<{ trackId: number; field: string; newValue: string }>): void
  evidence(u: FilerUnit): Promise<Evidence>
  classify(system: string, user: string): Promise<string>
  loadCheck(): Promise<CheckEntry[]>
  saveCheck(list: CheckEntry[]): Promise<void>
  log?(msg: string): void
  now?: () => Date
  maxUnits?: number
  /** Where an artist is from — the NETWORK lookup only (origin-lookup.ts):
   *  found, unknown (cache it), or busy (cache nothing, ask next sweep).
   *  Each call is one of the sweep's maxOriginLookups. */
  lookupOrigin?(artist: string, albums: string[]): Promise<OriginLookup>
  /** Network lookups per sweep (default 10). Remembered answers are free. */
  maxOriginLookups?: number
  /** The remembered answers (origin-lookups-v3.json). Absent = nothing remembered. */
  loadOriginCache?(): Promise<OriginCache>
  saveOriginCache?(cache: OriginCache): Promise<void>
  originRetryMs?: number
}

/** One remembered origin answer per artist credit (originCacheKey).
 *  origin: a country = known; null = nobody knows (ask again after
 *  ORIGIN_RETRY_MS); absent = never answered. failedAt = the last BUSY try —
 *  an ordering hint only, never a reason to skip. source / via / mbid /
 *  note say how an answer was reached, so a source can be audited and its
 *  origins reverted (every 'mb-lone-name' answer, say). */
export interface OriginCacheEntry { origin?: string | null; at?: number; source?: OriginSource; via?: 'mb' | 'mb-lone-name'; mbid?: string; note?: string; failedAt?: number }
export type OriginCache = Record<string, OriginCacheEntry>
export const ORIGIN_RETRY_MS = 60 * 24 * 3600 * 1000
/** v2 → v3: its known answers carry over; its "unknown"s don't — they were
 *  asked the old way (two albums, " - EP" titles, whole multi-artist credits). */
export function originCacheFromV2(v2: unknown): OriginCache {
  if (!v2 || typeof v2 !== 'object') return {}
  const out: OriginCache = {}
  for (const [k, e] of Object.entries(v2 as Record<string, { origin?: unknown; at?: unknown }>)) {
    if (typeof e?.origin === 'string' && e.origin) out[k] = { origin: e.origin, at: typeof e.at === 'number' ? e.at : undefined, source: 'mb', note: 'v2' }
  }
  return out
}

/** One sweep: file what the rules can, look up the rest (capped), list the unsure. */
export async function runFilerSweep(deps: FilerDeps): Promise<{ filed: number; checked: number; deferred: number; origins: number }> {
  const tracks = await deps.tracks()
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const check = await deps.loadCheck()
  const listed = new Set(check.map((c) => c.key))
  const units = unfiledUnits(tracks).filter((u) => !listed.has(u.key))
  const homes = artistHomes(tracks)
  if (!units.length) return { filed: 0, checked: 0, deferred: 0, origins: await fillOrigins(deps, tracks, homes, new Set()) }
  const decided: Array<[FilerUnit, Decision]> = []
  const needEvidence: FilerUnit[] = []
  for (const u of units) {
    const d = decideByRules(u, homes)
    if (d) decided.push([u, d]); else needEvidence.push(u)
  }
  const batch = needEvidence.slice(0, deps.maxUnits ?? 8)
  if (batch.length) {
    const ev = new Map<string, Evidence>()
    for (const u of batch) ev.set(u.key, await deps.evidence(u))
    const reply = parseReply(await deps.classify(filerSystemPrompt(), 'Albums:\n' + batch.map((u, i) => evidenceLine(String(i), u, ev.get(u.key)!)).join('\n')))
    const got = new Map(reply.map((r) => [r.id, r]))
    batch.forEach((u, i) => decided.push([u, enforce(u, got.get(String(i)) ?? {}, ev.get(u.key)?.origin)]))
  }
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  let filed = 0
  const now = (deps.now ?? (() => new Date()))().toISOString()
  for (const [u, d] of decided) {
    for (const id of u.ids) {
      const t = byId.get(id)
      if (!t) continue
      const fields: Record<string, string> = {}
      if (d.genre) fields.genre = d.genre
      if (d.origin && !t.origin) fields.origin = d.origin
      if (!Object.keys(fields).length) continue
      await deps.persist(t, fields)
      for (const [field, newValue] of Object.entries(fields)) updates.push({ trackId: id, field, newValue })
    }
    if (d.genre) filed++
    else check.push({ key: u.key, artist: u.artist, album: u.comp ? (u.title || u.album) : u.album, ids: u.ids, tag: u.tag, suggested: d.suggested, why: d.why, at: now })
    deps.log?.(`[genre-filer] ${u.artist} — ${u.album}: ${d.genre ? `→ ${d.genre} (${d.how})` : `check list (${d.why})`}`)
  }
  if (updates.length) deps.applied(updates)
  if (decided.some(([, d]) => !d.genre)) await deps.saveCheck(check)
  const origins = await fillOrigins(deps, tracks, homes, new Set(updates.filter((u) => u.field === 'origin').map((u) => u.trackId)))
  return { filed, checked: decided.filter(([, d]) => !d.genre).length, deferred: needEvidence.length - batch.length, origins }
}

/** Whose origin a song carries: its album artist — or, on a compilation or a
 *  Various Artists album, the song's own artist (each song its own performer). */
export function originArtist(t: FilerTrack): string {
  const aa = (t.albumArtist || '').trim()
  return !aa || isVarious(aa) || t.compilation ? (t.artist || '').trim() : aa
}

export interface OriginGroup {
  key: string                 // originCacheKey(name)
  name: string
  tracks: FilerTrack[]
  albums: string[]            // his albums by this artist, most songs first
  /** copy = his other songs say; remembered = the cache knows; waiting = the
   *  cache says nobody knows, not yet time to ask again; ask = a lookup. */
  plan: 'copy' | 'remembered' | 'waiting' | 'ask'
  origin?: string
}

/** Every artist with songs missing an origin, and what fillOrigins will do for
 *  each — in the order it will do it (lookups: never-failed first, then most
 *  songs first). Pure, so a dry run can print it. */
export function planOrigins(tracks: FilerTrack[], cache: OriginCache, now: number, alreadySet: Set<number> = new Set(), retryMs = ORIGIN_RETRY_MS): OriginGroup[] {
  const counts = new Map<string, Map<string, number>>()
  for (const t of tracks) {
    if (!t.origin) continue
    const k = norm(originArtist(t))
    if (!k) continue
    const c = counts.get(k) ?? new Map<string, number>(); c.set(t.origin, (c.get(t.origin) ?? 0) + 1); counts.set(k, c)
  }
  const known = (name: string): string | undefined => {
    const c = counts.get(norm(name))
    return c ? [...c.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0] : undefined
  }
  const groups = new Map<string, OriginGroup & { albumCount: Map<string, number> }>()
  for (const t of tracks) {
    if (t.origin || alreadySet.has(t.id)) continue          // genre doesn't matter: origin is the artist's
    const name = originArtist(t)
    if (!name || isVarious(name)) continue
    const key = originCacheKey(name)
    const g = groups.get(key) ?? { key, name, tracks: [], albums: [], plan: 'ask' as const, albumCount: new Map<string, number>() }
    g.tracks.push(t)
    const al = (t.album || '').trim()
    if (al) g.albumCount.set(al, (g.albumCount.get(al) ?? 0) + 1)
    groups.set(key, g)
  }
  const out: OriginGroup[] = []
  for (const { albumCount, ...g } of groups.values()) {
    g.albums = [...albumCount.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([a]) => a)
    // His other songs by the same credit — or by its primary artist, featured
    // guests dropped ("Gorillaz feat. X" is Gorillaz). Never a shorter "&" or
    // "," part: "Love, DEAN" is not Love.
    const copied = known(g.name) ?? known(originNames(g.name).primary)
    const hit = cache[g.key]
    if (copied) out.push({ ...g, plan: 'copy', origin: copied })
    else if (hit?.origin) out.push({ ...g, plan: 'remembered', origin: hit.origin })
    else if (hit?.origin === null && hit.at !== undefined && now - hit.at < retryMs) out.push({ ...g, plan: 'waiting' })
    else out.push({ ...g, plan: 'ask' })
  }
  const failed = (g: OriginGroup): number => cache[g.key]?.failedAt ?? 0
  return out.sort((a, b) => (a.plan === 'ask' ? 1 : 0) - (b.plan === 'ask' ? 1 : 0)
    || (a.plan === 'ask' ? failed(a) - failed(b) : 0)
    || b.tracks.length - a.tracks.length || a.name.localeCompare(b.name))
}

/**
 * Origin for every song whose Origin is blank, whatever its genre — Charley
 * Crockett arrived with a fine "Country" tag, so nothing ever filed him.
 * Free first: his other songs by that artist, then remembered answers (an
 * artist nobody knows is skipped until ORIGIN_RETRY_MS — skipped, never
 * blocking anyone else). Then up to maxOriginLookups real lookups; only those
 * count (10/18: the 10 remembered unknowns at the head of the walk ate the
 * whole budget every sweep from 10/12, and 123 artists were never asked).
 * MusicBrainz busy → this sweep stops asking; nothing is remembered.
 * Never guessed: no answer, no origin.
 */
export async function fillOrigins(deps: FilerDeps, tracks: FilerTrack[], _homes: Map<string, { genre: string; origin?: string }>, alreadySet: Set<number>): Promise<number> {
  const cache: OriginCache = (await deps.loadOriginCache?.()) ?? {}
  const now = (deps.now ?? (() => new Date()))().getTime()
  const groups = planOrigins(tracks, cache, now, alreadySet, deps.originRetryMs)
  const budget = deps.maxOriginLookups ?? 10
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  let asked = 0, busy = false
  for (const g of groups) {
    let origin = g.origin
    let how = g.plan === 'copy' ? 'his other songs' : 'remembered'
    if (g.plan === 'ask' && deps.lookupOrigin && !busy && asked < budget) {
      asked++
      const r = await deps.lookupOrigin(g.name, g.albums)
      if (r.kind === 'busy') {
        busy = true                                  // no hammering: the rest wait for the next sweep
        cache[g.key] = { ...cache[g.key], failedAt: now }
        deps.log?.(`[genre-filer] origin: ${g.name} — lookup busy (${r.note}); asking again next sweep`)
      } else if (r.kind === 'found') {
        cache[g.key] = { origin: r.origin, at: now, source: r.source, ...(r.via ? { via: r.via } : {}), mbid: r.mbid, note: r.evidence }
        origin = r.origin
        how = `${r.source}${r.via ? ` via ${r.via}` : ''}, ${r.evidence}`
      } else {
        cache[g.key] = { origin: null, at: now, ...(r.mbid ? { mbid: r.mbid } : {}), note: r.note }
        if (!HEBREW.test(g.name)) deps.log?.(`[genre-filer] origin: ${g.name} — unknown (${r.note})`)
      }
      await deps.saveOriginCache?.(cache)
    }
    // Jake's rule (2026-10-11): a name written in Hebrew is an Israeli artist.
    // Not extended to Cyrillic — that spans Belarus, Russia, Ukraine and more.
    if (!origin && HEBREW.test(g.name)) { origin = 'Israel'; how = 'Hebrew name' }
    if (!origin) continue
    for (const t of g.tracks) {
      await deps.persist(t, { origin })
      updates.push({ trackId: t.id, field: 'origin', newValue: origin })
    }
    deps.log?.(`[genre-filer] origin: ${g.name} → ${origin} (${how}; ${g.tracks.length} song${g.tracks.length === 1 ? '' : 's'})`)
  }
  if (updates.length) deps.applied(updates)
  if (asked) {
    const left = groups.filter((g) => g.plan === 'ask').length - asked + (busy ? 1 : 0)
    deps.log?.(`[genre-filer] origins: asked ${asked} of ${budget}${busy ? ' (stopped: busy)' : ''}, ${left} artist${left === 1 ? '' : 's'} still to ask`)
  }
  return updates.length
}

/** Jake picks a genre for a check-list entry: write it, drop the entry. */
export async function resolveCheckEntry(deps: Pick<FilerDeps, 'tracks' | 'persist' | 'applied' | 'loadCheck' | 'saveCheck'>, key: string, genre: string): Promise<{ ok: boolean; error?: string }> {
  if (!GENRE_NAMES.has(genre)) return { ok: false, error: 'not on the list' }
  const check = await deps.loadCheck()
  const entry = check.find((c) => c.key === key)
  if (!entry) return { ok: false, error: 'not on the check list' }
  const byId = new Map((await deps.tracks()).map((t) => [t.id, t]))
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  for (const id of entry.ids) {
    const t = byId.get(id)
    if (!t) continue
    await deps.persist(t, { genre })
    updates.push({ trackId: id, field: 'genre', newValue: genre })
  }
  if (updates.length) deps.applied(updates)
  await deps.saveCheck(check.filter((c) => c.key !== key))
  return { ok: true }
}
