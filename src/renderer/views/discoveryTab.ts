/**
 * Which Record Shop tab to show — remembered across remounts (MainContent
 * unmounts views on navigation) and requestable from anywhere: the Counter,
 * the Listen List and the Downloads panel send a refused or loose selection
 * to Search (tab id 'browse') with `requestDiscoveryTab('browse')` before
 * switching views. A mounted DiscoveryView hears the event and switches; an
 * unmounted one reads the remembered tab when it mounts.
 *
 * 'bandcamp' (Brief 253): the Bandcamp Store left the sidebar and is a tab
 * here; the old 'store' and 'download' views are gone, and a session saved on
 * either reopens on its tab (nav-history.ts legacyShopTab).
 */
export type DiscoveryTab = 'new-for-you' | 'browse' | 'your-list' | 'bandcamp'

export const DISCOVERY_TAB_EVENT = 'jaketunes-discovery-tab'

let lastTab: DiscoveryTab = 'new-for-you'
export function rememberedDiscoveryTab(): DiscoveryTab { return lastTab }
export function rememberDiscoveryTab(t: DiscoveryTab): void { lastTab = t }

export function requestDiscoveryTab(t: DiscoveryTab): void {
  lastTab = t
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DISCOVERY_TAB_EVENT, { detail: t }))
}
