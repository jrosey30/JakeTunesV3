/**
 * The Year in Review on the Home page (Jake 10/11: "Home page card"): the
 * year so far until December 17, then the reveal. Hidden until this Mac has
 * the nightly facts.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirHomeCard.swift (the phone's Home card).
 */
import { useLibrary } from '../../context/LibraryContext'
import { useYirFacts } from './yirData'
import { setYirMode, type YirMode } from './yirNav'
import { isRevealed, n } from '../../../common/yir-story'
import '../../styles/year-in-review.css'

export default function YirHomeCard(): JSX.Element | null {
  const { dispatch } = useLibrary()
  const year = new Date().getFullYear()
  const { facts } = useYirFacts(year)
  if (!facts || facts.totals.plays === 0) return null
  const revealed = isRevealed(year, new Date())
  const open = (mode: YirMode): void => { setYirMode(mode); dispatch({ type: 'SET_VIEW', view: 'year-in-review' }) }
  const yy = String(year)
  return (
    <section className={`yir-home${revealed ? ' yir-home--revealed' : ''}`} aria-label="Year in Review">
      <div className="yir-home-year" aria-hidden="true">{yy.slice(0, 2)}<span>{yy.slice(2)}</span></div>
      <div className="yir-home-copy">
        <div className="yir-home-eyebrow">Year in Review</div>
        <div className="yir-home-title">{revealed ? `Your ${year} is here.` : `${year}, so far.`}</div>
        <div className="yir-home-stats">
          {n(facts.totals.plays)} songs · {n(Math.round(facts.totals.minutes / 60))} hours · {n(facts.totals.daysListened)} days with music
        </div>
        {!revealed && <div className="yir-home-sub">The full reveal is December 17.</div>}
      </div>
      <div className="yir-home-actions">
        <button type="button" className="home-featured-btn home-featured-btn--primary" onClick={() => open('story')}>Play the story</button>
        <button type="button" className="home-featured-btn" onClick={() => open('page')}>See it all</button>
      </div>
    </section>
  )
}
