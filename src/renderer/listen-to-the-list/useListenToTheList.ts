import { useCallback, useEffect, useRef, useState } from 'react'
import { setNotice } from '../activity'
import type { Recommendation } from '../types'
import {
  dedupeSuggestions,
  getRecsCache,
  getSuggestionsCache,
  invalidateRecsCache,
  isRecsCacheFresh,
  isSuggestionsCacheFresh,
  markAutoSuggestAttempted,
  MM_VISIBLE,
  recsListUnchanged,
  setRecsCache,
  setSuggestionsCache,
  suggKey,
  wasAutoSuggestAttempted,
  type MmSuggestion,
} from './store'

export interface AddFormState {
  song: string
  artist: string
  album: string
  note: string
  // v2 capture: who sent it + the link it came from (both optional).
  from: string
  link: string
}

const EMPTY_FORM: AddFormState = { song: '', artist: '', album: '', note: '', from: '', link: '' }

export function useListenToTheList() {
  const cachedRecs = getRecsCache()
  const [recs, setRecs] = useState<Recommendation[]>(cachedRecs ?? [])
  const [loading, setLoading] = useState(cachedRecs === null)
  const [adding, setAdding] = useState(false)
  const [mmPool, setMmPool] = useState<MmSuggestion[]>(getSuggestionsCache() ?? [])
  const [suggLoading, setSuggLoading] = useState(false)

  const recsRef = useRef(recs)
  recsRef.current = recs
  const loadSeqRef = useRef(0)
  const suggestInFlightRef = useRef(false)

  const updateRecs = useCallback((next: Recommendation[]) => {
    setRecsCache(next)
    setRecs(next)
  }, [])

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const res = await window.electronAPI.loadRecommendations()
      if (seq !== loadSeqRef.current) return
      const list = res.ok ? res.recommendations : []
      setRecsCache(list)
      setRecs((prev) => (recsListUnchanged(prev, list) ? prev : list))
    } catch (err) {
      console.error('[ltl] load failed', err)
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isRecsCacheFresh()) void load()
    else setLoading(false)
  }, [load])

  const mergeSuggestions = useCallback((replace: boolean, incoming: MmSuggestion[]) => {
    setMmPool((prev) => {
      const base = replace ? [] : prev
      const merged = dedupeSuggestions([...base, ...incoming], recsRef.current)
      setSuggestionsCache(merged)
      return merged
    })
  }, [])

  const fetchSuggestions = useCallback(async (replace: boolean, force = false) => {
    const res = await window.electronAPI.suggestRecommendations(force ? { force: true } : undefined)
    const incoming = res.ok && res.suggestions ? res.suggestions : []
    mergeSuggestions(replace, incoming)
  }, [mergeSuggestions])

  const ensureSuggestions = useCallback(async (replace = false, silent = false) => {
    if (suggestInFlightRef.current) return
    if (silent && isSuggestionsCacheFresh()) return

    suggestInFlightRef.current = true
    if (!silent) setSuggLoading(true)
    try {
      if (replace) {
        setSuggestionsCache([])
        setMmPool([])
      }
      await fetchSuggestions(replace, replace)
    } catch (err) {
      console.error('[ltl] suggest failed', err)
    } finally {
      suggestInFlightRef.current = false
      if (!silent) setSuggLoading(false)
    }
  }, [fetchSuggestions])

  const refreshSuggestions = useCallback(async () => {
    markAutoSuggestAttempted()
    await ensureSuggestions(true, false)
  }, [ensureSuggestions])

  useEffect(() => {
    if (loading) return
    if (mmPool.length >= MM_VISIBLE) return
    // 2026-07-14: MM suggestions removed from the list view (Jake: 'he should
    // just focus on New for You') — never auto-fetch here.
    return
    // eslint-disable-next-line no-unreachable
    if (wasAutoSuggestAttempted()) return
    if (isSuggestionsCacheFresh() && (getSuggestionsCache()?.length ?? 0) > 0) return

    const isFirst = getSuggestionsCache() === null
    const timer = setTimeout(() => {
      markAutoSuggestAttempted()
      void ensureSuggestions(isFirst, !isFirst)
    }, isFirst ? 400 : 0)
    return () => clearTimeout(timer)
  }, [loading, mmPool.length, ensureSuggestions])

  useEffect(() => {
    let pruned = false
    setMmPool((prev) => {
      const next = dedupeSuggestions(prev, recs)
      if (next.length === prev.length) return prev
      pruned = true
      setSuggestionsCache(next)
      return next
    })
    if (pruned && mmPool.length < MM_VISIBLE && !suggestInFlightRef.current) {
      void ensureSuggestions(false, true)
    }
  }, [recs, mmPool.length, ensureSuggestions])

  const applyAddResult = useCallback((
    prev: Recommendation[],
    tempId: string,
    res: Awaited<ReturnType<typeof window.electronAPI.addRecommendation>>,
    draftLabel: string,
    onRollback: () => void,
  ): boolean => {
    if (!res?.ok) {
      updateRecs(prev)
      onRollback()
      setNotice(
        res?.error?.includes('nothing to add')
          ? 'Enter at least a song, artist, album, or note.'
          : `Couldn't save recommendation${res?.error ? `: ${res.error}` : ''}.`,
        { kind: 'error' },
      )
      return false
    }
    if (res.deduped && res.recommendation) {
      const canon = res.recommendation
      setRecs((cur) => {
        const withoutTemp = cur.filter((r) => r.id !== tempId)
        const next = withoutTemp.some((r) => r.id === canon.id) ? withoutTemp : [canon, ...withoutTemp]
        setRecsCache(next)
        return next
      })
      setNotice(`"${canon.song || canon.matchedTitle || draftLabel}" is already on your list.`, { kind: 'success' })
      return true
    }
    if (res.recommendation) {
      const enriched = res.recommendation
      setRecs((cur) => {
        const swapped = cur.some((r) => r.id === tempId)
          ? cur.map((r) => (r.id === tempId ? enriched : r))
          : [enriched, ...cur]
        setRecsCache(swapped)
        return swapped
      })
      return true
    }
    return false
  }, [updateRecs])

  const addRecommendation = useCallback(async (input: {
    song?: string
    artist?: string
    album?: string
    note?: string
    source?: 'user' | 'mm' | 'radar'
  }, opts?: { restoreOnFail?: () => void }) => {
    setAdding(true)
    const tempId = `temp-${Date.now()}`
    const provisional: Recommendation = {
      id: tempId,
      song: input.song,
      artist: input.artist,
      album: input.album,
      note: input.note,
      createdAt: new Date().toISOString(),
    }
    const prev = recsRef.current
    updateRecs([provisional, ...prev])
    loadSeqRef.current++

    try {
      const res = await window.electronAPI.addRecommendation(input)
      const ok = applyAddResult(prev, tempId, res, input.song || input.artist || 'That', () => opts?.restoreOnFail?.())
      if (!ok && res?.ok) await load()
      return res
    } catch (err) {
      updateRecs(prev)
      opts?.restoreOnFail?.()
      setNotice(`Add failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' })
      return null
    } finally {
      setAdding(false)
    }
  }, [applyAddResult, load, updateRecs])

  const addFromForm = useCallback(async (form: AddFormState) => {
    const trimmed = {
      song: form.song.trim() || undefined,
      artist: form.artist.trim() || undefined,
      album: form.album.trim() || undefined,
      note: form.note.trim() || undefined,
      from: form.from.trim() || undefined,
      link: form.link.trim() || undefined,
    }
    const canAdd = trimmed.song || trimmed.artist || trimmed.album || trimmed.note
    if (!canAdd || adding) return { ok: false as const }

    const draft = { ...form }
    loadSeqRef.current++
    const res = await addRecommendation({ ...trimmed, source: 'user' }, {
      restoreOnFail: () => { /* form restored by caller */ },
    })
    return { ok: Boolean(res?.ok), draft }
  }, [addRecommendation, adding])

  const addSuggestion = useCallback(async (s: MmSuggestion) => {
    setMmPool((prev) => {
      const next = prev.filter((x) => suggKey(x) !== suggKey(s))
      setSuggestionsCache(next)
      return next
    })
    void ensureSuggestions(false, true)

    const prev = recsRef.current
    try {
      const res = await addRecommendation({
        song: s.song || undefined,
        artist: s.artist || undefined,
        note: s.note || undefined,
        source: 'mm',
      }, {
        restoreOnFail: () => {
          setMmPool((p) => {
            const next = dedupeSuggestions([s, ...p], recsRef.current)
            setSuggestionsCache(next)
            return next
          })
        },
      })
      if (!res?.ok) {
        setMmPool((p) => {
          const next = dedupeSuggestions([s, ...p], recsRef.current)
          setSuggestionsCache(next)
          return next
        })
      }
    } catch {
      updateRecs(prev)
      setMmPool((p) => {
        const next = dedupeSuggestions([s, ...p], recsRef.current)
        setSuggestionsCache(next)
        return next
      })
    }
  }, [addRecommendation, ensureSuggestions, updateRecs])

  const deleteRecommendation = useCallback(async (rec: Recommendation) => {
    const prev = recsRef.current
    const next = prev.filter((x) => x.id !== rec.id)
    updateRecs(next)
    loadSeqRef.current++
    try {
      const res = await window.electronAPI.deleteRecommendation(rec.id)
      if (!res.ok) {
        updateRecs(prev)
        loadSeqRef.current++
        setNotice(`Couldn't delete${res.error ? `: ${res.error}` : ''}.`, { kind: 'error' })
      } else {
        invalidateRecsCache()
      }
    } catch (err) {
      updateRecs(prev)
      loadSeqRef.current++
      setNotice(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' })
    }
  }, [updateRecs])

  return {
    recs,
    loading,
    adding,
    mmPool,
    visibleMm: mmPool.slice(0, MM_VISIBLE),
    suggLoading,
    refreshSuggestions,
    addFromForm,
    addSuggestion,
    deleteRecommendation,
    EMPTY_FORM,
  }
}
