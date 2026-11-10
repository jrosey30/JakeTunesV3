import { createContext, useContext } from 'react'

/**
 * How the page on screen was reached: 'arrive' (a click to somewhere new) or
 * 'return' (Back / Forward to a page you had left). MainContent decides it once
 * per mounted page (navIntent.ts) and hands it down here, so a page can open
 * at the top when you arrive and where you left it when you return.
 */
export type NavArrival = 'arrive' | 'return'
export const NavArrivalContext = createContext<NavArrival>('arrive')
export const useNavArrivalKind = (): NavArrival => useContext(NavArrivalContext)
