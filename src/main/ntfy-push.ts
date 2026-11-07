/**
 * Push to Jake's phone through ntfy (2026-11-07). The same channel as the
 * scripts' pushes (scripts/brain-watchdog.mjs pushNtfy, the install gate's
 * push): the topic lives in ~/.config/jaketunes/ntfy-topic (a bare topic or a
 * full URL), never in the repo, never in a log. Default priority. Best-effort:
 * no topic file means no push, and a failure is one log line without the topic.
 *
 * Electron-free; fetch and the topic file are injected for tests.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const NTFY_TOPIC_FILE = join(homedir(), '.config', 'jaketunes', 'ntfy-topic')

export type NtfyFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>

export interface NtfyOptions {
  topicFile?: string
  fetchImpl?: NtfyFetch
  log?: (msg: string) => void
}

export type NtfyOutcome = 'sent' | 'no-topic' | 'failed'

/** ntfy's Title header is ASCII only (the scripts strip the rest the same way). */
export function ntfyTitle(title: string): string {
  return title.replace(/[^\x20-\x7E]/g, '').trim() || 'JakeTunes'
}

export function ntfyUrl(topic: string): string {
  return topic.startsWith('http') ? topic : `https://ntfy.sh/${topic}`
}

export async function pushNtfy(msg: { title: string; body: string }, opts: NtfyOptions = {}): Promise<NtfyOutcome> {
  const log = opts.log ?? ((m: string) => console.warn(m))
  let topic = ''
  try { topic = (await readFile(opts.topicFile ?? NTFY_TOPIC_FILE, 'utf-8')).trim() } catch { return 'no-topic' }
  if (!topic) return 'no-topic'
  const doFetch = opts.fetchImpl ?? (fetch as unknown as NtfyFetch)
  try {
    const res = await doFetch(ntfyUrl(topic), {
      method: 'POST',
      headers: { Title: ntfyTitle(msg.title) },
      body: msg.body,
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) return 'sent'
    log(`[ntfy] push refused: HTTP ${res.status}`)
    return 'failed'
  } catch (err) {
    log(`[ntfy] push failed: ${(err as Error)?.name ?? 'error'}`)   // never the message: it can carry the URL
    return 'failed'
  }
}
