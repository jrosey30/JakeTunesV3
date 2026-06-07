/**
 * Pure helpers for the AI-assisted artist-grouping pass (metadata hierarchy
 * Phase 2). The impure half (claudeCall) lives in the classify-artist-groups
 * IPC; this is the deterministic half — pick the candidate tags + relevant
 * primaries to send, and parse the model's classification back. Pure so
 * `node --test` drives it.
 */

export interface ArtistCandidate { tag: string; count: number }

export interface GroupingProposal {
  tag: string
  type: 'persona' | 'collaboration' | 'standalone'
  /** Canonical primary for a persona (e.g. Wings → "Paul McCartney"). */
  canonical?: string
  /** Distinct artists for a collaboration. */
  contributors?: string[]
  why?: string
}

// A tag is a grouping CANDIDATE if it contains a join marker — the ambiguous
// cases ("X & Y") that could be persona / collab / standalone. Clean single
// names without a marker are treated as primaries (or left alone).
const MARKER = /( & | and |\s*\/\s*| feat\.?\s| featuring | with | presents |, |;| vs\.? )/i

const STOPWORDS = new Set([
  'the', 'and', 'feat', 'featuring', 'with', 'presents', 'his', 'her', 'their',
  'band', 'orchestra', 'friends', 'all', 'starr', 'project', 'group', 'ensemble',
  'vs', 'a', 'of', 'amp',
])

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
}

/**
 * From the library tracks, pick the candidate tags (those with join markers)
 * and the relevant primary artists (clean single-name tags that share a word
 * token with some candidate — so the model can map a persona to an existing
 * artist by exact name without us shipping all ~1000 names).
 */
export function computeArtistCandidates(
  tracks: Array<{ artist?: string }>,
  opts: { maxCandidates?: number; maxPrimaries?: number } = {},
): { candidates: ArtistCandidate[]; primaries: string[] } {
  const counts = new Map<string, number>()
  for (const t of tracks) {
    const a = (t.artist || '').trim()
    if (a) counts.set(a, (counts.get(a) || 0) + 1)
  }
  const all = [...counts.entries()]
  const candidates = all
    .filter(([a]) => MARKER.test(a))
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, opts.maxCandidates ?? 200)

  const candTokens = new Set<string>()
  for (const c of candidates) for (const w of tokenize(c.tag)) candTokens.add(w)

  const primaries = all
    .filter(([a]) => !MARKER.test(a))
    .filter(([name]) => tokenize(name).some((w) => candTokens.has(w)))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, opts.maxPrimaries ?? 400)

  return { candidates, primaries }
}

/** Tolerant parse of the model's JSON array of classifications. */
export function parseGroupingResponse(text: string): GroupingProposal[] {
  if (!text) return []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr: unknown
  try {
    arr = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: GroupingProposal[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const tag = String(r.tag ?? '').trim()
    if (!tag) continue
    const type = r.type === 'persona' || r.type === 'collaboration' || r.type === 'standalone'
      ? r.type
      : 'standalone'
    const canonical = typeof r.canonical === 'string' ? r.canonical.trim() : undefined
    const contributors = Array.isArray(r.contributors)
      ? r.contributors.map((c) => String(c).trim()).filter(Boolean)
      : undefined
    const why = typeof r.why === 'string' ? r.why.trim() : undefined
    // A persona is only actionable with a canonical that differs from the tag.
    if (type === 'persona' && (!canonical || canonical.toLowerCase() === tag.toLowerCase())) {
      out.push({ tag, type: 'standalone', why })
      continue
    }
    out.push({ tag, type, canonical, contributors, why })
  }
  return out
}
