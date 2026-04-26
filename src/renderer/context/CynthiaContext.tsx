import { createContext, useCallback, useContext, useState, ReactNode } from 'react'
import { CynthiaScope } from '../types'
import CynthiaPopover from '../components/CynthiaPopover'

// Cynthia is summoned from any view's right-click menu — every view that
// shows tracks (Songs, Albums, Artists, Playlists) calls openCynthia({...}).
// We mount one popover at the app root rather than letting each view
// manage its own, because the popover lives at fixed window coordinates
// and only one can be open at a time anyway.

interface CynthiaInvocation {
  x: number
  y: number
  scope: CynthiaScope
}

interface CynthiaContextValue {
  openCynthia: (args: CynthiaInvocation) => void
}

const CynthiaContext = createContext<CynthiaContextValue | null>(null)

export function useCynthia(): CynthiaContextValue {
  const ctx = useContext(CynthiaContext)
  if (!ctx) throw new Error('useCynthia must be used within CynthiaProvider')
  return ctx
}

export function CynthiaProvider({ children }: { children: ReactNode }) {
  const [invocation, setInvocation] = useState<CynthiaInvocation | null>(null)

  const openCynthia = useCallback((args: CynthiaInvocation) => {
    setInvocation(args)
  }, [])

  const closePopover = useCallback(() => {
    setInvocation(null)
  }, [])

  return (
    <CynthiaContext.Provider value={{ openCynthia }}>
      {children}
      {invocation && (
        <CynthiaPopover
          x={invocation.x}
          y={invocation.y}
          scope={invocation.scope}
          onClose={closePopover}
        />
      )}
    </CynthiaContext.Provider>
  )
}
