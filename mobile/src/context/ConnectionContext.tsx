// NAS connection state. Owns the Synology client instance, reconnects
// on app foreground, and exposes connect/disconnect to settings UI.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionState, NasConnectionConfig } from '@/types'
import { storage } from '@/services/storage'
import { secureStore } from '@/services/secureStore'
import { createSynologyClient, type SynologyClient } from '@/services/nas/synologyClient'

interface ConnectionContextValue {
  state: ConnectionState
  config: NasConnectionConfig | null
  client: SynologyClient | null
  saveConfig: (config: NasConnectionConfig, password: string) => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  forget: () => Promise<void>
}

const Ctx = createContext<ConnectionContextValue | null>(null)

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<NasConnectionConfig | null>(null)
  const [state, setState] = useState<ConnectionState>({ status: 'disconnected' })
  const clientRef = useRef<SynologyClient | null>(null)
  // Generation counter so an in-flight connect() that loses the race
  // to forget()/saveConfig() can't write its result over the new
  // state. Per CLAUDE.md: "every cancel path must reverse all side
  // effects of the corresponding start path."
  const connectGenRef = useRef(0)

  // Hydrate stored config on mount.
  useEffect(() => {
    let alive = true
    void (async () => {
      const stored = (await storage.loadNasConfig()) as NasConnectionConfig | null
      if (alive && stored) {
        setConfig(stored)
        clientRef.current = createSynologyClient(stored)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const connect = useCallback(async () => {
    if (!clientRef.current) return
    const gen = ++connectGenRef.current
    const client = clientRef.current
    setState({ status: 'connecting' })
    try {
      await client.login()
      // If forget()/saveConfig() ran while we were awaiting, drop the
      // result — the client we logged into may not even be the
      // current one.
      if (connectGenRef.current !== gen || clientRef.current !== client) return
      setState({
        status: 'connected',
        serverInfo: { hostname: client.config.host },
      })
    } catch (err) {
      if (connectGenRef.current !== gen || clientRef.current !== client) return
      setState({ status: 'error', message: (err as Error).message })
    }
  }, [])

  const disconnect = useCallback(async () => {
    // Invalidate any in-flight connect attempt before we logout, so a
    // racing successful login can't flip us back to 'connected'.
    connectGenRef.current++
    if (!clientRef.current) {
      setState({ status: 'disconnected' })
      return
    }
    await clientRef.current.logout().catch(() => undefined)
    setState({ status: 'disconnected' })
  }, [])

  const saveConfig = useCallback(
    async (next: NasConnectionConfig, password: string) => {
      // Replacing the client invalidates any in-flight connect.
      connectGenRef.current++
      const withFlag: NasConnectionConfig = { ...next, hasStoredCredential: true }
      await secureStore.setNasPassword(password)
      await storage.saveNasConfig(withFlag)
      setConfig(withFlag)
      clientRef.current = createSynologyClient(withFlag)
    },
    [],
  )

  const forget = useCallback(async () => {
    connectGenRef.current++
    await secureStore.clearNasPassword()
    await storage.saveNasConfig(null)
    clientRef.current = null
    setConfig(null)
    setState({ status: 'disconnected' })
  }, [])

  const value = useMemo<ConnectionContextValue>(
    () => ({
      state,
      config,
      client: clientRef.current,
      saveConfig,
      connect,
      disconnect,
      forget,
    }),
    [state, config, saveConfig, connect, disconnect, forget],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConnection(): ConnectionContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useConnection must be used inside <ConnectionProvider>')
  return v
}
