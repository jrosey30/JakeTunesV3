/**
 * Artist profiles in the renderer's memory (2026-11-10) — what makes the
 * cached profile available on the artist page's FIRST frame.
 *
 * Main owns the network and the disk cache (main/artist-profile-client.ts).
 * Until now the page asked main for the cached copy after its first paint, so
 * the eyebrow, the one-liner, About, the facts and the whole Members section
 * arrived a few frames late and pushed the Discography down — on every first
 * visit after a launch. Now:
 *
 *   seed()   — at boot main hands over every cached profile (artistPageSeed.ts).
 *              With a complete seed, "not in the store" MEANS "not cached", so
 *              the page knows that on its first frame too.
 *   peek()   — synchronous: what is known right now. Never waits on anything.
 *   open()   — the refresh behind it: the cached copy (only if not known),
 *              then homemini. Slow or unreachable, it changes nothing on screen
 *              until it answers; the first frame never waits for it.
 *   apply()  — main's push when a photo of a profile lands, and Jake's own
 *              member photo.
 *
 * No React here: the hook (artistProfile.ts) is a thin subscription, and
 * node --test drives this against a stubbed slow main.
 */
import { emptyProfileState, type ArtistProfileState } from '../common/artist-profile.ts'

export interface ProfileEntry {
  key: string
  state: ArtistProfileState
  /** The cached copy has been read (or there is none): fallbacks may be planned. */
  cacheRead: boolean
  /** homemini has answered (or failed to) at least once this session. */
  settled: boolean
}

type Reply = { ok: boolean; state?: ArtistProfileState } | undefined
export interface ProfileApi {
  artistProfileGet?: (name: string) => Promise<Reply>
  artistProfileRefresh?: (name: string) => Promise<Reply>
}

export interface ArtistProfileStore {
  seed(states: readonly ArtistProfileState[], complete: boolean): void
  peek(name: string): ProfileEntry
  open(name: string): Promise<void>
  apply(state: ArtistProfileState): void
  subscribe(cb: () => void): () => void
}

export const profileKey = (name: string): string => String(name ?? '').trim().toLowerCase()

function usable(s: unknown, k: string): s is ArtistProfileState {
  return !!s && typeof s === 'object' && 'source' in s && profileKey((s as ArtistProfileState).name) === k
}

export function createArtistProfileStore(
  api: () => ProfileApi | undefined,
  warn: (msg: string, err: unknown) => void = (m, e) => console.warn(m, e instanceof Error ? e.message : e),
  /** dx.nav: how long each ask took and where its answer came from (a no-op unless the recorder is on). */
  timing: (ask: 'profile-cache' | 'profile-refresh', ms: number, from: string) => void = () => {},
  now: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
): ArtistProfileStore {
  const entries = new Map<string, ProfileEntry>()
  const running = new Map<string, Promise<void>>()
  const listeners = new Set<() => void>()
  let seedComplete = false
  const notify = (): void => { for (const l of [...listeners]) l() }
  const set = (e: ProfileEntry): void => { entries.set(e.key, e); notify() }

  const peek = (name: string): ProfileEntry => {
    const k = profileKey(name)
    let e = entries.get(k)
    if (!e) {
      // Nothing known. With the whole cache seeded that is an answer ("none
      // cached"); before the seed lands it is still a question for main.
      e = { key: k, state: emptyProfileState(name.trim()), cacheRead: seedComplete || !k, settled: !k }
      entries.set(k, e)
    }
    return e
  }

  const put = (k: string, s: ArtistProfileState | undefined, patch: Partial<ProfileEntry>): void => {
    const e = entries.get(k)
    if (!e) return
    set({ ...e, ...(usable(s, k) ? { state: s } : {}), ...patch })
  }

  const open = (name: string): Promise<void> => {
    const k = profileKey(name)
    if (!k) return Promise.resolve()
    const going = running.get(k)
    if (going) return going
    const start = peek(name)
    const run = (async () => {
      if (!start.cacheRead) {
        let got: ArtistProfileState | undefined
        const t = now()
        try { const r = await api()?.artistProfileGet?.(name); if (r?.ok) got = r.state } catch (err) { warn('[artist-profile] cache read failed:', err) }
        timing('profile-cache', now() - t, 'disk')
        // A push or a seed may have landed first: the read never replaces a newer answer.
        if (!entries.get(k)?.cacheRead) put(k, got, { cacheRead: true })
      } else {
        timing('profile-cache', 0, 'memory')
      }
      let fresh: ArtistProfileState | undefined
      const t = now()
      try { const r = await api()?.artistProfileRefresh?.(name); if (r?.ok) fresh = r.state } catch (err) { warn('[artist-profile] refresh failed:', err) }
      timing('profile-refresh', now() - t, fresh ? fresh.source : 'no-answer')
      put(k, fresh, { cacheRead: true, settled: true })
    })().finally(() => { running.delete(k) })
    running.set(k, run)
    return run
  }

  const seed = (states: readonly ArtistProfileState[], complete: boolean): void => {
    for (const s of states) {
      const k = profileKey(s?.name)
      if (!k || !usable(s, k)) continue
      const e = entries.get(k)
      if (e?.cacheRead) continue          // this session already knows better
      entries.set(k, { key: k, state: s, cacheRead: true, settled: e?.settled ?? false })
    }
    if (complete) {
      seedComplete = true
      for (const [k, e] of entries) if (!e.cacheRead && !running.has(k)) entries.set(k, { ...e, cacheRead: true })
    }
    notify()
  }

  const apply = (state: ArtistProfileState): void => {
    const k = profileKey(state?.name)
    if (!k || !usable(state, k)) return
    const e = entries.get(k)
    set({ key: k, state, cacheRead: true, settled: e?.settled ?? false })
  }

  return {
    seed, peek, open, apply,
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}
