import { useEffect, useState } from 'react'
import { AppSettings, DEFAULT_APP_SETTINGS } from '../types'
import '../styles/import-convert.css'

/**
 * App-level user preferences. Currently one section (Playback) with
 * the crossfade toggle. Reuses the import-convert.css modal styles so
 * we don't sprout a new visual vocabulary for every modal.
 *
 * Save flow: edits live in local state until user clicks Save. Cancel
 * discards. On Save we persist to app-settings.json and notify the
 * renderer's audio layer via window event so playback applies the new
 * setting immediately (no app restart needed).
 */
interface Props {
  initial: AppSettings
  onClose: () => void
  onSaved: (next: AppSettings) => void
}

export default function SettingsModal({ initial, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<AppSettings>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync draft if initial changes (modal re-opened with fresh values)
  useEffect(() => { setDraft(initial) }, [initial])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    const result = await window.electronAPI.saveAppSettings(draft as unknown as Record<string, unknown>)
    setSaving(false)
    if (result.ok) {
      onSaved(draft)
    } else {
      setError(result.error || 'Failed to save settings.')
    }
  }

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true">
        <div className="imp-header">
          <h2>Preferences</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="imp-body">
          <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 14, color: '#3a3a3a' }}>Playback</h3>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <input
              type="checkbox"
              checked={draft.crossfade.enabled}
              onChange={(e) => setDraft({
                ...draft,
                crossfade: { ...draft.crossfade, enabled: e.target.checked },
              })}
            />
            <span>Crossfade Songs</span>
          </label>

          <div style={{ opacity: draft.crossfade.enabled ? 1 : 0.4, transition: 'opacity 0.15s' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: '#555', minWidth: 30 }}>1 sec</span>
              <input
                type="range"
                min={1}
                max={12}
                step={1}
                value={draft.crossfade.seconds}
                disabled={!draft.crossfade.enabled}
                onChange={(e) => setDraft({
                  ...draft,
                  crossfade: { ...draft.crossfade, seconds: Number(e.target.value) || DEFAULT_APP_SETTINGS.crossfade.seconds },
                })}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, color: '#555', minWidth: 40, textAlign: 'right' }}>12 sec</span>
            </div>
            <div style={{ textAlign: 'center', fontSize: 12, color: '#3a3a3a' }}>
              {draft.crossfade.seconds} second{draft.crossfade.seconds === 1 ? '' : 's'}
            </div>
          </div>

          {error && (
            <div className="imp-result imp-result--error" style={{ marginTop: 16 }}>{error}</div>
          )}
        </div>

        <div className="imp-footer">
          <button className="imp-btn imp-btn--cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="imp-btn imp-btn--start" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
