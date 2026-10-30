/**
 * Which pages the shell's shared back pill shows on (MainContent renders it in
 * a strip above the view; components/chrome/BackButton.tsx is the pill). Pure,
 * so the rule is unit-tested (back-pill.test.ts).
 *
 * Jake, 2026-10-30: "never used those arrows. make going back obvious on every
 * page." The album, artist and concert pages already carry their own pill where
 * it sits (in the top bar, over the hero), and Home carries its own over the
 * launch page's hero (so the hero doesn't move down) — the shell must not add
 * a second one. Everywhere else the shell's strip carries it, hidden when there
 * is nothing to go back to.
 */
export const VIEWS_WITH_OWN_BACK = ['home', 'album-detail', 'artist-detail', 'concert-detail'] as const

export function viewHasOwnBack(view: string): boolean {
  return (VIEWS_WITH_OWN_BACK as readonly string[]).includes(view)
}

/** Does the shell show its back pill on `view`? Only with somewhere to go back to. */
export function showsSharedBack(view: string, canGoBack: boolean): boolean {
  return canGoBack && !viewHasOwnBack(view)
}
