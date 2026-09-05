/**
 * The requested-ALBUM identity contract (6.0 Phase 1, final slice, 2026-09-05).
 *
 * Root cause, album-level: download-by-query's album path had no identity at
 * all. `judgeStaged` answered `exact: ['album rip']` for ANY multi-file stage
 * and the Bandcamp album lane hard-coded `verdict: 'exact'`, so whichever
 * album Qobuz ranked first was imported whole. XTC "Drums and Wires (Bonus
 * Track Version)" landed correctly only because the ranker happened to put
 * the 15-track edition first; a 12-track standard, an anniversary edition, a
 * deluxe with different bonus material, or a live album titled after the
 * record would have been imported just as readily — and partially, since the
 * importer dedupes per file.
 *
 * This module is the ONE definition of "is this album the EDITION Jake
 * picked", separate from the per-recording contract in exact-recording.ts
 * (which still judges single tracks and keeps its compilation allowance —
 * a studio master on a compilation is the same track; the album contract
 * never runs for a track request).
 *
 * Evidence hierarchy — strongest first, each one sufficient on its own to
 * settle what it settles; weaker evidence never overrides stronger:
 *   1. The ORDERED TRACKLIST (titles in order, per-disc, runtimes where
 *      known). Two editions whose contents differ differ here. When both
 *      sides carry it, it decides the edition outright — labels do not.
 *   2. TRACK COUNT + DISC COUNT. A different count is a different edition.
 *      An equal count is proof only together with agreeing edition labels.
 *   3. EDITION LABELS ("Bonus Track Version", "Deluxe", "25th Anniversary")
 *      — packaging words. Tolerated to differ when 1 proves the contents
 *      (Qobuz titles the bonus edition plainly "Drums And Wires"); decisive
 *      only when nothing stronger is available, and then only agreement
 *      accepts — disagreement is UNPROVEN, never a guess.
 *   4. RECORDING-VERSION MARKERS (live, remix, demo…) on the album title or
 *      the provider's version field: a marker the request did not carry is a
 *      different recording of the album, always rejected; a marker Jake asked
 *      for must be present unless the tracklist proves the contents.
 *   5. ARTIST and BASE TITLE — gate everything; small spelling differences
 *      are allowed (the recording matchers), character-perfect titles are not
 *      required.
 *   6. EXPLICITNESS — symmetric, as for tracks.
 *   7. IDENTIFIERS (iTunes collection id, UPC) are recorded for the log and
 *      for equality when both sides carry the same kind; providers rarely do.
 *
 * Not proven = not imported. The verdict then carries every judged edition
 * as a structured alternative ("Drums And Wires — XTC, 12 tracks, 1979: has
 * 12 tracks; the edition you picked has 15").
 *
 * Verification runs TWICE per candidate: on the provider's own tracklist
 * BEFORE any bytes move (cheap refusal), and on the STAGED FILES' tags and
 * runtimes AFTER the rip and BEFORE import (what would actually land). A
 * short stage is 'incomplete' — the wrong edition is never partially
 * imported, and neither is the right one.
 *
 * Library duplicates: the importer's dedupe key is title|artist|runtime,
 * matched against the staged (already verified) file, so a "dupe" is the
 * same recording by construction. reconcileAlbumCompletion re-checks that
 * against the requested track anyway — a same-title library track with a
 * different runtime is NOT credited toward completion.
 *
 * Pure: no network, no files. The store feeds it evidence; the tests feed it
 * editions.
 *
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamrip.ts has no album path at
 * all (its downloadByQuery rips a Qobuz pick and imports); the phone's
 * downloader stays explicitly INCOMPLETE on identity — closing it is a
 * mobile-phase change, not a desktop one.
 */
import { recoArtistMatches, recoNorm, recoTitleMatches } from './reco-match.ts'
import { foldAccents } from '../common/fold-text.ts'
import { maskedTitleMatches, requestedVersionMarkers, searchTitle, subtitleVariantMatches, unwantedVersionOf } from './streamrip-match.ts'
import type { Provider } from './exact-recording.ts'

export interface RequestedAlbumTrack {
  title: string
  trackNumber?: number
  discNumber?: number
  durationSec?: number
  explicitness?: string
}

export interface RequestedAlbum {
  artist: string
  /** As clicked ("Drums and Wires (Bonus Track Version)"). */
  title: string
  /** Packaging stripped, version markers kept ("Drums and Wires"). */
  baseTitle: string
  /** Packaging words on the request: bonus, deluxe, anniversary, expanded… */
  packaging: string[]
  /** Recording-changing markers Jake asked for by name: live, remix… */
  versionMarkers: string[]
  trackCount?: number
  discCount?: number
  /** Ordered as the catalogue lists them; may be empty when the lookup failed. */
  tracks: RequestedAlbumTrack[]
  releaseYear?: number
  explicit: 'explicit' | 'clean' | 'unknown'
  providerIds: { itunesCollectionId?: number; upc?: string }
}

export interface CandidateAlbumTrack {
  title: string
  trackNumber?: number
  discNumber?: number
  durationSec?: number | null
  /** The staged file this row came from (post-rip), so a partial import can
   *  pick exactly the files whose tracks are not already owned. */
  file?: string
}

/** Everything a lane could learn about one candidate album — from the search
 *  desc, the provider's album endpoint, or the staged files' tags. Unknown
 *  fields are undefined and never a mismatch; they only weaken the verdict. */
export interface CandidateAlbum {
  provider: Provider
  desc: string
  id?: string
  title?: string
  artist?: string
  /** Provider's own version field (Qobuz: "Deluxe Edition", "Live"…). */
  version?: string | null
  trackCount?: number
  discCount?: number
  tracks?: CandidateAlbumTrack[]
  releaseYear?: number
  upc?: string
  parentalWarning?: boolean
  /** true when `tracks` ARE the staged files (post-rip): a short list is an
   *  incomplete download, not a smaller edition. */
  staged?: boolean
}

export type AlbumRejectKind = 'artist' | 'title' | 'version' | 'edition' | 'track-count' | 'disc' | 'tracklist' | 'explicit' | 'incomplete'

export type AlbumVerdict =
  | { verdict: 'exact'; evidence: string[] }
  | { verdict: 'reject'; kind: AlbumRejectKind; reason: string }
  | { verdict: 'unverifiable'; reason: string }

/** Per-track runtime slack inside one edition. Remasters drift a second or
 *  two; a different mix, an extended cut or a live take drifts far more. */
export const ALBUM_TRACK_TOLERANCE_SEC = 20

// Labels that change what an edition CONTAINS. A remaster or a reissue is
// the same recordings in the same order (the recording contract says so
// too), so those words are neutral: "Record (2001 Remaster)" with the same
// count IS the plain record, not an unproven edition.
const PACKAGING = /^(bonus|bonustrack|bonustracks|deluxe|expanded|anniversary|anniversaries|special|collector|collectors|legacy|super|complete|definitive|ultimate|redux)$/

const tokens = (s: string): string[] =>
  foldAccents(String(s || '')).split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean)

/** The decoration on an album title: bracket groups and a trailing " - …". */
function decorations(title: string): string[] {
  const out: string[] = []
  const t = String(title || '')
  for (const m of t.matchAll(/[([{]([^()[\]{}]*)[)\]}]/g)) out.push(m[1])
  const dash = t.match(/\s+[-–—]\s+([^-–—]+)$/)
  if (dash) out.push(dash[1])
  return out
}

/** Packaging words found in an album title's decoration (+ a provider
 *  version field), normalised: "Bonus Track Version" → bonus; "25th
 *  Anniversary Edition" → anniversary; "2001 Remaster" → nothing (same
 *  contents). Years and ordinals qualify a label, they are not one. */
export function packagingMarkersOf(title: string, version?: string | null): string[] {
  const words = [...decorations(title), version || ''].flatMap(tokens)
  const out = new Set<string>()
  for (const w of words) {
    if (!PACKAGING.test(w)) continue
    out.add(w.replace(/^bonustracks?$/, 'bonus').replace(/^anniversaries$/, 'anniversary').replace(/^collectors?$/, 'collector'))
  }
  return [...out].sort()
}

export interface AlbumRequestOpts {
  artist?: string
  title?: string
  trackCount?: number
  discCount?: number
  tracks?: RequestedAlbumTrack[]
  releaseYear?: number
  collectionId?: number
  upc?: string
  explicitSource?: boolean
  cleanRequested?: boolean
}

export function buildRequestedAlbum(o: AlbumRequestOpts): RequestedAlbum {
  const artist = (o.artist || '').trim()
  const title = (o.title || '').trim()
  const tracks = (o.tracks || []).filter((t) => t && (t.title || '').trim()).map((t) => ({ ...t, title: t.title.trim() }))
  const discs = tracks.map((t) => t.discNumber ?? 1)
  const discCount = o.discCount ?? (tracks.length ? Math.max(...discs) : undefined)
  return {
    artist,
    title,
    baseTitle: searchTitle(title) || title,
    packaging: packagingMarkersOf(title),
    versionMarkers: requestedVersionMarkers(title),
    trackCount: o.trackCount ?? (tracks.length ? tracks.length : undefined),
    discCount,
    tracks: orderTracks(tracks),
    releaseYear: o.releaseYear,
    explicit: o.explicitSource ? 'explicit' : o.cleanRequested ? 'clean' : 'unknown',
    providerIds: { itunesCollectionId: o.collectionId, upc: o.upc },
  }
}

/** Catalogue order: disc, then track number; rows without numbers keep
 *  their given order after the numbered ones of the same disc. Stable. */
export function orderTracks<T extends { trackNumber?: number; discNumber?: number }>(tracks: T[]): T[] {
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) =>
      (a.t.discNumber ?? 1) - (b.t.discNumber ?? 1) ||
      (a.t.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.t.trackNumber ?? Number.MAX_SAFE_INTEGER) ||
      a.i - b.i)
    .map((x) => x.t)
}

/** "2/15" → { n: 2, of: 15 }; "7" → { n: 7 }; junk → {}. */
export function parseCountTag(raw: string | undefined | null): { n?: number; of?: number } {
  const m = String(raw || '').trim().match(/^(\d+)(?:\s*\/\s*(\d+))?$/)
  if (!m) return {}
  return m[2] ? { n: Number(m[1]), of: Number(m[2]) } : { n: Number(m[1]) }
}

const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** Album titles are compared on their BASE (packaging stripped); a
 *  subtitle one catalogue carries and the other drops still reads the same. */
function albumTitleReads(wantBase: string, got: string): boolean {
  const gotBase = searchTitle(got) || got
  return recoTitleMatches(wantBase, gotBase) || subtitleVariantMatches(wantBase, gotBase) || maskedTitleMatches(wantBase, gotBase)
}

/** Track titles are compared with EDITION packaging stripped from both
 *  sides first — Qobuz stamps every track of a reissue "(2001 Digital
 *  Remaster)", iTunes does not, and a catalogue typo on top of that
 *  ("Real By Reel" vs "Reel By Reel", first live run 2026-09-05) put the
 *  two beyond the lenient matcher's reach. Version markers are judged on the
 *  RAW titles by the caller, so "(Live)" still never reads as the studio cut. */
function trackTitleReads(want: string, got: string): boolean {
  const w = searchTitle(want) || want, g = searchTitle(got) || got
  return recoTitleMatches(w, g) || maskedTitleMatches(w, g) || subtitleVariantMatches(w, g)
    || recoTitleMatches(want, got) || maskedTitleMatches(want, got) || subtitleVariantMatches(want, got)
}

/**
 * Judge one candidate album against the request. The first failing witness
 * names the reason; the evidence list says what proved it.
 */
export function verifyAlbumCandidate(req: RequestedAlbum, cand: CandidateAlbum, tolSec = ALBUM_TRACK_TOLERANCE_SEC): AlbumVerdict {
  const evidence: string[] = []
  const candTitle = (cand.title || '').trim()

  // 5. Artist and base title gate everything.
  if (req.artist && cand.artist && !recoArtistMatches(req.artist, cand.artist)) {
    return { verdict: 'reject', kind: 'artist', reason: `is by “${cand.artist}”, not ${req.artist}` }
  }
  if (cand.artist) evidence.push(`artist “${cand.artist}”`)
  if (candTitle && !albumTitleReads(req.baseTitle, candTitle)) {
    return { verdict: 'reject', kind: 'title', reason: `is titled “${candTitle}”, not “${req.baseTitle}”` }
  }
  if (candTitle) evidence.push(`title “${candTitle}”`)

  // 4a. A recording-version marker the request never carried is a different
  //     recording of the album (live, remixed, demos) — whatever the labels.
  const unwanted = (candTitle ? unwantedVersionOf(req.title, candTitle) : null) || (cand.version ? unwantedVersionOf(req.title, cand.version) : null)
  if (unwanted) return { verdict: 'reject', kind: 'version', reason: `is the ${unwanted} version (“${candTitle || cand.version}”)` }

  // 6. Explicitness — symmetric, unknown is never a mismatch.
  if (req.explicit === 'explicit' && cand.parentalWarning === false) return { verdict: 'reject', kind: 'explicit', reason: 'is the clean edition; the explicit record was asked for' }
  if (req.explicit === 'clean' && cand.parentalWarning === true) return { verdict: 'reject', kind: 'explicit', reason: 'is the explicit edition; the clean record was asked for' }

  // 7. Identifiers, when both sides carry the same kind.
  if (req.providerIds.upc && cand.upc) {
    if (req.providerIds.upc !== cand.upc) return { verdict: 'reject', kind: 'edition', reason: `carries UPC ${cand.upc}, the edition you picked is ${req.providerIds.upc}` }
    evidence.push(`UPC ${cand.upc}`)
  }

  // 2. Counts. The staged list short of the expectation is an incomplete
  //    download, never "a smaller edition".
  const wantCount = req.trackCount ?? (req.tracks.length || undefined)
  const gotCount = cand.trackCount ?? (cand.tracks?.length || undefined)
  if (wantCount != null && gotCount != null && wantCount !== gotCount) {
    if (cand.staged && gotCount < wantCount) return { verdict: 'reject', kind: 'incomplete', reason: `only ${gotCount} of ${wantCount} tracks arrived — not importing a partial album` }
    return { verdict: 'reject', kind: 'track-count', reason: `has ${gotCount} tracks; the edition you picked has ${wantCount}` }
  }
  const wantDiscs = req.discCount
  const gotDiscs = cand.discCount ?? (cand.tracks?.length ? Math.max(...cand.tracks.map((t) => t.discNumber ?? 1)) : undefined)
  if (wantDiscs != null && gotDiscs != null && wantDiscs !== gotDiscs && (wantDiscs > 1 || gotDiscs > 1)) {
    return { verdict: 'reject', kind: 'disc', reason: `is ${gotDiscs} disc${gotDiscs === 1 ? '' : 's'}; the edition you picked is ${wantDiscs}` }
  }

  // 1. The ordered tracklist decides the edition when both sides have one.
  let tracklistProved = false
  if (req.tracks.length && cand.tracks?.length) {
    const want = req.tracks
    const got = orderTracks(cand.tracks)
    if (want.length !== got.length) {
      if (cand.staged && got.length < want.length) return { verdict: 'reject', kind: 'incomplete', reason: `only ${got.length} of ${want.length} tracks arrived — not importing a partial album` }
      return { verdict: 'reject', kind: 'track-count', reason: `has ${got.length} tracks; the edition you picked has ${want.length}` }
    }
    for (let i = 0; i < want.length; i++) {
      const w = want[i], g = got[i]
      const pos = `track ${w.discNumber && (req.discCount ?? 1) > 1 ? `${w.discNumber}-` : ''}${w.trackNumber ?? i + 1}`
      if (w.discNumber != null && g.discNumber != null && w.discNumber !== g.discNumber) {
        return { verdict: 'reject', kind: 'disc', reason: `${pos} sits on disc ${g.discNumber}; the edition you picked has it on disc ${w.discNumber}` }
      }
      if (!trackTitleReads(w.title, g.title)) return { verdict: 'reject', kind: 'tracklist', reason: `${pos} is “${g.title}”; the edition you picked has “${w.title}”` }
      const marker = unwantedVersionOf(w.title, g.title)
      if (marker) return { verdict: 'reject', kind: 'tracklist', reason: `${pos} is the ${marker} version (“${g.title}”)` }
      if (w.durationSec && g.durationSec != null && g.durationSec > 0 && Math.abs(g.durationSec - w.durationSec) > tolSec) {
        return { verdict: 'reject', kind: 'tracklist', reason: `${pos} “${g.title}” runs ${fmt(g.durationSec)}; the edition you picked runs ${fmt(w.durationSec)}` }
      }
    }
    tracklistProved = true
    evidence.push(`tracklist ${want.length}/${want.length} in order${want.some((t) => t.durationSec) ? ' with runtimes' : ''}`)
  }

  // 4b. A version Jake asked for by name must be there — unless the
  //     tracklist already proved these are those recordings.
  if (!tracklistProved && req.versionMarkers.length) {
    const got = new Set(requestedVersionMarkers(`${candTitle} ${cand.version ?? ''} ${(cand.tracks || []).map((t) => t.title).join(' ')}`))
    const missing = req.versionMarkers.find((m) => !got.has(m))
    if (missing) return { verdict: 'reject', kind: 'version', reason: `is not the ${missing} version that was asked for (“${candTitle || cand.desc}”)` }
  }

  if (tracklistProved) return { verdict: 'exact', evidence }

  // 3. Labels — decisive only now, and only agreement accepts.
  if (wantCount != null && gotCount != null) {
    const gotPack = packagingMarkersOf(candTitle, cand.version)
    const same = gotPack.length === req.packaging.length && gotPack.every((p, i) => p === req.packaging[i])
    if (same) {
      evidence.push(`${gotCount} tracks`, req.packaging.length ? `edition “${req.packaging.join(', ')}”` : 'plain edition')
      return { verdict: 'exact', evidence }
    }
    return { verdict: 'unverifiable', reason: `${gotCount} tracks match, but it is labelled “${gotPack.join(', ') || 'plain'}” and you picked “${req.packaging.join(', ') || 'plain'}” — no tracklist to prove the contents` }
  }
  return { verdict: 'unverifiable', reason: wantCount == null ? 'the edition you picked has no known track count or tracklist to check against' : `${cand.desc} reports no track count or tracklist` }
}

export interface LibraryTrackLite { id?: number; title: string; artist?: string; album?: string; durationSec?: number }
export interface Ownership {
  /** requested-track index → the library track that IS that recording */
  owned: Array<{ index: number; track: LibraryTrackLite }>
  /** requested-track indices Jake does not have */
  missing: number[]
  ownedCount: number
}

/**
 * Which requested tracks does the library already hold, by RECORDING
 * identity: the title reads as the song with edition stamps stripped, no
 * version marker either side lacks, the artist matches, and the runtime
 * agrees when both are known. The album name is deliberately not required —
 * the same master on a compilation is the same track (individual-track
 * doctrine). Each library track satisfies at most one requested track.
 * 2026-09-05: this replaces trusting the importer's text key, which missed
 * every "(2001 Digital Remaster)" stamp and re-imported a complete album.
 */
export function matchLibraryOwnership(req: RequestedAlbum, library: LibraryTrackLite[], tolSec = ALBUM_TRACK_TOLERANCE_SEC): Ownership {
  const pool = library.filter((l) => l.title && (!req.artist || !l.artist || recoArtistMatches(req.artist, l.artist)))
  const used = new Set<number>()
  const owned: Ownership['owned'] = []
  const missing: number[] = []
  req.tracks.forEach((w, i) => {
    let hit = -1
    for (let j = 0; j < pool.length; j++) {
      if (used.has(j)) continue
      const l = pool[j]
      if (!trackTitleReads(w.title, l.title)) continue
      if (unwantedVersionOf(w.title, l.title)) continue
      const wantMarkers = requestedVersionMarkers(w.title)
      if (wantMarkers.length) {
        const got = new Set(requestedVersionMarkers(l.title))
        if (wantMarkers.some((m) => !got.has(m))) continue
      }
      if (w.durationSec && l.durationSec && Math.abs(w.durationSec - l.durationSec) > tolSec) continue
      hit = j; break
    }
    if (hit >= 0) { used.add(hit); owned.push({ index: i, track: pool[hit] }) } else missing.push(i)
  })
  return { owned, missing, ownedCount: owned.length }
}

/** One-line description of a judged edition for the alternatives list. */
export function albumAlternativeDesc(cand: CandidateAlbum): string {
  const count = cand.trackCount ?? cand.tracks?.length
  const bits = [count != null ? `${count} tracks` : '', cand.releaseYear ? String(cand.releaseYear) : ''].filter(Boolean)
  const head = cand.title ? `${cand.title}${cand.artist ? ` — ${cand.artist}` : ''}` : cand.desc
  return bits.length ? `${head} (${bits.join(', ')})` : head
}

export interface CompletionInput {
  req: RequestedAlbum
  /** The staged, verified files in catalogue order. */
  staged: CandidateAlbumTrack[]
  /** Titles the importer added. */
  imported: Array<{ title?: string }>
  /** Files the importer skipped as library duplicates — with the tags the
   *  STAGED file carried (what the dedupe key was built from). */
  dupes: Array<{ title: string; artist?: string; durationSec?: number | null }>
}

export interface Completion {
  expected: number
  imported: number
  /** Duplicates credited: an existing library track that IS the requested recording. */
  credited: number
  /** Duplicates refused credit: same name, different recording. */
  uncredited: Array<{ title: string; reason: string }>
  missing: number
  complete: boolean
}

/**
 * Did the album land whole? Library duplicates count only when the
 * requested track they claim to be matches by recording identity — title
 * reads as the song AND (when both runtimes are known) the runtime agrees.
 */
export function reconcileAlbumCompletion(inp: CompletionInput, tolSec = ALBUM_TRACK_TOLERANCE_SEC): Completion {
  const expected = inp.req.trackCount ?? (inp.req.tracks.length || inp.staged.length)
  const wanted = inp.req.tracks.length ? inp.req.tracks : inp.staged.map((t) => ({ title: t.title, durationSec: t.durationSec ?? undefined }))
  const claimed = new Set<number>()
  let credited = 0
  const uncredited: Array<{ title: string; reason: string }> = []
  for (const d of inp.dupes) {
    let reason = `“${d.title}” is not on the edition you picked`
    let ok = false
    for (let i = 0; i < wanted.length; i++) {
      if (claimed.has(i)) continue
      const w = wanted[i]
      if (!trackTitleReads(w.title, d.title) || unwantedVersionOf(w.title, d.title)) continue
      if (inp.req.artist && d.artist && !recoArtistMatches(inp.req.artist, d.artist)) { reason = `“${d.title}” in your library is by ${d.artist}`; continue }
      if (w.durationSec && d.durationSec && Math.abs(w.durationSec - d.durationSec) > tolSec) { reason = `“${d.title}” in your library runs ${fmt(d.durationSec)}, this edition's runs ${fmt(w.durationSec)}`; continue }
      claimed.add(i); ok = true; break
    }
    if (ok) credited++; else uncredited.push({ title: d.title, reason })
  }
  const imported = inp.imported.length
  const missing = Math.max(0, expected - imported - credited)
  return { expected, imported, credited, uncredited, missing, complete: missing === 0 }
}

/** Human line for the queue: "15 tracks · 14 imported, 1 already in your library". */
export function describeCompletion(c: Completion): string {
  const parts = [`${c.imported} imported`]
  if (c.credited) parts.push(`${c.credited} already in your library`)
  if (c.uncredited.length) parts.push(`${c.uncredited.length} not credited (${c.uncredited.map((u) => u.reason).join('; ')})`)
  if (c.missing) parts.push(`${c.missing} missing`)
  return `${c.expected} tracks · ${parts.join(', ')}`
}

/** Wall-clock budget for one download attempt. A single track keeps the
 *  ladder's 12 minutes; a whole album gets time for its size — the first
 *  live Deluxe run (2026-09-05, 12 tracks) hit "Gave up after 12 minutes"
 *  mid-rip, while the 15-track XTC rip earlier took about 10. 100 s per
 *  track, floor 12 min, ceiling 40 min; unknown size = 15 tracks. */
export function ladderBudgetMs(wantAlbum: boolean, trackCount?: number): number {
  const base = 12 * 60 * 1000
  if (!wantAlbum) return base
  const n = typeof trackCount === 'number' && trackCount > 0 ? trackCount : 15
  return Math.min(40 * 60 * 1000, Math.max(base, n * 100 * 1000))
}

/** The normalised key the recording matchers agree on, for logs. */
export const albumKey = (artist: string, title: string): string => `${recoNorm(artist)}|${recoNorm(searchTitle(title) || title)}`
