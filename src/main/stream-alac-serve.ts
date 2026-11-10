/**
 * Where a streamed ALAC song's bytes come from when it is played (2026-11-10).
 *
 * Until now: download the whole original from homemini, decode it here, and
 * only then send the player its first byte (stream-alac-cache.ts). On a quiet
 * LAN that is about a second. On 2026-11-10 13:22-13:26Z, with homemini busy,
 * the downloads ran at 6 to 20 Mbit/s and Jake waited 7 to 31 s a song.
 *
 * Now, in this order:
 *   1. the decoded copy already on this Mac: served from disk, as before;
 *   2. homemini says its FLAC copy is ready (flac-variant.ts): that copy is
 *      played straight from homemini, range by range, so the first byte comes
 *      back as soon as homemini answers, however slow the link;
 *   3. otherwise the old way (download, decode here), and homemini is asked to
 *      build its copy for next time.
 *
 * One song, one source: the two FLAC copies are different files (two ffmpegs),
 * so a song that started on one keeps to it for its later ranges. A seek never
 * lands in the other file.
 *
 * Electron-free; every effect is injected (__tests__/stream-alac-serve.test.ts).
 */

export interface StreamedAlacDeps {
  /** The decoded copy is already on this Mac. */
  cachedLocally: (id: string) => Promise<boolean>
  /** Serve from the decode cache (downloads and decodes first when it has to). */
  serveLocal: (id: string, range: string | null) => Promise<Response>
  /** homemini's FLAC copy is ready. Any doubt, any delay: false. */
  readyOnHomemini: (id: string) => Promise<boolean>
  /** homemini's `/audio/:id?fmt=flac`, or null when it didn't serve it. */
  fetchFlac: (id: string, range: string | null) => Promise<Response | null>
  /** Ask homemini to build its copy. Never awaited by a play. */
  want: (id: string) => void
  now?: () => number
  log?: (msg: string) => void
}

/** How long a song keeps to the source its first request got. */
export const SOURCE_PIN_MS = 30 * 60 * 1000

export interface StreamedAlacServer {
  serve(id: string | number, range: string | null): Promise<Response>
  /** For tests and the log: which source a song is on. */
  sourceOf(id: string | number): 'homemini' | 'local' | null
}

export function createStreamedAlacServer(deps: StreamedAlacDeps): StreamedAlacServer {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.log(m))
  const pins = new Map<string, { source: 'homemini' | 'local'; at: number }>()
  const pinned = (id: string): 'homemini' | 'local' | null => {
    const p = pins.get(id)
    if (!p) return null
    if (now() - p.at >= SOURCE_PIN_MS) { pins.delete(id); return null }
    return p.source
  }
  const pin = (id: string, source: 'homemini' | 'local'): void => {
    pins.delete(id)
    pins.set(id, { source, at: now() })
    if (pins.size > 500) pins.delete(pins.keys().next().value as string)
  }
  const local = async (id: string, range: string | null): Promise<Response> => {
    pin(id, 'local')
    return deps.serveLocal(id, range)
  }

  async function serve(rawId: string | number, range: string | null): Promise<Response> {
    const id = String(rawId)
    const was = pinned(id)
    if (was === 'local') return local(id, range)
    if (was === null) {
      if (await deps.cachedLocally(id).catch(() => false)) return local(id, range)
      if (!(await deps.readyOnHomemini(id).catch(() => false))) {
        deps.want(id)
        return local(id, range)
      }
    }
    // homemini's copy: this song's first request found it ready, or an earlier range already came from it.
    const remote = await deps.fetchFlac(id, range).catch(() => null)
    if (remote) { pin(id, 'homemini'); return remote }
    log(`[stream-alac] homemini didn't serve its FLAC copy of ${id}; decoding here instead`)
    return local(id, range)
  }

  return { serve, sourceOf: (id) => pinned(String(id)) }
}
