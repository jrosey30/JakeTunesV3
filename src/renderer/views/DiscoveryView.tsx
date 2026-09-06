import { useState } from 'react'
import NewForYouView from './NewForYouView'
import ListenToTheListView from './ListenToTheListView'
import { useShopList } from '../record-shop/useShopSession'
import '../styles/discovery.css'

// Backlog 2026-06-06 — "Discovery" merges the two discovery surfaces behind
// ONE sidebar entry: the AI radar ("New for You") and your saved jots
// ("Your List" = Listen to the List). Each tab renders its existing view
// unchanged — both already own their module caches + scroll containers, so
// the wrapper just toggles which one is mounted. Recolored teal (see the
// sidebar entry + discovery.css) so it reads cool vs. the Music Man's orange.

export type DiscoveryTab = 'new-for-you' | 'your-list'

// Remembered across remounts (MainContent unmounts views on navigation), so
// returning to Discovery keeps the tab you were last on.
let lastTab: DiscoveryTab = 'new-for-you'

export default function DiscoveryView({ initialTab }: { initialTab?: DiscoveryTab }) {
  const [tab, setTab] = useState<DiscoveryTab>(() => {
    if (initialTab) lastTab = initialTab
    return lastTab
  })
  const select = (t: DiscoveryTab) => { lastTab = t; setTab(t) }
  // The saved-item count on the Listen List tab (terminology map, 6.0 Record
  // Shop step 5): the same lean reader the Counter uses — no suggestion fetch.
  const { recs } = useShopList()

  // Literal labels (Record Shop structure proposal, step 5): what a tab IS.
  // "For You" = the AI picks (The Racks stays as the room's name, a subtitle);
  // "Listen List" = the saved items, with how many. Routes and tab ids are
  // unchanged; "At the Counter" now names acquisition activity (Step Inside).
  return (
    <div className="discovery">
      <div className="discovery-tabs" role="tablist" aria-label="Record Shop">
        <button
          role="tab"
          aria-selected={tab === 'new-for-you'}
          className={`discovery-tab ${tab === 'new-for-you' ? 'discovery-tab--on' : ''}`}
          onClick={() => select('new-for-you')}
        >For You<span className="discovery-tab__sub">The Racks</span></button>
        <button
          role="tab"
          aria-selected={tab === 'your-list'}
          className={`discovery-tab ${tab === 'your-list' ? 'discovery-tab--on' : ''}`}
          onClick={() => select('your-list')}
        >Listen List{recs.length > 0 && <span className="discovery-tab__count" aria-label={`${recs.length} saved`}>{recs.length.toLocaleString()}</span>}</button>
      </div>
      <div className="discovery-body">
        {tab === 'new-for-you' ? <NewForYouView /> : <ListenToTheListView />}
      </div>
    </div>
  )
}
