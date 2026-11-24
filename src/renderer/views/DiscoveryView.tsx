import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import NewForYouView from './NewForYouView'
import ListenToTheListView from './ListenToTheListView'
import DownloadView from './DownloadStore/DownloadView'
import StoreView from './BandcampStore'
import { useShopList } from '../record-shop/useShopSession'
import { DISCOVERY_TAB_EVENT, SHOP_TABS, rememberDiscoveryTab, rememberedDiscoveryTab, type DiscoveryTab } from './discoveryTab'
import { getShopQuery, setShopQuery, shopSearching, subscribeShopQuery, typingOpensSearch } from './DownloadStore/shopQuery'
import { SHOP_WORDS } from '../../common/shop-names'
import '../styles/discovery.css'

// The Record Shop (view id 'discovery'): a title and one search box, then the
// tabs. Each tab renders its own view, which owns its module cache and scroll
// container, so this only toggles which one is mounted.

export type { DiscoveryTab }

// The tab is remembered across remounts in ./discoveryTab (MainContent
// unmounts views on navigation), so returning to Discovery keeps the tab you
// were last on — and other views can ask for one (Browse) before navigating.
export default function DiscoveryView({ initialTab }: { initialTab?: DiscoveryTab }) {
  const [tab, setTab] = useState<DiscoveryTab>(() => {
    if (initialTab) rememberDiscoveryTab(initialTab)
    return rememberedDiscoveryTab()
  })
  const select = (t: DiscoveryTab) => { rememberDiscoveryTab(t); setTab(t) }
  useEffect(() => {
    const onRequest = (e: Event) => setTab((e as CustomEvent<DiscoveryTab>).detail)
    window.addEventListener(DISCOVERY_TAB_EVENT, onRequest)
    return () => window.removeEventListener(DISCOVERY_TAB_EVENT, onRequest)
  }, [])
  // The saved-item count on the Listening List tab: the same lean reader the
  // Counter uses (no suggestion fetch).
  const { recs } = useShopList()

  // The one search box (Jake's approved picture, 2026-11-24): at the top of
  // the shop on every tab. Typing brings the Search tab forward; the words
  // live in shopQuery.ts, where the Search tab reads them.
  const query = useSyncExternalStore(subscribeShopQuery, getShopQuery)
  const searching = useSyncExternalStore(subscribeShopQuery, shopSearching)
  const boxRef = useRef<HTMLInputElement>(null)
  const type = (words: string): void => {
    setShopQuery(words, 'typed')
    if (typingOpensSearch(words) && tab !== 'browse') select('browse')
  }
  // Opening Search puts the cursor in the box, as the tab's own box did.
  useEffect(() => { if (tab === 'browse') boxRef.current?.focus() }, [tab])

  return (
    <div className="discovery">
      <div className="discovery-head">
        <h1 className="discovery-title">{SHOP_WORDS.shop}</h1>
        <div className="dl-field discovery-search">
          <svg className="dl-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            ref={boxRef}
            className="dl-input"
            value={query}
            onChange={(e) => type(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && query.trim() && tab !== 'browse') select('browse') }}
            placeholder="Search a song, album or artist"
            aria-label="Search the Record Shop"
            spellCheck={false}
          />
          {searching && <span className="dl-spinner dl-field-spin" aria-hidden="true" />}
          {!searching && query && <button type="button" className="dl-field-clear" onClick={() => { setShopQuery('', 'typed'); boxRef.current?.focus() }} title="Clear">✕</button>}
        </div>
      </div>
      <div className="discovery-tabs" role="tablist" aria-label={SHOP_WORDS.shop}>
        {/* For You (the AI picks), Search (the catalogue; tab id 'browse'),
            the Listening List (saved items, with how many) and Bandcamp (the
            real site, a tab and not a door of its own). Rock DNA left the tabs
            on 2026-11-09: its page is linked from the For You strip. */}
        {SHOP_TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`discovery-tab ${tab === id ? 'discovery-tab--on' : ''}`}
            onClick={() => select(id)}
          >{label}{id === 'your-list' && recs.length > 0 && <span className="discovery-tab__count" aria-label={`${recs.length} saved`}>{recs.length.toLocaleString()}</span>}</button>
        ))}
      </div>
      <div className="discovery-body">
        {tab === 'new-for-you' ? <NewForYouView />
          : tab === 'browse' ? <DownloadView />
            : tab === 'bandcamp' ? <StoreView />
              : <ListenToTheListView />}
      </div>
    </div>
  )
}
