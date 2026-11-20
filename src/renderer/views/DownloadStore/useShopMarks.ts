/**
 * "In your library" and "On your list" for every Record Shop result (Brief 256).
 *
 * The library comes from LibraryContext; the Listen List from its in-session
 * cache (listen-to-the-list/store.ts), loaded once here when the shop's Search
 * opens before the list ever has, and again when main says the list changed.
 * The rules are common/shop-search.ts (libraryMarks, listMarks).
 */
import { useEffect, useMemo, useState } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { getRecsCache, setRecsCache } from '../../listen-to-the-list/store'
import { libraryMarks, listMarks, type LibraryMarks, type ListMarks } from '../../../common/shop-search'
import type { Recommendation } from '../../types'

export function useShopMarks(): { lib: LibraryMarks; list: ListMarks } {
  const { state } = useLibrary()
  const lib = useMemo(() => libraryMarks(state.tracks), [state.tracks])
  const [recs, setRecs] = useState<Recommendation[]>(() => getRecsCache() ?? [])
  useEffect(() => {
    let live = true
    const load = () => {
      window.electronAPI.loadRecommendations?.()
        .then((r) => { if (live && r?.ok) { setRecsCache(r.recommendations); setRecs(r.recommendations) } })
        .catch(() => { /* no marks is honest */ })
    }
    if (getRecsCache() === null) load()
    const off = window.electronAPI.onRecommendationsUpdated?.(() => load())
    return () => { live = false; off?.() }
  }, [])
  const list = useMemo(() => listMarks(recs), [recs])
  return { lib, list }
}
