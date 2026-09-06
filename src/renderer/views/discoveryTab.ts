/**
 * Which Record Shop tab to show — remembered across remounts (MainContent
 * unmounts views on navigation) and requestable from anywhere: the Counter,
 * the Listen List and the Downloads panel send a refused or loose selection
 * to Browse with `requestDiscoveryTab('browse')` before switching views. A
 * mounted DiscoveryView hears the event and switches; an unmounted one reads
 * the remembered tab when it mounts.
 */
export type DiscoveryTab = 'new-for-you' | 'browse' | 'your-list'

export const DISCOVERY_TAB_EVENT = 'jaketunes-discovery-tab'

let lastTab: DiscoveryTab = 'new-for-you'
export function rememberedDiscoveryTab(): DiscoveryTab { return lastTab }
export function rememberDiscoveryTab(t: DiscoveryTab): void { lastTab = t }

export function requestDiscoveryTab(t: DiscoveryTab): void {
  lastTab = t
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DISCOVERY_TAB_EVENT, { detail: t }))
}
