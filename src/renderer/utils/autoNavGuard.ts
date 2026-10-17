/**
 * Live read of "is anything in flight" for hardware-arrival navigation
 * (iPod connected → Device page, new CD → CD Import). The rule itself is
 * pure in common/auto-nav.ts; this only gathers the facts.
 */
import { getRip, getSync } from '../activity'
import { getSyncTimeline } from '../syncTimeline'
import { autoNavHeld } from '../../common/auto-nav'

// Every modal surface in the app: the aria-modal sheets/dialogs, the
// ConfirmDialog, Get Info, the imp-* modals, Artist Grouping.
const MODAL_SELECTOR = '[aria-modal="true"], .confirm-overlay, .getinfo-overlay, .imp-backdrop, .agm-overlay'

export function autoNavBlocked(): boolean {
  return autoNavHeld({
    syncing: !!getSync()?.active || getSyncTimeline().status === 'running',
    ripping: !!getRip()?.active,
    modalOpen: !!document.querySelector(MODAL_SELECTOR),
  })
}
