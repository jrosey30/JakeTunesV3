/**
 * useUpdateReady (2026-10-30, three choices 2026-11-14) — what the status bar
 * needs to offer an update and carry out Jake's answer.
 *
 * Main (src/main/update-ready.ts) watches the install gate's marker and this
 * Mac's decision and pushes `update-ready` with the whole state (or null). The
 * hook pulls the current state once on mount (the push may have happened
 * before the renderer was listening) and then follows the pushes.
 *
 *   install()      Install now: main pauses the music and writes the go-file;
 *                  `installing` stays true until the gate quits the app — or
 *                  until main says the update is gone (a null push).
 *   installAt(t)   Install at a time in the next 7 days (main holds the clock).
 *   skip()         Skip to next week: never offered on this Mac again.
 *   cancel()       Take back a now or an at before the install starts.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateReadyState } from '../types'
import { INSTALL_AFTER_SYNC } from '../../common/update-ready'

export interface UpdateReadyView {
  ready: UpdateReadyState | null
  /** Install clicked and accepted, or main says the install has started. */
  installing: boolean
  /** The last click did not take; clears itself. */
  failed: boolean
  /** That click came during an iPod sync: nothing went wrong, it has to wait. Clears itself. */
  afterSync: boolean
  install: () => Promise<void>
  installAt: (at: number) => Promise<boolean>
  skip: () => Promise<boolean>
  cancel: () => Promise<boolean>
}

const FAILED_SHOWN_MS = 6000

export function useUpdateReady(): UpdateReadyView {
  const [ready, setReady] = useState<UpdateReadyState | null>(null)
  const [installing, setInstalling] = useState(false)
  const [failed, setFailed] = useState(false)
  const [afterSync, setAfterSync] = useState(false)
  const failedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    const off = window.electronAPI.onUpdateReady((state) => {
      if (!alive) return
      setReady(state)
      if (!state) setInstalling(false)
    })
    window.electronAPI.getUpdateReady()
      .then((r) => { if (alive && r?.ok) setReady(r.state) })
      .catch((err: unknown) => { console.warn('[update-ready] initial read failed:', err) })
    return () => {
      alive = false
      off()
      if (failedTimer.current) { clearTimeout(failedTimer.current); failedTimer.current = null }
    }
  }, [])

  const showFailed = useCallback((error?: string) => {
    setFailed(true)
    setAfterSync(error === INSTALL_AFTER_SYNC)
    if (failedTimer.current) clearTimeout(failedTimer.current)
    failedTimer.current = setTimeout(() => { failedTimer.current = null; setFailed(false); setAfterSync(false) }, FAILED_SHOWN_MS)
  }, [])

  const install = useCallback(async () => {
    setFailed(false)
    setAfterSync(false)
    setInstalling(true)
    let ok = false
    let error: string | undefined
    try {
      ({ ok, error } = await window.electronAPI.installUpdateNow())
    } catch (err) {
      console.warn('[update-ready] install request failed:', err)
    }
    if (ok) return
    setInstalling(false)
    showFailed(error)
  }, [showFailed])

  const answer = useCallback(async (run: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setFailed(false)
    setAfterSync(false)
    try {
      const r = await run()
      if (r.ok) return true
      showFailed(r.error)
    } catch (err) {
      console.warn('[update-ready] request failed:', err)
      showFailed()
    }
    return false
  }, [showFailed])

  const installAt = useCallback((at: number) => answer(() => window.electronAPI.decideUpdate({ choice: 'at', at: new Date(at).toISOString() })), [answer])
  const skip = useCallback(() => answer(() => window.electronAPI.decideUpdate({ choice: 'skip' })), [answer])
  const cancel = useCallback(() => answer(() => window.electronAPI.cancelUpdateDecision()), [answer])

  return { ready, installing: installing || ready?.phase === 'installing', failed, afterSync, install, installAt, skip, cancel }
}
