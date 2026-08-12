/**
 * The listener profile — what Jake has actually DONE with his library.
 *
 * The counterpart to library-digest.ts. That module describes what he owns;
 * this one describes what he plays, skips and rates, and turns it into the
 * taste summary every persona prompt carries. Owning a record and wearing it
 * out are different facts, and the characters are told both.
 *
 * Two stores, deliberately not one:
 *
 *   listener-profile.json — rolling aggregates in STATE_DIR (shared): play
 *     counts per artist, recent skips, top-rated. Capped hard (200 recent
 *     plays, 100 skips, 50 rated) because it is read into a PROMPT, and an
 *     uncapped history would eventually crowd out the conversation.
 *   listening-log.jsonl — one compact line per play/skip, local and uncapped.
 *     The caps above make the profile useless for streaks and habits over
 *     months, so the log keeps the long tail. Local per machine on purpose:
 *     the deploy script does not sync it, so each host keeps its own history.
 *
 * Kept free of any electron import so `node --test` can reach it. That is not
 * incidental — buildTasteProfile is 130 lines of branching prompt assembly
 * that feeds every character call, and its failure mode is silent: it returns
 * '' both when it is broken and when there is genuinely nothing to say.
 *
 * Extracted from index.ts 2026-08-09. What still lives there arrives through
 * init as FUNCTIONS, never values, so nothing can freeze:
 *   discogsSummary — the Discogs blurb, fetched and cached in index.ts
 *   onReflect      — fires every 20th play; index.ts owns the Claude call
 */

import { readFile, writeFile, appendFile, stat } from 'fs/promises'
import { join } from 'path'
import { parseLogLines, computeListeningMemory, type PlayEvent } from './listening-memory.ts'
import { safeIpcError } from './safe-ipc-error.ts'
// NOTE: nothing here may import electron, directly or transitively. That is
// what keeps buildTasteProfile reachable from `node --test`, and it is easy to
// break by accident — activity-context.ts imports electron, which is why the
// activity block arrives as an injected function rather than an import.

/** The slice of JsonFileCache used here — structural, so index.ts keeps ownership. */
interface ProfileCache {
  get(): Promise<Record<string, unknown> | null>
  set(value: Record<string, unknown>): void
}

let stateDir = ''
let profileCache: ProfileCache | null = null
let discogsSummary: () => string = () => ''
let readActivityBlock: () => string = () => ''
let onReflect: () => void = () => {}

export function initListenerProfile(deps: {
  stateDir: string
  profileCache: ProfileCache
  discogsSummary: () => string
  activityBlock: () => string
  onReflect: () => void
}): void {
  stateDir = deps.stateDir
  profileCache = deps.profileCache
  discogsSummary = deps.discogsSummary
  readActivityBlock = deps.activityBlock
  onReflect = deps.onReflect
}

// ── Listener Profile — Music Man learns your taste over time ──
// 4.5.0-92 — listener-profile.json moves to STATE_DIR. Per-user taste
// profile (play counts per artist, recent skips, ratings) shapes the
// AI persona prompts; living on NAS means future workmini + mobile
// see the same listening signal the desktop sees.
const PROFILE_PATH = join(stateDir, 'listener-profile.json')

export interface ListenerProfile {
  totalPlays: number
  totalSkips: number
  firstSeen: string
  artistPlays: Record<string, number>
  artistSkips: Record<string, number>
  albumPlays: Record<string, number>
  genrePlays: Record<string, number>
  recentPlays: { title: string; artist: string; album: string; genre: string; ts: string }[]
  recentSkips: { title: string; artist: string; ts: string }[]
  topRated: { title: string; artist: string; album: string; rating: number }[]
  observations: string[]  // Music Man's own notes about the listener
}

const defaultProfile: ListenerProfile = {
  totalPlays: 0, totalSkips: 0, firstSeen: new Date().toISOString().split('T')[0],
  artistPlays: {}, artistSkips: {}, albumPlays: {}, genrePlays: {},
  recentPlays: [], recentSkips: [], topRated: [], observations: []
}

let listenerProfile: ListenerProfile = { ...defaultProfile }

export async function loadListenerProfile(): Promise<ListenerProfile> {
  // 4.5.0-106: read via cache so the in-memory snapshot is shared.
  const raw = await profileCache?.get()
  listenerProfile = { ...defaultProfile, ...(raw as Partial<ListenerProfile>) }
  return listenerProfile
}

export function saveListenerProfile() {
  // 4.5.0-106: routes through listenerProfileCache so the SMB flush
  // is backgrounded instead of awaited. record-play / record-skip fire
  // on every track end — pre-cache each one blocked the IPC for the
  // full NAS round-trip.
  profileCache?.set(listenerProfile as unknown as Record<string, unknown>)
}
// ── Listening memory — durable play log ──────────────────────────────────
// The listener profile caps recentPlays at 200, which is plenty for Music Man
// prompts but useless for streaks/habit analytics over months. Every play and
// skip ALSO appends one compact JSON line to listening-log.jsonl in STATE_DIR
// (local, per-machine; the deploy script doesn't sync it, so workmini keeps
// its own history). The log seeds once from the profile's recentPlays/
// recentSkips so the Home card has data from day one.
function listeningLogPath(): string {
  return join(stateDir, 'listening-log.jsonl')
}
let listeningLogCache: PlayEvent[] | null = null
let listeningLogSeeded = false
async function seedListeningLogOnce(): Promise<void> {
  if (listeningLogSeeded) return
  listeningLogSeeded = true
  try {
    await stat(listeningLogPath())
    return // already exists
  } catch { /* missing — seed from the profile's recent history */ }
  try {
    const p = await loadListenerProfile()
    const events: PlayEvent[] = [
      ...p.recentPlays.map((r) => ({ t: 'p' as const, ts: r.ts, ar: r.artist, al: r.album, g: r.genre, ti: r.title })),
      ...p.recentSkips.map((r) => ({ t: 's' as const, ts: r.ts, ar: r.artist, ti: r.title })),
    ].filter((e) => e.ts && !Number.isNaN(Date.parse(e.ts)))
      .sort((a, b) => a.ts.localeCompare(b.ts))
    await writeFile(listeningLogPath(), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf-8')
  } catch { /* an empty log is fine — it fills from here on */ }
}
export async function appendListeningEvent(e: PlayEvent): Promise<void> {
  try {
    await seedListeningLogOnce()
    await appendFile(listeningLogPath(), JSON.stringify(e) + '\n', 'utf-8')
    if (listeningLogCache) listeningLogCache.push(e)
  } catch { /* losing one log line beats blocking playback */ }
}


// ── What the IPC handlers do ──
//
// These were the bodies of three ipcMain.handle registrations. The
// registrations stay in index.ts — importing electron here would put this
// module out of reach of `node --test`, and the logic is the part worth
// testing. Bodies are unchanged.

/** A song finished playing (not skipped). */
export async function recordPlay(track: { title: string; artist: string; album: string; genre: string; pct?: number }): Promise<{ ok: boolean }> {
  void appendListeningEvent({ t: 'p', ts: new Date().toISOString(), ar: track.artist, al: track.album, g: track.genre, ti: track.title, pct: track.pct ?? 100 })
  if (!listenerProfile.firstSeen) listenerProfile.firstSeen = new Date().toISOString().split('T')[0]
  listenerProfile.totalPlays++
  if (track.artist) listenerProfile.artistPlays[track.artist] = (listenerProfile.artistPlays[track.artist] || 0) + 1
  if (track.album) {
    const key = `${track.artist} — ${track.album}`
    listenerProfile.albumPlays[key] = (listenerProfile.albumPlays[key] || 0) + 1
  }
  if (track.genre) listenerProfile.genrePlays[track.genre] = (listenerProfile.genrePlays[track.genre] || 0) + 1
  listenerProfile.recentPlays.unshift({ title: track.title, artist: track.artist, album: track.album, genre: track.genre, ts: new Date().toISOString() })
  listenerProfile.recentPlays = listenerProfile.recentPlays.slice(0, 200)
  await saveListenerProfile()
  // Every 20 plays, Music Man reflects on the listener's taste
  if (listenerProfile.totalPlays % 20 === 0) {
    onReflect()
  }
  return { ok: true }
}

/** A song was skipped — next pressed before it finished. */
export async function recordSkip(track: { title: string; artist: string; pct?: number }): Promise<{ ok: boolean }> {
  void appendListeningEvent({ t: 's', ts: new Date().toISOString(), ar: track.artist, ti: track.title, pct: track.pct })
  listenerProfile.totalSkips++
  if (track.artist) listenerProfile.artistSkips[track.artist] = (listenerProfile.artistSkips[track.artist] || 0) + 1
  listenerProfile.recentSkips.unshift({ title: track.title, artist: track.artist, ts: new Date().toISOString() })
  listenerProfile.recentSkips = listenerProfile.recentSkips.slice(0, 100)
  await saveListenerProfile()
  return { ok: true }
}

/** The user rated a track. 4-5 stars adds it, anything lower removes it. */
export async function recordRating(track: { title: string; artist: string; album: string; rating: number }): Promise<{ ok: boolean }> {
  if (track.rating >= 4) {
    const existing = listenerProfile.topRated.findIndex(t => t.title === track.title && t.artist === track.artist)
    if (existing >= 0) listenerProfile.topRated[existing].rating = track.rating
    else listenerProfile.topRated.push({ title: track.title, artist: track.artist, album: track.album, rating: track.rating })
    listenerProfile.topRated.sort((a, b) => b.rating - a.rating)
    listenerProfile.topRated = listenerProfile.topRated.slice(0, 50)
  } else {
    listenerProfile.topRated = listenerProfile.topRated.filter(t => !(t.title === track.title && t.artist === track.artist))
  }
  await saveListenerProfile()
  return { ok: true }
}

/** Insights for the Home listening card. */
export async function getListeningMemory(): Promise<unknown> {
  try {
    await seedListeningLogOnce()
    if (!listeningLogCache) {
      const raw = await readFile(listeningLogPath(), 'utf-8').catch(() => '')
      listeningLogCache = parseLogLines(raw)
    }
    const insights = computeListeningMemory(listeningLogCache, new Date())
    const p = await loadListenerProfile()
    return {
      ok: true,
      insights,
      lifetime: { totalPlays: p.totalPlays, firstSeen: p.firstSeen },
      observations: p.observations.slice(-5).reverse(),
    }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'io-failed') }
  }
}

/** Music Man's periodic reflection appends here; index.ts owns the Claude call. */
export function addObservation(text: string): void {
  listenerProfile.observations.push(text.trim())
  if (listenerProfile.observations.length > 15) {
    listenerProfile.observations = listenerProfile.observations.slice(-15)
  }
  saveListenerProfile()
}

/** Read-only view for callers that just need the numbers. */
export function getListenerProfile(): ListenerProfile {
  return listenerProfile
}

// Build a rich taste summary for Music Man prompts

export function buildTasteProfile(): string {
  const p = listenerProfile
  // Activity context must still reach the AI brain even when play history
  // / Discogs are empty — it is live situational state from iPod sync.
  const activityBlockEarly = readActivityBlock()
  if (p.totalPlays === 0 && !discogsSummary() && !activityBlockEarly) return ''

  const lines: string[] = []
  if (p.totalPlays > 0) {
    lines.push(`Listener since ${p.firstSeen}. ${p.totalPlays} plays, ${p.totalSkips} skips.`)
  }

  // Top artists by plays. Cap at 10 so the #1 slot doesn't dominate
  // everything the model sees.
  const topArtists = Object.entries(p.artistPlays).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const topArtistSet = new Set(topArtists.map(([a]) => a))
  if (topArtists.length > 0) {
    lines.push(`Most played artists: ${topArtists.map(([a, n]) => `${a} (${n})`).join(', ')}`)
  }

  // Most skipped artists (taste signal — they have these artists but skip them)
  const skippedArtists = Object.entries(p.artistSkips).sort((a, b) => b[1] - a[1]).slice(0, 10).filter(([, n]) => n >= 2)
  if (skippedArtists.length > 0) {
    lines.push(`Frequently skipped artists: ${skippedArtists.map(([a, n]) => `${a} (${n} skips)`).join(', ')}`)
  }

  // 4.4.41: surface SPECIFIC recent skips. The artist-level rollup above
  // hides the "Jake skipped this exact track 5 times" signal — and Jake
  // explicitly asked for this: "music man should know that if i have no
  // plays on a song....that doesnt mean i didnt skip it." Each recent
  // skip is a track the user heard at least partially and chose to bail
  // on. Dedup by (title|artist) so the same song getting skipped 4 times
  // in one session doesn't fill the slot.
  if (p.recentSkips.length > 0) {
    const seen = new Set<string>()
    const skipsUnique: typeof p.recentSkips = []
    for (const s of p.recentSkips) {
      const key = `${s.title}|${s.artist}`
      if (seen.has(key)) continue
      seen.add(key)
      skipsUnique.push(s)
      if (skipsUnique.length >= 10) break
    }
    if (skipsUnique.length > 0) {
      const list = skipsUnique.map(s => `"${s.title}" by ${s.artist}`).join(', ')
      lines.push(`Recently skipped tracks (the user heard each of these and chose to skip): ${list}`)
    }
  }

  // Top albums — dedup to one-per-artist so a single obsession doesn't
  // take over multiple slots (e.g. James Brown appearing as top artist
  // AND three of their albums being in the top-albums list).
  const seenArtist = new Set<string>()
  const topAlbumsUnique: Array<[string, number]> = []
  for (const [album, n] of Object.entries(p.albumPlays).sort((a, b) => b[1] - a[1])) {
    const parts = album.split(' — ')
    const artist = parts[0] || ''
    if (seenArtist.has(artist)) continue
    seenArtist.add(artist)
    topAlbumsUnique.push([album, n])
    if (topAlbumsUnique.length >= 10) break
  }
  if (topAlbumsUnique.length > 0) {
    lines.push(`Most played albums (one per artist): ${topAlbumsUnique.map(([a, n]) => `${a} (${n})`).join(', ')}`)
  }

  // Genre breakdown
  const topGenres = Object.entries(p.genrePlays).sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (topGenres.length > 0) {
    lines.push(`Genre breakdown: ${topGenres.map(([g, n]) => `${g} (${n})`).join(', ')}`)
  }

  // Highly rated tracks — exclude artists already in top-played so the
  // profile surfaces variety rather than doubling up on favorites.
  const raredFiltered = p.topRated.filter(t => !topArtistSet.has(t.artist))
  if (raredFiltered.length > 0) {
    const faves = raredFiltered.slice(0, 8).map(t => `"${t.title}" by ${t.artist} (${t.rating}★)`).join(', ')
    lines.push(`Also-liked (rated highly, outside top-played): ${faves}`)
  }

  // Recent listening — dedup to unique artists so a James-Brown-for-an-hour
  // session doesn't make recent-plays look like "only this one artist".
  if (p.recentPlays.length > 0) {
    const seenRecent = new Set<string>()
    const recentUnique: typeof p.recentPlays = []
    for (const t of p.recentPlays) {
      if (seenRecent.has(t.artist)) continue
      seenRecent.add(t.artist)
      recentUnique.push(t)
      if (recentUnique.length >= 8) break
    }
    const recent = recentUnique.map(t => `"${t.title}" by ${t.artist}`).join(', ')
    lines.push(`Recent plays (unique artists): ${recent}`)
  }

  // Music Man's own accumulated observations — used to be "include all
  // 15 every call", which meant one artist getting mentioned in 4
  // observations would hammer that artist into every response.
  // Take only the 3 most recent AND downweight any observation that
  // repeats an artist already dominating the top-played list.
  if (p.observations.length > 0) {
    const recent = p.observations.slice(-3)
    lines.push(`Your last few observations about this listener (background, NOT talking points): ${recent.join(' | ')}`)
  }

  // Discogs vinyl/record collection — what they actually own on physical media
  const discogs = discogsSummary()
  if (discogs) {
    lines.push(`\nPhysical record collection (Discogs): ${discogs}`)
    lines.push(`This tells you what they care about enough to own on vinyl/CD. Use this for deeper recommendations and conversation.`)
  }

  // Activity / iPod sync context — what they're doing, where, weather there.
  // Populated when they run an activity sync; Music Man / Megan / radio should
  // treat it as live (chat, DJ, playlists, picks, discovery all see this).
  const activityBlock = activityBlockEarly || readActivityBlock()
  if (activityBlock) lines.push(`\n${activityBlock}`)

  // 4.4.41 — explicit reasoning rule. Without this, Picks and observations
  // would treat playCount == 0 as "unfamiliar" and surface tracks the user
  // has heard and skipped multiple times as "discoveries." Jake: "music man
  // should know that if i have no plays on a song....that doesnt mean i
  // didnt skip it."
  lines.push(
    `\nIMPORTANT RULE: A track with playCount == 0 does NOT mean the user is unfamiliar with it. Check the skip lists above first — if a track or artist is in "Frequently skipped" or "Recently skipped," the user has heard it and chose to skip. Do not surface those as discoveries or recommendations. True engagement = plays minus ~half the skips, not plays alone.`
  )

  return lines.join('\n')
}
