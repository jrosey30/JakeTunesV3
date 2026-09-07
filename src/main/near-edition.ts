/**
 * Compare editions — the per-track comparison behind a refused album
 * (near-edition-recovery-proposal-2026-09-06.md). The whole-album judge
 * stops at the first mismatch; this runs the SAME judge one track at a
 * time so every row gets a verdict. Pure: no network, no files.
 *
 * Wording rule (Jake): a runtime difference is a "runtime mismatch", never
 * a claim about which edit it is — the judge cannot know that.
 */
import { buildRequestedAlbum, verifyAlbumCandidate, matchLibraryOwnership, ALBUM_TRACK_TOLERANCE_SEC, type CandidateAlbum, type LibraryTrackLite } from './album-identity.ts'
import type { RequestedAlbum, RequestedAlbumTrack } from '../common/acquisition-identity.ts'
import type { AlternativeTrack } from '../common/acquisition-identity.ts'
import type { TrackRow, NearEditionSummary, CompareEditionsResult } from '../common/near-edition-types.ts'
export type { TrackRow, NearEditionSummary, CompareEditionsResult }

const fmt = (s: number | null | undefined): string => s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`

export function judgeAlbumTracks(req: RequestedAlbum, candTracks: AlternativeTrack[], tolSec = ALBUM_TRACK_TOLERANCE_SEC, library: LibraryTrackLite[] = []): TrackRow[] {
  const want = req.tracks
  const ownership = library.length ? matchLibraryOwnership(req, library, tolSec) : null
  const ownedIdx = new Set(ownership?.owned.map((o) => o.index) ?? [])
  const got = [...candTracks].sort((a, b) => ((a.discNumber ?? 1) - (b.discNumber ?? 1)) || ((a.trackNumber ?? 0) - (b.trackNumber ?? 0)))
  const rows: TrackRow[] = []
  for (let i = 0; i < want.length; i++) {
    const w = want[i]; const g = got[i]
    const wantSec = w.durationSec ?? null
    const owned = ownedIdx.has(i)
    if (!g) { rows.push({ n: i + 1, wantTitle: w.title, gotTitle: null, wantSec, gotSec: null, deltaSec: null, verdict: 'unknown', reason: 'not on the found edition', owned }); continue }
    const gotSec = g.durationSec ?? null
    const one = buildRequestedAlbum({ artist: req.artist, title: req.title, trackCount: 1, tracks: [{ ...w, trackNumber: 1, discNumber: undefined } as RequestedAlbumTrack] })
    const cand: CandidateAlbum = { provider: 'bandcamp', desc: 'row', title: req.title, artist: req.artist, trackCount: 1, tracks: [{ title: g.title, trackNumber: 1, durationSec: gotSec }] }
    const v = verifyAlbumCandidate(one, cand, tolSec)
    const deltaSec = wantSec != null && gotSec != null ? Math.round(gotSec - wantSec) : null
    if (v.verdict === 'exact') rows.push({ n: i + 1, wantTitle: w.title, gotTitle: g.title, wantSec, gotSec, deltaSec, verdict: 'exact', reason: null, owned })
    else if (v.verdict === 'reject') rows.push({ n: i + 1, wantTitle: w.title, gotTitle: g.title, wantSec, gotSec, deltaSec, verdict: 'mismatch', reason: /runs \d+:\d\d/.test(v.reason) ? `runtime mismatch (${fmt(gotSec)} found, ${fmt(wantSec)} picked)` : v.reason, owned })
    else rows.push({ n: i + 1, wantTitle: w.title, gotTitle: g.title, wantSec, gotSec, deltaSec, verdict: 'unknown', reason: v.reason, owned })
  }
  return rows
}

export function summarizeNearEdition(rows: TrackRow[], picked: { label: string }, found: { label: string; source: string }): NearEditionSummary {
  const exact = rows.filter((r) => r.verdict === 'exact').length
  const mismatch = rows.filter((r) => r.verdict === 'mismatch').length
  const unknown = rows.filter((r) => r.verdict === 'unknown').length
  const differing = rows.filter((r) => r.verdict !== 'exact').map((r) => ({ n: r.n, title: r.wantTitle, wantSec: r.wantSec, gotSec: r.gotSec, reason: r.reason ?? 'unknown' }))
  const total = rows.length
  const owned = rows.filter((r) => r.verdict === 'exact' && r.owned).length
  const toAcquire = exact - owned
  const missingList = differing.map((d) => `${d.n} “${d.title}” (${fmt(d.wantSec)})`).join(', ')
  const diffList = differing.map((d) => `track ${d.n} (${fmt(d.gotSec)} vs ${fmt(d.wantSec)})`).join(', ')
  const ownedNote = owned ? ` ${owned} of the matching ${exact === 1 ? 'track is' : 'tracks are'} already in your library and ${owned === 1 ? 'is' : 'are'} skipped.` : ''
  return {
    total, exact, mismatch, unknown, owned, toAcquire, differing,
    matchingSentence: exact === 0
      ? 'No track matches the edition you picked; nothing to acquire this way.'
      : toAcquire === 0
        ? `All ${exact} matching tracks are already in your library; nothing to acquire. Not acquired: ${missingList || 'none'}. The record stays incomplete (${exact} of ${total} of ${picked.label}).`
        : `Acquires ${toAcquire} of ${total} songs, as songs, pinned to the edition you picked (title, version and runtime), each verified before import.${ownedNote} Not acquired: ${missingList || 'none'}. Recorded as ${exact} of ${total} of ${picked.label} — the record stays incomplete.`,
    editionSentence: `Acquires all ${total} tracks as the ${found.label} (${found.source}), selected by that source and its own tracklist. Recorded as the ${found.label}, ${total} of ${total}; it differs from the edition you picked at ${diffList || 'no track'}. The edition you picked is not marked as owned.`,
  }
}
