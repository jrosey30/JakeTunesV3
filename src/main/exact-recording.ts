/**
 * The requested-recording identity contract (6.0 Phase 1, 2026-09-04).
 *
 * Jake selected the regular album version of "5 Years Time" and JakeTunes
 * repeatedly imported a SoundCloud remix. The wrong file had passed because
 * every provider lane in download-by-query carried its OWN partial checks —
 * Qobuz's verified path had four witnesses, Bandcamp three, SoundCloud two,
 * and the Qobuz "no duration known" path had none at all (stage → import).
 *
 * This module is the ONE definition of "is this file the recording Jake
 * asked for", applied to every provider the same way:
 *
 *   1. A title with no alternate-version marker is a POSITIVE request for the
 *      ordinary studio recording — never "any audio that resembles it".
 *   2. A candidate carrying a marker the request did not (remix, live,
 *      acoustic, demo, edit, cover, instrumental, sped/slowed…) is rejected.
 *      A marker Jake DID pick ("… (Live)") is honored. Remasters are the
 *      same recording and pass.
 *   3. The file's own tags are witnesses: title must read as the song,
 *      artist must be the artist (SoundCloud's uploader tag is allowed to be
 *      a label when the artist is in the title), album must not name a
 *      different recording, a TV/venue show brand is a different recording.
 *   4. Runtime within tolerance of the version Jake clicked, when known. A
 *      clean row's length is not known (requestedLength, 2026-11-04).
 *   5. No duration does NOT switch verification off — the tags still judge.
 *      No duration AND no tags = UNVERIFIABLE, and unverifiable never imports.
 *   6. Explicitness is an identity axis: Jake asked for the explicit record,
 *      the provider says this one is clean → rejected.
 *
 * Pure and dependency-free beyond the matchers, so the tests can run the
 * whole contract without a network or a file.
 *
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts unwantedVersion is
 * the phone's copy of this judge: the same witnesses since 2026-11-03, the phone
 * reading its runtimes off iTunes (nobody clicks a row there). It has no explicit
 * axis yet, because it never asks Qobuz's metadata endpoint.
 */
import type { Provider, RequestedRecording, Alternative, DownloadOutcome } from '../common/acquisition-identity.ts'
export type { Provider, RequestedRecording, Alternative, DownloadOutcome } from '../common/acquisition-identity.ts'

import { artistOrAlias, recoNorm, recoTitleMatches } from './reco-match.ts'
import { albumVersionOf, carriesCensorStamp, editionSubstituted, isCoverAct, liveBrandMarker, searchTitle, titleReads, unwantedVersionOf, requestedVersionMarkers, withoutCensorStamp } from './streamrip-match.ts'
import { nameKey } from '../common/fold-text.ts'

/** Does free text (a SoundCloud title/desc) name the artist? Folded in any
 *  script. It used to test recoNorm(text).includes(req.artistNorm), and a
 *  Hebrew or Cyrillic artist's artistNorm is '' — which every string
 *  includes, so any upload "named" them. A name with no letters at all
 *  ("!!!") is looked for as written. */
export function textNamesArtist(text: string, artist: string): boolean {
  const a = nameKey(artist, '')
  if (!a) return !!artist.trim() && text.toLowerCase().includes(artist.trim().toLowerCase())
  return nameKey(text, '').includes(a)
}

/** "Villanova - Mr Vibe" is the song "Mr Vibe": SoundCloud uploads carry the
 *  artist in the title. Only when what precedes the dash names the artist. */
function withoutArtistPrefix(title: string, artist: string): string {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title)
  return m && artist && textNamesArtist(m[1], artist) ? m[2] : title
}

export interface RequestOpts {
  artist?: string
  title?: string
  album?: string
  durationMs?: number
  /** ± seconds. Left out, requestedLength reads it off the row's own words. */
  durationTolSec?: number
  releaseYear?: number
  cleanedSource?: boolean
  explicitSource?: boolean
  /** A clean record was deliberately asked for (no UI sets this yet). */
  cleanRequested?: boolean
  itunesTrackId?: number
  isrc?: string
  /** Other names MusicBrainz knows the artist by (RequestedRecording.artistAliases). */
  artistAliases?: string[]
}

/** A file is held to the pressing Jake clicked. */
export const RUNTIME_TOLERANCE_SEC = 5
/** A remaster or a masked title names the song, not that pressing, and a
 *  remaster's length drifts: Jamiroquai's "If I Like It, I Do It" is 274.3 s on
 *  the album and 292.7 s on the remaster. Still tight enough to refuse a
 *  9-minute megamix or a 90-second interlude. */
export const EDITION_TOLERANCE_SEC = 30

/**
 * What a row's length honestly says about the file to fetch (2026-11-04).
 *
 * A clean row, by Apple's flag or a stamp on its title or album, says nothing.
 * Apple's search hides explicit rows, so on a rap record the row Jake clicks is
 * often the censored edit, and an edit can lose or gain whole passages. By Apple's
 * own lookups, clean vs explicit: Nasty Boy 231.6 vs 333.8 s, Sky's the Limit 277.1
 * vs 329.4, Respect 273.7 vs 321.3, I Love the Dough 340.2 vs 311.5. No window fits
 * that, and any window around the clean length fits the clean file best: at ±30 s
 * the judge refused the 329.4 s "Sky's the Limit" and called 277.1 s exact. So the
 * title, album and explicit checks decide. Only a clean record asked for on purpose
 * keeps its clean length.
 *
 * This used to be a ±30 s window, measured as "Mo Money Mo Problems 258 s amended
 * vs 251 s explicit, Hypnotize 230 vs 243, Sky's the Limit 277 vs 254". Those three
 * "explicit" lengths are other cuts, by Apple's rows: the Instrumental (251.0), the
 * Club Mix (243.4) and the Radio Edit (253.7). The album cuts are 257.4, 229.8, 329.4.
 *
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamripMatch.ts expectedRuntimes (the
 * phone reads every row Apple lists; the desktop reads the row Jake clicked).
 */
export function requestedLength(o: Pick<RequestOpts, 'title' | 'album' | 'durationMs' | 'cleanedSource' | 'cleanRequested'>): { durationSec: number; durationTolSec: number } {
  const title = o.title || '', album = o.album || ''
  const clean = !o.cleanRequested && (o.cleanedSource || carriesCensorStamp(title) || carriesCensorStamp(album))
  return {
    durationSec: !clean && typeof o.durationMs === 'number' && o.durationMs > 1000 ? o.durationMs / 1000 : 0,
    durationTolSec: editionSubstituted(title) || editionSubstituted(album) ? EDITION_TOLERANCE_SEC : RUNTIME_TOLERANCE_SEC,
  }
}

export function buildRequestedRecording(o: RequestOpts): RequestedRecording {
  const artist = (o.artist || '').trim()
  const title = (o.title || '').trim()
  const { durationSec, durationTolSec } = requestedLength(o)
  return {
    artist,
    title,
    album: (o.album || '').trim(),
    artistNorm: recoNorm(artist),
    titleNorm: recoNorm(title),
    durationSec,
    durationTolSec: o.durationTolSec ?? durationTolSec,
    releaseYear: o.releaseYear,
    explicit: o.explicitSource ? 'explicit' : o.cleanRequested ? 'clean' : 'unknown',
    // A censorship stamp is how Apple lists the song, not a version Jake asked
    // for (2026-11-03): an "[Amended]" row refused the explicit master by name.
    requestedMarkers: requestedVersionMarkers(searchTitle(title) || title),
    artistAliases: o.artistAliases,
    providerIds: { itunesTrackId: o.itunesTrackId, isrc: o.isrc },
  }
}

/** Everything a lane could learn about one candidate — from the search
 *  desc, the provider's metadata endpoint, and/or the staged file's tags.
 *  Unknown fields are left undefined/null and are never treated as a
 *  mismatch; they only weaken the verdict. */
export interface CandidateEvidence {
  provider: Provider
  /** Search-result line, for messages. */
  desc?: string
  title?: string
  artist?: string
  album?: string
  durationSec?: number | null
  /** Provider's own explicit flag (Qobuz parental_warning). */
  parentalWarning?: boolean
  /** Provider's own "version" field (Qobuz: "Remix", "Live"…). */
  version?: string | null
}

export type RejectKind = 'version' | 'brand' | 'title' | 'artist' | 'duration' | 'explicit'

export type Verdict =
  | { verdict: 'exact'; evidence: string[]; albumMatches: boolean }
  | { verdict: 'reject'; kind: RejectKind; reason: string }
  | { verdict: 'unverifiable'; reason: string }

const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/**
 * Judge one candidate against the request. Order matters only for the
 * message: the first failing witness names the reason.
 */
export function verifyCandidate(req: RequestedRecording, ev: CandidateEvidence): Verdict {
  const evidence: string[] = []
  // The row's censorship stamp buys a file nothing. With "[Amended]" in the request,
  // the marker checks read a file that says "[Amended]" as asked for, and a clean
  // row has no length left to catch it (2026-11-04).
  const stampFree = (s: string): string => req.explicit === 'clean' ? s : withoutCensorStamp(s)
  const wantTitle = stampFree(req.title)
  const wantWords = `${wantTitle} ${stampFree(req.album)}`

  // 1. Version markers — title, album and the provider's version field.
  const titleMarker = ev.title ? unwantedVersionOf(wantTitle, ev.title) : null
  if (titleMarker) return { verdict: 'reject', kind: 'version', reason: `is tagged “${ev.title}” (${titleMarker})` }
  const versionField = ev.version ? unwantedVersionOf(wantTitle, ev.version) : null
  if (versionField) return { verdict: 'reject', kind: 'version', reason: `is the “${ev.version}” version (${versionField})` }
  const albumMarker = ev.album ? albumVersionOf(wantWords, ev.album) : null
  if (albumMarker) return { verdict: 'reject', kind: 'version', reason: `is from “${ev.album}” (${albumMarker})` }
  const descMarker = ev.desc && !ev.title ? unwantedVersionOf(`${wantTitle} ${req.artist}`, ev.desc) : null
  if (descMarker) return { verdict: 'reject', kind: 'version', reason: `is listed as “${ev.desc}” (${descMarker})` }

  // 1b. Cover, karaoke and tribute acts: "Rihanna" is inside "Rihanna Cover Band".
  if (!isCoverAct(req.title, req.artist)) {
    if (isCoverAct(ev.title ?? '', ev.artist ?? '')) return { verdict: 'reject', kind: 'version', reason: `is a cover or tribute act (“${ev.artist ?? ev.title}”)` }
    if (ev.album && isCoverAct(ev.album, '')) return { verdict: 'reject', kind: 'version', reason: `is from a cover or tribute release (“${ev.album}”)` }
  }

  // 2. Show brands — a different recording even with a clean title and the
  //    studio runtime (the Ed Sullivan case).
  const brand = liveBrandMarker(wantWords, `${ev.title ?? ''} ${ev.album ?? ''} ${ev.desc ?? ''}`)
  if (brand) return { verdict: 'reject', kind: 'brand', reason: `is a show recording (“${brand}”)` }

  // 3. The title must read as the song — and when Jake asked for a version
  //    BY NAME ("… (Live)"), a title without that word is a different
  //    recording too: the studio cut is not the live one he picked.
  if (ev.title) {
    const reads = titleReads(req.title, ev.title) || titleReads(req.title, withoutArtistPrefix(ev.title, req.artist))
    if (!reads) return { verdict: 'reject', kind: 'title', reason: `is titled “${ev.title}”, not “${req.title}”` }
    if (req.requestedMarkers.length) {
      const gotMarkers = new Set(requestedVersionMarkers(`${ev.title} ${ev.version ?? ''} ${ev.album ?? ''}`))
      const missing = req.requestedMarkers.find((m) => !gotMarkers.has(m))
      if (missing) return { verdict: 'reject', kind: 'version', reason: `is not the ${missing} version that was asked for (tagged “${ev.title}”)` }
    }
    evidence.push(`title “${ev.title}”`)
  }

  // 4. The artist. A same-title song by someone else is a different song.
  //    SoundCloud's artist tag is often the uploader (a label), so there the
  //    artist may instead appear in the title/desc.
  if (req.artist && ev.artist) {
    const inText = textNamesArtist(`${ev.title ?? ''} ${ev.desc ?? ''}`, req.artist)
    const ok = artistOrAlias(req.artist, ev.artist, req.artistAliases) || (ev.provider === 'soundcloud' && inText)
    if (!ok) return { verdict: 'reject', kind: 'artist', reason: `is by “${ev.artist}”, not ${req.artist}` }
    evidence.push(`artist “${ev.artist}”`)
  } else if (req.artist && ev.provider === 'soundcloud' && (ev.title || ev.desc)) {
    // No artist tag at all: the artist must be somewhere in what we can see.
    if (!textNamesArtist(`${ev.title ?? ''} ${ev.desc ?? ''}`, req.artist)) {
      return { verdict: 'reject', kind: 'artist', reason: `does not name ${req.artist} anywhere` }
    }
  }

  // 5. Runtime, when both sides know it.
  if (req.durationSec > 0 && ev.durationSec != null && ev.durationSec > 0) {
    const diff = Math.abs(ev.durationSec - req.durationSec)
    if (diff > req.durationTolSec) {
      return { verdict: 'reject', kind: 'duration', reason: `runs ${fmt(ev.durationSec)}, wanted ${fmt(req.durationSec)}` }
    }
    evidence.push(`runs ${fmt(ev.durationSec)} (±${req.durationTolSec}s of ${fmt(req.durationSec)})`)
  }

  // 6. Explicitness — symmetric. The explicit record was asked for and the
  //    provider says this one is clean → out; a CLEAN record was asked for
  //    and the provider says this one is explicit → out. Unknown on either
  //    side is never a mismatch.
  if (req.explicit === 'explicit' && ev.parentalWarning === false) {
    return { verdict: 'reject', kind: 'explicit', reason: 'is the clean edition; the explicit record was asked for' }
  }
  if (req.explicit === 'clean' && ev.parentalWarning === true) {
    return { verdict: 'reject', kind: 'explicit', reason: 'is the explicit edition; the clean record was asked for' }
  }

  // 7. Enough witnesses? A runtime match or a matching title tag is one.
  //    Neither = we know nothing about this file beyond that it downloaded.
  if (evidence.length === 0) {
    return { verdict: 'unverifiable', reason: req.durationSec > 0 ? 'the file carries no tags and no readable duration' : 'no runtime was known for the pick and the file carries no tags' }
  }

  const albumMatches = !req.album || !ev.album || recoTitleMatches(req.album, ev.album)
  return { verdict: 'exact', evidence, albumMatches }
}

/** Decide the honest final outcome once every lane has had its turn.
 *  `ripFailure` = a download of a matched candidate died; `searchFailure` =
 *  a provider could not be searched at all. An empty search is NEITHER. */
export function finalOutcome(o: { alternatives: Alternative[]; ripFailure: string | null; searchFailure: string | null; anyMatched: boolean; unverifiable: boolean }): DownloadOutcome {
  if (o.unverifiable && o.alternatives.length === 0) return 'unverifiable'
  if (o.alternatives.length > 0) return 'exact-not-found'
  if (o.ripFailure) return 'provider-failed'
  if (o.searchFailure && !o.anyMatched) return 'provider-unavailable'
  return o.anyMatched ? 'exact-not-found' : 'not-found'
}

/** Short readable primary status for a queue row + the full actionable
 *  explanation for its detail panel. The queue always shows `primary`;
 *  `detail` is never truncated into a one-liner. */
export function describeOutcome(outcome: DownloadOutcome, ctx: { title: string; artist: string; query: string; alternatives: Alternative[]; ripFailure?: string | null; searchFailure?: string | null; otherVersions?: string[]; wantAlbum?: boolean }): { primary: string; detail: string } {
  const who = `“${ctx.title}” — ${ctx.artist}`.trim()
  const judged = ctx.alternatives.slice(0, 5).map((a) => `${a.provider}: ${a.desc} ${a.reason}`).join('\n')
  switch (outcome) {
    case 'imported': return { primary: 'In your library', detail: '' }
    case 'canceled': return { primary: 'Canceled', detail: 'You stopped this one. Retry to download it after all.' }
    case 'not-released': return { primary: 'Not out yet', detail: `${who} is listed but not streamable yet. It will download once it releases.` }
    case 'exact-not-found': {
      const other = ctx.otherVersions?.length ? `\nOther versions seen on Qobuz: ${ctx.otherVersions.slice(0, 5).join(', ')}.` : ''
      if (ctx.wantAlbum) {
        // Album identity contract: every judged EDITION is listed, with why
        // it is not the one Jake picked, so the choice is his — never the app's.
        return { primary: 'Exact edition not found', detail: `Sources answered for ${who}, but no edition was the one you picked, so nothing was imported — not even part of another edition.${judged ? `\nEditions judged and refused:\n${judged}` : ''}${other}\nRetrying will not change this. Paste a link to the exact album in the Download view, or Get the tracks one by one.` }
      }
      return { primary: 'Exact version not found', detail: `Sources answered for ${who}, but nothing was the recording you picked, so nothing was imported.${judged ? `\nJudged and refused:\n${judged}` : ''}${other}\nRetrying will not change this. Paste a link to the exact track in the Download view.` }
    }
    case 'unverifiable':
      if (ctx.wantAlbum) {
        return { primary: 'Couldn’t prove the edition', detail: `An album arrived for ${who} but it could not be proven to be the edition you picked (${ctx.alternatives[0]?.reason ?? 'no track count, no tracklist'}), so it was not imported.${judged ? `\nEditions seen:\n${judged}` : ''}\nPaste a link to the exact album to download it deliberately.` }
      }
      return { primary: 'Couldn’t verify recording', detail: `A file arrived for ${who} but it could not be judged (${ctx.alternatives[0]?.reason ?? 'no tags, no runtime'}), so it was not imported. Paste a link to the exact track to download it deliberately.` }
    case 'provider-failed':
      return { primary: 'Download failed', detail: `A source matched ${who} but the transfer failed: ${ctx.ripFailure ?? 'unknown error'}.\nCheck the connection or the service login, then Retry.` }
    case 'provider-unavailable':
      return { primary: 'Provider unavailable', detail: `A service could not be searched for ${who}: ${ctx.searchFailure ?? 'unknown error'}.\nCheck the connection or the login in Setup, then Retry.` }
    case 'not-found':
    default:
      return { primary: 'Not found', detail: `Nothing resembling ${who} on Qobuz${ctx.wantAlbum ? '' : ', Bandcamp or SoundCloud'} (searched “${ctx.query}”). Retrying repeats the same search; try a different spelling in the Download view, or paste a link.` }
  }
}
