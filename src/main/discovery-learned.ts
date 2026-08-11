/**
 * "What I've learned" — the brain, made falsifiable.
 *
 * Jake, 2026-08-09, on Discovery: "hard to know if you are actually learning
 * my tastes or not based on what is recommended."
 *
 * He was right to doubt it. Reading his actual ledger: 1,942 entries, of which
 * 1,840 are "pass" (scrolled by), 101 "accept" and exactly ONE "reject" — and
 * only 20 of the 1,942 came from Discovery at all. The nightly learner was
 * nudging weights ±5% off evidence like {accepts: 3, passes: 760}.
 *
 * So the honest answer is not "here is what I know about you", it is "I have
 * barely been taught anything, and here is exactly how much". A recommender
 * that cannot say that is asking to be trusted on faith.
 *
 * Three rules this summary follows:
 *  1. It states VOLUME before conclusions. A claim drawn from four signals is
 *     labelled as such rather than dressed up.
 *  2. It only reports what the ledger can support. Lane accept/reject counts
 *     are real; "shown" counts are not recorded per lane for Discovery, so
 *     they are not invented.
 *  3. Everything is phrased so Jake can contradict it. A wrong claim he
 *     corrects is worth more than a vague one he ignores — a correction is
 *     the highest-quality signal this thing can receive, and right now it
 *     receives almost none.
 *
 * Pure and fs-free so the tests bind to production code.
 */

export interface LedgerRow {
  ts?: string
  surface?: string
  verdict?: string
  key?: { artist?: string; title?: string; trackId?: number; playlistId?: string }
  ctx?: { lane?: string }
}

export interface LearnedLane {
  lane: string
  accepts: number
  rejects: number
}

export interface LearnedSummary {
  /** Discovery only — the strip's signals are a different surface. */
  discoverSignals: number
  accepts: number
  rejects: number
  /** Every surface, for context on where the app IS being taught. */
  totalSignals: number
  stripSignals: number
  lanes: LearnedLane[]
  stoppedShowing: Array<{ artist: string; at: number }>
  /** How much this should be trusted, and the sentence to show for it. */
  confidence: 'none' | 'thin' | 'growing' | 'solid'
  headline: string
  /** ISO string from the nightly weight learner, when it last ran. */
  learnedAt?: string
  daysCovered: number
}

/** Volume thresholds. Deliberately demanding: a recommender that claims to
 *  know someone from twenty signals is the reason people distrust them. */
function confidenceFor(signals: number, rejects: number): LearnedSummary['confidence'] {
  if (signals < 10) return 'none'
  if (signals < 60 || rejects < 5) return 'thin'
  if (signals < 200) return 'growing'
  return 'solid'
}

function headlineFor(c: LearnedSummary['confidence'], signals: number, rejects: number): string {
  switch (c) {
    case 'none':
      return `I don't know your taste yet — ${signals} signal${signals === 1 ? '' : 's'} from this page so far.`
    case 'thin':
      return rejects < 5
        ? `${signals} signals, but only ${rejects} "not for me". Telling me what you DON'T want teaches me fastest.`
        : `${signals} signals — enough to guess, not enough to be confident.`
    case 'growing':
      return `${signals} signals. I'm starting to see a shape. Correct me where I'm wrong.`
    default:
      return `${signals} signals. I have a solid read — hold me to it.`
  }
}

export function summariseLearning(
  rows: LedgerRow[],
  notForMe: Record<string, { artist?: string; at?: number }>,
  weightsUpdatedAt?: string,
  now: number = 0,
): LearnedSummary {
  const discover = rows.filter((r) => r.surface === 'discover')
  const strip = rows.filter((r) => r.surface === 'strip')
  const accepts = discover.filter((r) => r.verdict === 'accept').length
  const rejects = discover.filter((r) => r.verdict === 'reject').length

  const laneMap = new Map<string, LearnedLane>()
  for (const r of discover) {
    const lane = r.ctx?.lane
    if (!lane) continue
    const e = laneMap.get(lane) ?? { lane, accepts: 0, rejects: 0 }
    if (r.verdict === 'accept') e.accepts++
    else if (r.verdict === 'reject') e.rejects++
    laneMap.set(lane, e)
  }
  const lanes = [...laneMap.values()].sort((a, b) => (b.accepts + b.rejects) - (a.accepts + a.rejects))

  const stoppedShowing = Object.values(notForMe || {})
    .filter((v) => v && v.artist)
    .map((v) => ({ artist: String(v.artist), at: Number(v.at) || 0 }))
    .sort((a, b) => b.at - a.at)

  const stamps = rows.map((r) => Date.parse(r.ts || '')).filter((n) => Number.isFinite(n))
  const oldest = stamps.length ? Math.min(...stamps) : 0
  const end = now || (stamps.length ? Math.max(...stamps) : 0)
  const daysCovered = oldest && end > oldest ? Math.max(1, Math.round((end - oldest) / 86_400_000)) : 0

  const confidence = confidenceFor(discover.length, rejects)
  return {
    discoverSignals: discover.length,
    accepts,
    rejects,
    totalSignals: rows.length,
    stripSignals: strip.length,
    lanes,
    stoppedShowing,
    confidence,
    headline: headlineFor(confidence, discover.length, rejects),
    learnedAt: weightsUpdatedAt,
    daysCovered,
  }
}
