/**
 * Friend credit sweep — the IO shell around friend-imports-core (extracted
 * from index.ts 2026-08-28 under the line ratchet, in the same change that
 * added ATTRIBUTION credits).
 *
 * Jake: "it is not doing a good job tracking when a song suggestion comes
 * through from a friend" / "lorin should get credit for the latest john
 * mayer song that i imported." Two ledgers feed credits now:
 *   1. live list rows with "from <friend>" notes (the original path);
 *   2. reco-attributions.json — a durable record written the moment a
 *      friend's send arrives, INCLUDING sends that dedupe against a row
 *      already on the list and rows that later leave the list. This is
 *      what catches "Til the Right One Comes": Lorin texted it 8/24, the
 *      capture deduped it, Jake imported it 8/25 — the old sweep had
 *      nothing to look at; the attribution remembers.
 * Same honesty rules everywhere: library arrival must POSTDATE the send,
 * and one credit per friend+song, ever (coveredPairs guards the overlap).
 */
import { join } from 'path'
import { STATE_DIR } from './state-dir.ts'
import { JsonFileCache } from './state-cache.ts'
import {
  computeImportCredits, computeAttributionCredits, pairKeys, friendOfNote,
  attributionKey, type RecoAttribution, type CreditableReco,
} from './friend-imports-core'
import { computeAlbumCredits, creditKindOf, type CreditRecord } from './friend-standings-core'

export interface SweepDeps {
  readRecos: () => Promise<Array<Record<string, unknown>>>
  getTracks: () => Promise<Array<{ title?: string; artist?: string; albumArtist?: string; album?: string; dateAdded?: string }>>
  updateFriends: (fn: (cur: Record<string, { name: string; adds: number; got: number; tossed: number; lastAt: number; imported?: number }>) => Record<string, { name: string; adds: number; got: number; tossed: number; lastAt: number; imported?: number }>) => Promise<unknown>
  creditsCache: JsonFileCache<{ credits: CreditRecord[] }>
}

const importCreditCache = new JsonFileCache<{ credited: string[] }>(
  () => join(STATE_DIR, 'reco-import-credit.json'),
  () => ({ credited: [] }),
  'reco-import-credit',
)

const attributionsCache = new JsonFileCache<{ attributions: RecoAttribution[] }>(
  () => join(STATE_DIR, 'reco-attributions.json'),
  () => ({ attributions: [] }),
  'reco-attributions',
)

/**
 * Record that a friend SENT a song — called on every friend-attributed add,
 * including deduped ones (a new message pitching an already-listed song is
 * still a real send; the URL-seen guard upstream already stops the same
 * MESSAGE from recording twice, which was the 13→15 double-count bug).
 */
export async function noteAttribution(a: RecoAttribution): Promise<void> {
  if (!a.friend?.trim() || !attributionKey(a)) return
  await attributionsCache.update((cur) => {
    const key = attributionKey(a)
    // One attribution per friend+song — the first send's timestamp stands.
    if (cur.attributions.some((x) => x.friend.trim().toLowerCase() === a.friend.trim().toLowerCase() && attributionKey(x) === key)) return cur
    cur.attributions.push(a)
    return cur
  })
}

export async function sweepFriendImports(deps: SweepDeps): Promise<number> {
  try {
    const recos = await deps.readRecos()
    const tracks = await deps.getTracks()
    const credited = new Set((await importCreditCache.get()).credited)

    // Song credits (existing matcher) — but only for song-kind recos, so an
    // album reco that happens to carry a title can't double-earn.
    const songRecos = recos.filter((r) => creditKindOf(r as Parameters<typeof creditKindOf>[0]) === 'song') as unknown as CreditableReco[]
    const credits = computeImportCredits(songRecos, tracks, credited)
    // Album credits (2026-08-05, the standings feature): +5 material.
    const albumHits = computeAlbumCredits(recos as unknown as Parameters<typeof computeAlbumCredits>[0], tracks, credited, friendOfNote)

    // Attribution credits — sends the live list no longer remembers.
    // coveredPairs: every friend+pair already credited through recos, so an
    // import never earns twice through two ledgers.
    const existingRecords = (await deps.creditsCache.get()).credits
    const coveredPairs = new Set<string>()
    const recoById = new Map(recos.map((r) => [String(r.id), r]))
    for (const rec of existingRecords) {
      for (const k of rec.keys || []) coveredPairs.add(`${rec.friend.trim().toLowerCase()}|${k}`)
    }
    for (const c of credits) {
      const r = recoById.get(c.recoId)
      if (r) for (const k of pairKeys(r as unknown as CreditableReco)) coveredPairs.add(`${c.friend.trim().toLowerCase()}|${k}`)
    }
    const attrs = (await attributionsCache.get()).attributions
    const attrHits = computeAttributionCredits(attrs, tracks, credited, coveredPairs)

    if (credits.length === 0 && albumHits.length === 0 && attrHits.length === 0) return 0

    // Per-credit RECORDS with the identity the award was granted on —
    // standings recompute points from these against the live library, which
    // is what makes "minus 1 when I delete it" automatic.
    const now = new Date().toISOString()
    const newRecords: CreditRecord[] = []
    for (const c of credits) {
      const r = recoById.get(c.recoId)
      if (!r) continue
      const title = String(r.matchedTitle || r.song || '').trim()
      const artist = String(r.matchedArtist || r.artist || '').trim()
      newRecords.push({
        recoId: c.recoId, friend: c.friend, kind: 'song',
        label: artist ? `${title} — ${artist}` : title,
        keys: pairKeys(r as unknown as CreditableReco), creditedAt: now,
      })
    }
    for (const h of albumHits) {
      newRecords.push({
        recoId: h.recoId, friend: h.friend, kind: 'album',
        label: h.label, albumKey: h.albumKey, n0: h.n0, creditedAt: now,
      })
    }
    for (const h of attrHits) {
      newRecords.push({
        recoId: h.recoId, friend: h.friend, kind: 'song',
        label: h.label, keys: [h.key], creditedAt: now,
      })
    }

    await deps.updateFriends((cur) => {
      for (const c of [...credits, ...albumHits, ...attrHits]) {
        const key = c.friend.trim().toLowerCase()
        const f = cur[key] || { name: c.friend.trim(), adds: 0, got: 0, tossed: 0, lastAt: 0 }
        f.imported = (f.imported || 0) + 1
        cur[key] = f
      }
      return cur
    })
    await deps.creditsCache.update((cur) => {
      const have = new Set(cur.credits.map((r) => r.recoId))
      for (const r of newRecords) if (!have.has(r.recoId)) cur.credits.push(r)
      return cur
    })
    await importCreditCache.update((cur) => {
      cur.credited = [...new Set([...cur.credited, ...newRecords.map((r) => r.recoId)])]
      return cur
    })
    for (const r of newRecords) console.log(`[scouts] ${r.kind} credit → ${r.friend} (${r.label})`)
    return newRecords.length
  } catch (err) {
    console.warn('[scouts] import sweep failed:', err instanceof Error ? err.message : err)
    return 0
  }
}
