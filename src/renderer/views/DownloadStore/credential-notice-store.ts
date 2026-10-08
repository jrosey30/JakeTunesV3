/** One notice at a time, shared by every Download view instance (Browse and
 *  the legacy page) — the same store shape as the queue. */
import type { QobuzNotice } from '../../../common/qobuz-notice'

let current: QobuzNotice | null = null
const subs = new Set<() => void>()
const emit = (): void => { for (const f of subs) f() }
export function subscribeCredentialNotice(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn) } }
export function getCredentialNotice(): QobuzNotice | null { return current }
export function showCredentialNotice(n: QobuzNotice): void { current = n; emit() }
export function clearCredentialNotice(): void { if (current) { current = null; emit() } }

/** Ask App to open Preferences on a tab (the same modal the menu opens). */
export const OPEN_PREFERENCES_EVENT = 'jaketunes-open-preferences'
export function openPreferences(tab: 'Music Sources'): void {
  window.dispatchEvent(new CustomEvent(OPEN_PREFERENCES_EVENT, { detail: { tab } }))
}
