/**
 * rag-retrieval — the dual-index retrieval router and core RAG entry
 * points (every consumer flows through ragRetrieveByQuery). Extracted
 * verbatim from main/index.ts (6.0 Phase 1, the Phase-3a precursor:
 * the eval harness can now call the PRODUCTION retrieval path).
 */
import { join } from 'path'
import { readFile } from 'fs/promises'
import { foldAccents } from '../../common/fold-text.ts'
import { DECADE_QUERY_RE, parseDecadeConstraint, yearInDecade } from './decade-query'
import {
  analyzeEmbeddings as ragAnalyzeEmbeddings,
  embedTexts as ragEmbedTexts,
  getEmbeddingsMap as ragGetEmbeddingsMap,
  isEmbeddingsConfigured as ragIsConfigured,
  topK as ragTopK,
} from './embeddings'
import { getMoodIndexMap } from './mood-index'
import { getAudioIndexMap, audioTopK } from './audio-index.ts'
import { clapEmbedText } from './audio-query.ts'
import { RERANK_OVERFETCH, RERANK_POOL_CAP, RERANK_GENRE_W, rerankHits } from './rag-rerank.ts'

export interface RagRetrievalHost {
  libraryCache: { get: () => Promise<unknown> }
  libraryPath: () => string
}
let ragHost: RagRetrievalHost
export function initRagRetrieval(host: RagRetrievalHost): void { ragHost = host }

export async function ragIndexedCountForTracks(tracks: Array<{ id: number }>): Promise<number> {
  const validIds = new Set(tracks.map(t => t.id))
  const { indexed } = await ragAnalyzeEmbeddings(validIds).catch(() => ({ indexed: 0, stale: 0, missing: validIds.size }))
  return indexed
}

// ── Dual-index retrieval router ──────────────────────────────────────
// Two brains, one door: embeddings.bin knows WHO (artist/album/title/
// year/★), mood-index.bin knows how it FEELS (descriptor/tempo/genre,
// identity stripped). Identity collapses on the mood index BY DESIGN
// (Sublime → 0.00 in the validation), so routing is load-bearing:
//   • query names a library artist  → main index
//   • query names a decade/year     → main index (mood text has no year)
//   • anything else (vibe-shaped)   → mood index, if it's ready
// Validated 2026-07-07 (brain-eval mood_index_proto.py): this routing
// takes retrieval 0.825 → ~0.91 on the held-out eval set.
// DECADE_QUERY_RE lives in ./ai/decade-query (twin with Mobile rag).
// Genre-ish words that can also be band names — an artist match on one
// of these must not hijack a vibe query ("house and dance music" is not
// about a band named House).
const GENRE_WORD_ARTISTS = new Set([
  'house', 'dance', 'funk', 'soul', 'punk', 'metal', 'grunge', 'jazz', 'blues',
  'rock', 'pop', 'disco', 'techno', 'ambient', 'folk', 'country', 'rap',
  'reggae', 'ska', 'indie', 'emo', 'hardcore', 'trance', 'garage', 'gospel',
])
let ragArtistSetCache: { at: number; set: Set<string> } | null = null
export async function ragLibraryArtistSet(): Promise<Set<string>> {
  if (ragArtistSetCache && Date.now() - ragArtistSetCache.at < 5 * 60 * 1000) return ragArtistSetCache.set
  const set = new Set<string>()
  try {
    const lib = (await ragHost.libraryCache.get()) as { tracks?: Array<{ artist?: string; albumArtist?: string }> }
    for (const t of lib.tracks || []) {
      for (const a of [t.artist, t.albumArtist]) {
        // ⚠️ Must fold identically to pickRetrievalIndex's qNorm below, or an
        //    accented artist is in this set under a name the query can't form.
        const norm = foldAccents(a || '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
        if (norm.length >= 4 && !GENRE_WORD_ARTISTS.has(norm)) set.add(norm)
      }
    }
  } catch { /* empty set = router falls back to the main index only on artist grounds */ }
  ragArtistSetCache = { at: Date.now(), set }
  return set
}

export async function pickRetrievalIndex(query: string): Promise<'main' | 'mood'> {
  if (DECADE_QUERY_RE.test(query)) return 'main'
  const qNorm = ` ${foldAccents(query).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `
  const artists = await ragLibraryArtistSet()
  for (const a of artists) {
    if (qNorm.includes(` ${a} `)) return 'main'
  }
  // Vibe-shaped. Route to the mood index only once it covers most of
  // the brain — a half-built index would silently shrink the library.
  const [main, mood] = await Promise.all([ragGetEmbeddingsMap(), getMoodIndexMap()])
  return mood.size >= main.size * 0.5 && mood.size > 0 ? 'mood' : 'main'
}

/** Library year lookup for the decade hard-gate. Missing year = excluded. */
async function ragTrackGenreMap(): Promise<Map<number, string>> {
  try {
    const lib = (await ragHost.libraryCache.get()) as { tracks?: Array<{ id: number; genre?: string }> }
    return new Map((lib.tracks || []).filter(t => typeof t?.id === 'number').map(t => [t.id, String(t.genre || '')]))
  } catch {
    return new Map()
  }
}

export async function ragTrackYearMap(): Promise<Map<number, string | number | undefined>> {
  try {
    const lib = (await ragHost.libraryCache.get()) as { tracks?: Array<{ id: number; year?: string | number }> }
    return new Map((lib.tracks || []).filter(t => typeof t?.id === 'number').map(t => [t.id, t.year]))
  } catch {
    return new Map()
  }
}

// Retrieve the K most-similar tracks to a free-text query. Used by
// musicman-chat to build a focused context block in place of the
// giant pre-computed digest. Returns track IDs + similarity scores;
// caller resolves to full track records. Routes between the identity
// brain and the mood brain (see the router block above).
//
// Decade hard-gate (2026-08): when the query claims an era ("1970s",
// "seventies", "'80s"), restrict the cosine scan to tracks whose
// library year falls in that range. Soft embedding similarity alone
// will happily rank Turnstile next to Bill Withers on a "1970s" query —
// that is the daily-mix "1970s, Your Version" failure mode. Fail closed
// on missing year (no year → not eligible for a decade claim).
export async function ragRetrieveByQuery(query: string, k: number): Promise<Array<{ trackId: number; score: number }>> {
  if (!ragIsConfigured()) return []
  const route = await pickRetrievalIndex(query)
  let map = route === 'mood' ? await getMoodIndexMap() : await ragGetEmbeddingsMap()
  if (map.size === 0) return []
  const decade = parseDecadeConstraint(query)
  if (decade) {
    const years = await ragTrackYearMap()
    const gated = new Map<number, Float32Array>()
    for (const [id, vec] of map) {
      if (yearInDecade(years.get(id), decade)) gated.set(id, vec)
    }
    console.log(`[rag] decade hard-gate ${decade.label} (${decade.start}-${decade.end}): ${gated.size}/${map.size} candidates`)
    map = gated
    if (map.size === 0) return []
  }
  // 3d (gated): the AUDIO route — CLAP text query against how tracks
  // actually SOUND. Opt-in via JT_AUDIO_ROUTE until the production-path
  // eval says it beats the mood route; every failure falls through.
  const audioMode = process.env.JT_AUDIO_ROUTE   // '1' = audio-only, 'fusion' = mood ⊕ audio
  if (route === 'mood' && (audioMode === '1' || audioMode === 'fusion') && !decade) {
    try {
      const amap = await getAudioIndexMap()
      if (amap.size > 0) {
        const aq = await clapEmbedText(query)
        if (aq) {
          const poolK = Math.min(Math.max(k * RERANK_OVERFETCH, k), RERANK_POOL_CAP)
          if (audioMode === '1') {
            console.log(`[rag] route=audio k=${k} "${query.slice(0, 60)}"`)
            const pool = audioTopK(aq, amap, poolK)
            return rerankHits(query, pool, await ragTrackGenreMap(), k, RERANK_GENRE_W)
          }
          // FUSION: union of the mood pool and the audio pool; every candidate
          // gets both cosines. The audio term is added as a DEVIATION scaled
          // into mood units (W × z_audio × σ_mood), so the score stays in
          // cosine units and the 3c genre reranker's weight means the same
          // thing it always did. A track with no audio vector sits at the
          // audio mean (no bonus, no penalty).
          const [qvec] = await ragEmbedTexts([query])
          if (qvec) {
            const W = Number(process.env.JT_AUDIO_W ?? '0.5')
            const moodPool = ragTopK(qvec, map, poolK)
            const audioPool = audioTopK(aq, amap, poolK)
            const ids = new Set<number>([...moodPool.map((h) => h.trackId), ...audioPool.map((h) => h.trackId)])
            const dot = (a: Float32Array, b: Float32Array): number => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i] * b[i]; return t }
            const rows: Array<{ trackId: number; m: number; a: number | null }> = []
            for (const id of ids) {
              const mv = map.get(id)
              if (!mv) continue
              const av = amap.get(id)
              rows.push({ trackId: id, m: dot(qvec, mv), a: av ? dot(aq, av) : null })
            }
            const stats = (xs: number[]): { mean: number; sd: number } => {
              const mean = xs.reduce((t, x) => t + x, 0) / Math.max(1, xs.length)
              const sd = Math.sqrt(xs.reduce((t, x) => t + (x - mean) ** 2, 0) / Math.max(1, xs.length)) || 1e-6
              return { mean, sd }
            }
            const ms = stats(rows.map((r) => r.m))
            const as = stats(rows.filter((r) => r.a != null).map((r) => r.a as number))
            const fused = rows
              .map((r) => ({ trackId: r.trackId, score: r.m + (r.a == null ? 0 : W * ((r.a - as.mean) / as.sd) * ms.sd) }))
              .sort((x, y) => y.score - x.score)
              .slice(0, poolK)
            console.log(`[rag] route=fusion W=${W} pool=${rows.length} k=${k} "${query.slice(0, 60)}"`)
            return rerankHits(query, fused, await ragTrackGenreMap(), k, RERANK_GENRE_W)
          }
        }
      }
    } catch (err) {
      console.warn('[rag] audio route failed — falling back to mood:', err instanceof Error ? err.message : err)
    }
  }
  try {
    const [qvec] = await ragEmbedTexts([query])
    if (!qvec) return []
    console.log(`[rag] route=${route} k=${k} "${query.slice(0, 60)}"`)
    // 3c reranker: over-fetch, add the lexical genre bonus, re-slice.
    const poolK = Math.min(Math.max(k * RERANK_OVERFETCH, k), RERANK_POOL_CAP)
    const pool = ragTopK(qvec, map, poolK)
    const reranked = rerankHits(query, pool, await ragTrackGenreMap(), k, RERANK_GENRE_W)
    const beforeTop = new Set(pool.slice(0, k).map((h) => h.trackId))
    const moved = reranked.filter((h) => !beforeTop.has(h.trackId)).length
    if (moved > 0) console.log(`[rag] rerank promoted ${moved}/${k} from the ${pool.length}-deep pool`)
    return reranked
  } catch (err) {
    console.warn('[rag] retrieve failed:', err instanceof Error ? err.message : err)
    return []
  }
}

// Build a focused block of retrieved tracks for injection into the
// AI prompt. Reads the live library so the displayed metadata reflects
// any post-embedding edits (artist renames, etc.). Returns '' when
// retrieval has no hits — caller appends nothing and the legacy digest
// is the only library context the model sees.
// 4.5.0-89 — shared RAG pool builder for the three weekly-picks
// handlers (mm / megan / dj-hands). Each persona passes its own seed
// query so the retrieved candidate pool biases toward that persona's
// lane WITHIN the user's library. Returns the original tracks array
// untouched when:
//   - OPENAI_API_KEY is not set
//   - fewer than 80% of library tracks are embedded
//   - retrieval returns < 100 hits (below threshold for picks variety)
// That fallback keeps current behavior intact when RAG isn't ready.
export async function buildRagPoolForPicks<T extends { id: number }>(
  seedQuery: string,
  allTracks: T[],
  k: number,
  minPool: number = 100,
): Promise<{ pool: T[]; used: boolean }> {
  if (!ragIsConfigured()) return { pool: allTracks, used: false }
  const idxCount = await ragIndexedCountForTracks(allTracks)
  if (idxCount < Math.max(50, Math.floor(allTracks.length * 0.8))) return { pool: allTracks, used: false }
  const hits = await ragRetrieveByQuery(seedQuery, k)
  if (hits.length < minPool) return { pool: allTracks, used: false }
  const idSet = new Set(hits.map(h => h.trackId))
  const pool = allTracks.filter(t => idSet.has(t.id))
  if (pool.length < minPool) return { pool: allTracks, used: false }
  return { pool, used: true }
}

export async function buildRetrievalBlockForQuery(query: string, k: number): Promise<string> {
  if (!query.trim()) return ''
  const hits = await ragRetrieveByQuery(query, k)
  if (hits.length === 0) return ''
  try {
    const raw = await readFile(ragHost.libraryPath(), 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: Array<{ id: number; title?: string; artist?: string; album?: string; year?: number | string; playCount?: number; rating?: number }> }
    const byId = new Map((lib.tracks || []).map(t => [t.id, t]))
    const lines = hits
      .map(h => {
        const t = byId.get(h.trackId)
        if (!t) return null
        const sig: string[] = []
        if (Number(t.rating) > 0) sig.push(`★${t.rating}`)
        const plays = Number(t.playCount) || 0
        if (plays > 0) sig.push(`${plays}p`)
        return `  • "${t.title || '?'}" — ${t.artist || '?'}${t.album ? ` (${t.album}${t.year ? ` ${t.year}` : ''})` : ''}${sig.length ? ` ${sig.join(' ')}` : ''}`
      })
      .filter((line): line is string => !!line)
    if (lines.length === 0) return ''
    return `RELEVANT TRACKS in the user's library (retrieved by semantic similarity to "${query.replace(/"/g, '\\"').slice(0, 80)}" — these are real tracks they own, ordered by relevance; use them to ground specifics):\n${lines.join('\n')}`
  } catch (err) {
    console.warn('[rag] block build failed:', err instanceof Error ? err.message : err)
    return ''
  }
}
