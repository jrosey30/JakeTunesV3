/**
 * Boom Phase 2 HTTP + SSE client (main process).
 *
 * Opt-in via app-settings.json:
 *   { "library": { "boomUrl": "http://homemini:3001" } }
 * or env BOOM_URL.
 *
 * Dual-write bridge: local library.json remains the working cache until
 * full renderer cutover; this client publishes mutations and applies
 * remote SSE into the cache.
 */

import { createParser, type EventSourceParser } from './sse-parse.ts'
import type { BoomEvent, BoomLibrarySnapshot, BoomTrack, BoomPlaylist } from './apply-remote.ts'

export interface BoomClientOptions {
  baseUrl: string
  /** Optional fetch impl (tests). */
  fetch?: typeof fetch
}

export function normalizeBoomUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export function isBoomEnabled(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim())
}

export class BoomClient {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: BoomClientOptions) {
    this.baseUrl = normalizeBoomUrl(opts.baseUrl)
    this.fetchImpl = opts.fetch ?? fetch
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  async health(): Promise<{ ok: boolean; latestEventId?: number }> {
    const res = await this.fetchImpl(this.url('/healthz'), { method: 'GET' })
    if (!res.ok) return { ok: false }
    return (await res.json()) as { ok: boolean; latestEventId?: number }
  }

  async fetchLibrary(): Promise<BoomLibrarySnapshot> {
    const res = await this.fetchImpl(this.url('/api/library'))
    if (!res.ok) throw new Error(`boom library ${res.status}`)
    return (await res.json()) as BoomLibrarySnapshot
  }

  async upsertTrack(track: BoomTrack): Promise<{ ok: boolean; etag: number; track: BoomTrack }> {
    const body = { ...track }
    delete body._etag
    const res = await this.fetchImpl(this.url('/api/tracks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: body }),
    })
    if (!res.ok) throw new Error(`boom upsert track ${res.status}`)
    return (await res.json()) as { ok: boolean; etag: number; track: BoomTrack }
  }

  async patchTrack(
    trackId: number,
    fields: Record<string, unknown>,
    opts?: { etag?: number; increment?: Record<string, number> },
  ): Promise<{ ok: boolean; status: number; track?: BoomTrack; etag?: number; error?: string }> {
    const res = await this.fetchImpl(this.url(`/api/tracks/${trackId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields,
        etag: opts?.etag,
        increment: opts?.increment,
      }),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        track: json.track as BoomTrack | undefined,
        etag: json.etag as number | undefined,
      }
    }
    return {
      ok: true,
      status: res.status,
      track: json.track as BoomTrack,
      etag: json.etag as number,
    }
  }

  async deleteTrack(trackId: number): Promise<void> {
    const res = await this.fetchImpl(this.url(`/api/tracks/${trackId}`), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`boom delete track ${res.status}`)
  }

  async upsertPlaylist(playlist: BoomPlaylist): Promise<{ ok: boolean; etag: number }> {
    const body = { ...playlist }
    delete body._etag
    const res = await this.fetchImpl(this.url('/api/playlists'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlist: body }),
    })
    if (!res.ok) throw new Error(`boom upsert playlist ${res.status}`)
    return (await res.json()) as { ok: boolean; etag: number }
  }

  async importLibrary(library: { tracks: unknown[]; playlists?: unknown[] }): Promise<void> {
    const res = await this.fetchImpl(this.url('/api/import'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library }),
    })
    if (!res.ok) throw new Error(`boom import ${res.status}`)
  }

  /**
   * Open SSE `/api/events`. Calls onEvent for each parsed event.
   * Returns an abort handle. Reconnect is the caller's responsibility.
   */
  async subscribeEvents(
    lastEventId: number,
    onEvent: (ev: BoomEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await this.fetchImpl(
      this.url(`/api/events?lastEventId=${encodeURIComponent(String(lastEventId))}`),
      {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(lastEventId > 0 ? { 'Last-Event-ID': String(lastEventId) } : {}),
        },
        signal,
      },
    )
    if (res.status === 409) {
      const detail = await res.json().catch(() => ({}))
      throw Object.assign(new Error('snapshot-recommended'), { code: 'snapshot-recommended', detail })
    }
    if (!res.ok || !res.body) throw new Error(`boom events ${res.status}`)

    const parser = createParser((ev) => {
      if (!ev.data || ev.data.startsWith(':')) return
      try {
        const parsed = JSON.parse(ev.data) as BoomEvent
        if (ev.id) parsed.id = Number(ev.id)
        if (ev.event) parsed.type = ev.event
        onEvent(parsed)
      } catch {
        /* ignore malformed */
      }
    })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
  }
}
