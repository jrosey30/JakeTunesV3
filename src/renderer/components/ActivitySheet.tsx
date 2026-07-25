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
  /** How many songs to put on the iPod this sync. Default 1,000. */
  target?: number
}

interface SavedProfile extends ActivityBrief {
  id: string
  profileName: string
}

interface Props {
  initial?: ActivityBrief | null
  onConfirm: (brief: ActivityBrief) => void
  onCancel: () => void
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
const SIZES: { id: number; label: string }[] = [
  { id: 100, label: '100' },
  { id: 250, label: '250' },
  { id: 500, label: '500' },
  { id: 1000, label: '1,000' },
]
const DEFAULT_TARGET = 1000

const DEFAULT: ActivityBrief = {
  activity: 'bop',
  intensity: 'medium',
  setting: 'city',
  place: 'Brooklyn',
  social: 'solo',
  note: '',
  target: DEFAULT_TARGET,
}

export default function ActivitySheet({ initial, onConfirm, onCancel }: Props) {
  const [brief, setBrief] = useState<ActivityBrief>(initial || DEFAULT)
  const [profiles, setProfiles] = useState<SavedProfile[]>([])
  const [weatherLine, setWeatherLine] = useState<string | null>(null)
  const [weatherBusy, setWeatherBusy] = useState(false)
  // 2026-07-24 (Jake: "easier to use"). The sheet asked five questions every
  // time. Only "how many" and "what are you doing" change the set materially;
  // intensity/place/steer are refinements. They stay one tap away — and open
  // automatically if a previous brief had actually set them, so nothing a user
  // configured ever silently hides.
  const [showMore, setShowMore] = useState<boolean>(
    Boolean(initial?.note) || Boolean(initial?.place && initial.place !== DEFAULT.place),
  )

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
            Music Man reads your taste — what you star and play most — and builds a set that fits both
            you and what you’re doing. Songs land at your convert setting.
            “Bopping Around” is everyday listening: hanging out, commuting, errands.
          </p>
        </div>

        <div className="activity-q">
          <span className="activity-q-label">How many songs</span>
          <div className="activity-chips">
            {SIZES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`activity-chip${(brief.target ?? DEFAULT_TARGET) === s.id ? ' is-on' : ''}`}
                onClick={() => set('target', s.id)}
              >{s.label}</button>
            ))}
          </div>
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

        {!showMore && (
          <button
            type="button"
            className="activity-more-toggle"
            onClick={() => setShowMore(true)}
          >Fine-tune — intensity, place, steer the vibe</button>
        )}

        {showMore && (<>
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
          <span className="activity-q-label">Steer the vibe</span>
          <input
            className="activity-place"
            value={brief.note || ''}
            onChange={(e) => set('note', e.target.value)}
            placeholder="90s hip-hop, no lyrics, funky, keep it moving…"
          />
          <div className="activity-weather">
            The brain reads this — the more specific, the better the picks.
          </div>
        </div>
        </>)}

        <div className="activity-sheet-actions">
          <button type="button" className="activity-btn activity-btn--ghost" onClick={onCancel}>Cancel</button>
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
