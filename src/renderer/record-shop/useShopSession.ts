// The Listen List's saved items for the Record Shop (the tab's count).
// Brief 253 removed useShopSession, the live session hook that composed the
// list, the queue and main's ownership verdicts: nothing called it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getRecsCache, setRecsCache, isRecsCacheFresh } from '../listen-to-the-list/store'
import type { Recommendation } from '../types'

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
