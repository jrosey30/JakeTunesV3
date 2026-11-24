/**
 * The Record Shop's one search box (Jake's approved picture, 2026-11-24): it
 * sits at the top of the shop beside the title, on every tab, and the Search
 * tab shows what it finds. The words live here, not in either view, so the box
 * (DiscoveryView) and the results (DownloadView) read the same thing, and the
 * words survive leaving the shop (MainContent unmounts views on navigation).
 *
 * `how` is how the words on screen got there, for the usage log's search
 * funnel (common/shop-funnel.ts): typed in the box, or sent from a list.
 */
import type { ShopSearchHow } from '../../../common/shop-funnel'

interface ShopQueryState { query: string; how: ShopSearchHow; searching: boolean }
let state: ShopQueryState = { query: '', how: 'typed', searching: false }
const watchers = new Set<() => void>()
const tell = (): void => { for (const w of watchers) w() }

export function getShopQuery(): string { return state.query }
export function shopQueryHow(): ShopSearchHow { return state.how }
export function shopSearching(): boolean { return state.searching }

/** New words in the box. */
export function setShopQuery(query: string, how: ShopSearchHow = 'typed'): void {
  if (query === state.query && how === state.how) return
  state = { ...state, query, how }
  tell()
}

/** The Search tab says when it is waiting on an answer, for the box's spinner. */
export function setShopSearching(searching: boolean): void {
  if (searching === state.searching) return
  state = { ...state, searching }
  tell()
}

export function subscribeShopQuery(w: () => void): () => void {
  watchers.add(w)
  return () => { watchers.delete(w) }
}

/**
 * Whether typing these words should bring the Search tab forward: anything
 * but an empty box. Clearing the box leaves Jake on the tab he is on.
 */
export function typingOpensSearch(words: string): boolean {
  return words.trim().length > 0
}
