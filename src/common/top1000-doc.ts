/**
 * The Top 1000 Quiz wire contract (2026-10-23) — what homemini serves:
 *
 *   GET  /api/top1000/next?mode=tournament → { question: { kind, songs: [{ track, hookMs }], quota? } | null, progress }
 *   POST /api/top1000/answer { kind, ids, choice, reasons?, picked?, quota? } → { ok, progress }
 *   POST /api/top1000/undo   {} → { ok, undone: { kind, ids, choice } | null, question | null, progress }
 *   GET  /api/top1000        → { version: 1, progress, list: [{ id, rank, pIn }] }
 *
 * The model, the question picking and the answers file all live on homemini
 * (JakeTunesMobile backend/src/util/top1000.ts + routes/top1000.ts); the
 * desktop only asks and draws. Pure — node --test loads it.
 */

/** heat = pick the `quota` songs that make the 1000; duel = a tough call, one on one (homemini ≥ #594). */
export type QuizKind = 'pick' | 'inout' | 'still' | 'best' | 'heat' | 'duel'

export const QUIZ_REASONS = [
  { id: 'voice', label: 'The voice' },
  { id: 'hook', label: 'The hook' },
  { id: 'riff', label: 'The riff' },
  { id: 'lyrics', label: 'The lyrics' },
  { id: 'mood', label: 'The mood' },
  { id: 'memory', label: 'A memory' },
  { id: 'production', label: 'The production' },
  { id: 'energy', label: 'The energy' },
] as const
export type QuizReason = typeof QUIZ_REASONS[number]['id']

export interface QuizSongRef {
  id: number
  title: string
  artist: string
  album: string
  hookMs: number
}

export interface QuizQuestion {
  kind: QuizKind
  songs: QuizSongRef[]
  quota?: number
  /** after the finish line (homemini, 2026-10-27): a genre bracket's question (`bracket` = the genre),
   *  or a champions' final between two genres (`brackets` = each song's genre, in `songs` order) */
  stage?: 'bracket' | 'final'
  bracket?: string
  brackets?: string[]
}
export interface QuizProgress {
  answered: number
  settled: number
  moving: number
  /** seats held by the locked albums and pinned lists (homemini ≥ #593) */
  fixed?: number
  /** songs without a seat that could still win one (homemini ≥ #593) */
  contenders?: number
  /** the tournament (homemini ≥ #594): the round and what is left of it */
  round?: number
  heatsLeft?: number
  duelsLeft?: number
  /** the finish line (homemini, 2026-10-23 late): rounds before the 1000 is set, how far through this
   *  round (0–1, only forward), songs knocked out, how sure the brain is of the 1000 (0–1) */
  totalRounds?: number
  roundDone?: number
  out?: number
  sure?: number
  /** the genre brackets (homemini, 2026-10-27): the tour of the genres — which bracket is up, of
   *  how many — then the finals and how many champions' duels are left */
  stage?: 'brackets' | 'finals'
  bracket?: { name: string; index: number; total: number }
  finalsLeft?: number
}
export interface QuizNext { question: QuizQuestion | null; progress: QuizProgress }

const KINDS = new Set<QuizKind>(['pick', 'inout', 'still', 'best', 'heat', 'duel'])
const SIZE: Record<Exclude<QuizKind, 'heat'>, number> = { pick: 2, inout: 1, still: 1, best: 3, duel: 2 }
const HEAT_MIN = 3
const HEAT_MAX = 6

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function parseProgress(raw: unknown): QuizProgress | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const answered = num(r.answered)
  const settled = num(r.settled)
  const moving = num(r.moving)
  if (answered === null || settled === null || moving === null) return null
  const out: QuizProgress = { answered, settled, moving }
  for (const k of ['fixed', 'contenders', 'round', 'heatsLeft', 'duelsLeft', 'totalRounds', 'roundDone', 'out', 'sure', 'finalsLeft'] as const) {
    const v = num(r[k])
    if (v !== null) out[k] = v
  }
  if (r.stage === 'brackets' || r.stage === 'finals') out.stage = r.stage
  const b = r.bracket as Record<string, unknown> | undefined
  if (b && typeof b === 'object' && typeof b.name === 'string' && b.name) {
    const index = num(b.index)
    const total = num(b.total)
    if (index !== null && total !== null) out.bracket = { name: b.name, index, total }
  }
  return out
}

/** One question in /next's shape; null when it is malformed. */
function parseQuestion(raw: unknown): QuizQuestion | null {
  const q = raw as Record<string, unknown> | undefined
  if (!q || !KINDS.has(q.kind as QuizKind) || !Array.isArray(q.songs)) return null
  const kind = q.kind as QuizKind
  const songs: QuizSongRef[] = []
  for (const s of q.songs) {
    const t = (s as { track?: Record<string, unknown> })?.track
    const id = num(t?.id)
    if (!t || id === null) return null
    songs.push({
      id,
      title: String(t.title ?? ''),
      artist: String(t.artist ?? ''),
      album: String(t.album ?? ''),
      hookMs: Math.max(0, num((s as { hookMs?: unknown }).hookMs) ?? 0),
    })
  }
  // The genre brackets (homemini, 2026-10-27): which bracket a question belongs to, or the two
  // genres of a final (one per song, in order — dropped if they don't line up with the songs).
  const stage: QuizQuestion['stage'] = q.stage === 'bracket' || q.stage === 'final' ? q.stage : undefined
  const bracket = typeof q.bracket === 'string' && q.bracket ? q.bracket : undefined
  const brackets = Array.isArray(q.brackets) && q.brackets.length === songs.length && q.brackets.every((x) => typeof x === 'string' && x)
    ? (q.brackets as string[]) : undefined
  const genre = { ...(stage ? { stage } : {}), ...(bracket ? { bracket } : {}), ...(brackets ? { brackets } : {}) }
  if (kind === 'heat') {
    const quota = num(q.quota)
    if (songs.length < HEAT_MIN || songs.length > HEAT_MAX || quota === null || quota < 1 || quota >= songs.length) return null
    return { kind, songs, quota, ...genre }
  }
  if (songs.length !== SIZE[kind]) return null
  return { kind, songs, ...genre }
}

export function parseQuizNext(raw: unknown): QuizNext | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const progress = parseProgress(r.progress)
  if (!progress) return null
  if (r.question === null) return { question: null, progress }
  const question = parseQuestion(r.question)
  return question ? { question, progress } : null
}

/** The answer an undo took back. */
export interface QuizUndone { kind: QuizKind; ids: string[]; choice: string }
/**
 * What undo returns. `question` is the undone question, asked again; both are
 * null when there is nothing left to undo.
 */
export interface QuizUndo { undone: QuizUndone | null; question: QuizQuestion | null; progress: QuizProgress }

export function parseQuizUndo(raw: unknown): QuizUndo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const progress = parseProgress(r.progress)
  if (!progress || r.ok !== true) return null
  if (r.undone === null || r.undone === undefined) return { undone: null, question: null, progress }
  const u = r.undone as Record<string, unknown>
  if (!KINDS.has(u.kind as QuizKind) || !Array.isArray(u.ids) || typeof u.choice !== 'string') return null
  const undone: QuizUndone = { kind: u.kind as QuizKind, ids: u.ids.map(String), choice: u.choice }
  if (r.question === null || r.question === undefined) return { undone, question: null, progress }
  const question = parseQuestion(r.question)
  return question ? { undone, question, progress } : null
}

/** The choices each kind accepts, besides a song id (pick / best). */
export type QuizChoice = string

export interface QuizAnswerInput {
  kind: QuizKind
  ids: string[]
  choice: QuizChoice
  reasons?: QuizReason[]
  /** heat: the songs he picked (exactly `quota` of them) */
  picked?: string[]
  quota?: number
}

export interface QuizListEntry { id: number; rank: number; pIn: number }

export function parseQuizList(raw: unknown): { progress: QuizProgress; list: QuizListEntry[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const progress = parseProgress(r.progress)
  if (!progress || !Array.isArray(r.list)) return null
  const list: QuizListEntry[] = []
  for (const e of r.list) {
    const id = num((e as { id?: unknown })?.id)
    const rank = num((e as { rank?: unknown })?.rank)
    const pIn = num((e as { pIn?: unknown })?.pIn)
    if (id === null || rank === null || pIn === null) continue
    list.push({ id, rank, pIn })
  }
  return { progress, list }
}
