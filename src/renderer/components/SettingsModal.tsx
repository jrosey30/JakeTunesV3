import { useEffect, useState } from 'react'
import { AppSettings, DEFAULT_APP_SETTINGS, ImportFormatChoice } from '../types'
import { EQ_BAND_FREQUENCIES, EQ_PRESETS } from '../audio/eq'
import '../styles/import-convert.css'

/**
 * App-level user preferences. Tabbed layout (Playback / Library / Sync /
 * AI / About) so we can keep adding settings without ballooning a single
 * pane. Reuses the import-convert.css modal shell so we don't grow a
 * second visual vocabulary.
 *
 * Save flow: edits live in local state until user clicks Save. Cancel
 * discards. On Save we persist to app-settings.json. The Claude daily
 * ceiling is also propagated to claude-stats.json (the runtime store
 * the wrapper reads from on every call) so the change takes effect
 * without an app restart.
 */
interface Props {
  initial: AppSettings
  onClose: () => void
  onSaved: (next: AppSettings) => void
}

type Tab = 'Playback' | 'EQ' | 'Library' | 'Sync' | 'AI'
const TABS: Tab[] = ['Playback', 'EQ', 'Library', 'Sync', 'AI']

// Pretty Hz labels for the band frequencies (31, 62, 125, 250, 500,
// 1000, 2000, 4000, 8000, 16000). Anything ≥1k becomes "1k" / "16k".
function bandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

const FORMAT_OPTIONS: { value: ImportFormatChoice; label: string }[] = [
  { value: 'aac-128', label: 'AAC 128 kbps (small)' },
  { value: 'aac-256', label: 'AAC 256 kbps (default)' },
  { value: 'aac-320', label: 'AAC 320 kbps (high)' },
  { value: 'alac',    label: 'Apple Lossless (ALAC)' },
  { value: 'aiff',    label: 'AIFF (uncompressed)' },
  { value: 'wav',     label: 'WAV (uncompressed)' },
]

export default function SettingsModal({ initial, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<AppSettings>(initial)
  const [tab, setTab] = useState<Tab>('Playback')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setDraft(initial) }, [initial])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    const result = await window.electronAPI.saveAppSettings(draft as unknown as Record<string, unknown>)
    if (result.ok) {
      // Mirror the Claude daily ceiling into claude-stats.json so the
      // runtime wrapper picks it up immediately (no app restart needed).
      try {
        await window.electronAPI.setClaudeDailyCeiling?.(draft.ai.claudeDailyCeiling)
      } catch { /* non-fatal */ }
      setSaving(false)
      onSaved(draft)
    } else {
      setSaving(false)
      setError(result.error || 'Failed to save settings.')
    }
  }

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true" style={{ minWidth: 460 }}>
        <div className="imp-header">
          <h2>Preferences</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        {/* Tab strip */}
        <div style={{ display: 'flex', borderBottom: '1px solid #c4c4c4', background: '#e8e8e8' }}>
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: '8px 0',
                border: 'none',
                background: tab === t ? '#f5f5f5' : 'transparent',
                borderBottom: tab === t ? '2px solid #4a7fbf' : '2px solid transparent',
                fontSize: 12,
                fontWeight: tab === t ? 600 : 400,
                color: tab === t ? '#222' : '#555',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="imp-body" style={{ minHeight: 220 }}>
          {tab === 'Playback' && (
            <>
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
              <p className="imp-help" style={{ marginTop: 16 }}>
                Gapless playback (preload + instant start) is always on; no setting needed.
              </p>
            </>
          )}

          {tab === 'EQ' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.eq.enabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    eq: { ...draft.eq, enabled: e.target.checked },
                  })}
                />
                <span>Equalizer enabled</span>
              </label>

              <div style={{ opacity: draft.eq.enabled ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                <label style={{ display: 'block', fontSize: 12, color: '#3a3a3a', marginBottom: 4 }}>
                  Preset
                </label>
                <select
                  value={draft.eq.preset in EQ_PRESETS ? draft.eq.preset : 'Custom'}
                  disabled={!draft.eq.enabled}
                  onChange={(e) => {
                    const name = e.target.value
                    if (name === 'Custom') {
                      setDraft({ ...draft, eq: { ...draft.eq, preset: 'Custom' } })
                      return
                    }
                    const p = EQ_PRESETS[name]
                    if (!p) return
                    setDraft({
                      ...draft,
                      eq: {
                        ...draft.eq,
                        preset: name,
                        preamp: p.preamp,
                        bands: [...p.bands],
                      },
                    })
                  }}
                  style={{ width: '100%', padding: 6, fontSize: 13, marginBottom: 16 }}
                >
                  {Object.keys(EQ_PRESETS).map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                  <option value="Custom">Custom</option>
                </select>

                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 180, paddingBottom: 4, borderBottom: '1px solid #d0d0d0' }}>
                  {/* Preamp */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                    <span style={{ fontSize: 10, color: '#555', minHeight: 12 }}>
                      {draft.eq.preamp > 0 ? `+${draft.eq.preamp}` : draft.eq.preamp} dB
                    </span>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={1}
                      value={draft.eq.preamp}
                      disabled={!draft.eq.enabled}
                      onChange={(e) => setDraft({
                        ...draft,
                        eq: { ...draft.eq, preamp: Number(e.target.value), preset: 'Custom' },
                      })}
                      style={{
                        writingMode: 'vertical-lr',
                        WebkitAppearance: 'slider-vertical',
                        appearance: 'slider-vertical',
                        width: 22,
                        height: 130,
                        margin: 0,
                      } as unknown as React.CSSProperties}
                    />
                    <span style={{ fontSize: 9, color: '#777', marginTop: 2, fontWeight: 600 }}>Preamp</span>
                  </div>

                  {/* Divider */}
                  <div style={{ width: 1, height: 130, background: '#d0d0d0', alignSelf: 'center' }} />

                  {/* 10 bands */}
                  {EQ_BAND_FREQUENCIES.map((hz, i) => {
                    const value = draft.eq.bands[i] ?? 0
                    return (
                      <div key={hz} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                        <span style={{ fontSize: 10, color: '#555', minHeight: 12 }}>
                          {value > 0 ? `+${value}` : value}
                        </span>
                        <input
                          type="range"
                          min={-12}
                          max={12}
                          step={1}
                          value={value}
                          disabled={!draft.eq.enabled}
                          onChange={(e) => {
                            const next = [...draft.eq.bands]
                            next[i] = Number(e.target.value)
                            setDraft({
                              ...draft,
                              eq: { ...draft.eq, bands: next, preset: 'Custom' },
                            })
                          }}
                          style={{
                            writingMode: 'vertical-lr',
                            WebkitAppearance: 'slider-vertical',
                            appearance: 'slider-vertical',
                            width: 22,
                            height: 130,
                            margin: 0,
                          } as unknown as React.CSSProperties}
                        />
                        <span style={{ fontSize: 9, color: '#777', marginTop: 2 }}>{bandLabel(hz)}</span>
                      </div>
                    )
                  })}
                </div>

                <p className="imp-help" style={{ marginTop: 14 }}>
                  Range −12 dB to +12 dB. Toggling EQ on or off mid-track applies to the next song;
                  preset and slider changes apply immediately.
                </p>
                <p className="imp-help" style={{ marginTop: 4, fontSize: 10, color: '#888' }}>
                  Bands: 31, 62, 125, 250, 500 Hz · 1k, 2k, 4k, 8k, 16k Hz
                </p>
              </div>
            </>
          )}

          {tab === 'Library' && (
            <>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Default import format
              </label>
              <select
                value={draft.library.defaultImportFormat}
                onChange={(e) => setDraft({
                  ...draft,
                  library: { defaultImportFormat: e.target.value as ImportFormatChoice },
                })}
                style={{ width: '100%', padding: 6, fontSize: 13 }}
              >
                {FORMAT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="imp-help" style={{ marginTop: 10 }}>
                Applied when you drag-drop or use Import. Existing tracks aren't re-encoded.
              </p>
            </>
          )}

          {tab === 'Sync' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.sync.autoSyncOnConnect}
                  onChange={(e) => setDraft({
                    ...draft,
                    sync: { ...draft.sync, autoSyncOnConnect: e.target.checked },
                  })}
                />
                <span>Automatically sync to iPod when connected</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.sync.autoRemoveDeletedFromIpod}
                  onChange={(e) => setDraft({
                    ...draft,
                    sync: { ...draft.sync, autoRemoveDeletedFromIpod: e.target.checked },
                  })}
                />
                <span>Automatically remove deleted tracks from iPod</span>
              </label>
              <p className="imp-help" style={{ marginTop: 10 }}>
                When off, both flows still work — they just require an explicit click. Turn on for set-and-forget syncing.
              </p>
            </>
          )}

          {tab === 'AI' && (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={draft.ai.musicManVoiceEnabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    ai: { ...draft.ai, musicManVoiceEnabled: e.target.checked },
                  })}
                />
                <span>Music Man voice (ElevenLabs)</span>
              </label>
              <p className="imp-help" style={{ marginTop: 0, marginBottom: 16 }}>
                When off, Music Man chats in text only. Saves ElevenLabs credits on quiet days.
              </p>

              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: '#3a3a3a' }}>
                Daily Claude API call ceiling
              </label>
              <input
                type="number"
                min={1}
                max={10000}
                step={10}
                value={draft.ai.claudeDailyCeiling}
                onChange={(e) => setDraft({
                  ...draft,
                  ai: { ...draft.ai, claudeDailyCeiling: Math.max(1, Math.min(10000, Number(e.target.value) || DEFAULT_APP_SETTINGS.ai.claudeDailyCeiling)) },
                })}
                style={{ width: 120, padding: 6, fontSize: 13 }}
              />
              <p className="imp-help" style={{ marginTop: 10 }}>
                Hard cap on how many Claude calls JakeTunes makes per day. After hitting the ceiling, fallback uses the most recent cached response.
              </p>
            </>
          )}

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
