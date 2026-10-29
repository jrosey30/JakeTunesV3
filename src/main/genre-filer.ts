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
 *   5. Unsure → his check list (Settings → Library). Since 2026-10-28 (Jake,
 *      after "Myatt's Song" sat for a day as "Alternatif et Indé, Rock, Pop":
 *      "genre not updated boooo") an unsure album is FILED under the filer's
 *      suggestion (on the list, rock-stays-rock still enforced) and STAYS on the
 *      check list, marked filedAs, so he can change it. A raw store tag never
 *      sits on a song waiting for him.
 *   6. No dumping grounds (2026-10-28, Sam Gellaitry's "IV" → Experimental
 *      while House, Nu Disco, French House sat right there): a catch-all
 *      shelf (DUMPING_GROUNDS) only when the evidence itself says so;
 *      otherwise the closest real shelf, or low confidence.
 *   7. Evidence is real (2026-10-28): besides MusicBrainz and press, the
 *      sound-alike vote from his own library (genre-sound-alike.ts) and the
 *      store/Discogs tags (genre-external-tags.ts). Check-list albums judged
 *      on the old, thinner evidence get ONE re-judgement (EVIDENCE_VERSION);
 *      a song Jake set himself is never touched.
 *   8. Who set it counts (2026-10-28, genre-provenance.ts): his own Get Info
 *      choice stands even OFF the list (The Avalanches "Electronic" was
 *      filed over three times on 10/20); the filer's own picks are recorded,
 *      so they are never re-filed every sweep yet CAN be re-judged; new songs
 *      of an album already filed join that album's shelf (album-sibling); and
 *      an artist's "home" is built only from shelves someone trusted chose —
 *      never a filer guess, a dumping ground or a catch-all it picked.
 *
 * Pure decisions + injected effects, so the rules are tested directly.
 */
import { GENRES, GENRE_NAMES, CATCH_ALL, ROCK_FAMILY, PER_ALBUM_ARTISTS, isListGenre } from '../common/genre-vocab.ts'
import { normName } from './taste-profile.ts'
import { originNames, type OriginLookup, type OriginSource } from './origin-lookup.ts'
import { soundAlikeFor, soundAlikeLeader, soundAlikeText, type ShelfTrack, type SoundAlike } from './genre-sound-alike.ts'
import { isHis, type GenreOwner, type FilerHow } from './genre-provenance.ts'

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
  /** Who set the genre (genre-provenance.ts). Absent = the old rule (tests,
   *  callers without a record): genreApproved decides. */
  genreBy?: GenreOwner
  /** When genreBy is 'filer': how it got there. */
  filerPick?: { how: string; confidence?: string }
  /** The fp of the overrides entry when it does NOT match this song (a
   *  wipe/re-measure trace for the repair log). */
  overrideFpSeen?: string
}

/** Why a genre is being written — the provenance record (by: filer unless Jake filed it). */
export interface GenreWhy { by: 'filer' | 'jake'; how: FilerHow | 'check-list'; confidence?: 'high' | 'medium' | 'low' }

export interface FilerUnit { key: string; artist: string; album: string; title?: string; comp: boolean; ids: number[]; tag: string }

export interface Decision {
  genre: string | null          // null = leave the genre alone (on the check list)
  origin?: string
  how: 'artist-home' | 'album-sibling' | 'specific-tag' | 'evidence' | 'check'
  why: string
  suggested?: string
  /** The AI's confidence, or the inherited one (artist-home / album-sibling). */
  confidence?: 'high' | 'medium' | 'low'
}

export interface Evidence {
  artistTags: string[]; albumTags: string[]; origin?: string; press: string
  /** Deezer's genres for this album (keyless). */
  deezer?: string[]
  /** Discogs genres + styles (only with a token). */
  discogs?: string[]
  /** His nearest settled songs' shelves — filled by the sweep, not the fetcher. */
  soundAlike?: SoundAlike | null
}

/** Which evidence a check-list entry was judged on. 1 = MusicBrainz + press
 *  (to 2026-10-28); 2 = + sound-alike vote, Deezer, Discogs, no dumping
 *  grounds. An open entry below this gets one re-judgement. */
export const EVIDENCE_VERSION = 2

/** Catch-all shelves (Jake 2026-10-28: "Experimental" means "Defies genre on
 *  purpose", not "nothing fit"). A pick here stands only when the evidence
 *  itself says so. Store tags count; the sound-alike vote does not (a shelf
 *  name in the vote is the list's word, not the evidence's). */
export const DUMPING_GROUNDS: ReadonlyMap<string, RegExp> = new Map([
  ['Experimental', /\b(experimental|avant[- ]?garde|noise(?![- ]?(?:pop|rock))|musique concr[eè]te|sound art|sound collage|free improv\w*|electroacoustic)\b/i],
])

/** The words the evidence actually says — store tag, MusicBrainz, Deezer, Discogs, press. */
export function evidenceWords(tag: string, e: Partial<Evidence> | undefined): string {
  return [tag, ...(e?.albumTags ?? []), ...(e?.artistTags ?? []), ...(e?.deezer ?? []), ...(e?.discogs ?? []), e?.press ?? ''].join(' | ')
}

/** May this genre be picked on this evidence? Only a dumping ground needs the evidence to say it. */
export function dumpingGroundAllowed(genre: string, tag: string, e: Partial<Evidence> | undefined): boolean {
  const re = DUMPING_GROUNDS.get(genre)
  return !re || re.test(evidenceWords(tag, e))
}

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

/** A genre that needs no filing: his own choice (on the list or not), a list
 *  genre the filer wrote, a specific list genre, or a catch-all he approved. */
export function isSettled(t: FilerTrack): boolean {
  if (isHis(t.genreBy) && t.genreBy !== 'unknown') return !!(t.genre || '').trim()
  if (t.genreBy === 'filer') return isListGenre(t.genre)
  return isListGenre(t.genre) && (!!t.genreApproved || !CATCH_ALL.has(t.genre!.trim()))
}

/** May this song's genre be rewritten by the filer (a re-judgement, a
 *  correction)? Only when the filer put it there or nobody chose it. */
export function filerMayRewrite(t: FilerTrack): boolean {
  if (t.genreBy) return t.genreBy === 'filer' || t.genreBy === 'store'
  return !isSettled(t)
}

/** Is a check-list entry still Jake's to look at? Yes while any song is
 *  unsettled, or still wears the suggestion the filer wrote (filedAs). A song
 *  on another list genre means he filed it himself (Get Info). */
export function checkEntryOpen(c: CheckEntry, byId: Map<number, FilerTrack>): boolean {
  if (c.review) return c.ids.some((id) => (byId.get(id)?.genre || '').trim() === c.tag)
  return c.ids.some((id) => {
    const t = byId.get(id)
    if (!t) return false
    if (!isSettled(t)) return true
    if (isHis(t.genreBy)) return false
    // Still the filer's: its suggestion (filedAs), or any pick it recorded
    // for an entry he never answered.
    return (!!c.filedAs && (t.genre || '').trim() === c.filedAs) || (t.genreBy === 'filer' && t.filerPick?.how === 'suggestion')
  })
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

/** Filer picks that may NOT seed an artist's home: a suggestion or anything
 *  low-confidence, a copy (artist-home / album-sibling — no chains), a
 *  dumping ground, or a catch-all it chose (2026-10-28: Father of Peace went
 *  Rock on two songs' thin evidence, then 14 more songs followed it). */
export function trustedForHome(t: FilerTrack): boolean {
  if (!isSettled(t) || !isListGenre(t.genre)) return false
  if (t.genreBy !== 'filer') return true
  const g = t.genre!.trim()
  const p = t.filerPick
  if (!p || p.confidence === 'low') return false
  if (!['evidence', 'specific-tag', 'rejudge', 'correction'].includes(p.how)) return false
  return !DUMPING_GROUNDS.has(g) && !CATCH_ALL.has(g)
}

const albumKeyOf = (t: FilerTrack): string | null => {
  const albumArtist = (t.albumArtist || t.artist || '').trim()
  if (t.compilation || isVarious(albumArtist)) return null
  return `album:${norm(albumArtist)}|${norm(t.album)}`
}

/** An album's shelf from its songs already settled — new songs of the same
 *  album join it (one genre per album), carrying the pick's own provenance. */
export function albumHomes(tracks: FilerTrack[]): Map<string, { genre: string; by?: GenreOwner; pick?: { how: string; confidence?: string } }> {
  const c = new Map<string, Map<string, { n: number; t: FilerTrack }>>()
  for (const t of tracks) {
    if (!isSettled(t) || !isListGenre(t.genre)) continue
    const k = albumKeyOf(t)
    if (!k) continue
    const m = c.get(k) ?? new Map<string, { n: number; t: FilerTrack }>()
    const g = t.genre!.trim()
    const cur = m.get(g) ?? { n: 0, t }
    cur.n++
    m.set(g, cur); c.set(k, m)
  }
  const out = new Map<string, { genre: string; by?: GenreOwner; pick?: { how: string; confidence?: string } }>()
  for (const [k, m] of c) {
    const [g, v] = [...m.entries()].sort((x, y) => y[1].n - x[1].n || x[0].localeCompare(y[0]))[0]
    out.set(k, { genre: g, by: v.t.genreBy, pick: v.t.filerPick })
  }
  return out
}

/** Each artist's shelf (most common TRUSTED list genre across their songs) and origin. */
export function artistHomes(tracks: FilerTrack[]): Map<string, { genre: string; origin?: string }> {
  const g = new Map<string, Map<string, number>>()
  const o = new Map<string, Map<string, number>>()
  const bump = (m: Map<string, Map<string, number>>, k: string, v: string): void => {
    const c = m.get(k) ?? new Map<string, number>(); c.set(v, (c.get(v) ?? 0) + 1); m.set(k, c)
  }
  for (const t of tracks) {
    const a = (t.albumArtist || t.artist || '').trim()
    if (!a || isVarious(a)) continue
    if (trustedForHome(t)) bump(g, norm(a), t.genre!.trim())   // homes come from trusted shelves only
    if (t.origin) bump(o, norm(a), t.origin)
  }
  const top = (c: Map<string, number> | undefined): string | undefined =>
    c ? [...c.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] : undefined
  const out = new Map<string, { genre: string; origin?: string }>()
  for (const [a, c] of g) out.set(a, { genre: top(c)!, origin: top(o.get(a)) })
  return out
}

/** Rules 1 and 2: decisions that need no lookup. null = needs evidence. */
export function decideByRules(u: FilerUnit, homes: Map<string, { genre: string; origin?: string }>, albums?: Map<string, { genre: string; by?: GenreOwner; pick?: { how: string; confidence?: string } }>): Decision | null {
  const home = homes.get(norm(u.artist))
  // New songs of an album already on a shelf (a download still landing, a
  // single that became an album) join it — no lookup, no new judgement.
  const sib = u.comp ? undefined : albums?.get(u.key)
  if (sib) {
    const c = sib.by === 'filer' ? sib.pick?.confidence : 'high'
    return { genre: sib.genre, origin: home?.origin, how: 'album-sibling', why: `the rest of the album is on ${sib.genre}`, confidence: c === 'high' || c === 'medium' || c === 'low' ? c : undefined }
  }
  if (home && !PER_ALBUM_ARTISTS.has(u.artist)) return { genre: home.genre, origin: home.origin, how: 'artist-home', why: `${u.artist} already lives on ${home.genre}`, confidence: 'high' }
  if (isListGenre(u.tag) && !CATCH_ALL.has(u.tag)) return { genre: u.tag, origin: home?.origin, how: 'specific-tag', why: 'its tag is already a specific genre on the list' }
  return null
}

export interface AiPick { genre?: string; confidence?: string; why?: string; alt?: string }

const isRockTag = (tag: string): boolean => tag === 'Rock' || tag === 'Classic Rock'

/** Rules 4, 5 and 6 applied to the AI's pick. `ev` is the evidence it saw
 *  (a bare string is the old origin-only call). */
export function enforce(u: FilerUnit, pick: AiPick, ev?: Partial<Evidence> | string): Decision {
  const e: Partial<Evidence> | undefined = typeof ev === 'string' ? { origin: ev } : ev
  const origin = e?.origin
  const g = (pick.genre || '').trim()
  const why = String(pick.why || '').slice(0, 140)
  if (!GENRE_NAMES.has(g)) return { genre: null, origin, how: 'check', why: `not on the list: ${g || 'no answer'}`, suggested: undefined }
  if (isRockTag(u.tag) && !ROCK_FAMILY.has(g)) {
    // A rock alt is the useful suggestion; otherwise the pick is recorded and
    // fileableSuggestion keeps it off the songs.
    const alt = (pick.alt || '').trim()
    return { genre: null, origin, how: 'check', why: `rock stays rock (suggested ${g})`, suggested: GENRE_NAMES.has(alt) && ROCK_FAMILY.has(alt) ? alt : g }
  }
  if (!dumpingGroundAllowed(g, u.tag, e)) {
    // Rule 6: never a dumping ground the evidence doesn't name. The AI's
    // closest real shelf, else his own shelves' plurality — or nothing.
    const fallback = [pick.alt, soundAlikeLeader(e?.soundAlike)].map((x) => (x || '').trim())
      .find((x) => GENRE_NAMES.has(x) && !DUMPING_GROUNDS.has(x) && (!isRockTag(u.tag) || ROCK_FAMILY.has(x)))
    return { genre: null, origin, how: 'check', why: `${g} needs evidence that says so${fallback ? ` — closest real shelf ${fallback}` : ''}${why ? ` (${why})` : ''}`.slice(0, 200), suggested: fallback }
  }
  if (pick.confidence === 'low') return { genre: null, origin, how: 'check', why: why || 'not sure', suggested: g, confidence: 'low' }
  return { genre: g, origin, how: 'evidence', why, confidence: pick.confidence === 'high' ? 'high' : 'medium' }
}

export function filerSystemPrompt(): string {
  let area = ''
  const list = GENRES.map((g) => { const head = g.area !== area ? `\n## ${(area = g.area)}\n` : ''; return `${head}- ${g.name}: ${g.strict ? 'STRICT — ' : ''}${g.definition}` }).join('\n')
  return `You file new albums into Jake's record collection. Each album gets EXACTLY ONE genre from his list — copy the name exactly; never invent or combine.
Rules: ROCK IS CONSERVATIVE (an album tagged Rock or Classic Rock stays on a rock, punk or metal shelf). Alternative, Pop and R&B are STRICT (Alternative = real 80s–90s alternative rock only). Rap is shelved by region or style. Judge the artist's mainstream identity and this record's sound: what would most music listeners file it under?
Evidence, most trusted first: MusicBrainz album tags, MusicBrainz artist tags (the FIRST tags describe the artist; a minor tag never wins), Discogs styles, music press, Deezer genres (coarse store genres). "sounds like Jake's shelves" counts the shelves of the songs in HIS library that sound nearest to this album: strong evidence of which of his shelves it sits beside — weigh it with the tags, it is not the answer by itself (the mood-index version is weaker).
NO DUMPING GROUNDS: Experimental means "defies genre on purpose". Pick it ONLY when the evidence itself says experimental / avant-garde / noise. When no shelf fits perfectly, pick the CLOSEST real shelf (e.g. future bass or melodic electronic → the nearest Electronic & Dance shelf his sound-alikes point to) or answer confidence "low". If the evidence is thin or contradictory, answer confidence "low" — never guess from a band's name.
Answer with ONLY a JSON array: [{"id": "<id>", "genre": "<exact list name>", "alt": "<second-closest exact list name>", "confidence": "high"|"medium"|"low", "why": "<12 words max, name the evidence>"}]

JAKE'S GENRE LIST
${list}`
}

export function evidenceLine(id: string, u: FilerUnit, e: Evidence): string {
  const parts = [`id=${id}`, `${u.artist} — "${u.comp ? u.title : u.album}"`, `store tag: ${u.tag || '(none)'}`]
  if (e.albumTags.length) parts.push(`MB album tags: ${e.albumTags.slice(0, 6).join(', ')}`)
  if (e.artistTags.length) parts.push(`MB artist tags (most-voted first): ${e.artistTags.slice(0, 6).join(', ')}`)
  if (e.discogs?.length) parts.push(`Discogs: ${e.discogs.slice(0, 8).join(', ')}`)
  if (e.deezer?.length) parts.push(`Deezer: ${e.deezer.slice(0, 4).join(', ')}`)
  if (e.soundAlike) parts.push(soundAlikeText(e.soundAlike))
  if (e.press) parts.push(`press: ${e.press.replace(/\s+/g, ' ').slice(0, 600)}`)
  if (!e.albumTags.length && !e.artistTags.length && !e.press && !e.discogs?.length && !e.deezer?.length && !e.soundAlike) parts.push('no evidence found')
  return parts.join(' | ')
}

export function parseReply(text: string): Array<AiPick & { id: string }> {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    return Array.isArray(arr) ? arr.filter((x): x is { id: string } => !!x && typeof x === 'object' && 'id' in x).map((x) => ({ ...(x as object), id: String((x as { id: unknown }).id) })) : []
  } catch { return [] }
}

export interface CheckEntry { key: string; artist: string; album: string; ids: number[]; tag: string; suggested?: string; why: string; at: string
  /** The suggestion the filer wrote onto the songs (2026-10-28). The entry stays
   *  listed until Jake confirms or changes it; a different genre on the songs
   *  (Get Info) means he already did. */
  filedAs?: string
  /** EVIDENCE_VERSION it was last judged on (absent = 1). */
  evidence?: number
  /** When the one re-judgement on newer evidence ran. */
  rejudgedAt?: string
  /** A suggestion for songs he set (or nobody recorded who set): nothing is
   *  written until he files it. `tag` is what they wear now. Open while they
   *  still wear it. (The 2026-10-28 audit.) */
  review?: boolean }

/** The suggestion an unsure album can be filed under: on his list, and never
 *  moving a Rock / Classic Rock album off the rock shelves (rule 4). */
export function fileableSuggestion(tag: string, suggested: string | undefined): string | null {
  const g = (suggested || '').trim()
  if (!g || !GENRE_NAMES.has(g)) return null
  const t = (tag || '').trim()
  if ((t === 'Rock' || t === 'Classic Rock') && !ROCK_FAMILY.has(g)) return null
  return g
}

export interface FilerDeps {
  tracks(): Promise<FilerTrack[]>                 // effective tracks (overrides applied)
  /** `why` is given whenever fields.genre is: the host records it (genre-provenance.ts). */
  persist(t: FilerTrack, fields: Record<string, string>, why?: GenreWhy): Promise<void>
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
  /** The vector spaces for the sound-alike vote: CLAP audio, and the mood
   *  index as the fallback. Absent = no vote (tests, or no index files). */
  vectors?(): Promise<{ audio?: Map<number, Float32Array>; mood?: Map<number, Float32Array> }>
}

/** His shelves for the sound-alike vote: settled songs, minus everything on
 *  an open check-list entry (a filedAs suggestion is not his decision yet —
 *  Experimental-filed albums must not vote for Experimental). */
export function shelfTracks(tracks: FilerTrack[], check: CheckEntry[]): Map<number, ShelfTrack> {
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const pending = new Set(check.filter((c) => !c.review && checkEntryOpen(c, byId)).flatMap((c) => c.ids))
  const out = new Map<number, ShelfTrack>()
  for (const t of tracks) {
    if (!isSettled(t) || pending.has(t.id)) continue
    out.set(t.id, { genre: t.genre!.trim(), artist: (t.albumArtist || t.artist || '').trim() })
  }
  return out
}

/** Open check-list entries judged on older evidence: each gets ONE re-judgement. */
export function needsRejudge(c: CheckEntry, byId: Map<number, FilerTrack>): boolean {
  return !c.review && (c.evidence ?? 1) < EVIDENCE_VERSION && checkEntryOpen(c, byId)
}

/** A check-list entry's songs the filer may still write: unsettled, or still
 *  wearing the suggestion it wrote. A song Jake set himself is never touched. */
export function rewritableIds(c: CheckEntry, byId: Map<number, FilerTrack>): number[] {
  return c.ids.filter((id) => {
    const t = byId.get(id)
    if (!t) return false
    if (t.genreBy) return filerMayRewrite(t)
    return !isSettled(t) || (!!c.filedAs && (t.genre || '').trim() === c.filedAs)
  })
}

/** Songs wearing a genre the filer recorded whose overrides entry is gone
 *  or no longer matches (10/28: The Police and Social Distortion were judged
 *  twice because their catch-all override vanished between sweeps). Put it
 *  back as it was — no new judgement — and say what was found. */
export function repairsNeeded(tracks: FilerTrack[]): FilerTrack[] {
  return tracks.filter((t) => t.genreBy === 'filer' && !t.genreApproved && isListGenre(t.genre))
}

const entryUnit = (c: CheckEntry): FilerUnit => {
  const comp = c.key.startsWith('song:')
  return { key: c.key, artist: c.artist, album: comp ? '' : c.album, title: comp ? c.album : undefined, comp, ids: c.ids, tag: c.tag }
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
/** Busy lookups in one sweep before it stops asking. One 503 is MusicBrainz
 *  shedding load for a moment; two in a sweep, it is struggling. */
export const ORIGIN_BUSY_STOP = 2
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
export async function runFilerSweep(deps: FilerDeps): Promise<{ filed: number; checked: number; deferred: number; backfilled: number; origins: number; rejudged: number }> {
  const tracks = await deps.tracks()
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const check = await deps.loadCheck()
  // Albums already on the check list that were never filed (listed before
  // 2026-10-28): file them under their suggestion now. Songs Jake has since
  // settled himself are left alone.
  const backfill: Array<{ trackId: number; field: string; newValue: string }> = []
  let backfilled = 0
  for (const c of check) {
    if (c.filedAs || c.review) continue
    const g = fileableSuggestion(c.tag, c.suggested)
    if (!g) continue
    // An unvetted catch-all suggestion waits for its re-judgement (rule 6).
    if (DUMPING_GROUNDS.has(g) && (c.evidence ?? 1) < EVIDENCE_VERSION) continue
    let wrote = false
    for (const id of c.ids) {
      const t = byId.get(id)
      if (!t || isSettled(t)) continue
      await deps.persist(t, { genre: g }, { by: 'filer', how: 'suggestion', confidence: 'low' })
      backfill.push({ trackId: id, field: 'genre', newValue: g })
      wrote = true
    }
    if (wrote) { c.filedAs = g; backfilled++; deps.log?.(`[genre-filer] ${c.artist} — ${c.album}: → ${g} (suggestion; stays on the check list)`) }
  }
  if (backfill.length) { deps.applied(backfill); await deps.saveCheck(check) }
  // Rule 8: a pick the filer recorded whose override went missing is put back
  // as it was (and the trace logged), never judged again.
  for (const t of repairsNeeded(tracks)) {
    const g = t.genre!.trim()
    await deps.persist(t, { genre: g }, { by: 'filer', how: (t.filerPick?.how as FilerHow) ?? 'evidence', ...(t.filerPick?.confidence ? { confidence: t.filerPick.confidence as 'high' | 'medium' | 'low' } : {}) })
    t.genreApproved = true
    deps.log?.(`[genre-filer] repaired ${t.artist} — ${t.album} (${t.id}): its ${g} was missing from the edits file${t.overrideFpSeen ? ` (entry fp "${t.overrideFpSeen}" ≠ song "${trackFingerprint(t)}")` : ''}; put back, not re-judged`)
  }
  const listed = new Set(check.map((c) => c.key))
  const units = unfiledUnits(tracks).filter((u) => !listed.has(u.key))
  const homes = artistHomes(tracks)
  const albums = albumHomes(tracks)
  const rejudge = check.filter((c) => needsRejudge(c, byId))
  if (!units.length && !rejudge.length) return { filed: 0, checked: 0, deferred: 0, backfilled, origins: await fillOrigins(deps, tracks, homes, new Set()), rejudged: 0 }
  const decided: Array<[FilerUnit, Decision]> = []
  const needEvidence: FilerUnit[] = []
  for (const u of units) {
    const d = decideByRules(u, homes, albums)
    if (d) decided.push([u, d]); else needEvidence.push(u)
  }
  const max = deps.maxUnits ?? 8
  const batch = needEvidence.slice(0, max)
  // Re-judgements share the sweep's budget, after the new albums.
  const rejudgeBatch = rejudge.slice(0, Math.max(0, max - batch.length))
  const rejudged: Array<[CheckEntry, Decision]> = []
  const now = (deps.now ?? (() => new Date()))().toISOString()
  if (batch.length || rejudgeBatch.length) {
    const spaces = (await deps.vectors?.().catch(() => undefined)) ?? {}
    const shelf = shelfTracks(tracks, check)
    const judge: Array<{ u: FilerUnit; entry?: CheckEntry }> = [...batch.map((u) => ({ u })), ...rejudgeBatch.map((c) => ({ u: entryUnit(c), entry: c }))]
    const ev = new Map<string, Evidence>()
    for (const { u, entry } of judge) {
      if (!u.artist.trim() && !u.album.trim() && !u.title?.trim()) { ev.set(u.key, { artistTags: [], albumTags: [], press: '' }); continue }
      const e = await deps.evidence(u)
      // Mood vectors carry the song's genre line: for an album already wearing
      // the filer's suggestion they would echo it back, so audio only.
      e.soundAlike = soundAlikeFor(u.ids, spaces, shelf, !entry?.filedAs)
      ev.set(u.key, e)
    }
    const reply = parseReply(await deps.classify(filerSystemPrompt(), 'Albums:\n' + judge.map(({ u }, i) => evidenceLine(String(i), u, ev.get(u.key)!)).join('\n')))
    const got = new Map(reply.map((r) => [r.id, r]))
    judge.forEach(({ u, entry }, i) => {
      const d = enforce(u, got.get(String(i)) ?? {}, ev.get(u.key))
      // A re-judgement with no answer (API failure, bad JSON) isn't spent:
      // it runs again next sweep. Only a real answer stamps the entry.
      if (entry) { if (got.has(String(i))) rejudged.push([entry, d]) } else decided.push([u, d])
    })
  }
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  let filed = 0
  for (const [u, d] of decided) {
    for (const id of u.ids) {
      const t = byId.get(id)
      if (!t) continue
      const fields: Record<string, string> = {}
      const genre = d.genre ?? fileableSuggestion(u.tag, d.suggested)
      if (genre) fields.genre = genre
      if (d.origin && !t.origin) fields.origin = d.origin
      if (!Object.keys(fields).length) continue
      const how: FilerHow = !d.genre ? 'suggestion' : d.how === 'check' ? 'suggestion' : d.how
      await deps.persist(t, fields, genre ? { by: 'filer', how, ...(d.genre ? (d.confidence ? { confidence: d.confidence } : {}) : { confidence: 'low' as const }) } : undefined)
      for (const [field, newValue] of Object.entries(fields)) updates.push({ trackId: id, field, newValue })
    }
    const filedAs = d.genre ? undefined : fileableSuggestion(u.tag, d.suggested) ?? undefined
    if (d.genre) filed++
    else check.push({ key: u.key, artist: u.artist, album: u.comp ? (u.title || u.album) : u.album, ids: u.ids, tag: u.tag, suggested: d.suggested, why: d.why, at: now, evidence: EVIDENCE_VERSION, ...(filedAs ? { filedAs } : {}) })
    deps.log?.(`[genre-filer] ${u.artist} — ${u.album}: ${d.genre ? `→ ${d.genre} (${d.how})` : filedAs ? `→ ${filedAs} (suggestion; stays on the check list: ${d.why})` : `check list (${d.why})`}`)
  }
  // Re-judgements (rule 7): once per entry, on the newer evidence. Only songs
  // still unsettled or wearing the filer's own suggestion are rewritten.
  const resolved = new Set<string>()
  for (const [c, d] of rejudged) {
    const before = c.filedAs
    const g = d.genre ?? fileableSuggestion(c.tag, d.suggested)
    if (g) {
      for (const id of rewritableIds(c, byId)) {
        const t = byId.get(id)!
        if ((t.genre || '').trim() === g && isSettled(t) && t.genreBy !== 'store') continue
        await deps.persist(t, { genre: g }, { by: 'filer', how: d.genre ? 'rejudge' : 'suggestion', confidence: d.genre ? (d.confidence ?? 'medium') : 'low' })
        updates.push({ trackId: id, field: 'genre', newValue: g })
      }
    }
    c.evidence = EVIDENCE_VERSION
    c.rejudgedAt = now
    if (d.genre) { resolved.add(c.key); filed++ }
    else {
      c.why = d.why
      c.suggested = d.suggested
      if (g) c.filedAs = g
      // No fileable answer: the songs keep what they wear (never made worse),
      // and the entry stays on his list.
    }
    deps.log?.(`[genre-filer] re-judged ${c.artist} — ${c.album}: ${before ?? c.tag} → ${d.genre ? `${d.genre} (${d.how}; off the check list)` : g ? `${g} (suggestion; stays on the check list: ${d.why})` : `unchanged, on the check list (${d.why})`}`)
  }
  if (updates.length) deps.applied(updates)
  if (decided.some(([, d]) => !d.genre) || rejudged.length) await deps.saveCheck(resolved.size ? check.filter((c) => !resolved.has(c.key)) : check)
  const origins = await fillOrigins(deps, tracks, homes, new Set(updates.filter((u) => u.field === 'origin').map((u) => u.trackId)))
  return { filed, checked: decided.filter(([, d]) => !d.genre).length, deferred: needEvidence.length - batch.length, backfilled, origins, rejudged: rejudged.length }
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
 * Busy (503 / timeout) → nothing is remembered, that artist is asked again
 * next sweep; a second busy stops this sweep's asking (MusicBrainz is
 * struggling — no hammering).
 * Never guessed: no answer, no origin.
 */
export async function fillOrigins(deps: FilerDeps, tracks: FilerTrack[], _homes: Map<string, { genre: string; origin?: string }>, alreadySet: Set<number>): Promise<number> {
  const cache: OriginCache = (await deps.loadOriginCache?.()) ?? {}
  const now = (deps.now ?? (() => new Date()))().getTime()
  const groups = planOrigins(tracks, cache, now, alreadySet, deps.originRetryMs)
  const budget = deps.maxOriginLookups ?? 10
  const updates: Array<{ trackId: number; field: string; newValue: string }> = []
  let asked = 0, busy = 0
  for (const g of groups) {
    let origin = g.origin
    let how = g.plan === 'copy' ? 'his other songs' : 'remembered'
    if (g.plan === 'ask' && deps.lookupOrigin && busy < ORIGIN_BUSY_STOP && asked < budget) {
      asked++
      const r = await deps.lookupOrigin(g.name, g.albums)
      if (r.kind === 'busy') {
        busy++                                       // ORIGIN_BUSY_STOP of these and the rest wait for the next sweep
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
    const left = groups.filter((g) => g.plan === 'ask').length - asked + busy
    deps.log?.(`[genre-filer] origins: asked ${asked} of ${budget}${busy ? `, ${busy} busy${busy >= ORIGIN_BUSY_STOP ? ' (stopped)' : ''}` : ''}, ${left} artist${left === 1 ? '' : 's'} still to ask`)
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
    await deps.persist(t, { genre }, { by: 'jake', how: 'check-list' })
    updates.push({ trackId: id, field: 'genre', newValue: genre })
  }
  if (updates.length) deps.applied(updates)
  await deps.saveCheck(check.filter((c) => c.key !== key))
  return { ok: true }
}
