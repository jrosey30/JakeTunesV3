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

const norm = (s: string | undefined): string => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
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
  /** Where an artist is from: a country name, null when nobody knows (don't
   *  ask again soon), undefined when the lookup failed (ask next sweep). */
  lookupOrigin?(artist: string): Promise<string | null | undefined>
  maxOriginLookups?: number
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

/**
 * Origin for songs whose genre is already settled but whose Origin is blank —
 * Charley Crockett arrived with a fine "Country" tag, so nothing ever filed him.
 * An artist he already has an origin for is copied with no lookup; the rest
 * are looked up a few per sweep. Never guessed: no answer, no origin.
 */
export async function fillOrigins(deps: FilerDeps, tracks: FilerTrack[], homes: Map<string, { genre: string; origin?: string }>, alreadySet: Set<number>): Promise<number> {
  const byArtist = new Map<string, { name: string; tracks: FilerTrack[] }>()
  for (const t of tracks) {
    if (t.origin || alreadySet.has(t.id) || !isSettled(t)) continue
    const a = (t.albumArtist || t.artist || '').trim()
    if (!a || isVarious(a)) continue
    const g = byArtist.get(norm(a)) ?? { name: a, tracks: [] }
    g.tracks.push(t)
    byArtist.set(norm(a), g)
  }
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  let lookups = 0
  for (const [k, g] of byArtist) {
    let origin = homes.get(k)?.origin
    if (!origin && deps.lookupOrigin && lookups < (deps.maxOriginLookups ?? 10)) {
      lookups++
      origin = (await deps.lookupOrigin(g.name)) ?? undefined
    }
    if (!origin) continue
    for (const t of g.tracks) {
      await deps.persist(t, { origin })
      updates.push({ trackId: t.id, field: 'origin', newValue: origin })
    }
    deps.log?.(`[genre-filer] origin: ${g.name} → ${origin} (${g.tracks.length} song${g.tracks.length === 1 ? '' : 's'})`)
  }
  if (updates.length) deps.applied(updates)
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
