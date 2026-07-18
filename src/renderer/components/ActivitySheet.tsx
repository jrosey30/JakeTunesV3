import { useEffect, useState } from 'react'
import '../styles/activity-sheet.css'

export type ActivityKind = 'bop' | 'run' | 'ski' | 'lift' | 'bike' | 'walk' | 'hike' | 'other'
export type Intensity = 'easy' | 'medium' | 'hard'
export type SettingKind = 'city' | 'trail' | 'gym' | 'mountain' | 'indoors' | 'water'
export type SocialKind = 'solo' | 'friends'

export interface ActivityBrief {
  id?: string
  profileName?: string
  activity: ActivityKind
  intensity: Intensity
  setting: SettingKind
  place: string
  social: SocialKind
  note?: string
}

interface SavedProfile extends ActivityBrief {
  id: string
  profileName: string
}

interface Props {
  initial?: ActivityBrief | null
  onConfirm: (brief: ActivityBrief) => void
  onCancel: () => void
  onFullLibrary?: () => void
}

const ACTIVITIES: { id: ActivityKind; label: string }[] = [
  { id: 'bop', label: 'Bopping Around' },
  { id: 'run', label: 'Run' },
  { id: 'ski', label: 'Ski' },
  { id: 'lift', label: 'Lift' },
  { id: 'bike', label: 'Bike' },
  { id: 'hike', label: 'Hike' },
  { id: 'walk', label: 'Walk' },
  { id: 'other', label: 'Other' },
]
const INTENSITIES: { id: Intensity; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
]
const SETTINGS: { id: SettingKind; label: string }[] = [
  { id: 'city', label: 'City' },
  { id: 'trail', label: 'Trail' },
  { id: 'gym', label: 'Gym' },
  { id: 'mountain', label: 'Mountain' },
  { id: 'indoors', label: 'Indoors' },
  { id: 'water', label: 'Water' },
]

const DEFAULT: ActivityBrief = {
  activity: 'bop',
  intensity: 'medium',
  setting: 'city',
  place: 'Brooklyn',
  social: 'solo',
  note: '',
}

export default function ActivitySheet({ initial, onConfirm, onCancel, onFullLibrary }: Props) {
  const [brief, setBrief] = useState<ActivityBrief>(initial || DEFAULT)
  const [profiles, setProfiles] = useState<SavedProfile[]>([])
  const [weatherLine, setWeatherLine] = useState<string | null>(null)
  const [weatherBusy, setWeatherBusy] = useState(false)

  useEffect(() => {
    window.electronAPI.getActivityProfiles?.().then((r) => {
      if (r?.ok && r.profiles) setProfiles(r.profiles as SavedProfile[])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const place = brief.place.trim()
    if (place.length < 2) { setWeatherLine(null); return }
    let cancelled = false
    setWeatherBusy(true)
    const t = setTimeout(() => {
      window.electronAPI.previewPlaceWeather?.(place).then((r) => {
        if (cancelled) return
        if (r?.weather) {
          const w = r.weather
          setWeatherLine(`${w.placeLabel || place}: ${w.tempF}°F, ${w.description || w.condition}`)
        } else {
          setWeatherLine(null)
        }
      }).catch(() => { if (!cancelled) setWeatherLine(null) })
        .finally(() => { if (!cancelled) setWeatherBusy(false) })
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [brief.place])

  const set = <K extends keyof ActivityBrief>(key: K, value: ActivityBrief[K]) => {
    setBrief((b) => ({ ...b, [key]: value }))
  }

  return (
    <div className="activity-sheet-overlay" role="dialog" aria-modal="true" aria-label="Activity sync">
      <div className="activity-sheet">
        <div className="activity-sheet-head">
          <h2 className="activity-sheet-title">What are you doing?</h2>
          <p className="activity-sheet-sub">
            Music Man builds ~1,000 tracks for this — weather and place included. Songs land at your convert setting.
            “Bopping Around” is everyday listening: hanging out, commuting, errands.
          </p>
        </div>

        {profiles.length > 0 && (
          <div className="activity-profiles">
            <span className="activity-q-label">Saved</span>
            <div className="activity-chips">
              {profiles.slice(0, 6).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="activity-chip"
                  onClick={() => setBrief({ ...p })}
                >{p.profileName}</button>
              ))}
            </div>
          </div>
        )}

        <div className="activity-q">
          <span className="activity-q-label">Activity</span>
          <div className="activity-chips">
            {ACTIVITIES.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`activity-chip${brief.activity === a.id ? ' is-on' : ''}`}
                onClick={() => set('activity', a.id)}
              >{a.label}</button>
            ))}
          </div>
        </div>

        <div className="activity-q">
          <span className="activity-q-label">Intensity</span>
          <div className="activity-chips">
            {INTENSITIES.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`activity-chip${brief.intensity === a.id ? ' is-on' : ''}`}
                onClick={() => set('intensity', a.id)}
              >{a.label}</button>
            ))}
          </div>
        </div>

        <div className="activity-q">
          <span className="activity-q-label">Setting</span>
          <div className="activity-chips">
            {SETTINGS.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`activity-chip${brief.setting === a.id ? ' is-on' : ''}`}
                onClick={() => set('setting', a.id)}
              >{a.label}</button>
            ))}
          </div>
        </div>

        <div className="activity-q">
          <span className="activity-q-label">Where</span>
          <input
            className="activity-place"
            value={brief.place}
            onChange={(e) => set('place', e.target.value)}
            placeholder="Prospect Park, Brooklyn"
            spellCheck={false}
          />
          <div className="activity-weather">
            {weatherBusy ? 'Checking weather…' : weatherLine || 'Weather loads from the place name'}
          </div>
        </div>

        <div className="activity-q">
          <span className="activity-q-label">With</span>
          <div className="activity-chips">
            <button
              type="button"
              className={`activity-chip${brief.social === 'solo' ? ' is-on' : ''}`}
              onClick={() => set('social', 'solo')}
            >Solo</button>
            <button
              type="button"
              className={`activity-chip${brief.social === 'friends' ? ' is-on' : ''}`}
              onClick={() => set('social', 'friends')}
            >Friends</button>
          </div>
        </div>

        <div className="activity-q">
          <span className="activity-q-label">Anything else?</span>
          <input
            className="activity-place"
            value={brief.note || ''}
            onChange={(e) => set('note', e.target.value)}
            placeholder="Optional — no lyrics, 90s hip-hop, keep it under 160 BPM…"
          />
        </div>

        <div className="activity-sheet-actions">
          <button type="button" className="activity-btn activity-btn--ghost" onClick={onCancel}>Cancel</button>
          {onFullLibrary && (
            <button type="button" className="activity-btn activity-btn--ghost" onClick={onFullLibrary} title="Skip the activity set — mirror the ENTIRE library to the iPod at your convert setting">
              Whole library instead
            </button>
          )}
          <button
            type="button"
            className="activity-btn activity-btn--go"
            onClick={() => onConfirm({ ...brief, place: brief.place.trim() || 'Brooklyn' })}
          >Build set & sync</button>
        </div>
      </div>
    </div>
  )
}
