/**
 * The Genres page: "Browse" is the original column browser (GenresView,
 * untouched — it's on the do-not-touch list), "Icebergs" is the genre
 * iceberg (2026-10-11, Jake chose the Genres page as its home).
 */
import { useState } from 'react'
import GenresView from './GenresView'
import GenreIcebergView from './GenreIcebergView'

type Mode = 'browse' | 'icebergs'
let lastMode: Mode = 'browse'

export default function GenresPage(): JSX.Element {
  const [mode, setMode] = useState<Mode>(lastMode)
  const pick = (m: Mode): void => { lastMode = m; setMode(m) }
  return (
    <div className="genres-page">
      <div className="genres-page__toggle" role="tablist" aria-label="Genres">
        {(['browse', 'icebergs'] as Mode[]).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={`genres-page__tab${mode === m ? ' genres-page__tab--on' : ''}`} onClick={() => pick(m)}>
            {m === 'browse' ? 'Browse' : 'Icebergs'}
          </button>
        ))}
      </div>
      <div className="genres-page__body">{mode === 'browse' ? <GenresView /> : <GenreIcebergView />}</div>
    </div>
  )
}
