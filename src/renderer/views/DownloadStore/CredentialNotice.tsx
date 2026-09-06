import { useSyncExternalStore } from 'react'
import { subscribeCredentialNotice, getCredentialNotice, clearCredentialNotice, openPreferences } from './credential-notice-store'

/** The missing-account line under the search field: what stopped, and the
 *  one button that fixes it. Never blocks browsing or previews. */
export default function CredentialNotice() {
  const n = useSyncExternalStore(subscribeCredentialNotice, getCredentialNotice)
  if (!n) return null
  return (
    <div className="dl-cred-notice" role="status">
      <span className="dl-cred-notice-text"><b>{n.title}.</b> {n.body}</span>
      <button type="button" className="dl-cred-notice-btn" onClick={() => { openPreferences(n.action.preferencesTab); clearCredentialNotice() }}>{n.action.label}</button>
      <button type="button" className="dl-cred-notice-close" onClick={clearCredentialNotice} aria-label="Dismiss">✕</button>
    </div>
  )
}
