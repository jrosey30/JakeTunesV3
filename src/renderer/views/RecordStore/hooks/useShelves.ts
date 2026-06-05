// useShelves — fetches the daily ShelfBundle from main via IPC.
//
// Phase 0 scope: simple fetch on mount, loading + error states,
// manual refresh function. The bundle is cached on disk (per-local-date)
// by the main process, so consecutive view-mounts during the day reuse
// the same data — first-open-of-day regeneration per Brief 037 D1.
//
// Phase 1 will add "served from yesterday" treatment when the LLM is
// down and we're showing a stale-but-cached bundle.

import { useCallback, useEffect, useState } from 'react'
import type { ShelfBundle } from '../types'

type State =
  | { status: 'loading' }
  | { status: 'ready'; bundle: ShelfBundle }
  | { status: 'error'; error: string }

interface RecordStoreApi {
  getShelves: (opts?: { forceRefresh?: boolean }) => Promise<unknown>
}

interface ElectronAPI {
  recordStore?: RecordStoreApi
}

export function useShelves() {
  const [state, setState] = useState<State>({ status: 'loading' })

  const fetchShelves = useCallback(async (forceRefresh = false) => {
    setState({ status: 'loading' })
    try {
      const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI
      if (!api?.recordStore?.getShelves) {
        throw new Error('record-store IPC not exposed in preload')
      }
      const bundle = (await api.recordStore.getShelves({ forceRefresh })) as ShelfBundle
      setState({ status: 'ready', bundle })
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  useEffect(() => {
    void fetchShelves(false)
  }, [fetchShelves])

  return {
    state,
    refresh: () => fetchShelves(true),
  }
}
