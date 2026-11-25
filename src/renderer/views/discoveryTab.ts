/**
 * Which Record Shop tab to show — remembered across remounts (MainContent
 * unmounts views on navigation) and requestable from anywhere: the Counter,
 * the Listen List and the Downloads panel send a refused or loose selection
 * to Search (tab id 'browse') with `requestDiscoveryTab('browse')` before
 * switching views. A mounted DiscoveryView hears the event and switches; an
 * unmounted one reads the remembered tab when it mounts.
 *
 * 'bandcamp' (Brief 253): Bandcamp is a tab here, with no sidebar row of its
 * own (the approved picture, 2026-11-24); the old 'store' and 'download' views
 * are gone, and a session saved on either reopens on its tab (nav-history.ts
 * legacyShopTab).
 */
import { SHOP_TAB_LABELS } from '../../common/shop-names.ts'

export type DiscoveryTab = 'new-for-you' | 'browse' | 'your-list' | 'bandcamp'

/** The tabs, in order, with what each is called (common/shop-names.ts; ids unchanged). */
export const SHOP_TABS: ReadonlyArray<{ id: DiscoveryTab; label: string }> = [
  { id: 'new-for-you', label: SHOP_TAB_LABELS[0] },
  { id: 'browse', label: SHOP_TAB_LABELS[1] },
  { id: 'your-list', label: SHOP_TAB_LABELS[2] },
  { id: 'bandcamp', label: SHOP_TAB_LABELS[3] },
]

export const DISCOVERY_TAB_EVENT = 'jaketunes-discovery-tab'

let lastTab: DiscoveryTab = 'new-for-you'
const setLast = (t: DiscoveryTab): void => { lastTab = t }
export function rememberedDiscoveryTab(): DiscoveryTab { return lastTab }
export function rememberDiscoveryTab(t: DiscoveryTab): void { setLast(t) }

export function requestDiscoveryTab(t: DiscoveryTab): void {
  setLast(t)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DISCOVERY_TAB_EVENT, { detail: t }))
}
