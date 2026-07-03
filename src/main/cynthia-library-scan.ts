/**
 * Cynthia neat-freak pass — LIBRARY-WIDE consistency.
 *
 * The per-album scanner (cynthia-scan.ts) can't see across albums, so a
 * library where one record says "Beastie Boys" and another says "The
 * beastie boys", or where the genre field splinters into "Hip Hop" /
 * "Hip-Hop" / "hip hop", passes album-by-album inspection while the
 * COLLECTION stays messy. This pass looks at the whole library at once
 * and normalizes vocabulary to each cluster's majority form:
 *
 *   artists / albumArtists — variants that differ only in case or
 *     whitespace collapse to the majority spelling (whitespace-only
 *     variants are provable; case variants are judgment — a lone
 *     lowercase form could be intentional stylization)
 *   genres — variants that differ only in case, spacing, or punctuation
 *     ("Hip Hop" vs "Hip-Hop") collapse to the majority form (judgment,
 *     high confidence — same letters, different dress)
 *   feat. style — "featuring" / "ft." in titles and artists normalize to
 *     the house form "feat." (judgment; content rewrite is never provable)
 *
 * Clusters are letters-based, so genuinely different names ("Rap" vs
 * "Hip-Hop") never merge. Ties (no majority) are skipped, not guessed.
 * Pure module — unit-tested; the sweep distributes findings per album
 * through the same dismissed/ledger machinery as everything else.
 */

import type { CynthiaFinding, CynthiaScanTrack } from './cynthia-scan'

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Letters-only cluster key: case-, space- and punctuation-insensitive. */
function clusterKey(s: string): string {
  return collapse(s).toLowerCase().replace(/[^a-z0-9]+/gi, '')
}

const FEAT_VARIANT_RE = /\b(featuring|ft\.)\s+/gi

interface ClusterOpts {
  field: 'artist' | 'albumArtist' | 'genre'
  get: (t: CynthiaScanTrack) => string
  minClusterSize: number
}

function normalizeClusters(
  tracks: CynthiaScanTrack[],
  { field, get, minClusterSize }: ClusterOpts,
  findings: CynthiaFinding[],
): void {
  const clusters = new Map<string, Map<string, CynthiaScanTrack[]>>()
  for (const t of tracks) {
    const raw = collapse(get(t))
    if (!raw) continue
    const key = clusterKey(raw)
    if (!key) continue
    let forms = clusters.get(key)
    if (!forms) { forms = new Map(); clusters.set(key, forms) }
    const arr = forms.get(raw)
    if (arr) arr.push(t)
    else forms.set(raw, [t])
  }
  for (const [, forms] of clusters) {
    if (forms.size < 2) continue
    const total = [...forms.values()].reduce((s, arr) => s + arr.length, 0)
    if (total < minClusterSize) continue
    const ranked = [...forms.entries()].sort((a, b) => b[1].length - a[1].length)
    if (ranked[0][1].length === ranked[1][1].length) continue  // tie — never guess
    const winner = ranked[0][0]
    for (const [form, ts] of ranked.slice(1)) {
      // Whitespace-only difference from the winner is mechanically
      // certain; anything else (case, punctuation) is a judgment call.
      const whitespaceOnly = collapse(form) !== form || form.replace(/\s+/g, ' ') === winner
      const provable = form.toLowerCase() === winner.toLowerCase() && collapse(form) === collapse(winner)
      for (const t of ts) {
        findings.push({
          trackId: t.id,
          field,
          oldValue: get(t),
          newValue: winner,
          reason: `library majority uses '${winner}' (${ranked[0][1].length} of ${total})`,
          source: 'internal-consistency',
          confidence: 'high',
          provable: provable && whitespaceOnly,
        })
      }
    }
  }
}

export function scanLibraryConsistency(tracks: CynthiaScanTrack[]): CynthiaFinding[] {
  const findings: CynthiaFinding[] = []
  if (tracks.length === 0) return findings

  // Artist + albumArtist vocabulary (min cluster 3 — a 2-track split has
  // no meaningful majority).
  normalizeClusters(tracks, { field: 'artist', get: t => String(t.artist ?? ''), minClusterSize: 3 }, findings)
  normalizeClusters(tracks, { field: 'albumArtist', get: t => String(t.albumArtist ?? ''), minClusterSize: 3 }, findings)

  // Genre vocabulary — same-letters variants collapse to the majority.
  normalizeClusters(tracks, { field: 'genre', get: t => String(t.genre ?? ''), minClusterSize: 2 }, findings)

  // House featuring style: "feat." (never provable — content rewrite).
  for (const t of tracks) {
    for (const { field, value } of [
      { field: 'title' as const, value: String(t.title ?? '') },
      { field: 'artist' as const, value: String(t.artist ?? '') },
    ]) {
      FEAT_VARIANT_RE.lastIndex = 0
      if (FEAT_VARIANT_RE.test(value)) {
        const fixed = value.replace(FEAT_VARIANT_RE, 'feat. ')
        if (fixed !== value) {
          findings.push({
            trackId: t.id,
            field,
            oldValue: value,
            newValue: fixed,
            reason: "house style is 'feat.'",
            source: 'internal-consistency',
            confidence: 'high',
            provable: false,
          })
        }
      }
    }
  }

  return findings
}
