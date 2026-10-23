/**
 * The Top 1000 Quiz wire contract (2026-10-23) — what homemini serves:
 *
 *   GET  /api/top1000/next   → { question: { kind, songs: [{ track, hookMs }] } | null, progress }
 *   POST /api/top1000/answer { kind, ids, choice, reasons? } → { ok, progress }
 *   GET  /api/top1000        → { version: 1, progress, list: [{ id, rank, pIn }] }
 *
 * The model, the question picking and the answers file all live on homemini
 * (JakeTunesMobile backend/src/util/top1000.ts + routes/top1000.ts); the
 * desktop only asks and draws. Pure — node --test loads it.
 */

export type QuizKind = 'pick' | 'inout' | 'still' | 'best'

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

export interface QuizQuestion { kind: QuizKind; songs: QuizSongRef[] }
export interface QuizProgress { answered: number; settled: number; moving: number }
export interface QuizNext { question: QuizQuestion | null; progress: QuizProgress }

const KINDS = new Set<QuizKind>(['pick', 'inout', 'still', 'best'])
const SIZE: Record<QuizKind, number> = { pick: 2, inout: 1, still: 1, best: 3 }

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
  return { answered, settled, moving }
}

export function parseQuizNext(raw: unknown): QuizNext | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const progress = parseProgress(r.progress)
  if (!progress) return null
  if (r.question === null) return { question: null, progress }
  const q = r.question as Record<string, unknown> | undefined
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
  if (songs.length !== SIZE[kind]) return null
  return { question: { kind, songs }, progress }
}

/** The choices each kind accepts, besides a song id (pick / best). */
export type QuizChoice = string

export interface QuizAnswerInput {
  kind: QuizKind
  ids: string[]
  choice: QuizChoice
  reasons?: QuizReason[]
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
