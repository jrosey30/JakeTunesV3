/**
 * useDelayedFlag — true only once `flag` has been true for `delayMs`.
 *
 * For loading placeholders: a lookup that answers from cache in 80 ms should
 * never flash "Looking up…" at all. Below the delay a load is better felt as
 * a beat of stillness than shown as chrome (2026-09-02, Jake: "the loading
 * pages suck ass… and they appear too frequently").
 */
import { useEffect, useState } from 'react'

export function useDelayedFlag(flag: boolean, delayMs = 400): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!flag) { setShown(false); return }
    const t = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(t)
  }, [flag, delayMs])
  return flag && shown
}
