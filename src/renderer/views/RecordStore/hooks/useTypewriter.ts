// useTypewriter — reveals a string one character at a time, Pokémon-GBC
// dialogue style. Returns the visible slice, a `done` flag, and a `skip`
// to fast-forward to the full text (the "press A" behaviour).

import { useCallback, useEffect, useRef, useState } from 'react'

export function useTypewriter(text: string, speedMs = 24) {
  const [count, setCount] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    setCount(0)
    if (timerRef.current) clearInterval(timerRef.current)
    if (!text) return
    timerRef.current = setInterval(() => {
      setCount((c) => {
        const next = c + 1
        if (next >= text.length && timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
        return Math.min(next, text.length)
      })
    }, speedMs)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [text, speedMs])

  const skip = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setCount(text.length)
  }, [text.length])

  return { shown: text.slice(0, count), done: count >= text.length, skip }
}
