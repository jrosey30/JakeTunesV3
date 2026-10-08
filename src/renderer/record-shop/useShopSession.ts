// The live Record Shop session for any presentation: the Listen List's
// saved items, the one Downloads scheduler's jobs, and main's ownership
// verdicts by recording identity — composed by the pure builder in common.
// Resolution (tracklist + ownership) is asked of main one item at a time
// (iTunes throttles), cached at module level so leaving and returning is
// instant, and dropped whenever the library changes or a job lands.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRecsCache, setRecsCache, isRecsCacheFresh } from '../listen-to-the-list/store'
import { subscribeQueue, getQueue } from '../views/DownloadStore/downloadQueue'
import { useLibrary } from '../context/LibraryContext'
import { shopSessionFromLive, resolveRequestFor, recommendationIdOf, type ResolvedShopItem } from '../../common/record-shop-live'
import type { ShopSession } from '../../common/record-shop'
import type { Recommendation } from '../types'

const resolved = new Map<string, ResolvedShopItem>()
let resolvedForLibrary = ''

/** The saved list, read the way the regular shop reads it (same cache,
 *  same loader, same update signal) — WITHOUT the regular shop's
 *  Music Man suggestion fetch, which is that view's business. */
export function useShopList(): { recs: Recommendation[]; loading: boolean } {
  const cached = getRecsCache()
  const [recs, setRecs] = useState<Recommendation[]>(cached ?? [])
  const [loading, setLoading] = useState(cached === null)
  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const res = await window.electronAPI.loadRecommendations()
      if (mine !== seq.current) return
      const list = res.ok ? res.recommendations : []
      setRecsCache(list); setRecs(list)
    } catch (e) { console.error('[record-shop] list load failed', e) }
    finally { if (mine === seq.current) setLoading(false) }
  }, [])
  // Show the cache at once, then ALWAYS re-read the mirror: the cache is
  // only maintained by the regular shop's own hook, and a jot that arrived
  // by any other path (a friend's send, a sync) is not in it yet
  // (live, 2026-09-06: a fresh jot never reached the counter).
  useEffect(() => {
    if (isRecsCacheFresh()) { setRecs(getRecsCache() ?? []); setLoading(false) }
    void load()
    return window.electronAPI.onRecommendationsUpdated?.(() => { void load() })
  }, [load])
  return { recs, loading }
}

function useQueueVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => subscribeQueue(() => setV((x) => x + 1)), [])
  return v
}

export interface LiveShopSession {
  session: ShopSession
  recs: Recommendation[]
  loading: boolean
  /** Drop the item's cached verdict and ask main again. */
  refresh: (itemId: string) => void
}

export function useShopSession(): LiveShopSession {
  const ltl = useShopList()
  const { state: lib } = useLibrary()
  const queueVersion = useQueueVersion()
  const [tick, setTick] = useState(0)
  const libraryRev = useMemo(() => {
    let max = 0
    for (const t of lib.tracks) if (t.id > max) max = t.id
    return `${lib.tracks.length}:${max}`
  }, [lib.tracks])
  // An import landed or the library was edited: every verdict is stale.
  useEffect(() => {
    if (resolvedForLibrary === libraryRev) return
    resolved.clear(); resolvedForLibrary = libraryRev; setTick((x) => x + 1)
  }, [libraryRev])

  const recById = useMemo(() => new Map(ltl.recs.map((r) => [r.id, r] as const)), [ltl.recs])
  const session = useMemo(
    () => shopSessionFromLive({ recs: ltl.recs, queue: getQueue(), resolved: Object.fromEntries(resolved), now: new Date().toISOString() }),
    // queueVersion / tick / libraryRev are the change signals for the module-level inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ltl.recs, queueVersion, tick, libraryRev],
  )
  const sessionRef = useRef(session); sessionRef.current = session
  const recRef = useRef(recById); recRef.current = recById

  const pending = useRef<string[]>([])
  const inFlight = useRef(false)
  const pump = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      while (pending.current.length) {
        const itemId = pending.current.shift()!
        const item = sessionRef.current.items.find((i) => i.itemId === itemId)
        if (!item) continue
        const rid = recommendationIdOf(itemId)
        const req = resolveRequestFor(item, rid ? recRef.current.get(rid) : undefined)
        if (!req) continue
        const forRevision = (item.kind === 'release' || item.kind === 'recording') ? item.selection?.revision : undefined
        const api = window.electronAPI.recordShop
        if (!api) return
        try {
          const res = await api.resolve(req)
          resolved.set(itemId, res.ok ? { forRevision, selection: res.selection, ownership: res.ownership, libraryRevision: res.libraryRevision, at: Date.now() } : { forRevision, error: res.error, at: Date.now() })
        } catch (e) {
          resolved.set(itemId, { forRevision, error: e instanceof Error ? e.message : String(e), at: Date.now() })
        }
        setTick((x) => x + 1)
      }
    } finally {
      inFlight.current = false
    }
  }, [])
  const ask = useCallback((itemId: string) => { if (!pending.current.includes(itemId)) pending.current.push(itemId) }, [])
  const refresh = useCallback((itemId: string) => { resolved.delete(itemId); ask(itemId); void pump() }, [ask, pump])

  // Everything unresolved — or resolved for a selection the item no longer has
  // (a job just chose an edition) — gets asked, in list order.
  useEffect(() => {
    for (const it of session.items) {
      const rev = (it.kind === 'release' || it.kind === 'recording') ? it.selection?.revision : undefined
      const r = resolved.get(it.itemId)
      // A record with no edition chosen has nothing to verify yet (no verdict is shown for it): don't spend a catalogue call.
      if (it.kind === 'release' && !it.selection) continue
      if ((!r || r.forRevision !== rev) && resolveRequestFor(it, undefined)) { if (r) resolved.delete(it.itemId); ask(it.itemId) }
    }
    void pump()
  }, [session, ask, pump])
  // A job that just finished changes what the library holds: ask again for that item.
  const seenDone = useRef(new Set<string>())
  useEffect(() => {
    for (const [itemId, job] of Object.entries(session.jobs)) {
      const k = `${job.jobId}#${job.attempt}`
      if (job.status === 'done' && !seenDone.current.has(k)) { seenDone.current.add(k); refresh(itemId) }
    }
  }, [session, refresh])

  return { session, recs: ltl.recs, loading: ltl.loading, refresh }
}
