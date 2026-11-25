/**
 * A list's column sort, remembered per list while the app runs (V7): leave a
 * playlist sorted by Artist and it is still sorted by Artist when you come
 * back. `null` = the list's own order ("Original Order"). The Songs view keeps
 * its sort in LibraryContext instead (saved across launches by App.tsx).
 *
 * Moved from PlaylistView's and SmartPlaylistView's module maps (sortPrefs,
 * smartSortPrefs), which were the same code twice.
 */
import { useCallback, useState } from 'react'
import type { SongSort } from '../utils/songTableRules'

const remembered = new Map<string, SongSort | null>()

export function useListSort(key: string): [SongSort | null, (next: SongSort | null) => void] {
  const [state, setState] = useState<{ key: string; sort: SongSort | null }>(() => ({ key, sort: remembered.get(key) ?? null }))
  // Another list in the same mounted view (playlist A → B): read B's.
  const sort = state.key === key ? state.sort : (remembered.get(key) ?? null)
  const set = useCallback((next: SongSort | null) => {
    remembered.set(key, next)
    setState({ key, sort: next })
  }, [key])
  return [sort, set]
}
