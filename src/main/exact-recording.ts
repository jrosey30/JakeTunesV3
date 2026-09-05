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
 *   4. Runtime within tolerance of the version Jake clicked, when known.
 *   5. No duration does NOT switch verification off — the tags still judge.
 *      No duration AND no tags = UNVERIFIABLE, and unverifiable never imports.
 *   6. Explicitness is an identity axis: Jake asked for the explicit record,
 *      the provider says this one is clean → rejected.
 *
 * Pure and dependency-free beyond the matchers, so the tests can run the
 * whole contract without a network or a file.
 *
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/streamrip.ts downloadByQuery has
 * NO staging verification (Qobuz pick → rip → import) and its matcher,
 * backend/src/util/streamripMatch.ts, is a Brief-131 port that predates the
 * wrong-version guard. The phone's downloader is explicitly INCOMPLETE on
 * identity as of 2026-09-04; closing it is a mobile-phase change.
 */
import { recoArtistMatches, recoNorm, recoTitleMatches } from './reco-match.ts'
import { liveBrandMarker, maskedTitleMatches, subtitleVariantMatches, unwantedVersionOf, requestedVersionMarkers } from './streamrip-match.ts'

export type Provider = 'qobuz' | 'bandcamp' | 'soundcloud'

export interface RequestedRecording {
  /** As displayed by the source Jake clicked (iTunes / Deezer / a card). */
  artist: string
  title: string
  album: string
  /** Normalised forms, for logs and equality. */
  artistNorm: string
  titleNorm: string
  /** Seconds, when the clicked row knew its runtime; 0 = unknown. */
  durationSec: number
  /** ± seconds. Tight for the exact pressing; wide when we deliberately
   *  searched for the SONG rather than that pressing (censored/remaster). */
  durationTolSec: number
  releaseYear?: number
  /** What was ASKED for. 'clean' only when a clean record was deliberately
   *  requested (`cleanRequested`) — an Apple listing that merely happened to
   *  be the cleaned edition (`cleanedSource`) is NOT a request for
   *  censorship: the ladder's explicit-first rule (Jake, 2026-09-04: "why do
   *  these clean versions keep appearing???") still prefers the explicit
   *  master there, so it stays 'unknown' for the judge. */
  explicit: 'explicit' | 'clean' | 'unknown'
  /** Version markers Jake asked for by name ("(Live)", "(Acoustic)"). Empty =
   *  the ordinary studio recording was requested. */
  requestedMarkers: string[]
  /** Provider ids that travelled with the pick, when any did. */
  providerIds: { itunesTrackId?: number; isrc?: string }
}

export interface RequestOpts {
  artist?: string
  title?: string
  album?: string
  durationMs?: number
  durationTolSec: number
  releaseYear?: number
  cleanedSource?: boolean
  explicitSource?: boolean
  /** A clean record was deliberately asked for (no UI sets this yet). */
  cleanRequested?: boolean
  itunesTrackId?: number
  isrc?: string
}

export function buildRequestedRecording(o: RequestOpts): RequestedRecording {
  const artist = (o.artist || '').trim()
  const title = (o.title || '').trim()
  const durationSec = typeof o.durationMs === 'number' && o.durationMs > 1000 ? o.durationMs / 1000 : 0
  return {
    artist,
    title,
    album: (o.album || '').trim(),
    artistNorm: recoNorm(artist),
    titleNorm: recoNorm(title),
    durationSec,
    durationTolSec: o.durationTolSec,
    releaseYear: o.releaseYear,
    explicit: o.explicitSource ? 'explicit' : o.cleanRequested ? 'clean' : 'unknown',
    requestedMarkers: requestedVersionMarkers(title),
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
  const wantWords = `${req.title} ${req.album}`

  // 1. Version markers — title, album and the provider's version field.
  const titleMarker = ev.title ? unwantedVersionOf(req.title, ev.title) : null
  if (titleMarker) return { verdict: 'reject', kind: 'version', reason: `is tagged “${ev.title}” (${titleMarker})` }
  const versionField = ev.version ? unwantedVersionOf(req.title, ev.version) : null
  if (versionField) return { verdict: 'reject', kind: 'version', reason: `is the “${ev.version}” version (${versionField})` }
  const albumMarker = ev.album ? unwantedVersionOf(wantWords, ev.album) : null
  if (albumMarker) return { verdict: 'reject', kind: 'version', reason: `is from “${ev.album}” (${albumMarker})` }
  const descMarker = ev.desc && !ev.title ? unwantedVersionOf(`${req.title} ${req.artist}`, ev.desc) : null
  if (descMarker) return { verdict: 'reject', kind: 'version', reason: `is listed as “${ev.desc}” (${descMarker})` }

  // 2. Show brands — a different recording even with a clean title and the
  //    studio runtime (the Ed Sullivan case).
  const brand = liveBrandMarker(wantWords, `${ev.title ?? ''} ${ev.album ?? ''} ${ev.desc ?? ''}`)
  if (brand) return { verdict: 'reject', kind: 'brand', reason: `is a show recording (“${brand}”)` }

  // 3. The title must read as the song — and when Jake asked for a version
  //    BY NAME ("… (Live)"), a title without that word is a different
  //    recording too: the studio cut is not the live one he picked.
  if (ev.title) {
    const reads = recoTitleMatches(req.title, ev.title) || maskedTitleMatches(req.title, ev.title) || subtitleVariantMatches(req.title, ev.title)
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
    const inText = recoNorm(`${ev.title ?? ''} ${ev.desc ?? ''}`).includes(req.artistNorm)
    const ok = recoArtistMatches(req.artist, ev.artist) || (ev.provider === 'soundcloud' && inText)
    if (!ok) return { verdict: 'reject', kind: 'artist', reason: `is by “${ev.artist}”, not ${req.artist}` }
    evidence.push(`artist “${ev.artist}”`)
  } else if (req.artist && ev.provider === 'soundcloud' && (ev.title || ev.desc)) {
    // No artist tag at all: the artist must be somewhere in what we can see.
    if (!recoNorm(`${ev.title ?? ''} ${ev.desc ?? ''}`).includes(req.artistNorm)) {
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

/** One rejected or unverifiable alternative, for the structured result a
 *  future approval UI can list ("we found these, none was the exact one"). */
export interface Alternative { provider: Provider; desc: string; reason: string }

export type DownloadOutcome =
  | 'imported'
  | 'exact-not-found'        // sources answered; nothing was the exact recording
  | 'not-found'              // no source had anything resembling it
  | 'unverifiable'           // a file arrived that could not be judged; not imported
  | 'provider-failed'        // a match was found, the rip/transfer itself died — try again
  | 'provider-unavailable'   // a service could not even be asked (auth, tool, network)
  | 'canceled'
  | 'not-released'

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
      return { primary: 'Exact version not found', detail: `Sources answered for ${who}, but nothing was the recording you picked, so nothing was imported.${judged ? `\nJudged and refused:\n${judged}` : ''}${other}\nRetrying will not change this. Paste a link to the exact track in the Download view.` }
    }
    case 'unverifiable':
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
