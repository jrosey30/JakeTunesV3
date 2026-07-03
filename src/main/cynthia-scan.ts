/**
 * Cynthia overhaul — the deterministic scanner.
 *
 * Most of what Cynthia historically burned a Sonnet call on is provable
 * with string logic: stray whitespace, blank counts siblings already
 * declare, the user's own internal inconsistencies. This module finds all
 * of that in microseconds with ZERO model calls, which is where the
 * precision comes from — a deterministic rule can't hallucinate.
 *
 * Findings carry `provable`: true means the fix is mechanically certain
 * (auto-apply eligible, per Jake's "done before I ask"); false means it's
 * a judgment call that waits for a human (or gets handed to Sonnet as
 * pre-gathered evidence). Flags are observations without a concrete fix —
 * they feed the MB-diff and the LLM's context, never auto-apply.
 *
 * Pure module: no imports from index.ts, no I/O — unit-tested in
 * __tests__/cynthia-scan.test.ts.
 */

export interface CynthiaScanTrack {
  id: number
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNumber: number | string
  trackCount: number | string
  discNumber: number | string
  discCount: number | string
  year: number | string
  genre: string
  duration: number  // ms
}

export type CynthiaFindingField =
  | 'title' | 'artist' | 'album' | 'albumArtist' | 'year' | 'genre'
  | 'trackNumber' | 'trackCount' | 'discNumber' | 'discCount'

export type CynthiaFindingSource =
  | 'internal-consistency' | 'musicbrainz' | 'discogs' | 'wikidata' | 'file-tags'

export interface CynthiaFinding {
  trackId: number
  field: CynthiaFindingField
  oldValue: string
  newValue: string
  reason: string
  source: CynthiaFindingSource
  confidence: 'high' | 'medium'
  /** true = mechanically certain → auto-apply eligible. */
  provable: boolean
}

export interface CynthiaScanFlag {
  kind: 'duplicate-track-number' | 'missing-track-number' | 'year-variance' | 'genre-variance' | 'artist-variance' | 'feat-variance'
  detail: string
}

export interface CynthiaScanResult {
  findings: CynthiaFinding[]
  flags: CynthiaScanFlag[]
}

const TEXT_FIELDS: Array<{ field: CynthiaFindingField; get: (t: CynthiaScanTrack) => string }> = [
  { field: 'title', get: t => String(t.title ?? '') },
  { field: 'artist', get: t => String(t.artist ?? '') },
  { field: 'album', get: t => String(t.album ?? '') },
  { field: 'albumArtist', get: t => String(t.albumArtist ?? '') },
  { field: 'genre', get: t => String(t.genre ?? '') },
]

function num(v: number | string | undefined | null): number {
  const x = parseInt(String(v ?? ''), 10)
  return Number.isFinite(x) && x > 0 ? x : 0
}

/** Collapse runs of whitespace to single spaces + trim. JS \s covers NBSP. */
function cleanWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const FEAT_RE = /\b(feat\.|feat\b|featuring|ft\.)\s/i

export function scanAlbum(tracks: CynthiaScanTrack[]): CynthiaScanResult {
  const findings: CynthiaFinding[] = []
  const flags: CynthiaScanFlag[] = []
  if (tracks.length === 0) return { findings, flags }

  // ── 1. Whitespace defects (provable — the cleaned value IS the value) ──
  for (const t of tracks) {
    for (const { field, get } of TEXT_FIELDS) {
      const raw = get(t)
      if (!raw) continue
      const cleaned = cleanWhitespace(raw)
      if (cleaned !== raw && cleaned !== '') {
        findings.push({
          trackId: t.id,
          field,
          oldValue: raw,
          newValue: cleaned,
          reason: 'stray whitespace',
          source: 'internal-consistency',
          confidence: 'high',
          provable: true,
        })
      }
    }
  }

  // From here on, variance classes need siblings to compare against.
  if (tracks.length < 2) {
    scanTrackNumberIntegrity(tracks, flags)
    return { findings, flags }
  }

  // ── 2. Blank discCount / trackCount fills (provable ONLY from siblings'
  //       consistent declarations — never inferred from absence; the
  //       MB-diff owns fills that need canonical knowledge). ──
  const declaredDiscCounts = new Set(tracks.map(t => num(t.discCount)).filter(n => n > 0))
  if (declaredDiscCounts.size === 1) {
    const dc = [...declaredDiscCounts][0]
    for (const t of tracks) {
      if (num(t.discCount) === 0) {
        findings.push({
          trackId: t.id,
          field: 'discCount',
          oldValue: String(t.discCount ?? ''),
          newValue: String(dc),
          reason: `siblings on this album declare ${dc} disc${dc === 1 ? '' : 's'}`,
          source: 'internal-consistency',
          confidence: 'high',
          provable: true,
        })
      }
    }
  }
  // trackCount is per-disc: fill blanks from same-disc siblings.
  const byDisc = new Map<number, CynthiaScanTrack[]>()
  for (const t of tracks) {
    const d = num(t.discNumber) || 1
    const arr = byDisc.get(d)
    if (arr) arr.push(t)
    else byDisc.set(d, [t])
  }
  for (const [disc, group] of byDisc) {
    const declared = new Set(group.map(t => num(t.trackCount)).filter(n => n > 0))
    if (declared.size !== 1) continue
    const tc = [...declared][0]
    for (const t of group) {
      if (num(t.trackCount) === 0) {
        findings.push({
          trackId: t.id,
          field: 'trackCount',
          oldValue: String(t.trackCount ?? ''),
          newValue: String(tc),
          reason: `siblings on disc ${disc} declare ${tc} tracks`,
          source: 'internal-consistency',
          confidence: 'high',
          provable: true,
        })
      }
    }
  }

  // ── 2b. Neat-freak sibling fills (provable): blank albumArtist /
  //        genre / year filled from UNANIMOUS album siblings. These are
  //        the fields that make grouping identifiable — a blank
  //        albumArtist splits an album across the grid. ──
  const artistsInScope = new Set(tracks.map(t => cleanWhitespace(String(t.artist ?? ''))).filter(Boolean))
  const declaredAlbumArtists = new Set(tracks.map(t => cleanWhitespace(String(t.albumArtist ?? ''))).filter(Boolean))
  // Fill source: a declared consistent albumArtist wins; otherwise a
  // single-artist album's artist IS its album artist.
  const albumArtistFill = declaredAlbumArtists.size === 1
    ? [...declaredAlbumArtists][0]
    : declaredAlbumArtists.size === 0 && artistsInScope.size === 1
      ? [...artistsInScope][0]
      : null
  if (albumArtistFill) {
    for (const t of tracks) {
      if (!cleanWhitespace(String(t.albumArtist ?? ''))) {
        findings.push({
          trackId: t.id,
          field: 'albumArtist',
          oldValue: String(t.albumArtist ?? ''),
          newValue: albumArtistFill,
          reason: declaredAlbumArtists.size === 1 ? 'siblings declare this album artist' : 'single-artist album',
          source: 'internal-consistency',
          confidence: 'high',
          provable: true,
        })
      }
    }
  }
  const declaredGenres = new Set(tracks.map(t => cleanWhitespace(String(t.genre ?? ''))).filter(Boolean))
  if (declaredGenres.size === 1) {
    const g = [...declaredGenres][0]
    for (const t of tracks) {
      if (!cleanWhitespace(String(t.genre ?? ''))) {
        findings.push({
          trackId: t.id, field: 'genre',
          oldValue: String(t.genre ?? ''), newValue: g,
          reason: 'siblings on this album agree on the genre',
          source: 'internal-consistency', confidence: 'high', provable: true,
        })
      }
    }
  }
  const declaredYears = new Set(tracks.map(t => num(t.year)).filter(y => y > 0))
  if (declaredYears.size === 1) {
    const y = [...declaredYears][0]
    for (const t of tracks) {
      if (num(t.year) === 0) {
        findings.push({
          trackId: t.id, field: 'year',
          oldValue: String(t.year ?? ''), newValue: String(y),
          reason: 'siblings on this album agree on the year',
          source: 'internal-consistency', confidence: 'high', provable: true,
        })
      }
    }
  }

  // ── 3. Artist-spelling variance within the album (judgment) ──
  // Case/whitespace variants of the same name: majority form wins, per the
  // materiality rule (the user's own consistency, not MusicBrainz's). Never
  // provable — a lone lowercase form COULD be intentional stylization.
  scanCaseVariance(tracks, t => String(t.artist ?? ''), 'artist', findings, flags)
  scanCaseVariance(tracks, t => String(t.albumArtist ?? ''), 'albumArtist', findings, flags)

  // ── 4. feat./featuring/ft. variance (judgment) ──
  const featForms = new Set<string>()
  for (const t of tracks) {
    const m = String(t.artist ?? '').match(FEAT_RE) || String(t.title ?? '').match(FEAT_RE)
    if (m) featForms.add(m[1].toLowerCase())
  }
  if (featForms.size > 1) {
    flags.push({
      kind: 'feat-variance',
      detail: `mixed featuring styles in scope: ${[...featForms].join(' / ')} — normalize to one form`,
    })
  }

  // ── 5. Title-case outlier (judgment, conservative) ──
  // Only the unambiguous case: an all-lowercase title among a scope whose
  // titles otherwise start uppercase. ALL-CAPS and stylized mixes are left
  // alone entirely.
  const titled = tracks.filter(t => cleanWhitespace(String(t.title ?? '')).length > 1)
  if (titled.length >= 4) {
    const startsUpper = (s: string) => /^[A-Z0-9("']/.test(s.trim())
    const isAllLower = (s: string) => s === s.toLowerCase() && /[a-z]/.test(s)
    const upperish = titled.filter(t => startsUpper(String(t.title)))
    if (upperish.length >= titled.length - 1 && upperish.length < titled.length) {
      for (const t of titled) {
        const title = String(t.title)
        if (!startsUpper(title) && isAllLower(title)) {
          const fixed = title.replace(/(^|\s)([a-z])/g, (_m, sp, ch) => sp + ch.toUpperCase())
          findings.push({
            trackId: t.id,
            field: 'title',
            oldValue: title,
            newValue: fixed,
            reason: 'lowercase outlier — every other title on this album is capitalized',
            source: 'internal-consistency',
            confidence: 'medium',
            provable: false,
          })
        }
      }
    }
  }

  // ── 6. Track-number integrity (flags only — MB-diff owns the fixes) ──
  scanTrackNumberIntegrity(tracks, flags)

  // ── 7. Year variance (flag only — canonical year is MB's call) ──
  const years = new Set(tracks.map(t => num(t.year)).filter(y => y > 0))
  if (years.size > 1) {
    flags.push({ kind: 'year-variance', detail: `mixed years in scope: ${[...years].sort().join(', ')}` })
  }

  // ── 8. Genre variance (flag only) ──
  const genres = new Set(tracks.map(t => cleanWhitespace(String(t.genre ?? '')).toLowerCase()).filter(Boolean))
  if (genres.size > 1) {
    flags.push({ kind: 'genre-variance', detail: `mixed genres in scope: ${[...genres].join(', ')}` })
  }

  return { findings, flags }
}

function scanCaseVariance(
  tracks: CynthiaScanTrack[],
  get: (t: CynthiaScanTrack) => string,
  field: CynthiaFindingField,
  findings: CynthiaFinding[],
  flags: CynthiaScanFlag[],
): void {
  const byNorm = new Map<string, Map<string, CynthiaScanTrack[]>>()
  for (const t of tracks) {
    const raw = cleanWhitespace(get(t))
    if (!raw) continue
    const norm = raw.toLowerCase()
    let forms = byNorm.get(norm)
    if (!forms) { forms = new Map(); byNorm.set(norm, forms) }
    const arr = forms.get(raw)
    if (arr) arr.push(t)
    else forms.set(raw, [t])
  }
  for (const [, forms] of byNorm) {
    if (forms.size < 2) continue
    // Same name, multiple casings — majority form wins; ties do nothing.
    const ranked = [...forms.entries()].sort((a, b) => b[1].length - a[1].length)
    if (ranked[0][1].length === ranked[1][1].length) {
      flags.push({ kind: 'artist-variance', detail: `"${ranked[0][0]}" vs "${ranked[1][0]}" appear equally often — no majority to normalize to` })
      continue
    }
    const winner = ranked[0][0]
    for (const [form, ts] of ranked.slice(1)) {
      for (const t of ts) {
        findings.push({
          trackId: t.id,
          field,
          oldValue: form,
          newValue: winner,
          reason: `outlier casing — ${ranked[0][1].length} of ${tracks.length} tracks use '${winner}'`,
          source: 'internal-consistency',
          confidence: 'high',
          provable: false,
        })
      }
    }
  }
}

function scanTrackNumberIntegrity(tracks: CynthiaScanTrack[], flags: CynthiaScanFlag[]): void {
  const byDisc = new Map<number, number[]>()
  let missing = 0
  for (const t of tracks) {
    const n = num(t.trackNumber)
    if (n === 0) { missing++; continue }
    const d = num(t.discNumber) || 1
    const arr = byDisc.get(d)
    if (arr) arr.push(n)
    else byDisc.set(d, [n])
  }
  if (missing > 0) {
    flags.push({ kind: 'missing-track-number', detail: `${missing} track${missing === 1 ? ' has' : 's have'} no track number` })
  }
  for (const [disc, nums] of byDisc) {
    const seen = new Set<number>()
    for (const n of nums) {
      if (seen.has(n)) {
        flags.push({ kind: 'duplicate-track-number', detail: `two tracks claim #${n} on disc ${disc}` })
      }
      seen.add(n)
    }
  }
}
