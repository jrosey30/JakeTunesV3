/**
 * NewMixtapeSheet — THE front door (Jake chose "one front door"): a
 * single entry that asks one question —
 *   RECORD IT YOURSELF  → blank tape straight into the deck (you drive)
 *   MUSIC MAN DEALS IT  → pick the songs (a playlist, or what you have
 *                         selected) → he sequences a finished tape you
 *                         can tweak on the deck sheet and dub.
 * Every other mixtape entrance collapses into this.
 */
import { useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import BlankTapeSheet from './BlankTapeSheet'
import MixtapeSheet from './MixtapeSheet'
import type { Track } from '../types'
import '../styles/activity-sheet.css'
import '../styles/mixtape.css'

interface Props {
  onClose: () => void
}

type Stage = 'choose' | 'blank' | 'source' | 'deal'

export default function NewMixtapeSheet({ onClose }: Props) {
  const { state } = useLibrary()
  const [stage, setStage] = useState<Stage>('choose')
  const [dealTracks, setDealTracks] = useState<Track[] | null>(null)

  const selectedTracks = useMemo(
    () => state.tracks.filter((t) => state.selectedTrackIds.has(t.id)),
    [state.tracks, state.selectedTrackIds],
  )
  const byId = useMemo(() => new Map(state.tracks.map((t) => [t.id, t])), [state.tracks])
  const pickablePlaylists = useMemo(
    () => state.playlists.filter((pl) => pl.category !== 'synced-set' && (pl.trackIds?.length || 0) >= 2),
    [state.playlists],
  )

  if (stage === 'blank') return <BlankTapeSheet onClose={onClose} />
  if (stage === 'deal' && dealTracks) return <MixtapeSheet tracks={dealTracks} onClose={onClose} />

  return (
    <div className="activity-sheet-overlay" role="dialog" aria-modal="true" aria-label="New mixtape">
      <div className="activity-sheet mixsheet mixsheet--blank">
        {stage === 'choose' && (
          <>
            <div className="activity-sheet-head">
              <h2 className="activity-sheet-title">New mixtape</h2>
              <p className="activity-sheet-sub">Two ways to make a tape. Both end up on the same shelf.</p>
            </div>
            <div className="newmix-doors">
              <button type="button" className="newmix-door" onClick={() => setStage('blank')}>
                <span className="newmix-door-title">Record it yourself</span>
                <span className="newmix-door-desc">
                  A blank tape goes in the deck. Press REC, play music, talk on the mic — the tape catches what you play, in order, until the sides run out.
                </span>
              </button>
              <button type="button" className="newmix-door" onClick={() => setStage('source')}>
                <span className="newmix-door-title">Music Man deals it</span>
                <span className="newmix-door-desc">
                  Hand him songs — a playlist, or whatever you've selected — and he sequences a finished tape with liner notes. You tweak it on the deck, then dub.
                </span>
              </button>
            </div>
            <div className="activity-sheet-actions">
              <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {stage === 'source' && (
          <>
            <div className="activity-sheet-head">
              <h2 className="activity-sheet-title">What does he get?</h2>
              <p className="activity-sheet-sub">The songs Music Man makes the tape from.</p>
            </div>
            <div className="newmix-sources">
              {selectedTracks.length >= 2 && (
                <button type="button" className="newmix-source" onClick={() => { setDealTracks(selectedTracks); setStage('deal') }}>
                  <span className="newmix-source-name">The {selectedTracks.length} songs I have selected</span>
                </button>
              )}
              {pickablePlaylists.map((pl) => {
                const tracks = (pl.trackIds || []).map((id) => byId.get(id)).filter((t): t is Track => !!t)
                return (
                  <button key={pl.id} type="button" className="newmix-source"
                    onClick={() => { setDealTracks(tracks); setStage('deal') }}>
                    <span className="newmix-source-name">{pl.name}</span>
                    <span className="newmix-source-count">{tracks.length} songs</span>
                  </button>
                )
              })}
              {selectedTracks.length < 2 && pickablePlaylists.length === 0 && (
                <p className="mixsheet-error">No playlists with 2+ songs and nothing selected — select some songs first.</p>
              )}
            </div>
            <div className="activity-sheet-actions">
              <button type="button" className="activity-btn activity-btn--ghost" onClick={() => setStage('choose')}>Back</button>
              <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
