/**
 * Step Inside's front door.
 *
 * Step Inside is the PS2-style shop now (2026-09-09 direction change).
 * Leaving drops you back on the regular Record Shop tabs, which are
 * unchanged and remain the fast way to browse — this is an alternative
 * way in, not a replacement for the app.
 */
import { useCallback } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import StepInsideView from './stepinside/StepInsideView'

export default function StepInsideRoute() {
  const { dispatch } = useLibrary()
  const leave = useCallback(() => dispatch({ type: 'SET_VIEW', view: 'discovery' }), [dispatch])
  return <StepInsideView onLeave={leave} />
}
