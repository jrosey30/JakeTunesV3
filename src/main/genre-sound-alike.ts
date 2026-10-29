/**
 * Sound-alike vote (2026-10-28, Jake: "assumptions by sam gellaitry is not
 * updated genre. the scanner needs to be better"). Sam Gellaitry's "IV" went
 * to Experimental because the only evidence was MusicBrainz tags and a thin
 * press search. His own library knows better: the songs that SOUND like a new
 * album sit on real shelves (French House, Nu Disco, ...). This counts the
 * shelves of a new album's nearest settled songs, so the filer can say
 * "sounds like your: French House 31, Nu Disco 22 ...".
 *
 * Evidence, never an answer: the vote is one line the AI weighs next to the
 * tags and press, and enforce() may fall back to its top shelf only when the
 * AI's pick breaks a rule.
 *
 * Two spaces, never mixed:
 *   - audio: the CLAP vectors (audio-index.bin) — the recording itself.
 *   - mood: the mood index (mood-index.bin), only when none of the album's
 *     songs has an audio vector yet (scripts/audio-embed.py runs on its own
 *     schedule). WEAKER: the mood text carries the song's current genre line
 *     (src/common/mood-genre-line.ts), so a mood vote partly echoes the tag
 *     the song wears. That is why the filer never uses mood for an album
 *     already wearing a genre the filer wrote (a re-judgement would only
 *     hear its own old answer back).
 *
 * Pure: vectors, shelves and ids in, a count out.
 */

export interface ShelfTrack { genre: string; artist: string }

export interface SoundAlike {
  source: 'audio' | 'mood'
  /** Songs of the album that had a vector in that space. */
  probed: number
  /** Shelf counts, most votes first (ties by name). */
  votes: Array<{ genre: string; n: number }>
  /** Sum of votes. */
  total: number
}

export interface SoundAlikeOpts {
  /** Nearest settled songs per album song. */
  k?: number
  /** At most this many of the k from one artist — the vote is about his
   *  shelves, not about one band with forty songs in the neighbourhood. */
  perArtist?: number
  /** Album songs probed (a 30-song deluxe edition doesn't need 30 scans). */
  maxProbe?: number
  /** Neighbours below this cosine don't vote (unrelated songs). */
  minScore?: number
}

const DEFAULTS: Required<SoundAlikeOpts> = { k: 10, perArtist: 2, maxProbe: 12, minScore: 0 }

/**
 * The shelf distribution of the album's nearest settled songs in ONE vector
 * space. `shelf` holds only songs whose genre counts as his decision (settled,
 * not on the check list); the album's own songs are never their own
 * neighbours. null when no album song has a vector, or nothing voted.
 */
export function soundAlikeVote(
  albumIds: number[],
  vectors: Map<number, Float32Array>,
  shelf: Map<number, ShelfTrack>,
  source: SoundAlike['source'],
  opts: SoundAlikeOpts = {},
): SoundAlike | null {
  const o = { ...DEFAULTS, ...opts }
  const own = new Set(albumIds)
  const probes = albumIds.map((id) => vectors.get(id)).filter((v): v is Float32Array => !!v).slice(0, o.maxProbe)
  if (!probes.length) return null
  // The candidate pool once: shelf songs that have a vector in this space.
  const pool: Array<{ v: Float32Array; s: ShelfTrack }> = []
  for (const [id, s] of shelf) {
    if (own.has(id)) continue
    const v = vectors.get(id)
    if (v) pool.push({ v, s })
  }
  if (!pool.length) return null
  const counts = new Map<string, number>()
  let probed = 0
  for (const q of probes) {
    const scored: Array<{ score: number; s: ShelfTrack }> = []
    for (const p of pool) {
      if (p.v.length !== q.length) continue
      let dot = 0
      for (let i = 0; i < q.length; i++) dot += q[i] * p.v[i]
      if (dot >= o.minScore) scored.push({ score: dot, s: p.s })
    }
    if (!scored.length) continue
    probed++
    scored.sort((a, b) => b.score - a.score)
    const perArtist = new Map<string, number>()
    let taken = 0
    for (const h of scored) {
      if (taken >= o.k) break
      const a = h.s.artist.trim().toLowerCase()
      const seen = perArtist.get(a) ?? 0
      if (seen >= o.perArtist) continue
      perArtist.set(a, seen + 1)
      counts.set(h.s.genre, (counts.get(h.s.genre) ?? 0) + 1)
      taken++
    }
  }
  const votes = [...counts.entries()].map(([genre, n]) => ({ genre, n })).sort((a, b) => b.n - a.n || a.genre.localeCompare(b.genre))
  const total = votes.reduce((s, v) => s + v.n, 0)
  return total ? { source, probed, votes, total } : null
}

/** Audio first; the mood index only when no album song has an audio vector
 *  and the caller allows it (see the header: never for an album wearing a
 *  genre the filer wrote). */
export function soundAlikeFor(
  albumIds: number[],
  spaces: { audio?: Map<number, Float32Array>; mood?: Map<number, Float32Array> },
  shelf: Map<number, ShelfTrack>,
  allowMood: boolean,
  opts?: SoundAlikeOpts,
): SoundAlike | null {
  if (spaces.audio?.size) {
    const a = soundAlikeVote(albumIds, spaces.audio, shelf, 'audio', opts)
    if (a) return a
  }
  if (allowMood && spaces.mood?.size) return soundAlikeVote(albumIds, spaces.mood, shelf, 'mood', opts)
  return null
}

/** The vote's leading shelf when it is a real plurality: at least `minShare`
 *  of the votes and ahead of the runner-up. */
export function soundAlikeLeader(s: SoundAlike | null | undefined, minShare = 0.3): string | undefined {
  if (!s || !s.votes.length) return undefined
  const [a, b] = s.votes
  if (a.n / s.total < minShare) return undefined
  if (b && b.n === a.n) return undefined
  return a.genre
}

/** One evidence line: "sounds like his (audio, 8 songs): French House 31, Nu Disco 22 … of 80". */
export function soundAlikeText(s: SoundAlike, top = 6): string {
  const what = s.source === 'audio' ? 'by audio' : 'by mood index — weaker, partly echoes the store tag'
  return `sounds like Jake's shelves (${what}, ${s.probed} song${s.probed === 1 ? '' : 's'}): ${s.votes.slice(0, top).map((v) => `${v.genre} ${v.n}`).join(', ')} of ${s.total}`
}
