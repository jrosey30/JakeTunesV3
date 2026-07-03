/**
 * Cynthia overhaul — deterministic MusicBrainz diff.
 *
 * Takes a local album + the (cached) musicBrainzAlbumLookup result and
 * derives findings WITHOUT a model: blank count fills, canonical
 * mismatch observations, and the missing-track list. Provable fixes are
 * gated on an EXACT release match (strict normalized artist+album
 * equality, mirroring getMusicBrainzReleaseMbid's discipline) — a fuzzy
 * match never auto-applies anything.
 *
 * Deliberately conservative classes (precision first):
 *   provable:  fill BLANK discCount / per-disc trackCount from canonical
 *   judgment:  count values that CONTRADICT canonical (edition risk),
 *              blank-year fill (release-date vs original-year trap)
 *   flags:     year mismatch (remaster dates are poison — never a fix),
 *              ambiguous release candidates (escalation-worthy)
 *   missing:   canonical tracks absent locally (informational list)
 *
 * Pure module — unit-tested with fixture lookup JSON.
 */

import type { CynthiaScanTrack, CynthiaFinding, CynthiaScanFlag } from './cynthia-scan'

export interface MbLookupResult {
  artist?: string
  album?: string
  error?: string
  note?: string
  chosenRelease?: {
    id: string
    title: string
    artist: string
    date: string | null
    country: string | null
    type: string | null
  }
  canonicalTracks?: Array<{ disc: number; position: number; title: string; durationSec: number | null }>
  canonicalTrackCount?: number
  otherCandidates?: Array<{ id: string; title: string; artist: string; date: string | null; country: string | null; trackCount: number | null }>
}

export interface CynthiaMissingTrack {
  trackNumber: number
  discNumber: number
  title: string
  duration: number | null
  reason: string
}

export interface MbDiffResult {
  findings: CynthiaFinding[]
  missingTracks: CynthiaMissingTrack[]
  flags: CynthiaScanFlag[]
  exactMatch: boolean
  /** true when other candidates make the release identity genuinely uncertain. */
  ambiguous: boolean
}

function num(v: number | string | undefined | null): number {
  const x = parseInt(String(v ?? ''), 10)
  return Number.isFinite(x) && x > 0 ? x : 0
}

/** Same normalization discipline as external.ts's MB matching. */
function normName(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\s*[([{].*?[)\]}]\s*/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normTitle(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function diffAgainstMusicBrainz(
  local: CynthiaScanTrack[],
  mb: MbLookupResult,
  requested: { artist: string; album: string },
): MbDiffResult {
  const findings: CynthiaFinding[] = []
  const missingTracks: CynthiaMissingTrack[] = []
  const flags: CynthiaScanFlag[] = []

  const canonical = mb.canonicalTracks || []
  if (mb.error || !mb.chosenRelease || canonical.length === 0 || local.length === 0) {
    return { findings, missingTracks, flags, exactMatch: false, ambiguous: false }
  }

  const exactMatch =
    normName(mb.chosenRelease.artist) === normName(requested.artist) &&
    normName(mb.chosenRelease.title) === normName(requested.album)

  // Ambiguity: another candidate with the SAME normalized title but a
  // DIFFERENT track count = edition confusion worth a judgment pass.
  const ambiguous = (mb.otherCandidates || []).some(c =>
    normName(c.title) === normName(mb.chosenRelease!.title) &&
    c.trackCount !== null &&
    c.trackCount !== canonical.length,
  )
  if (ambiguous) {
    flags.push({ kind: 'year-variance', detail: `multiple MusicBrainz editions of '${mb.chosenRelease.title}' with different track counts — release identity needs a judgment call` })
  }

  const canonicalDiscCount = Math.max(...canonical.map(t => t.disc || 1))
  const canonicalPerDisc = new Map<number, number>()
  for (const t of canonical) {
    const d = t.disc || 1
    canonicalPerDisc.set(d, (canonicalPerDisc.get(d) || 0) + 1)
  }

  const provableEligible = exactMatch && !ambiguous

  // ── discCount: fill blanks (provable on exact match); contradictions are judgment ──
  for (const t of local) {
    const dc = num(t.discCount)
    if (dc === 0) {
      findings.push({
        trackId: t.id,
        field: 'discCount',
        oldValue: String(t.discCount ?? ''),
        newValue: String(canonicalDiscCount),
        reason: `MusicBrainz canonical is ${canonicalDiscCount} disc${canonicalDiscCount === 1 ? '' : 's'}`,
        source: 'musicbrainz',
        confidence: provableEligible ? 'high' : 'medium',
        provable: provableEligible,
      })
    } else if (dc !== canonicalDiscCount) {
      findings.push({
        trackId: t.id,
        field: 'discCount',
        oldValue: String(dc),
        newValue: String(canonicalDiscCount),
        reason: `MusicBrainz says ${canonicalDiscCount} disc${canonicalDiscCount === 1 ? '' : 's'}, file says ${dc}`,
        source: 'musicbrainz',
        confidence: 'medium',
        provable: false,
      })
    }
  }

  // ── per-disc trackCount: fill blanks (provable on exact match) ──
  for (const t of local) {
    const disc = num(t.discNumber) || 1
    const canonicalTc = canonicalPerDisc.get(disc)
    if (!canonicalTc) continue
    const tc = num(t.trackCount)
    if (tc === 0) {
      findings.push({
        trackId: t.id,
        field: 'trackCount',
        oldValue: String(t.trackCount ?? ''),
        newValue: String(canonicalTc),
        reason: `MusicBrainz canonical disc ${disc} has ${canonicalTc} tracks`,
        source: 'musicbrainz',
        confidence: provableEligible ? 'high' : 'medium',
        provable: provableEligible,
      })
    } else if (tc !== canonicalTc) {
      findings.push({
        trackId: t.id,
        field: 'trackCount',
        oldValue: String(tc),
        newValue: String(canonicalTc),
        reason: `MusicBrainz disc ${disc} canonical count is ${canonicalTc}, file says ${tc}`,
        source: 'musicbrainz',
        confidence: 'medium',
        provable: false,
      })
    }
  }

  // ── blank year: judgment fill from release date (never provable — the
  //    chosen release's date can be a reissue date, not the original year) ──
  const mbYear = mb.chosenRelease.date ? parseInt(mb.chosenRelease.date.slice(0, 4), 10) : 0
  if (mbYear > 0) {
    for (const t of local) {
      if (num(t.year) === 0) {
        findings.push({
          trackId: t.id,
          field: 'year',
          oldValue: String(t.year ?? ''),
          newValue: String(mbYear),
          reason: `MusicBrainz release date is ${mb.chosenRelease.date}`,
          source: 'musicbrainz',
          confidence: 'medium',
          provable: false,
        })
      } else if (num(t.year) !== mbYear) {
        // Mismatch is a FLAG, never a fix — remaster/reissue dates.
        flags.push({ kind: 'year-variance', detail: `local year ${num(t.year)} vs MusicBrainz release date ${mb.chosenRelease.date} — could be an edition difference` })
        break
      }
    }
  }

  // ── missing tracks: canonical titles with no local counterpart ──
  const localTitles = new Set(local.map(t => normTitle(String(t.title ?? ''))))
  for (const c of canonical) {
    if (!c.title) continue
    if (!localTitles.has(normTitle(c.title))) {
      missingTracks.push({
        trackNumber: c.position,
        discNumber: c.disc || 1,
        title: c.title,
        duration: c.durationSec,
        reason: `on the MusicBrainz canonical release '${mb.chosenRelease.title}'${mb.chosenRelease.date ? ` (${mb.chosenRelease.date.slice(0, 4)})` : ''}`,
      })
    }
  }

  // ── track-number mismatches for title-matched pairs: judgment findings ──
  const canonicalByTitle = new Map<string, { disc: number; position: number }>()
  for (const c of canonical) {
    const key = normTitle(c.title)
    if (!canonicalByTitle.has(key)) canonicalByTitle.set(key, { disc: c.disc || 1, position: c.position })
    else canonicalByTitle.set(key, { disc: -1, position: -1 })  // duplicate canonical title — unusable for matching
  }
  for (const t of local) {
    const hit = canonicalByTitle.get(normTitle(String(t.title ?? '')))
    if (!hit || hit.disc === -1) continue
    const localNum = num(t.trackNumber)
    const localDisc = num(t.discNumber) || 1
    if (localNum > 0 && (localNum !== hit.position || localDisc !== hit.disc)) {
      findings.push({
        trackId: t.id,
        field: 'trackNumber',
        oldValue: String(localNum),
        newValue: String(hit.position),
        reason: `MusicBrainz places '${String(t.title).slice(0, 40)}' at disc ${hit.disc} track ${hit.position}`,
        source: 'musicbrainz',
        confidence: 'medium',
        provable: false,
      })
      if (localDisc !== hit.disc) {
        findings.push({
          trackId: t.id,
          field: 'discNumber',
          oldValue: String(localDisc),
          newValue: String(hit.disc),
          reason: `MusicBrainz places this track on disc ${hit.disc}`,
          source: 'musicbrainz',
          confidence: 'medium',
          provable: false,
        })
      }
    }
  }

  return { findings, missingTracks, flags, exactMatch, ambiguous }
}
