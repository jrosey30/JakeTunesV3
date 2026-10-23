/**
 * Top 1000 Quiz client (2026-10-23) — the desktop's half of homemini's
 * /api/top1000 (contract: common/top1000-doc.ts). No caching: every question
 * depends on the answers before it, and an answer must reach homemini or be
 * reported as not saved. Pure of electron — fetch is injected so it runs under
 * node:test (__tests__/top1000-client.test.ts).
 */
import { withCompanionInit } from './hub-companion.ts'
import {
  parseProgress, parseQuizList, parseQuizNext, parseQuizUndo,
  type QuizAnswerInput, type QuizListEntry, type QuizNext, type QuizProgress, type QuizUndo,
} from '../common/top1000-doc.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown> }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export interface Top1000ClientOptions {
  baseUrl: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  warn?: (msg: string) => void
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const OFFLINE = 'homemini isn’t answering, so the quiz can’t ask right now.'

export function createTop1000Client(opts: Top1000ClientOptions) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 15_000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/top1000`

  async function call(path: string, init: Record<string, unknown>): Promise<{ status: number; body: unknown } | null> {
    try {
      const res = await fetchImpl(`${base}${path}`, withCompanionInit({ ...init, signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
      return { status: res.status, body: await res.json().catch(() => null) }
    } catch (err) {
      warn(`[top1000] ${path || '/'} failed: ${(err as Error)?.message ?? err}`)
      return null
    }
  }

  return {
    async next(): Promise<Result<QuizNext>> {
      const r = await call('/next', { method: 'GET' })
      if (!r) return { ok: false, error: OFFLINE }
      const doc = r.status === 200 ? parseQuizNext(r.body) : null
      return doc ? { ok: true, value: doc } : { ok: false, error: 'The quiz sent back something unexpected. Try again in a moment.' }
    },

    async answer(input: QuizAnswerInput): Promise<Result<QuizProgress>> {
      const r = await call('/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!r) return { ok: false, error: 'That answer wasn’t saved — homemini isn’t answering.' }
      const body = r.body as { ok?: boolean; error?: string; progress?: unknown } | null
      const progress = parseProgress(body?.progress)
      if (r.status === 200 && body?.ok && progress) return { ok: true, value: progress }
      return { ok: false, error: body?.error ? `That answer wasn’t saved: ${body.error}.` : 'That answer wasn’t saved.' }
    },

    /** Take back the last answer (repeatable). A 404 means homemini predates undo. */
    async undo(): Promise<Result<QuizUndo>> {
      const r = await call('/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!r) return { ok: false, error: 'Nothing was undone — homemini isn’t answering.' }
      if (r.status === 404) return { ok: false, error: 'Undo isn’t available yet.' }
      const doc = r.status === 200 ? parseQuizUndo(r.body) : null
      if (doc) return { ok: true, value: doc }
      const err = (r.body as { error?: unknown } | null)?.error
      return { ok: false, error: typeof err === 'string' ? `Nothing was undone: ${err}.` : 'Nothing was undone.' }
    },

    async list(): Promise<Result<{ progress: QuizProgress; list: QuizListEntry[] }>> {
      const r = await call('', { method: 'GET' })
      if (!r) return { ok: false, error: OFFLINE }
      const doc = r.status === 200 ? parseQuizList(r.body) : null
      return doc ? { ok: true, value: doc } : { ok: false, error: 'The Top 1000 list came back unreadable.' }
    },
  }
}
