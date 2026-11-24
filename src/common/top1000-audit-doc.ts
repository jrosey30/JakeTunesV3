/**
 * The Top 1000 blind check (2026-11-24) — homemini's /api/top1000/audit, the
 * desktop's half. About 280 two-song questions over a few weeks, 15 a day:
 * "Which deserves a higher place on your all-time list, whatever you've
 * played lately?" Blind: the songs come with their cover, title and artist,
 * and nothing else is ever shown (no rank, plays, stars, scores, or which
 * list prefers which).
 *
 *   GET  /api/top1000/audit/next
 *        → { off?: true, done?: true, restingUntil?: ISO, progress: { answered, total, today, perDay },
 *            question?: { qid, repeat, songs: [{ track, hookMs }, { track, hookMs }] } }
 *        progress only = resting (no time given)
 *   POST /api/top1000/audit/answer { qid, choice: 'first' | 'second' | 'equal' | 'unknown' }
 *        → { ok: true, progress }; 409 = not due (final); 404 { off: true } = off
 *
 * Pure — node --test loads it (main/__tests__/top1000-audit.test.ts).
 */
import { parseQuizSongRef, type QuizSongRef } from './top1000-doc.ts'

export type AuditChoice = 'first' | 'second' | 'equal' | 'unknown'
export const AUDIT_CHOICES: readonly AuditChoice[] = ['first', 'second', 'equal', 'unknown']

export interface AuditProgress { answered: number; total: number; today: number; perDay: number }

export interface AuditQuestion {
  /** Sent back exactly as homemini gave it. */
  qid: string | number
  /** A question asked before (a consistency check). Never shown: the check stays blind. */
  repeat: boolean
  songs: [QuizSongRef, QuizSongRef]
}

export type AuditState =
  | { kind: 'off' }
  | { kind: 'done'; progress: AuditProgress | null }
  | { kind: 'resting'; until: string | null; progress: AuditProgress }
  | { kind: 'ask'; question: AuditQuestion; progress: AuditProgress }

export function isAuditChoice(v: unknown): v is AuditChoice {
  return typeof v === 'string' && (AUDIT_CHOICES as readonly string[]).includes(v)
}

export function isAuditQid(v: unknown): v is string | number {
  return (typeof v === 'string' && v.length > 0 && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v))
}

function count(v: unknown): number | null {
  const n = Number(v)
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

export function parseAuditProgress(raw: unknown): AuditProgress | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const answered = count(r.answered)
  const total = count(r.total)
  const today = count(r.today)
  const perDay = count(r.perDay)
  if (answered === null || total === null || today === null || perDay === null) return null
  return { answered, total, today, perDay }
}

function parseQuestion(raw: unknown): AuditQuestion | null {
  const q = raw as Record<string, unknown> | null
  if (!q || typeof q !== 'object' || !isAuditQid(q.qid) || !Array.isArray(q.songs) || q.songs.length !== 2) return null
  const a = parseQuizSongRef(q.songs[0])
  const b = parseQuizSongRef(q.songs[1])
  if (!a || !b || a.id === b.id) return null
  return { qid: q.qid, repeat: q.repeat === true, songs: [a, b] }
}

/** /next's answer, or null when it can't be read. */
export function parseAuditNext(raw: unknown): AuditState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.off === true) return { kind: 'off' }
  const progress = parseAuditProgress(r.progress)
  if (r.done === true) return { kind: 'done', progress }
  if (!progress) return null
  if (r.question !== undefined && r.question !== null) {
    const question = parseQuestion(r.question)
    return question ? { kind: 'ask', question, progress } : null
  }
  const until = typeof r.restingUntil === 'string' && !Number.isNaN(Date.parse(r.restingUntil)) ? r.restingUntil : null
  return { kind: 'resting', until, progress }
}

/** The keys: 1 / 2 pick, = about the same, ? don't know one of them. */
export function auditChoiceForKey(key: string): AuditChoice | null {
  switch (key) {
    case '1': return 'first'
    case '2': return 'second'
    case '=': return 'equal'
    case '?': return 'unknown'
    default: return null
  }
}

export const AUDIT_PROMPT = 'Which deserves a higher place on your all-time list, whatever you’ve played lately?'
export const AUDIT_DONE_LINE = 'All done. Thank you.'

const n = (x: number): string => x.toLocaleString('en-US')

export function auditLeftToday(p: AuditProgress): number {
  return Math.max(0, Math.min(p.perDay - p.today, p.total - p.answered))
}

/** "12 of 282 · 3 left today" */
export function auditProgressLine(p: AuditProgress): string {
  return `${n(p.answered)} of ${n(p.total)} · ${n(auditLeftToday(p))} left today`
}

/** "That's today's 15. More tomorrow." */
export function auditRestingLine(p: AuditProgress): string {
  return `That’s today’s ${n(p.perDay)}. More tomorrow.`
}

/** The button on the quiz page; null hides it (off, done, resting, nothing left today, or not known yet). */
export function auditDoorLabel(state: AuditState | null): string | null {
  if (!state || state.kind !== 'ask') return null
  const left = auditLeftToday(state.progress)
  return left > 0 ? `Blind check · ${n(left)} left today` : null
}

/** Answers on this Mac that homemini hasn't heard yet count as given. */
export function foldWaiting(p: AuditProgress, waiting: number): AuditProgress {
  if (waiting <= 0) return p
  return { ...p, answered: Math.min(p.total, p.answered + waiting), today: p.today + waiting }
}
