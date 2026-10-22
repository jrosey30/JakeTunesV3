/**
 * Which browse page stays mounted (hidden) under a detail page — pure, so the
 * rule is unit-testable (MainContent is the only caller).
 *
 * 2026-10-21 (Jake: "going back a page is glitchy. Screen blanks then
 * reappears"). Measured on the installed app with his library: every back to
 * Artists / Albums / Home REMOUNTED the page — a 280–390 ms frozen frame
 * rebuilding 1,940 artist or 2,579 album cards, one fully blank frame (the
 * 120 ms view fade starting at opacity 0), every cover re-requested and popping
 * back in, and the scroll memory overridden. Keeping the page you came from
 * alive under the artist / album page makes back an unhide: same DOM, same
 * scroll position, same decoded art, no rebuild.
 *
 * Detail pages themselves are NOT kept: ArtistDetailView / AlbumDetailView read
 * their subject from global state (activeArtist / pendingAlbumKey), so a hidden
 * copy would follow the visible one to the next artist. Back INTO a detail page
 * remounts it, without its entrance choreography (navIntent.ts).
 */

/** Browse grids whose identity doesn't depend on a selected item.
 *  Not Home: its Island jewel case reverses the disc handoff on MOUNT
 *  (discHandoff.ts peekReturningCase) and its Cover Flow owns ←/→ while on
 *  screen (arrowKeyOwner.ts) — a hidden-but-mounted Home would break the one
 *  and muddle the other. Home's back gets the return path (no entrance
 *  choreography — its 13 blank frames were that), not keep-alive. */
export const KEPT_ROOTS = ['artists', 'albums'] as const
export type KeptRoot = (typeof KEPT_ROOTS)[number]

/** Detail pages you can stack on top of a kept root without losing it. */
export const DETAIL_VIEWS = ['artist-detail', 'album-detail'] as const

export function isKeptRoot(view: string): view is KeptRoot {
  return (KEPT_ROOTS as readonly string[]).includes(view)
}

/**
 * The root to keep mounted after a navigation to `current`, given the root
 * kept before it. On a root: that root (it is the visible page). On a detail
 * page: whatever root you came from, through any depth of artist ↔ album
 * pages. Anywhere else: nothing — the next root mounts fresh.
 */
export function nextKeptRoot(current: string, kept: KeptRoot | null): KeptRoot | null {
  if (isKeptRoot(current)) return current
  if ((DETAIL_VIEWS as readonly string[]).includes(current)) return kept
  return null
}
