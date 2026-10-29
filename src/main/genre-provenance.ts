/**
 * Who set each song's genre (2026-10-28, Jake: "fix the filer re-doing albums
 * bug. make sure genres are CORRECT").
 *
 * Before this, the filer could not tell its own picks from Jake's. A genre in
 * metadata-overrides.json counted as "his" whoever wrote it, so:
 *   - his own Get Info choice OFF the list ("Electronic" on The Avalanches'
 *     "No Bad Memories", 10/20 — typed three times, re-filed to Experimental
 *     within five minutes each time; "World" on Niko Rubio, 10/26 → Latin Pop)
 *     looked like a store tag and was filed over;
 *   - the filer's own old picks counted as his, so it could never re-judge
 *     them (14 check-list albums wore its suggestion and had left the list);
 *   - a catch-all it wrote ("Classic Rock" on The Police, "Punk" on Social
 *     Distortion) whose override went missing was judged again from scratch;
 *   - its own weak pick became an artist's "home" and was copied onto the
 *     artist's other albums with no evidence of their own.
 *
 * The record: genre-provenance.json beside genre-check.json, one entry per
 * song the FILER wrote (or that Jake filed from the check list). Jake's Get
 * Info edits are already timed in user-edits.json (src/common/user-edits.ts),
 * and the phone's in mobile-metadata-overrides.json — the owner of a genre is
 * read from all three (genreOwner). A genre nobody recorded but the overrides
 * file holds is UNKNOWN, and unknown is treated as his: never changed.
 *
 * Pure decisions; the file is read and written by ipc/genre-filer-ipc.ts.
 */
import { CATCH_ALL, isListGenre } from '../common/genre-vocab.ts'

export const PROVENANCE_FILE = 'genre-provenance.json'

/** How the filer reached a genre. */
export type FilerHow =
  | 'evidence'        // judged on MusicBrainz / Deezer / Discogs / press / sound-alike evidence
  | 'specific-tag'    // the store tag was already a specific list genre
  | 'artist-home'     // copied from the artist's shelf
  | 'album-sibling'   // new songs of an album already filed (one genre per album)
  | 'suggestion'      // unsure: filed under the suggestion, still on the check list
  | 'rejudge'         // the one re-judgement on newer evidence
  | 'correction'      // the 2026-10-28 audit's corrections pass
  | 'log-seed'        // a filing from before this record, rebuilt from the filer's own log

export interface ProvenanceEntry {
  genre: string
  /** filer = this app's genre filer; jake = filed by him from the check list */
  by: 'filer' | 'jake'
  how: FilerHow | 'check-list'
  confidence?: 'high' | 'medium' | 'low'
  /** title|artist|duration of the song when written (trackFingerprint) */
  fp: string
  /** ISO time written */
  at: string
}

export interface ProvenanceDoc { version: 1; tracks: Record<string, ProvenanceEntry> }

export const emptyProvenance = (): ProvenanceDoc => ({ version: 1, tracks: {} })

export function parseProvenance(raw: unknown): ProvenanceDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyProvenance()
  const o = raw as { version?: unknown; tracks?: unknown }
  if (o.version !== 1 || !o.tracks || typeof o.tracks !== 'object') return emptyProvenance()
  const tracks: Record<string, ProvenanceEntry> = {}
  for (const [id, e] of Object.entries(o.tracks as Record<string, Partial<ProvenanceEntry>>)) {
    if (!/^\d+$/.test(id) || !e || typeof e.genre !== 'string' || (e.by !== 'filer' && e.by !== 'jake') || typeof e.fp !== 'string' || typeof e.at !== 'string') continue
    tracks[id] = {
      genre: e.genre, by: e.by, how: (e.how ?? 'evidence') as ProvenanceEntry['how'], fp: e.fp, at: e.at,
      ...(e.confidence === 'high' || e.confidence === 'medium' || e.confidence === 'low' ? { confidence: e.confidence } : {}),
    }
  }
  return { version: 1, tracks }
}

/** Same song? title|artist must match; the duration may drift (a re-measured file). */
export function sameSong(fpA: string, fpB: string): boolean {
  const head = (fp: string): string => fp.slice(0, fp.lastIndexOf('|'))
  return !!fpA && !!fpB && head(fpA) === head(fpB)
}

/** Who a song's current genre belongs to.
 *   jake    — his Get Info edit (journal), or he filed it from the check list
 *   phone   — set on his phone (a specific list genre the phone overlay carries)
 *   filer   — the filer wrote exactly this genre on exactly this song
 *   unknown — in the overrides file, nobody recorded who (the practice run, an
 *             edit before the journal began 2026-10-20…): treated as his
 *   store   — whatever the file / store shipped; nobody chose it */
export type GenreOwner = 'jake' | 'phone' | 'filer' | 'unknown' | 'store'

export interface OwnerInput {
  genre?: string
  fp: string
  duration?: number
  /** the overrides file holds a genre for this song (fp-valid) */
  inOverrides: boolean
  prov?: ProvenanceEntry
  /** his newest journaled genre edit for this song */
  journal?: { v: string; at: number; dur?: number }
  /** the phone overlay's genre for this song (fp-valid) */
  phone?: string
}

export function genreOwner(i: OwnerInput): GenreOwner {
  const g = (i.genre || '').trim()
  if (!g) return 'store'
  const prov = i.prov && i.prov.genre === g && sameSong(i.prov.fp, i.fp) ? i.prov : undefined
  // The journal's duration guards against an id that now names another song.
  const j = i.journal && i.journal.v.trim() === g && (i.journal.dur === undefined || !i.duration || i.journal.dur === i.duration) ? i.journal : undefined
  // His edit wins unless the filer wrote the same word on top of it later
  // (then it is still the same word he chose — his).
  if (j) return 'jake'
  if (prov) return prov.by === 'jake' ? 'jake' : 'filer'
  if (i.phone && i.phone.trim() === g && isListGenre(g) && !CATCH_ALL.has(g)) return 'phone'
  return i.inOverrides ? 'unknown' : 'store'
}

/** His (or treated as his): never changed by the filer or a corrections pass. */
export const isHis = (o: GenreOwner | undefined): boolean => o === 'jake' || o === 'phone' || o === 'unknown'
