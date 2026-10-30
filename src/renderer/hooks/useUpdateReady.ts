/**
 * useUpdateReady (2026-10-30) — what the status bar needs to say "Update
 * ready · Install" and to push the install through.
 *
 * Main (src/main/update-ready.ts) watches the install gate's marker and
 * pushes `update-ready` with { sha, version, note } or null. The hook pulls
 * the current state once on mount (the push may have happened before the
 * renderer was listening) and then follows the pushes.
 *
 * install() asks main to pause the music (the media-key path) and write the
 * go-file; `installing` stays true until the gate quits the app — or until
 * main says the update is gone (a null push), because then nothing is coming.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateReadyState } from '../types'

export interface UpdateReadyView {
  ready: UpdateReadyState | null
  /** Install clicked and accepted; the gate is about to quit the app. */
  installing: boolean
  /** The click did not take (main refused or the go-file could not be written); clears itself. */
  failed: boolean
  install: () => Promise<void>
}

const FAILED_SHOWN_MS = 6000

export function useUpdateReady(): UpdateReadyView {
  const [ready, setReady] = useState<UpdateReadyState | null>(null)
  const [installing, setInstalling] = useState(false)
  const [failed, setFailed] = useState(false)
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

  const install = useCallback(async () => {
    setFailed(false)
    setInstalling(true)
    let ok = false
    try {
      ok = (await window.electronAPI.installUpdateNow()).ok
    } catch (err) {
      console.warn('[update-ready] install request failed:', err)
    }
    if (ok) return
    setInstalling(false)
    setFailed(true)
    if (failedTimer.current) clearTimeout(failedTimer.current)
    failedTimer.current = setTimeout(() => { failedTimer.current = null; setFailed(false) }, FAILED_SHOWN_MS)
  }, [])

  return { ready, installing, failed, install }
}
