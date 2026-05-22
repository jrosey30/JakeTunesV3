# Brief 036 v2.2 — JakeTunes Bandcamp Store (iTunes Store UI + Library + Bandcamp Personalization)

**From:** Dex Desktop, co-COO
**To:** Claude Code (executor)
**Status:** Ready to execute. Audit-then-run discipline — audit phase MANDATORY before implementation.
**Priority:** P1 — flagship feature with personalization layer that meaningfully exceeds Bandcamp's own discovery surfaces.
**Repo:** `/Users/jacobrosenbaum/JakeTunesV3/`
**Estimated scope:** Audit ~1.5 days. Phased implementation 10-15 days. Total ~3 weeks.

**Supersedes Brief 036 v1, v2, and v2.1.** v1 specified iTunes Store visual fidelity with Bandcamp as data source. v2 added the personalization layer as a first-class architectural concern. v2.1 expanded personalization signals to include the JakeTunes library (~6,500 tracks) alongside the Bandcamp profile. **v2.2 incorporates Claude Code's Phase 0 audit findings:**

- Path scheme `<Artist>/<Album>/<TrackNumber>` was wrong — actual library uses iPod hashed-folder layout (`MUSIC_DIR/F{id%50}/imported_{id}.{ext}`). All downloads now route through the existing `importOneFile()` primitive (`src/main/index.ts:2173`), which handles dedupe-fingerprinting, format conversion, tag embedding, collision-safe IDs.
- Library has no `label` field, no geographic data, and `genre` is a single string (not a tag array). Label/geo surfaces are Bandcamp-only at launch. "Discover Labels From Your Library" surface dropped from v1 scope.
- Library DOES have `playCount`, `rating`, `lastPlayedAt`, `skipCount` — engagement-weighted ranking is now first-class Tier 1, not deferred.
- Auth: persistent Electron session partition (`persist:bandcamp`) on `WebContentsView` instead of Keychain/safeStorage. Cookies persist automatically; no manual token storage.
- Phase 0 on-device spike inserted between audit approval and Phase 1 to verify the four unverifiable Bandcamp unknowns.

---

## Context

JakeTunes needs a built-in music store. Bandcamp is the source: DRM-free FLAC/ALAC/MP3, artists paid fairly, your purchases are yours forever, clean legal posture.

Two product mandates from Jake:

1. **Visual fidelity:** the Store must look like the iTunes Store, not "inspired by" it. Real recreation — colors, typography, button styles, layout proportions all matching iTunes Store circa 2008-2010 (light theme, blue accents `#2c5aa0`, Lucida Grande typography, gridded album art, rounded gradient buttons, carousel banner).

2. **Personalization that beats Bandcamp's own:** Bandcamp's discovery is editorial + tag-filtered + global-popularity-sorted, NOT personalized. Their homepage is the same for everyone. Using Jake's authenticated account data (collection, wishlist, follows, label purchases, tag affinities) the JakeTunes Store must surface recommendations that are meaningfully better than what Bandcamp shows him in their own UI.

This isn't a Bandcamp browser. This is "Bandcamp's catalog presented through an iTunes Store UI, personalized to Jake's taste in a way Bandcamp itself doesn't bother to do."

## Constraints (Locked By Jake)

1. **Source service:** Bandcamp only. Single, focused integration.
2. **Visual target:** iTunes Store 2008-2010 era. Light theme, blue accents, Lucida Grande / system sans-serif fallback, gridded album art, rounded gradient buttons. Real fidelity, not inspiration.
3. **Catalog access:** Full Bandcamp catalog browsable and searchable.
4. **Authentication required:** Jake authenticates to Bandcamp inside JakeTunes. This auth is the unlock for personalization. Without it, the Store still works in a "generic Bandcamp browsing" mode but personalization is disabled.
5. **Personalization is a MANDATE, not optional.** Driven by TWO data sources, treated as co-equal:

   **A. JakeTunes library** (`library.json` — authoritative collection signal, ~6,500 tracks):
   - Artists, albums, tracks Jake owns across all sources (iPod imports, Bandcamp purchases, ripped CDs, etc.)
   - Genre tags / metadata across his collection
   - Labels (where present in metadata)
   - Release year patterns
   - Track density per artist (depth of interest)
   - Play history if tracked by JakeTunes (audit will determine)
   - Favorites / ratings if present (audit will determine)

   **B. Bandcamp profile** (intent / discovery signal):
   - Collection (Bandcamp purchases)
   - Wishlist — items signaling interest but not yet bought
   - Following list — artists Jake tracks
   - Label affinity — Bandcamp-specific label purchase patterns
   - Tag frequency — across Bandcamp purchases

   Signals are computed across BOTH sources and merged into a unified taste profile. The library is the deeper authoritative signal (it's what Jake actually keeps and engages with); the Bandcamp profile adds intent/discovery dimensions the library can't.
6. **Purchase flow:** routes through Bandcamp's authenticated checkout. After purchase, downloaded files route through the existing `importOneFile()` primitive (`src/main/index.ts:2173`), which handles dedupe via `audioFingerprint`, format conversion (FLAC/ALAC→AAC if configured), tag embedding, and placement at the iPod hashed-folder layout (`MUSIC_DIR/F{id%50}/imported_{id}.{ext}`) with colon-style paths in library.json. Album ZIPs unzip → per-file `importOneFile()` calls. **Do not invent a new path scheme.**
7. **Privacy:** all profile data stays local. No external services contacted with Jake's profile data. Same data Bandcamp itself has; just used on Jake's behalf in his app.

## Architecture (Four Layers)

### Layer 1 — UI (`src/renderer/views/BandcampStore/`)
React components, iTunes Store visual vocabulary. Pure presentation. Receives data from layer 3 (data) and layer 2 (personalization).

### Layer 2 — Personalization (`src/main/bandcamp-integration/personalization/`)
Reads Jake's profile data from TWO sources: (a) the JakeTunes library data (`library.json` + metadata-overrides + any play history), and (b) Jake's authenticated Bandcamp profile data. Merges signals across both into a unified taste profile, produces ranked recommendation lists for each UI surface. This is the brain that makes our Store better than Bandcamp's own discovery — and substantially better than what either signal alone could deliver.

### Layer 3 — Data (`src/main/bandcamp-integration/data/`)
Scrapes Bandcamp pages (both Jake's account pages for profile data, and general catalog pages for content), parses HTML/JSON-LD, caches results, handles auth. No Bandcamp UI assets used.

### Layer 4 — Acquisition (`src/main/bandcamp-integration/acquisition/`)
Purchase flow opens Bandcamp's authenticated checkout (webview overlay), detects completed purchases, downloads files via Bandcamp's authenticated download endpoints, routes to library.

---

## Personalization Design (The Core New Feature)

### Profile Inputs

Two data sources, treated as co-equal inputs to the personalization engine:

#### Source A: JakeTunes Library (authoritative collection)

The existing JakeTunes library data — ~6,500 tracks today, growing — represents Jake's actual curated collection across all sources (iPod imports, Bandcamp purchases, ripped CDs, other digital purchases). This is the broadest and most authoritative signal because it captures every piece of music Jake has chosen to keep.

- **`library.json`**: per-track metadata including artist, album, title, single-string `genre`, year, where present
- **`metadata-overrides.json`**: Jake's manual metadata corrections (applied during signal computation on desktop; mobile reads `library.json` raw)
- **Play history (CONFIRMED present per audit):** `playCount`, `lastPlayedAt`, `skipCount` — fed via metadata-overrides per existing recommendation-flow plumbing
- **Favorites/ratings (CONFIRMED present per audit):** `rating` 0–5 star with existing `StarRating.tsx` UI + bulk context-menu
- **Track count per artist**: depth-of-interest signal
- **Genre frequency**: coarser than Bandcamp tags (library is single-string genre, not tag array) — merge logic must account for this asymmetry
- **No `label` field, no geographic field, no tag array** — Bandcamp signals fill these gaps; library can't contribute to label/geo affinity without future enrichment
- **`audioFingerprint`** (where analyzed): identity-safe overlap/dedupe across library ↔ Bandcamp catalog

#### Source B: Bandcamp profile (discovery + intent)

Jake's Bandcamp profile data, scraped on authenticated session:

**Collection (purchases):**
- Every album Jake has bought
- For each: artist, label, tags, release date, geographic origin
- Source: `bandcamp.com/[username]/collection` (paginated)

**Wishlist:**
- Items Jake has wishlisted but not bought
- Same metadata as collection
- Source: `bandcamp.com/[username]/wishlist`

**Following list:**
- Artists Jake follows (gets notified about their releases)
- Source: `bandcamp.com/[username]/following`

**Derived signals (computed across BOTH sources, library typically weighted heavier):**
- **Tag frequency map:** count tags across library + Bandcamp collection + Bandcamp wishlist. Top tags = Jake's genre/mood profile. Library weighted heavier (larger sample, curated).
- **Label affinity:** count labels across library + Bandcamp collection. Library labels from track metadata; Bandcamp labels from artist/album pages.
- **Geographic clusters:** count artist origin cities/countries across both sources (Bandcamp directly provides geo; library requires artist-level enrichment if not in metadata).
- **Decade/era profile:** count release year buckets across both sources.
- **Artist density:** how many releases per artist (deep listeners vs samplers) — combined library + Bandcamp ownership.
- **Library-Bandcamp overlap:** which Bandcamp catalog items are already in Jake's library (used to mark "Owned" in Store UI, avoid recommending things he already has).
- **Net-new discovery signal:** tags/labels/artists present in library but underrepresented in Bandcamp profile — areas where the Store can fill discovery gaps.

### Recommendation Surfaces (Where Personalization Shows Up)

The iTunes Store UI has natural slots for personalized content. Each becomes a personalization surface:

1. **Featured carousel** (top of Store landing) → "Featured for you" — rotating banner of new releases from Jake's followed artists + top labels.

2. **"Your New Picks" section** → new releases from followed artists, ranked by recency + Jake's typical engagement with that artist's catalog.

3. **"From Artists You Follow" section** → all new releases from following list in the last 30 days.

4. **"Labels You Support" section** → new releases from Jake's top 5-10 labels.

5. **"Wishlist-Adjacent" section** → new releases tagged with the same tags as Jake's wishlist items, OR new releases by artists sharing tags with wishlisted artists.

6. **"Hidden Gems" section** → albums tagged with Jake's top 3-5 tags, but with low buyer count (Bandcamp's anti-popularity surface — things he probably hasn't heard).

7. **Genre sidebar prioritization** → Jake's top tags appear at the top of the genre nav, in his usage frequency order. Less-relevant tags drop below or hide.

8. **Search ranking boost** → when Jake searches "techno," results are ranked partially by overlap with his unified profile (boosting artists from his preferred labels/cities/decades).

9. **"Round Out Your Collection" section** (library-driven) → if Jake's library has 3 of 5 albums by an artist, surface the missing 2 from Bandcamp. Uses artist+album fuzzy match + `audioFingerprint` for accuracy.

10. **"More Like Your Library Staples" section** (library-driven, engagement-weighted) → for the most-owned + highest-played + highest-rated artists in Jake's library, find Bandcamp catalog items that match (similar tags, similar Bandcamp labels, similar geographic origin). **Engagement signals (`playCount`, `rating`, `lastPlayedAt`) directly weight which library artists count as "staples."**

11. **"Owned" indicator on Store items** → any Bandcamp item Jake already has in his library is marked "Owned" so he doesn't accidentally re-buy. Detection via `audioFingerprint` + normalized artist+album fuzzy match (`_normFingerprint` helper at `src/main/index.ts:1876`). Visual: muted badge or disabled-state buy button with "In Library" replacement label.

**Notes on this surface set vs. v2.1:**
- "Labels You Support" (#4 above) is now **Bandcamp-only at launch** — library has no label field, so Bandcamp purchase data is the sole label-affinity signal in v1.
- "Discover Labels From Your Library" (was v2.1 surface #11) is **dropped from v1** — no library label data to power it; enrichment via Discogs/MusicBrainz is sparse + slow + not worth the build cost.
- Engagement-weighted ranking using `playCount`/`rating`/`lastPlayedAt`/`skipCount` is now **first-class Tier 1**, not deferred. Actual play behavior beats inferred label preferences as a personalization signal anyway.

### Beating Bandcamp's Own Algorithm

Bandcamp's homepage (`bandcamp.com`) shows:
- Bandcamp Daily editorial picks (same for everyone)
- "New & Notable" (curated, same for everyone)
- "Discover" — tag-filterable, sorted by recency or popularity (not personalized to user beyond the user's tag selection)

What we add that Bandcamp doesn't:
- Personalization based on the user's actual purchases, wishlist, and follows
- Cross-signal blending (a track that hits multiple Jake-signals gets ranked higher than one that hits just one)
- "Hidden gems" surface that prioritizes Jake's taste profile + low buyer count (Bandcamp's algorithm sorts by popularity, never against it)
- Search results re-ranked by personal taste

This is genuinely better, not just "different."

### Tiered Implementation

**Tier 1 (MVP — Phase 1):**
- "Featured for you" carousel (new releases from followed artists)
- "Your New Picks" section
- Genre sidebar prioritization (Jake's top tags first)
- Search ranking boost (basic — boost by label/follow overlap)

**Tier 2 (Phase 2):**
- "From Artists You Follow" section
- "Labels You Support" section
- "Wishlist-Adjacent" section
- More sophisticated search ranking (multi-signal)

**Tier 3 (Phase 3 polish + future):**
- "Hidden Gems" surface
- Geographic affinity surface ("More from [Jake's top city]")
- Decade affinity surface ("More from [Jake's top era]")
- Cross-tag clustering (find tag combinations Jake likes that aren't obvious individually)

### Profile Refresh Cadence

- On first auth: full profile scrape (may take ~30-60 seconds for large collections)
- After first auth: daily background refresh of new collection items, wishlist changes, new follows
- Manual refresh button in settings ("Re-sync my Bandcamp profile")
- Cache invalidation: derived signals (tag frequencies, label affinity, etc.) recompute after each scrape

### Privacy & Data Storage

- All profile data stored locally at `~/Library/Application Support/JakeTunes/bandcamp-profile.json` (or similar — follows the existing per-feature JSON+TTL pattern, e.g. `discogs-collection.json` at `src/main/index.ts:3135`)
- **Auth storage:** persistent Electron session partition (`persist:bandcamp`) on `WebContentsView`. Cookies survive restarts automatically via Electron's built-in session management. **No manual token storage, no Keychain dependency.** If a token must be stored explicitly for any reason (e.g., a JSON API requires it), use Electron `safeStorage` which is Keychain-backed.
- Bandcamp `WebContentsView` runs in its own session partition, isolated from the main window. Never expose `electronAPI` / preload bridge to the Bandcamp view (security note per audit; `sandbox: false` is set globally).
- No telemetry, no external analytics, no profile data sent to any service other than Bandcamp itself (and only for fetching, never for posting)
- Settings panel exposes a "Clear Bandcamp profile data" option (clears `bandcamp-profile.json` + the `persist:bandcamp` partition's cookies)

---

## Visual Reference: iTunes Store 2008-2010

**Layout:**
- Top: persistent header with JakeTunes logo (left), centered search bar with magnifying glass icon, account/cart (right)
- Below header: secondary nav strip with breadcrumbs / category tabs
- Main area: featured carousel at top (rotating banner, ~600x250), then sections of album grids
- Left sidebar: Genre navigation, Jake's top tags first per personalization
- Right sidebar (optional v1, recommended v2): "Top Songs for You" + "Top Albums for You" charts (PERSONALIZED, not global), "Quick Links"

**Typography:**
- Headers: Lucida Grande Bold, 18-22px
- Body: Lucida Grande Regular, 11-13px
- System fallback: `-apple-system, BlinkMacSystemFont, "Lucida Grande", sans-serif`

**Color palette:**
- Background: `#ffffff` (white) with `#f5f5f5` panels
- Primary blue: `#2c5aa0`
- Hover blue: `#1e3f73`
- Text: `#000000` primary, `#6e6e6e` secondary
- Borders: `#cccccc`
- Buy button: rounded, blue gradient (`linear-gradient(to bottom, #4d7fc4, #2c5aa0)`), white text

**Spacing / sizing:**
- Album cover thumbnails: 120x120 in grid, 240x240 on detail
- Grid gap: 20px
- Section padding: 24px
- Header height: 64px

---

## Phased Implementation

### Phase 1 (MVP, ~4-5 days) — Store + Tier 1 Personalization + Purchase

- Top header with logo + search bar
- Left sidebar with genre nav, Jake's top tags surfaced first
- "Featured for you" carousel at landing (personalized)
- "Your New Picks" section (personalized, Tier 1)
- Album detail page: cover, title, artist, track listing, preview button per track, buy button
- Buy button: opens Bandcamp's authenticated checkout in webview overlay
- After purchase: detect via redirect, route downloaded files to library
- Bandcamp authentication flow + initial profile scrape

### Phase 2 (~4-5 days) — Tier 2 Personalization + Editorial + Artist Pages

- "From Artists You Follow" section
- "Labels You Support" section
- "Wishlist-Adjacent" section
- Search ranking with multi-signal personalization
- Bandcamp Daily editorial integration (scraped from daily.bandcamp.com)
- Artist pages (discography, bio, related artists, "you own X tracks by this artist")
- Right sidebar: "Top Songs for You" + "Top Albums for You" (personalized charts)

### Phase 3 (~2-3 days) — Tier 3 Personalization + Polish

- "Hidden Gems" surface
- Geographic affinity surface
- Decade affinity surface
- Visual QA pass against iTunes Store reference (side-by-side, line-by-line)
- Performance tuning (caching, lazy loading, skeleton screens)
- Animation polish (hover, transitions, carousel)
- Keyboard navigation

---

## Audit Phase: COMPLETE

Claude Code's Phase 0 audit ran against this codebase and delivered findings. Outcomes incorporated above (see Supersedes note at top). The original ten audit tasks have been resolved or carried forward to Phase 0 spike where Bandcamp live-verification is still needed.

---

## Phase 0 Spike (NEW — required before Phase 1)

A 1-2 day authenticated spike on Jake's machine, on a throwaway branch, **before any Phase 1 code is written**. Purpose: verify the four Bandcamp unknowns that Claude Code could not validate from its environment (it received HTTP 403 from `bandcamp.com` for non-browser requests). If any fail, `bad-idea-protocol` triggers and we replan instead of digging out of a half-built feature.

### Spike Goals (Falsifiable)

1. **Auth + cookies + 2FA in `WebContentsView`:** Jake logs in to Bandcamp inside a `WebContentsView` with `persist:bandcamp` session partition. 2FA (if Jake has it enabled) completes successfully. Session cookies persist across app restart. PASS = next launch Jake is still logged in without re-entering credentials.

2. **`fancollection` JSON endpoint returns:** Authenticated POST requests to `bandcamp.com/api/fancollection/1/collection_items`, `…/wishlist_items`, `…/following_bands` return JSON with Jake's `fan_id`. PASS = received structured JSON of Jake's actual collection/wishlist/follows, sample of at least 20 items per endpoint.

3. **`will-download` interception works end-to-end:** Jake completes one real cheap or free purchase (free Bandcamp Friday item, or a $1 single, his choice). `session.on('will-download')` attached to the `persist:bandcamp` partition fires. The download is intercepted, passed to `importOneFile()`, and the resulting file appears correctly in `library.json` with proper artist/album/title metadata. PASS = file plays in JakeTunes, library entry is correct, no manual cleanup required.

4. **Catalog `data-tralbum` parses:** A request to a public Bandcamp album page (e.g. one from Jake's wishlist) successfully extracts the embedded `data-tralbum` JSON blob with `trackinfo[]`, preview file URLs, prices, `is_purchasable` flag. PASS = parsed JSON contains all the fields needed to render an album detail page.

### Spike Deliverable

A go/no-go report covering all four goals, with: PASS/FAIL per goal, evidence (logs, screenshots, sample JSON), proposed mitigations for any FAIL, and final recommendation (proceed to Phase 1 / revise scope / abandon).

**No production commits. Throwaway branch. STOP after spike report.**

---

## Implementation Details (Gated On Audit Approval)

### Directory Layout

```
src/renderer/views/BandcampStore/
├── StoreView.tsx
├── StoreHeader.tsx
├── StoreSidebar.tsx                  # Genre nav with personalization-driven ordering
├── FeaturedCarousel.tsx              # Personalized rotating banner
├── PersonalizedSections.tsx          # "Your New Picks", "Labels You Support", etc.
├── AlbumGrid.tsx                     # Reusable album tile grid
├── AlbumTile.tsx
├── AlbumDetailView.tsx
├── ArtistDetailView.tsx
├── SearchResults.tsx                 # With personalization-aware ranking
├── PersonalizedCharts.tsx            # "Top Songs/Albums for You" (Phase 2)
├── BuyButton.tsx
├── PreviewPlayer.tsx
├── PurchaseFlow.tsx
├── BandcampAuthFlow.tsx              # First-time login + re-auth UI
├── styles/
│   ├── itunes-tokens.css
│   ├── store.css
│   └── animations.css
└── index.ts

src/main/bandcamp-integration/
├── data/
│   ├── scraper.ts                    # Bandcamp page scraping
│   ├── catalog-data.ts               # Public catalog data (search, tags, daily, charts)
│   ├── profile-data.ts               # Jake's authenticated Bandcamp profile data
│   ├── library-data.ts               # Reads JakeTunes library.json + metadata-overrides for personalization
│   └── cache.ts
├── personalization/
│   ├── profile-store.ts              # Unified profile cache (library + Bandcamp signals merged)
│   ├── library-ingestion.ts          # Extracts signals from library.json
│   ├── signal-computation.ts         # Tag frequency, label affinity, etc. across both sources
│   ├── overlap-detection.ts          # Library-Bandcamp overlap (avoid re-recommending owned items)
│   ├── recommenders/
│   │   ├── featured-for-you.ts
│   │   ├── your-new-picks.ts
│   │   ├── from-followed-artists.ts
│   │   ├── labels-you-support.ts
│   │   ├── wishlist-adjacent.ts
│   │   ├── hidden-gems.ts
│   │   ├── round-out-collection.ts        # Library-driven: missing albums by owned artists
│   │   ├── like-library-staples.ts        # Library-driven: similar to most-owned/played/rated artists (engagement-weighted)
│   │   └── search-reranker.ts
│   └── refresh-scheduler.ts          # Background profile refresh
├── acquisition/
│   ├── auth.ts                       # Bandcamp session management
│   ├── purchase-tracker.ts           # Detect completed purchases
│   ├── download-router.ts            # Route downloads to library
│   └── filename-parser.ts            # Same as Brief 035 v2 planning patterns
└── index.ts
```

### Profile Data Flow

1. **Library data ingestion** (on app launch + when `library.json` changes):
   - `library-data.ts` reads current `library.json` + `metadata-overrides.json`
   - `library-ingestion.ts` extracts signals (artists, tags, labels, years, track-density-per-artist, plays/favorites if present)
   - Signals stored in the unified profile cache

2. **Bandcamp profile ingestion** (one-time + incremental):
   - First launch: Jake clicks "Connect Bandcamp" → opens `BandcampAuthFlow` webview → logs in → cookies preserved
   - Initial scrape: `profile-data.ts` pages through Jake's collection / wishlist / following (~30-60s for typical Bandcamp library)
   - Stored at `~/Library/Application Support/JakeTunes/bandcamp-profile.json`
   - Subsequent launches: incremental refresh (only items added since last scrape)

3. **Unified profile assembled** at each surface render:
   - Library signals + Bandcamp signals merged via signal-computation.ts
   - Overlap detection identifies items Jake already owns (marked "Owned" in Store)
   - Derived signals (tag frequency, label affinity, geo clusters, etc.) recomputed across the unified set

4. **Surface queries**: UI surfaces request from personalization layer (e.g., "give me 10 items for the Featured carousel"), personalization layer returns ranked results based on unified profile.

5. **Cold-start handling**:
   - Library but no Bandcamp profile yet: library-driven surfaces work; Bandcamp-driven surfaces ("From Artists You Follow") show "Connect Bandcamp for personalized recs" prompt
   - Bandcamp profile but minimal library (unlikely given current 6,500 tracks but possible on a fresh install): Bandcamp-driven surfaces work; library-driven surfaces ("Round Out Your Collection") show empty state
   - Both present: full personalization, both sources contributing

### Recommendation Ranking

Generic ranking function for each surface:

```
score(item, profile) = sum(
    weight_follow * is_followed_artist(item.artist, profile.following),
    weight_label * label_affinity(item.label, profile.label_affinity),
    weight_tag * tag_overlap(item.tags, profile.top_tags),
    weight_geo * geo_affinity(item.geo, profile.geo_clusters),
    weight_recency * recency_score(item.release_date)
)
```

Weights tuned per surface (e.g., "Your New Picks" weights followed-artists heavily; "Wishlist-Adjacent" weights tag overlap heavily; "Hidden Gems" inverts popularity weight).

### Beating-Bandcamp Verification

Phase 2 acceptance includes a side-by-side comparison: visit `bandcamp.com` homepage (logged in as Jake), capture what Bandcamp surfaces. Visit JakeTunes Store, capture what we surface. Side-by-side, JakeTunes' surfaces should:
- Show more items relevant to Jake's actual taste (measured by overlap with his collection's tag profile)
- Surface things Bandcamp doesn't (Hidden Gems, label-specific feeds, etc.)
- Make obvious why JakeTunes is more useful to Jake than Bandcamp's own homepage

Jake reviews the side-by-side and signs off.

---

## Verification Phase

After Phase 1 (MVP, Tier 1 personalization):

1. **Visual fidelity (MVP):** open Store view, side-by-side with iTunes Store 2008-2010 reference. Confirm typography, colors, spacing, button styles match.
2. **Library ingestion:** library signals computed correctly from `library.json` — spot-check top 5 tags, top 5 labels (where present), top 10 artists against actual library content.
3. **Authentication:** "Connect Bandcamp" flow works, Jake logs in successfully, session persists across app restarts.
4. **Bandcamp profile scrape:** initial scrape completes within ~60 seconds for Jake's typical-size Bandcamp collection. Profile data visible in `bandcamp-profile.json`.
5. **Signal merging:** unified profile combines library + Bandcamp signals correctly; library tag frequencies dominate where library is larger; Bandcamp signals contribute distinctly where applicable.
6. **Library-Bandcamp overlap:** albums Jake already has in library appear with "Owned" indicator in Store browse/search results.
7. **Featured carousel personalized:** carousel surfaces items from BOTH library signals (e.g., new releases from artists in library) AND Bandcamp signals (followed artists, top labels) — not Bandcamp's editorial picks.
8. **"Your New Picks":** section populated with items personalized to unified profile.
9. **Genre sidebar prioritization:** Jake's top tags appear first in genre nav (verify against tag frequency across BOTH library and Bandcamp).
10. **Search:** search for "techno" — results ranked partially by unified profile.
11. **Album detail + preview:** album detail page renders, previews play.
12. **Purchase + auto-library-routing:** test purchase completes, file lands in correct `~/Music2/JakeTunesLibrary/...` path, file plays, metadata correct, JakeTunes UI shows new track within ~10s.
13. **Cold start (no Bandcamp):** if Bandcamp not yet connected, library-driven surfaces work and Bandcamp-driven surfaces show "Connect Bandcamp" prompts.

After Phase 2 (Tier 2):
14. **"From Artists You Follow":** section populated, all items from followed artists, sorted by recency.
15. **"Labels You Support" (Bandcamp-only at launch):** populated with new releases from Jake's top Bandcamp-purchased labels.
16. **"Wishlist-Adjacent":** items match Jake's wishlist tag profile.
17. **"Round Out Your Collection":** for artists where Jake's library has partial discography, surface the missing Bandcamp releases (spot-check 3-5 artists).
18. **"More Like Your Library Staples" (engagement-weighted):** items match the tag/label profile of Jake's most-played + highest-rated library artists. Verify that `playCount` + `rating` actually shifts the ranking vs. raw ownership-count.
19. **Personalized charts:** "Top Songs for You" / "Top Albums for You" differ from Bandcamp's global charts in ways that match Jake's unified profile.
20. **Bandcamp Daily:** editorial content visible, articles clickable.
21. **Artist pages:** clicking artist navigates to artist page with discography + "you own X tracks by this artist" indicator (derived from library).

After Phase 3 (Tier 3 + polish):
22. **"Hidden Gems":** items match Jake's top tags but have low buyer count (verify by checking surfaced items are deliberately lower-popularity than other surfaces).
23. **Beating-Bandcamp side-by-side:** Jake reviews JakeTunes Store homepage vs. `bandcamp.com` homepage and signs off that JakeTunes is more useful given his actual taste profile.
24. **Visual QA:** Jake signs off on iTunes Store visual fidelity using reference screenshots in `docs/4.0-ui-references/itunes-store/`.

---

## Methodology Disciplines

- **`audit-then-run`:** All eight audit tasks complete before any implementation.
- **`falsifiable-seam-contract`:** 24 verification tests, each binary PASS/FAIL. Plus 4 Phase 0 spike goals (also PASS/FAIL).
- **`bad-idea-protocol`:** If audit reveals Bandcamp blocks scraping or has restructured profile pages such that personalization is impossible, surface immediately. Don't try to work around silently.
- **`diagnostic-before-fix`:** During Phase 3 polish, use side-by-side visual diffs to identify divergence from iTunes reference. Don't guess what's off.
- **`safety-gate-with-explicit-abort`:** Profile data is sensitive (Jake's purchase history). Privacy guarantees enforced at code level — local-only storage, no external transmission, settings panel option to clear.

---

## Out Of Scope For v1

- Sources other than Bandcamp
- Movie/TV/Podcast sections
- Wishlist/cart for multiple-item purchases (one purchase at a time)
- Gift cards / promo codes
- Pre-orders
- Mobile/iPad versions
- Account-portable profile (Jake's profile is local-only; if he uses JakeTunes on workmini, he re-auths there separately)
- Cross-user features (no friend recommendations, no shared playlists, etc.)
- Bandcamp Friday promotional banners (could be a Phase 4 polish item)
- AI-driven semantic similarity (embedding-based recommendations) — possible future enhancement, out of scope for v1

---

## Risk Register

**Resolved by Phase 0 audit:**
- ~~Path scheme mismatch~~ — RESOLVED. Reuse `importOneFile()` per audit Finding #1.
- ~~Unknown play history availability~~ — RESOLVED. `playCount`/`rating`/`lastPlayedAt`/`skipCount` all present; engagement-weighted ranking is Tier 1.

**Open risks (carried forward):**

- **Bandcamp anti-scraping** (HIGH): non-browser requests get 403. Mitigation: all requests originate from the authenticated `persist:bandcamp` session (real Chromium UA, Jake's IP), polite pacing, long cache TTLs. Verified-or-failed by Phase 0 spike.
- **iTunes Store visual fidelity harder than expected:** flag during Phase 3, decide between "close enough" and "more investment."
- **Album ZIP downloads + async link generation (NEW, MEDIUM-HIGH):** Bandcamp post-purchase downloads are per-order `bcbits.com/download/...` links, often async ("preparing..."), format chosen at download time (not a global setting), and **albums arrive as ZIPs** of tagged files + `cover.jpg`. `will-download` intercepts the ZIP, then we unzip → per-file `importOneFile()`. This is the single most fragile flow. Phase 0 spike Goal #3 verifies it end-to-end.
- **Missing library label/geo data (NEW):** library has no `label` field, no geographic field, and `genre` is single-string (not array). Label/geo surfaces are Bandcamp-only at launch. Future enrichment via Discogs/MusicBrainz possible but out of v1 scope.
- **2FA in embedded view (NEW, MEDIUM):** if Bandcamp 2FA doesn't complete cleanly in `WebContentsView`, fall back to external browser for first auth, then resume session in app. Phase 0 spike Goal #1 verifies this.
- **`sandbox: false` + adding remote-content view (NEW, MEDIUM/security):** Bandcamp view must run isolated in its own `persist:bandcamp` partition with NO `electronAPI` preload exposure. Audit pattern explicit on this.
- **Purchase flow webview quirks:** Bandcamp's checkout may not work cleanly in Electron webview. Fallback: open external browser, monitor user's account for the new download.
- **Profile size:** users with 5,000+ purchase collections may hit memory/disk issues. Mitigation: paginated cache, lazy loading per surface.
- **Auth session expiry:** Bandcamp sessions expire (length TBD by audit). Re-auth UX must be smooth.
- **2FA:** if Bandcamp 2FA doesn't work in webview, may need to open external browser for first-time auth.
- **Personalization quality below user's expectations:** Tier 1 might feel weak. Mitigation: ship Tier 2 fast, get to "actually beats Bandcamp" state quickly.
- **Profile data sensitivity:** purchase history is personal data. Local-only storage + clear-data option are baseline; never log/telemeter this data.

---

## What "Done" Looks Like

1. Audit findings incorporated into brief (v2.2) — DONE
2. Phase 0 on-device spike completes — all four spike goals PASS, go/no-go report delivered, Dex + Jake approve proceed
3. Phase 1 (MVP) ships in a single commit. All thirteen Phase 1 verification tests PASS.
4. Phase 2 ships in a single commit. All eight Phase 2 verification tests PASS.
5. Phase 3 ships in a single commit. All three Phase 3 verification tests PASS.
6. Final Jake sign-off on:
   - iTunes Store visual fidelity
   - Personalization quality (beats Bandcamp's own homepage)
   - Overall product feel
7. Brief 036 v2 closes.

---

## Why This Is The Right Answer

JakeTunes has always been an iTunes-inspired platform. A built-in store that:
- Recreates the iTunes Store experience visually (perfect fidelity, not inspiration)
- Sources Bandcamp's legitimate, DRM-free catalog
- Adds a personalization layer that meaningfully beats Bandcamp's own discovery
- Auto-routes purchases into the library
- Stays private (local-only profile data)

...is the flagship version of "JakeTunes Store" that's worth building. Aligned with the project's aesthetic identity, aligned with Bandcamp's artist-friendly economics, aligned with Jake's actual product need (a store he uses because it's better than the alternatives, not because it's the only option).

The personalization layer is what elevates this from "decent" to "actually compelling." Bandcamp's algorithm doesn't try; ours does. That's the difference.

— Dex
