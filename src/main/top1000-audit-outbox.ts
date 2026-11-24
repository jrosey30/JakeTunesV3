/**
 * The Top 1000 blind check (2026-11-24) — the desktop's client for homemini's
 * /api/top1000/audit (contract: common/top1000-audit-doc.ts), with its answers
 * kept on this Mac's disk first.
 *
 * The same rule as every write the desktop makes to homemini (the iPod
 * playlists' outbox, Headline…): an answer is on disk
 * (top1000-audit-pending.json) before homemini is asked, so no signal never
 * loses one. They go in the order given, one at a time:
 *   - 200: homemini has it; it leaves the file.
 *   - 409: not due (answered already, or not this question's turn). Final: it
 *     leaves the file and is never sent again.
 *   - 404 { off: true }: the check is off. Nothing waiting can land; all of it
 *     leaves the file.
 *   - 400: homemini refused it. Final, logged.
 *   - anything else (no answer, 5xx, a proxy's page): it stays, and the rest
 *     wait behind it for the next /next, the next answer, or the 5-minute retry.
 * The waiting file is only changed under one lock, read and written in one
 * turn, through writeJsonAtomic. One send at a time.
 *
 * Questions are never kept: each one depends on the answers before it. The
 * renderer never sees the companion token (withCompanionInit, here in main).
 * Deps injected so node --test runs it against a fake homemini.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withLocalLock } from './hub-local-state.ts'
import { withCompanionInit } from './hub-companion.ts'
import type { FetchLike } from './top1000-client.ts'
import {
  foldWaiting, isAuditChoice, isAuditQid, parseAuditNext, parseAuditProgress,
  type AuditChoice, type AuditProgress, type AuditState,
} from '../common/top1000-audit-doc.ts'

export const AUDIT_PENDING_FILE = 'top1000-audit-pending.json'
/** How often answers homemini hasn't heard are tried again. */
export const AUDIT_RETRY_MS = 5 * 60_000

export interface PendingAuditAnswer { qid: string | number; choice: AuditChoice; at: string }
interface PendingDoc { version: 1; answers: PendingAuditAnswer[] }

export type AuditResult<T> = { ok: true; value: T } | { ok: false; error: string }
export type AuditNextValue = AuditState & { waiting: number }
export interface AuditAnswerValue { progress: AuditProgress | null; waiting: number }

/** What one POST's answer means for the waiting file. */
export type SendOutcome =
  | { kind: 'sent'; progress: AuditProgress | null }
  | { kind: 'not-due' }
  | { kind: 'off' }
  | { kind: 'refused'; error: string }
  | { kind: 'retry' }

export function sendOutcome(status: number, body: unknown): SendOutcome {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : null
  if (status === 200 && b?.ok === true) return { kind: 'sent', progress: parseAuditProgress(b.progress) }
  if (status === 409 && b) return { kind: 'not-due' }
  if (status === 404 && b?.off === true) return { kind: 'off' }
  if (status === 400 && b) return { kind: 'refused', error: typeof b.error === 'string' ? b.error : 'bad request' }
  return { kind: 'retry' }
}

export function parsePendingDoc(raw: unknown): PendingDoc {
  const doc = raw as { version?: unknown; answers?: unknown } | null
  const out: PendingDoc = { version: 1, answers: [] }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.answers)) return out
  for (const a of doc.answers as Array<Record<string, unknown> | null>) {
    if (!a || !isAuditQid(a.qid) || !isAuditChoice(a.choice)) continue
    out.answers.push({ qid: a.qid, choice: a.choice, at: String(a.at ?? '') })
  }
  return out
}

const OFFLINE = 'homemini isn’t answering right now.'
const OFFLINE_SAVED = 'homemini isn’t answering right now. Your answers are saved and go when it’s back.'

export interface Top1000AuditOptions {
  baseUrl: string
  stateDir: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: () => Date
  warn?: (msg: string) => void
}

export function createTop1000Audit(opts: Top1000AuditOptions) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 10_000
  const now = opts.now ?? (() => new Date())
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/top1000/audit`
  const file = join(opts.stateDir, AUDIT_PENDING_FILE)
  const fileLock = `top1000-audit-file:${opts.stateDir}`
  const sendLock = `top1000-audit-send:${opts.stateDir}`
  /** homemini's last word on progress (memory only: it's homemini's number). */
  let lastProgress: AuditProgress | null = null

  async function readDoc(): Promise<PendingDoc> {
    try {
      return parsePendingDoc(JSON.parse(await readFile(file, 'utf-8')))
    } catch {
      // No file yet: nothing is waiting.
      return { version: 1, answers: [] }
    }
  }

  function editDoc<T>(edit: (doc: PendingDoc) => T): Promise<T> {
    return withLocalLock(fileLock, async () => {
      const doc = await readDoc()
      const before = JSON.stringify(doc)
      const answer = edit(doc)
      if (JSON.stringify(doc) !== before) await writeJsonAtomic(file, doc)
      return answer
    })
  }

  const pending = (): Promise<PendingAuditAnswer[]> => withLocalLock(fileLock, async () => (await readDoc()).answers)

  async function post(a: PendingAuditAnswer): Promise<SendOutcome> {
    try {
      const res = await fetchImpl(`${base}/answer`, withCompanionInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qid: a.qid, choice: a.choice }),
        signal: AbortSignal.timeout(timeoutMs),
      }) as Record<string, unknown>)
      const out = sendOutcome(res.status, await res.json().catch(() => null))
      if (out.kind === 'retry') warn(`[top1000-audit] answer: homemini answered ${res.status}; it waits`)
      return out
    } catch (err) {
      warn(`[top1000-audit] answer not sent (${(err as Error)?.message ?? err}); it waits`)
      return { kind: 'retry' }
    }
  }

  /** Send what is waiting, oldest first, until homemini stops answering. Returns how many still wait. */
  function flush(): Promise<number> {
    return withLocalLock(sendLock, async () => {
      for (;;) {
        const head = (await pending())[0]
        if (!head) return 0
        const out = await post(head)
        if (out.kind === 'retry') return (await pending()).length
        if (out.kind === 'refused') warn(`[top1000-audit] homemini refused an answer: ${out.error}`)
        if (out.kind === 'sent' && out.progress) lastProgress = out.progress
        try {
          await editDoc((doc) => {
            if (out.kind === 'off') { doc.answers = []; return }
            const i = doc.answers.findIndex((x) => x.qid === head.qid && x.at === head.at)
            if (i >= 0) doc.answers.splice(i, 1)
          })
        } catch (err) {
          // Left in the file: the next turn sends it again and homemini's 409 clears it.
          warn(`[top1000-audit] could not clear a sent answer: ${(err as Error)?.message ?? err}`)
          return (await pending()).length
        }
      }
    })
  }

  return {
    flush,

    async next(): Promise<AuditResult<AuditNextValue>> {
      const waiting = await flush()
      let status: number
      let body: unknown
      try {
        const res = await fetchImpl(`${base}/next`, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        status = res.status
        body = await res.json().catch(() => null)
      } catch (err) {
        warn(`[top1000-audit] /next failed: ${(err as Error)?.message ?? err}`)
        return { ok: false, error: waiting > 0 ? OFFLINE_SAVED : OFFLINE }
      }
      // An older homemini has no blind check: the same as off.
      if (status === 404) return { ok: true, value: { kind: 'off', waiting } }
      const state = status === 200 ? parseAuditNext(body) : null
      if (!state) return { ok: false, error: 'The blind check sent back something unexpected. Try again in a moment.' }
      if (state.kind === 'off') return { ok: true, value: { ...state, waiting } }
      if (state.progress) lastProgress = state.progress
      if (state.kind === 'ask' && (await pending()).some((p) => p.qid === state.question.qid)) {
        return { ok: false, error: 'Still sending your last answer. Try again in a moment.' }
      }
      if (state.kind === 'done') return { ok: true, value: { ...state, progress: state.progress ? foldWaiting(state.progress, waiting) : null, waiting } }
      return { ok: true, value: { ...state, progress: foldWaiting(state.progress, waiting), waiting } }
    },

    /** On disk first, then sent. ok means it is kept; `waiting` says how many homemini hasn't heard. */
    async answer(input: { qid: unknown; choice: unknown }): Promise<AuditResult<AuditAnswerValue>> {
      const { qid, choice } = input
      if (!isAuditQid(qid) || !isAuditChoice(choice)) return { ok: false, error: 'That answer was incomplete.' }
      try {
        await editDoc((doc) => {
          // Twice for one question is one answer: the first stands.
          if (!doc.answers.some((a) => a.qid === qid)) doc.answers.push({ qid, choice, at: now().toISOString() })
        })
      } catch (err) {
        warn(`[top1000-audit] could not keep an answer: ${(err as Error)?.message ?? err}`)
        return { ok: false, error: 'That answer wasn’t saved. Try again.' }
      }
      const waiting = await flush()
      return { ok: true, value: { progress: lastProgress ? foldWaiting(lastProgress, waiting) : null, waiting } }
    },
  }
}
