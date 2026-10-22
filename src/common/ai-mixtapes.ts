/**
 * Daily AI tapes on the desktop (2026-10-22, parity gap #9) — the phone's
 * Home rail of today's tapes, Keep, and the tapes Keep sends to the shelf.
 *
 * homemini mints each day's mixes into AI MIXTAPES (Mobile Brief 133: one
 * side, ≤25 songs, one song per artist, mix order kept). A new day's mint
 * replaces every UNKEPT tape; a kept tape is permanent. Both devices read the
 * same store (GET /api/mixtapes) and flip the same flag
 * (POST /api/mixtapes/ai/:id/keep), so a Keep on either one shows on both.
 *
 * Only the AI tapes are taken from that reply. The rest of it is this Mac's
 * own mixtapes.json, published to the NAS for the phone — the desktop already
 * has those from its own file, and drawing them twice would double the shelf.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/MixesSection.swift `dailyTapes`
 *   (the rail = AI tapes not kept) and MixtapesCollectionView.swift `kept`
 *   (the shelf's KEPT FROM THE DAILIES band). Same two filters, same order.
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/aiMixtapes.ts `loadAiMixtapes` —
 *   the wire shape parsed here (`source: 'ai'`, `kept`, one side of tracks).
 */

export interface AiMixtape {
  id: string
  title: string
  commentary: string
  createdAt: string
  kept: boolean
  /** The tape in play order. One side, no cuts: an AI tape just plays through. */
  trackIds: number[]
}

export type AiMixtapesSource = 'homemini' | 'cache' | 'none'

/** What main hands the renderer (src/main/ai-mixtapes-client.ts). */
export interface AiMixtapesState {
  tapes: AiMixtape[]
  source: AiMixtapesSource
  /** null until the first GET has answered (or failed) this session. */
  reachable: boolean | null
}

interface WireSide { tracks?: Array<{ id?: unknown }> }
interface WireTape {
  id?: unknown
  title?: unknown
  commentary?: unknown
  createdAt?: unknown
  source?: unknown
  kept?: unknown
  sides?: WireSide[]
}

/**
 * The AI tapes in a GET /api/mixtapes reply, in the order homemini sent them
 * (newest first). null when the reply is not that document at all (HTML from
 * a proxy, an error body), so a bad answer never replaces a good cache. An
 * empty list is a real answer: every tape rolled over or there are none yet.
 */
export function parseAiMixtapes(body: unknown): AiMixtape[] | null {
  if (!body || typeof body !== 'object') return null
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const out: AiMixtape[] = []
  const seen = new Set<string>()
  for (const raw of items as WireTape[]) {
    if (!raw || typeof raw !== 'object' || raw.source !== 'ai') continue
    if (typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) continue
    const trackIds: number[] = []
    for (const side of Array.isArray(raw.sides) ? raw.sides : []) {
      for (const t of Array.isArray(side?.tracks) ? side.tracks : []) {
        const id = Number(t?.id)
        if (Number.isFinite(id) && id > 0) trackIds.push(id)
      }
    }
    if (trackIds.length === 0) continue
    seen.add(raw.id)
    out.push({
      id: raw.id,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Mixtape',
      commentary: typeof raw.commentary === 'string' ? raw.commentary : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      kept: raw.kept === true,
      trackIds,
    })
  }
  return out
}

/** Home's rail: today's batch, the disposable tapes (phone `dailyTapes`). */
export function dailyAiTapes(all: readonly AiMixtape[]): AiMixtape[] {
  return all.filter((t) => !t.kept)
}

/** The shelf's kept tapes: daily tapes made permanent by Keep (phone `kept`). */
export function keptAiTapes(all: readonly AiMixtape[]): AiMixtape[] {
  return all.filter((t) => t.kept)
}

/** The list with one tape's Keep flag set (the optimistic flip and its undo). */
export function withAiTapeKept(all: readonly AiMixtape[], id: string, kept: boolean): AiMixtape[] {
  return all.map((t) => (t.id === id && t.kept !== kept ? { ...t, kept } : t))
}

/** The keep route for one tape (phone `LibraryAPI.keepAiMixtape`). */
export function aiTapeKeepPath(id: string): string {
  return `/api/mixtapes/ai/${encodeURIComponent(id)}/keep`
}
