/**
 * V7 "click opens, ▶ plays" — the one rule for every card, tile and row
 * outside the song table (2026-11-24).
 *
 * Before this, the same click did different things a few inches apart: Home's
 * song cards played on click while the mixes beside them opened; Rediscover's
 * art played but its name opened; album tiles opened on the first click, so
 * their "double-click plays" never fired; an artist's Top Songs played on a
 * single click. Now:
 *
 *   click / Enter / Space  → OPEN the thing (its page, its sheet, its link)
 *   the ▶ shown on hover   → PLAY it
 *   double-click           → nothing extra (the first click already opened)
 *   right-click            → the menu for its kind (one menu per kind)
 *   drag                   → its songs onto Up Next or a playlist
 *
 * Song ROWS are lists, not cards: a click selects (or does nothing), a
 * double-click or Enter plays — the song table's rule, which every song list
 * outside the table (an artist's Top Songs, a release's tracks) follows too.
 *
 * Pure: the renderer's Card component (components/Card.tsx) asks here, and the
 * tests hold the table.
 */

/** Everything drawn as a card or tile. */
export type CardKind =
  | 'album' | 'artist' | 'playlist' | 'mix' | 'tape' | 'concert'
  | 'show' | 'shop' | 'chart' | 'song' | 'island' | 'reco'

export const CARD_KINDS: readonly CardKind[] = [
  'album', 'artist', 'playlist', 'mix', 'tape', 'concert', 'show', 'shop', 'chart', 'song', 'island', 'reco',
]

/** What the hand does. */
export type Gesture = 'click' | 'enter' | 'space' | 'double-click' | 'play-button' | 'context-menu' | 'drag'

export type CardAction = 'open' | 'play' | 'menu' | 'drag' | 'none'

/** A card: click opens, ▶ plays. Never plays on a plain click. */
export function cardAction(g: Gesture): CardAction {
  switch (g) {
    case 'click': case 'enter': case 'space': return 'open'
    case 'play-button': return 'play'
    case 'context-menu': return 'menu'
    case 'drag': return 'drag'
    case 'double-click': return 'none'
  }
}

export type RowAction = 'select' | 'play' | 'menu' | 'drag' | 'none'

/** A song row (any list of songs): double-click or Enter plays. */
export function songRowAction(g: Gesture): RowAction {
  switch (g) {
    case 'click': return 'select'
    case 'double-click': case 'enter': return 'play'
    case 'context-menu': return 'menu'
    case 'drag': return 'drag'
    case 'space': case 'play-button': return 'none'
  }
}

/** Which right-click menu a kind gets. Kinds that are the same thing share
 *  one: a chart cover and a Home song card are songs; Island covers and
 *  concerts are albums with their own few lines added. */
export type MenuKind = 'album' | 'artist' | 'playlist' | 'song' | 'tape' | 'show' | 'shop' | 'reco'

export const MENU_FOR: Readonly<Record<CardKind, MenuKind>> = {
  album: 'album',
  island: 'album',
  concert: 'album',
  artist: 'artist',
  playlist: 'playlist',
  mix: 'playlist',
  tape: 'tape',
  song: 'song',
  chart: 'song',
  show: 'show',
  shop: 'shop',
  reco: 'reco',
}

/** Kinds whose ▶ plays the user's own library (and so can be dragged onto Up
 *  Next or a playlist). A show on sale, a shop item and a Listening List row
 *  aren't owned yet: their ▶ is a preview and there is nothing to drag. */
export function canDrag(kind: CardKind): boolean {
  return kind !== 'show' && kind !== 'shop' && kind !== 'reco'
}

/** "See All" is always these words, with no count or arrow, and it is drawn
 *  only when there is a page to open. A row with no page shows no See All. */
export const SEE_ALL = 'See All'
export function seeAllShown(page: string | null | undefined): boolean {
  return typeof page === 'string' && page.length > 0
}

/** The Home's three rows, named as the approved V7 plan names them (#488).
 *  Each one's See All opens a playlist: Listen More opens Listen More Weekly,
 *  the others the playlist of the same name (components/sidebar/Sidebar.tsx). */
export const HOME_ROW_TITLE = {
  'listen-more-weekly': 'Listen More',
  'on-repeat': 'On Repeat',
  'recently-added': 'Recently Added',
} as const
export type HomeRowId = keyof typeof HOME_ROW_TITLE

/** The one Play button's words. */
export const PLAY_LABEL = 'Play'
export function playTitle(name: string): string {
  const n = name.trim()
  return n ? `Play ${n}` : PLAY_LABEL
}
