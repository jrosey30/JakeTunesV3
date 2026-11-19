/**
 * Album covers on the Device page: one plain line when the last sync put no
 * covers on a colour iPod, and the one question when JakeTunes doesn't know
 * which iPod this is (nothing on the iPod names its model). The answer is
 * kept with this iPod (main/ipod-artwork.ts rememberArtworkFamily) and the
 * next sync uses it. Covers never stop the music, so this never blocks Sync.
 */
import { useEffect, useState } from 'react'

export interface IpodArtworkSummary {
  images: number
  model: string | null
  ask: boolean
  skipped: string | null
}

export default function IpodArtworkAsk({ artwork }: { artwork: IpodArtworkSummary | undefined | null }) {
  const [families, setFamilies] = useState<Array<{ family: string; name: string }>>([])
  const [answered, setAnswered] = useState<string | null>(null)
  const ask = artwork?.ask === true
  useEffect(() => {
    if (!ask || families.length > 0) return
    void window.electronAPI.ipodArtworkFamilies?.().then((f) => setFamilies(f ?? [])).catch(() => undefined)
  }, [ask, families.length])

  if (!artwork) return null
  if (answered) return <span>Got it. Covers go on next sync.</span>
  if (ask) {
    const pick = (family: string) => {
      void window.electronAPI.rememberIpodArtworkFamily?.(family)
        .then((r) => { if (r?.ok) setAnswered(family) })
        .catch(() => undefined)
    }
    return (
      <span role="group" aria-label="Which iPod is this?">
        No covers yet. Which iPod is this?{' '}
        {families.map((f) => (
          <span key={f.family}>
            <button type="button" className="device-link-btn" onClick={() => pick(f.family)}>{f.name}</button>{' · '}
          </span>
        ))}
        <button type="button" className="device-link-btn" onClick={() => pick('none')}>No colour screen</button>
      </span>
    )
  }
  if (artwork.skipped) return <span>No covers this time: {artwork.skipped}.</span>
  return null
}
