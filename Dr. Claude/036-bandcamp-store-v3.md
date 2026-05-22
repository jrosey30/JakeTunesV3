# Brief 036 v3 — Bandcamp Store Phase 1 Completion

**Status:** Ready for Claude Code
**Priority:** P1 (blocks all Phase 2 work and any user-facing demo of the Store)
**Scope:** Large — 6 phases, ~15–20 files touched, ~800–1200 lines net
**Branch:** `claude/036-bandcamp-store-phase1` (continue on existing feature branch — do NOT rebase, do NOT create a new branch)
**Prerequisite commits already on branch:** `ebd947e` (Phase 1 backend), `4a4b0a9` (Phase 1 UI)

---

## 1. Context — Why This Brief Exists

On May 21, 2026, Phase 1 of the Bandcamp Store integration shipped to `claude/036-bandcamp-store-phase1` as commits `ebd947e` + `4a4b0a9`. The executor's self-review claimed "BUILT, unrun" for 13 verification tests + 3 early-validation gates.

Owner validation revealed a significant gap between Phase 1 *design* and Phase 1 *delivery*. Specifically:

| Component | Design Promised | Delivered |
|---|---|---|
| Featured for You surface | Library-driven recs via staples formula | Does not render at all |
| Your New Picks surface | Follows + library merge | Renders, empty |
| Sidebar prioritization | Weighted by listening history | Generic genre rail |
| Search re-rank | Catalog results re-scored by library signals | Not visible |
| Album detail view | Tracks, release date, price, description, art, Buy | Title, artist, art, Buy |
| Artist detail view | Discography grid, bio, follow CTA | Does not exist — artists render in album template |
| Buy flow | Bounded checkout WebContentsView → `importOneFile()` | Nukes the entire renderer when clicked |
| Follows scrape | Name, kind, band_url, last_release_date | Name + kind only |
| Collection scrape | Owned albums populated | Empty array (despite confirmed purchase during spike) |
| Wishlist scrape | User wishlist | Empty array |

**Diagnostic data** confirming these gaps is in chat history and `~/Library/Application Support/JakeTunes/bandcamp-profile.json` (280+ follow names, name-only). Screenshots of broken Buy flow, empty surfaces, and identical artist/album detail views are attached to the validation session.

Most of these gaps would have been caught had Phase 1's "BUILT, unrun" verification tests actually been run. **This brief therefore has two goals:**

1. **Functional:** Bring Phase 1 delivery up to original design + three additions discovered during validation (artist detail view, pre-connect default surfaces, re-sync button).
2. **Methodological:** Replace "BUILT, unrun" claims with executor-runnable verification that produces artifact evidence per phase.

---

## 2. Pre-Flight — Read Before Touching Anything

Run each step. If any produces unexpected output, **STOP and report**, do not proceed.

### 2.1 — Clean working tree on the right branch

```bash
cd ~/JakeTunesV3
git status
git branch --show-current
```

Expected: working tree clean, branch is `claude/036-bandcamp-store-phase1`.

### 2.2 — Prerequisite commits present

```bash
git log --oneline -5
```

Expected to see `4a4b0a9` (UI) and `ebd947e` (backend) within recent history.

### 2.3 — Baseline tsc passes

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Must be **0**. If non-zero, STOP — fix the pre-existing tsc errors in a separate brief before continuing.

### 2.4 — Baseline build passes

```bash
npm run build 2>&1 | tail -20
```

Must exit 0. If not, STOP.

### 2.5 — Bandcamp directories present from Phase 1

```bash
ls src/renderer/views/BandcampStore/
ls src/main/bandcamp-integration/
```

Both must list files. If either is empty, STOP — branch is wrong.

### 2.6 — Profile JSON shape matches what this brief assumes

```bash
cat ~/Library/Application\ Support/JakeTunes/bandcamp-profile.json | python3 -m json.tool | head -30
```

Expected: top-level keys `fanId`, `username`, `fetchedAt`, `collection`, `wishlist`, `following`. The `following` array contains objects with `name` + `kind` only (no `band_url`). If shape differs, STOP and report — the scrape may have changed.

### 2.7 — `importOneFile()` is at the expected site

```bash
grep -n "^export function importOneFile\|^export async function importOneFile\|^function importOneFile\|^async function importOneFile" src/main/index.ts
```

Expected: exactly one match around line 2173 (may have shifted). If missing or multiple, STOP.

### 2.8 — Create verification artifact directory

```bash
mkdir -p Dr.\ Claude/036-phase1c-verification/{A,B,C,D,E,F,final}
```

Every phase will write screenshots, logs, or JSON dumps into the corresponding subdirectory. This is mandatory — see §7.

---

## 3. Architectural Decisions (Locked)

These are decided. Do not deviate during execution. If discovery contradicts a decision, STOP and report.

### Decision 1 — Discriminated union for search/result types

Introduce in `src/main/bandcamp-integration/types.ts`:

```typescript
export type BandcampSearchResult =
  | { kind: 'artist'; name: string; bandUrl: string; imageUrl?: string }
  | { kind: 'release'; title: string; artist: string; artistUrl: string;
      releaseUrl: string; imageUrl?: string; releaseDate?: string;
      priceCents?: number; currency?: string };
```

All search responses, scrape outputs, and UI tile renders consume this union. Code that branches on result type uses `if (r.kind === 'artist')`, not duck-typing.

### Decision 2 — Split detail views by kind

Rename `AlbumDetailView.tsx` → `ReleaseDetailView.tsx`. Create new `ArtistDetailView.tsx`. The store router branches on `kind` to mount the correct view. Do NOT keep a single shared template.

### Decision 3 — Buy-flow uses modal overlay, never replaces renderer

The checkout WebContentsView attaches to the BrowserWindow as a CHILD with bounded `setBounds({ x, y, width, height })` matching a modal-sized region. It MUST register a `close` listener that calls `removeChildView` and restores focus to the renderer. **The renderer must remain visible underneath the modal at all times.**

If technically infeasible to bound the WebContentsView (e.g., Bandcamp checkout requires full-window for some reason), fall back to `shell.openExternal()` opening the checkout URL in the user's system browser. **Do not silently fall back — flag this in self-review.**

### Decision 4 — Follows-scrape v2 captures URL + last release date

The fancollection endpoint returns more than name + kind. Inspect the raw response, extract `band_url` (or equivalent) and `last_release_date` (or compute from latest release in response). Persist these in `following[]` objects.

### Decision 5 — Collection scrape may need different auth

Empty `collection:[]` despite confirmed Bandcamp purchase means the collection endpoint scrape either didn't run or got an empty/error response. Investigate the actual network call (`bandcamp.com/api/fancollection/1/collection_items` or similar). May need different cookies, different POST body, or session re-handshake. **Do not invent — read the actual Bandcamp web app's network calls and mirror them.**

### Decision 6 — Featured for You is library-only

This surface does NOT depend on the Bandcamp connection. It computes from library data using the staples formula (locked in v2.2):

```
score = 0.35·norm(ownedAlbumCount)
      + 0.30·norm(avgRating)
      + 0.25·norm(recentPlays)
      - 0.10·norm(skipRate)
```

with 90-day half-life on recency. Handle null `rating` and `lastPlayedAt` gracefully (skip the term, renormalize remaining weights). Render the top N staple artists/albums with "More like this on Bandcamp" CTAs that trigger Bandcamp catalog search for each artist.

### Decision 7 — Pre-connect default surfaces use public Bandcamp endpoints

When the user is not connected, render at least two default surfaces using Bandcamp's public discover/browse endpoints (unauthenticated). Possible sources: `bandcamp.com/api/discover/3/get_web` (or current equivalent). Verify the endpoint actually works before relying on it. If no public endpoint is reachable, render Featured for You (library-only, see Decision 6) as the only pre-connect surface — it works without Bandcamp data.

### Decision 8 — Re-sync wires to existing IPC

The "Try Re-sync in a bit" copy already references re-sync. The IPC channel `bandcamp:refresh-profile` already exists (per Phase 1 design). The button just needs to be visible, call this IPC, show a loading state, and update the UI when the IPC resolves. Do NOT introduce a new IPC channel.

---

## 4. Phase-by-Phase Execution

Six phases, one commit per phase. Phases must be executed in order — each phase's verification gates the next. Do not start Phase B until Phase A's verification artifacts are saved.

---

### Phase A — Type System Foundation

**Goal:** Introduce the discriminated union so all downstream code can branch correctly on artist vs release.

**Files:**
- `src/main/bandcamp-integration/types.ts` (modify or create)
- `src/renderer/views/BandcampStore/types.ts` if separate (modify or create)

**Step A.1 — Locate current type definitions:**

```bash
grep -rn "type.*Search\|interface.*Search\|type.*Album\|interface.*Album" src/main/bandcamp-integration/ src/renderer/views/BandcampStore/
```

**Step A.2 — Add the discriminated union (see Decision 1 for shape).**

**Step A.3 — Update the search normalizer to emit tagged results.** Find where search responses are parsed (likely in `src/main/bandcamp-integration/data/` or similar). The Bandcamp search API returns mixed artists and releases — the existing code currently flattens this. Preserve the distinction by tagging each output object with `kind`.

**Step A.4 — Update the search IPC handler return type** to use the union.

**Step A.5 — Update consumer code** (AlbumGrid, search results render) to compile against the new type. Existing render logic will not yet branch on kind — that's Phase D. For now, just get the types to compile.

**Verification A:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # expect 0
```

Save tsc output to `Dr. Claude/036-phase1c-verification/A/tsc-after.txt`.

**Save a sample search result** (run the app, search "Panic Shack", capture the IPC return value via DevTools console: `await window.bandcamp.search('Panic Shack')`):

```bash
# Save to: Dr. Claude/036-phase1c-verification/A/sample-search-result.json
```

The JSON must show at least one `kind: 'artist'` and one `kind: 'release'` entry. If search returns only one kind, that's a data problem to flag.

**Commit:**

```
feat(store): Phase 1C/A — discriminated union for artist vs release results

Brief 036 v3 Phase A. Introduces BandcampSearchResult tagged union
so artist and release results are distinguishable at the type level.
Downstream UI code will branch on .kind in Phase D.

- src/main/bandcamp-integration/types.ts: add union, update exports
- (other files updated for compile)
```

---

### Phase B — Buy-Flow Containment (urgent)

**Goal:** Clicking Buy must NOT nuke the renderer. Either modal overlay WebContentsView or external browser fallback. Renderer remains responsive throughout.

**Files:**
- `src/main/bandcamp-integration/acquisition/` (the open-checkout handler)
- `src/renderer/views/BandcampStore/BuyButton.tsx`

**Step B.1 — Locate the existing handler:**

```bash
grep -rn "bandcamp:open-checkout\|openCheckout" src/main/bandcamp-integration/ src/main/index.ts
```

**Step B.2 — Inspect what it currently does.** Likely it's creating a WebContentsView attached to the BrowserWindow without bounded coordinates, so it overlays the entire window.

**Step B.3 — Implement bounded modal pattern:**

The handler must:
1. Compute bounds matching a modal-sized region (e.g., centered, 800×900 max, capped at 90% of window).
2. Attach the WebContentsView as a child view with those bounds.
3. Register a `did-navigate` listener to detect post-purchase success URLs (Bandcamp typically routes to a confirmation page).
4. Register a `close` listener on the WebContentsView (and a Cmd+W shortcut + a visible close button overlay) that calls `removeChildView` and resolves the IPC.
5. Return a result to the renderer indicating purchase outcome (`'completed' | 'cancelled'`).

**Step B.4 — If bounded modal proves infeasible** (e.g., Bandcamp checkout has frame-busting or width minimums that exceed window size), implement the fallback:

```typescript
shell.openExternal(checkoutUrl);
```

Return `'external'` to the renderer so the UI can show "Complete purchase in your browser; we'll sync your collection when you return."

**Step B.5 — Renderer side**: BuyButton must handle all three outcomes (`completed`, `cancelled`, `external`) and not block UI in any.

**Verification B:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # expect 0
npm run build 2>&1 | tail -5                       # expect exit 0
```

**Manual smoke test (required, no skipping):**

1. Run `npm run dev`.
2. Navigate to Store → search a free or pay-what-you-want release.
3. Click Buy.
4. **Required outcome:** A modal-sized Bandcamp checkout view appears overlaid on the renderer, OR the user's system browser opens with the checkout URL. The JakeTunes window remains visible and responsive in either case.
5. Close the checkout modal (or system browser). Verify the JakeTunes renderer is still functional — sidebar clicks, search input, etc., all work.

**Save screenshots:**
- `Dr. Claude/036-phase1c-verification/B/01-before-click.png` (Store page with Buy visible)
- `Dr. Claude/036-phase1c-verification/B/02-after-click.png` (modal or external browser open, renderer still visible)
- `Dr. Claude/036-phase1c-verification/B/03-after-close.png` (renderer responsive post-close)

If the renderer becomes a white void at any point, **the fix is incomplete**. Do not commit until this is resolved.

**Commit:**

```
fix(store): Phase 1C/B — Buy-flow containment, renderer no longer eaten

Brief 036 v3 Phase B. Checkout WebContentsView is now bounded to a
modal-sized region with explicit close handler. Renderer remains
visible and responsive throughout the purchase flow. Falls back to
shell.openExternal() if bounded modal proves infeasible (flagged
in self-review if so).

- src/main/bandcamp-integration/acquisition/...: bounded view + close handler
- src/renderer/views/BandcampStore/BuyButton.tsx: handle all three outcomes
```

---

### Phase C — Scrape v2 (follows + collection + wishlist)

**Goal:** The profile JSON has correct, complete data after Connect Bandcamp.

**Files:**
- `src/main/bandcamp-integration/data/` (scrape modules)

**Step C.1 — Locate current scrape implementation:**

```bash
grep -rn "fancollection\|collection_items\|scrapeFollows\|scrapeCollection" src/main/bandcamp-integration/
```

**Step C.2 — Inspect what the fancollection endpoint actually returns.** In DevTools, with the WebContentsView authenticated, run `executeJavaScript` against an authenticated `fetch('/api/fancollection/1/following_bands', {...})` and dump the full response. Save the raw response to `Dr. Claude/036-phase1c-verification/C/fancollection-raw.json` for reference.

**Step C.3 — Update follows scrape to capture URL + last release date.** The raw response includes more fields than just name. Extract:
- `name`
- `kind` (already captured)
- `band_url` (Bandcamp URL slug — e.g., `panicshack.bandcamp.com`)
- `last_release_date` (most recent release date if available; null otherwise)

**Step C.4 — Implement collection scrape.** The collection endpoint is separate from follows. Investigate which endpoint Bandcamp's own web app uses to populate the user's collection page (`bandcamp.com/{username}`). Mirror those calls exactly. Save the raw collection response to `Dr. Claude/036-phase1c-verification/C/collection-raw.json`.

The collection should include at minimum the Panic Shack "grin & bear it" purchase made during the Phase 0 spike.

**Step C.5 — Implement wishlist scrape.** Same pattern — find Bandcamp's own wishlist endpoint, mirror its calls. Acceptable for this to return empty IF the user has never added anything to their Bandcamp wishlist. Verify empty-vs-broken by checking the raw response: 200 with empty array = empty wishlist, anything else = broken scrape.

**Step C.6 — Persist updated profile JSON.** The shape must now be:

```typescript
{
  fanId: number;
  username: string;
  fetchedAt: number;
  following: Array<{ name: string; kind: 'band' | 'fan'; bandUrl?: string; lastReleaseDate?: string }>;
  collection: Array<{ title: string; artist: string; bandUrl: string; releaseUrl: string; purchasedAt?: string; imageUrl?: string }>;
  wishlist: Array<{ title: string; artist: string; bandUrl: string; releaseUrl: string; addedAt?: string; imageUrl?: string }>;
}
```

**Verification C:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # expect 0
```

**Manual:** Run dev, click Connect Bandcamp, complete auth. Then:

```bash
cat ~/Library/Application\ Support/JakeTunes/bandcamp-profile.json | python3 -m json.tool > Dr.\ Claude/036-phase1c-verification/C/profile-after-refresh.json
```

The saved JSON must show:
- `following[]` with `bandUrl` populated for at least 90% of entries
- `collection[]` non-empty, containing the Panic Shack spike purchase
- `wishlist[]` matching what the user actually has on Bandcamp (verify by opening `bandcamp.com/{username}/wishlist` in a browser and comparing)

**Commit:**

```
feat(store): Phase 1C/C — scrape v2 captures URLs, collection, wishlist

Brief 036 v3 Phase C. Follows scrape now captures band_url and
last_release_date alongside name. Collection and wishlist scrapes
implemented. Profile JSON shape extended per brief Decision 4.

- src/main/bandcamp-integration/data/follows.ts: enrich follows shape
- src/main/bandcamp-integration/data/collection.ts: implement scrape
- src/main/bandcamp-integration/data/wishlist.ts: implement scrape
```

---

### Phase D — UI Completion

**Goal:** Search results render proper tiles by kind. Clicking artist tile opens artist detail with discography. Clicking release tile opens release detail with tracks, date, price, description.

**Files:**
- `src/renderer/views/BandcampStore/AlbumDetailView.tsx` → rename `ReleaseDetailView.tsx`
- `src/renderer/views/BandcampStore/ArtistDetailView.tsx` (new)
- `src/renderer/views/BandcampStore/AlbumTile.tsx` (branch on kind, or split into ArtistTile + ReleaseTile)
- `src/renderer/views/BandcampStore/StoreView.tsx` (router logic)

**Step D.1 — Rename AlbumDetailView → ReleaseDetailView:**

```bash
git mv src/renderer/views/BandcampStore/AlbumDetailView.tsx \
       src/renderer/views/BandcampStore/ReleaseDetailView.tsx
```

Update all imports.

**Step D.2 — Enrich ReleaseDetailView** to show:
- Album/release art (existing)
- Title (existing)
- Artist with link to artist page (NEW — must call ArtistDetailView, not search)
- Release date (NEW — from Phase C data, fall back to album page scrape if needed)
- Price + currency (NEW — fetched per-release, may require an additional IPC call to scrape the release page)
- Description (NEW — scraped from release page)
- Track listing with durations (NEW — scraped from release page)
- Buy button (existing — now uses Phase B containment)

For data not in the search response, add a new IPC `bandcamp:get-release-detail` that takes a releaseUrl and returns the enriched data. Scrape from the public release page (no auth required).

**Step D.3 — Create ArtistDetailView** to show:
- Artist name + photo (from search result data)
- Brief bio if available (from scrape)
- Discography grid (releases by this artist, each a clickable ReleaseTile)
- "Follow on Bandcamp" CTA if user is connected and not already following

Add IPC `bandcamp:get-artist-detail` that takes a bandUrl and returns bio + discography. Scrape from the artist's public Bandcamp page.

**Step D.4 — Tile branching.** Either split `AlbumTile` into `ArtistTile` and `ReleaseTile`, or keep one component that branches internally. Each tile's onClick routes to the correct detail view (ArtistDetailView for artist kind, ReleaseDetailView for release kind).

**Step D.5 — Router logic in StoreView.** The current router likely has a single "show detail page" state. Extend to track which kind. Use the discriminated union from Phase A.

**Verification D:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # expect 0
npm run build 2>&1 | tail -5                       # expect exit 0
```

**Manual smoke test:**

1. Search "Panic Shack". Verify results show distinct artist tile (with band photo) and release tile(s) (with album art).
2. Click the artist tile. **ArtistDetailView must render** with discography grid. Screenshot: `Dr. Claude/036-phase1c-verification/D/01-artist-detail.png`
3. From the discography grid, click a release. **ReleaseDetailView must render** with title, artist, art, release date, price, description, and a track listing. Screenshot: `Dr. Claude/036-phase1c-verification/D/02-release-detail.png`
4. Repeat with a different artist (try a follow from your profile, e.g., "King Gizzard & The Lizard Wizard") to verify the flow generalizes. Screenshot: `Dr. Claude/036-phase1c-verification/D/03-second-artist.png`

If any detail view is missing required fields, **the phase is incomplete**.

**Commit:**

```
feat(store): Phase 1C/D — artist vs release detail views, enriched data

Brief 036 v3 Phase D. AlbumDetailView renamed to ReleaseDetailView,
enriched with tracks, release date, price, description. New
ArtistDetailView renders discography grid + optional bio. Tile
rendering branches on kind. Router branches on kind.

- ReleaseDetailView.tsx: enrichment + new bandcamp:get-release-detail IPC
- ArtistDetailView.tsx: new view + new bandcamp:get-artist-detail IPC
- AlbumTile.tsx: kind-aware rendering and routing
- StoreView.tsx: router branches on kind
```

---

### Phase E — Surfaces (Featured for You + pre-connect defaults + sidebar prioritization)

**Goal:** The Store landing page is no longer mostly empty. Pre-connect shows default surfaces. Post-connect shows personalized surfaces including the library-driven Featured for You.

**Files:**
- `src/renderer/views/BandcampStore/PersonalizedSections.tsx`
- `src/renderer/views/BandcampStore/FeaturedCarousel.tsx`
- `src/renderer/views/BandcampStore/StoreSidebar.tsx`
- `src/main/bandcamp-integration/personalization/` modules

**Step E.1 — Implement Featured for You (library-only).**

The staples formula (Decision 6) operates on the V3 library data. Read library tracks via the existing in-process library state (not a new IPC). Compute staple scores per artist (aggregate across their tracks in the user's library). Take top N (e.g., 8) staple artists.

For each staple artist, the surface shows:
- Artist name
- A "More from this artist on Bandcamp" tile that, on click, runs a Bandcamp catalog search for the artist name.

If the artist exists on Bandcamp, the search result tile becomes their ArtistDetailView entry point. If not, the tile shows "Not found on Bandcamp" (acceptable degradation).

**Step E.2 — Pre-connect default surfaces.**

When `connected === false`, render at least:
- **Featured for You** (works without connection — library-only)
- **Popular on Bandcamp** (using a public discover endpoint; if no public endpoint is reachable, omit this surface and add a note in self-review)

Verify the public endpoint by hitting it directly first:

```bash
curl -s 'https://bandcamp.com/api/discover/3/get_web?...' | head -100 > Dr.\ Claude/036-phase1c-verification/E/discover-endpoint-test.txt
```

If the endpoint requires auth or returns error, document that in the verification file and skip the Popular surface. **Do not invent fake content.**

**Step E.3 — Post-connect surfaces.**

When `connected === true`, the page renders (in order):
1. **Featured for You** (library-driven)
2. **Your New Picks** (follows-driven — now actually populated, since Phase C captured band URLs that the picks logic can query)
3. **From Your Wishlist** (if wishlist non-empty)

For "Your New Picks": iterate the user's follows that have a `bandUrl`. For each, fetch latest release via the band's RSS feed or public discography page. Filter to releases within the last 90 days. Rank by recency + engagement score (use library staple score if the artist exists in library).

**Step E.4 — Sidebar prioritization.**

The genre rail currently shows a hardcoded list. Replace with library-derived ordering: count tracks per genre tag in the library, sort genres by frequency descending, then by alphabetical for ties. Cap at top 20 genres. Below the top 20, show "More genres" disclosure.

**Verification E:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # expect 0
npm run build 2>&1 | tail -5                       # expect exit 0
```

**Manual smoke test:**

1. Run dev. Disconnect from Bandcamp first (clear the partition or use a fresh profile path).
2. Navigate to Store. Screenshot: `Dr. Claude/036-phase1c-verification/E/01-pre-connect-landing.png`
   - Must show Featured for You with real library-derived content.
   - Must NOT be empty.
3. Connect Bandcamp.
4. Wait for sync to complete (Re-sync button will be implemented in Phase F; for now, refresh manually if needed).
5. Screenshot: `Dr. Claude/036-phase1c-verification/E/02-post-connect-landing.png`
   - Featured for You still renders.
   - Your New Picks now has content from follows.
6. Check sidebar genre rail. Screenshot: `Dr. Claude/036-phase1c-verification/E/03-sidebar-genres.png`
   - Genres ordered by library frequency, not alphabetically.

**Commit:**

```
feat(store): Phase 1C/E — Featured for You, pre-connect defaults, sidebar weighting

Brief 036 v3 Phase E. Featured for You surface implemented using
library staple-score formula. Pre-connect state shows Featured for You
(and Popular on Bandcamp if public endpoint available). Your New Picks
now populated from follows with bandUrl. Sidebar genre rail ordered by
library frequency.

- PersonalizedSections.tsx: surfaces wired
- FeaturedCarousel.tsx: library-driven content
- StoreSidebar.tsx: frequency-ordered genre rail
- personalization/staples.ts: staple score implementation
- personalization/follows-picks.ts: latest-release fetching per follow
```

---

### Phase F — Re-Sync Button

**Goal:** A visible button labeled "Re-sync" (or matching the existing "Try Re-sync in a bit" copy) that triggers `bandcamp:refresh-profile` and shows a loading state.

**Files:**
- `src/renderer/views/BandcampStore/StoreHeader.tsx` (or wherever the Connect button now appears as `@jrosey30`)
- Possibly `src/renderer/views/BandcampStore/PersonalizedSections.tsx` if the button lives inside Your New Picks

**Step F.1 — Locate the existing "Try Re-sync in a bit" copy:**

```bash
grep -rn "Re-sync\|Try Re-sync" src/renderer/views/BandcampStore/
```

**Step F.2 — Add the button.** Adjacent to the username display, or inside the Your New Picks empty state. The button:
- Label: "Re-sync"
- On click: dispatch `bandcamp:refresh-profile` IPC
- Disabled state while in-flight
- Shows spinner or "Syncing…" text while in-flight
- Updates UI when IPC resolves (re-fetches profile data, re-renders surfaces)

**Step F.3 — IPC handler.** Confirm `bandcamp:refresh-profile` exists and re-runs the full scrape (follows + collection + wishlist), persists the updated profile JSON, and emits an event the renderer can subscribe to.

**Verification F:**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # expect 0
npm run build 2>&1 | tail -5                       # expect exit 0
```

**Manual smoke test:**

1. Run dev, connect Bandcamp.
2. Note the current state of follows count (or some surface).
3. Click Re-sync. Screenshot mid-sync (showing loading state): `Dr. Claude/036-phase1c-verification/F/01-syncing.png`
4. Wait for completion. Screenshot post-sync: `Dr. Claude/036-phase1c-verification/F/02-post-sync.png`
5. Verify profile JSON has updated `fetchedAt` timestamp:

```bash
cat ~/Library/Application\ Support/JakeTunes/bandcamp-profile.json | python3 -c "import sys, json; d=json.load(sys.stdin); print('fetchedAt:', d['fetchedAt'])"
```

Compare to pre-sync timestamp — must be newer.

**Commit:**

```
feat(store): Phase 1C/F — Re-sync button

Brief 036 v3 Phase F. Adds visible Re-sync button matching existing
"Try Re-sync in a bit" copy. Wires to bandcamp:refresh-profile IPC
with loading state.

- StoreHeader.tsx (or relevant location): Re-sync button + loading state
```

---

## 5. Final Verification (Required Before Marking Complete)

After all six phases commit, run the final end-to-end verification:

### 5.1 — Build and type check

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l   # expect 0
npm run build 2>&1 | tail -10                      # expect exit 0
```

Save full output to `Dr. Claude/036-phase1c-verification/final/build.txt`.

### 5.2 — End-to-end user journey (required, no skipping)

1. Fresh `npm run dev`.
2. **Pre-connect:** Click Bandcamp Store sidebar. Store landing renders with Featured for You (library-driven). No empty void.
3. **Connect:** Click Connect Bandcamp. Authenticate. Username displays. Surfaces repopulate.
4. **Search:** Search "Panic Shack". Both artist and release tiles render with distinct visuals.
5. **Artist detail:** Click Panic Shack artist tile. ArtistDetailView renders with discography.
6. **Release detail:** From discography, click "grin & bear it" (or any release). ReleaseDetailView renders with tracks, release date, price, description.
7. **Buy (critical):** Click Buy on a pay-what-you-want or free release. Modal opens. Renderer remains visible underneath. Close modal. Renderer responsive.
8. **Optional purchase test:** If executor is comfortable, complete a real purchase ($0.50–$1 range). Verify track downloads and routes through `importOneFile()` into the library. Confirm track plays from the library.
9. **Re-sync:** Click Re-sync button. Loading state appears. Completes. Profile JSON `fetchedAt` updates.

Screenshot every step to `Dr. Claude/036-phase1c-verification/final/01-…09-…`.

### 5.3 — Self-Review Checklist (must be filled out)

Create `Dr. Claude/036-phase1c-verification/final/self-review.md` with this checklist filled in:

```markdown
# Brief 036 v3 Phase 1 Completion — Self-Review

## Phase A — Type System
- [ ] tsc passes (output saved)
- [ ] Sample search result JSON shows both kinds (file saved)
- [ ] Single commit pushed

## Phase B — Buy-Flow Containment
- [ ] tsc passes
- [ ] Build passes
- [ ] 3 screenshots saved (before/during/after click)
- [ ] Renderer remains responsive across full Buy flow
- [ ] If shell.openExternal fallback used, explained here: _______
- [ ] Single commit pushed

## Phase C — Scrape v2
- [ ] tsc passes
- [ ] Raw fancollection response saved
- [ ] Raw collection response saved
- [ ] Profile JSON post-refresh saved
- [ ] following[] has bandUrl for ≥90% of entries (actual %: ___)
- [ ] collection[] includes Panic Shack spike purchase: yes / no
- [ ] wishlist[] matches user's Bandcamp wishlist: yes / no
- [ ] Single commit pushed

## Phase D — UI Completion
- [ ] tsc passes
- [ ] Build passes
- [ ] 3 screenshots saved
- [ ] ArtistDetailView renders with discography
- [ ] ReleaseDetailView renders with tracks/date/price/description
- [ ] Single commit pushed

## Phase E — Surfaces
- [ ] tsc passes
- [ ] Build passes
- [ ] Public discover endpoint test saved (or reason omitted)
- [ ] Pre-connect landing screenshot saved (not empty)
- [ ] Post-connect landing screenshot saved (Your New Picks populated)
- [ ] Sidebar genre rail screenshot saved (frequency-ordered)
- [ ] Single commit pushed

## Phase F — Re-Sync
- [ ] tsc passes
- [ ] Build passes
- [ ] Mid-sync screenshot saved
- [ ] Post-sync screenshot saved
- [ ] Profile fetchedAt updates: pre=______, post=______
- [ ] Single commit pushed

## Final E2E
- [ ] Build clean (output saved)
- [ ] All 9 E2E steps completed with screenshots
- [ ] (Optional) Real purchase tested: yes / no — outcome: ______

## Honest Assessment
- Items I claimed complete but am uncertain about: _______
- Items that diverged from the brief and how: _______
- Bugs discovered but out of scope (file as new briefs): _______
```

**The self-review file must be committed to the verification directory before claiming the brief complete.** Do not push the final commit without it.

---

## 6. Commit Discipline Summary

Six commits, one per phase, in order. Push after each phase commits and verifies. Do not batch.

```
feat(store): Phase 1C/A — discriminated union for artist vs release results
fix(store):  Phase 1C/B — Buy-flow containment, renderer no longer eaten
feat(store): Phase 1C/C — scrape v2 captures URLs, collection, wishlist
feat(store): Phase 1C/D — artist vs release detail views, enriched data
feat(store): Phase 1C/E — Featured for You, pre-connect defaults, sidebar weighting
feat(store): Phase 1C/F — Re-sync button
```

A final commit lands the verification artifacts:

```
docs(store): Phase 1C verification artifacts + self-review
```

---

## 7. What NOT To Change

- Do NOT modify `importOneFile()` in `src/main/index.ts`. Reuse it as-is.
- Do NOT change existing IPC channel names. Extend with new channels (`bandcamp:get-release-detail`, `bandcamp:get-artist-detail`) but do not rename existing.
- Do NOT modify the `metadata-overrides.json` system. Bandcamp purchases route through `importOneFile()` which handles tagging.
- Do NOT introduce new top-level npm dependencies. `yauzl` is already in `package.json` from original Phase 1.
- Do NOT touch the spike harness at `spike/bandcamp/` — it's already merged-and-done.
- Do NOT touch any non-Bandcamp code (the rest of the V3 codebase is out of scope). If a non-Bandcamp file needs editing for compile, flag in self-review.
- Do NOT silently expand scope. If you discover a tenth gap mid-execution, finish the current phase, then STOP and report. Do not roll the new gap into this brief.
- Do NOT skip the verification screenshots. The point of this brief is to replace "BUILT, unrun" with proof-of-run.

---

## 8. What Done Looks Like

1. All 6 phases committed (6 commits) + 1 verification artifacts commit = 7 commits total on `claude/036-bandcamp-store-phase1` past `4a4b0a9`.
2. `npx tsc --noEmit` produces 0 errors.
3. `npm run build` exits 0.
4. App boots without console errors related to Bandcamp.
5. Bandcamp Store sidebar entry present and functional.
6. Pre-connect Store landing is not empty.
7. Post-connect Store landing shows Featured for You + Your New Picks + (optional) wishlist surface, all with real content.
8. Search returns mixed artist + release results, each routing to correct detail view.
9. Artist detail shows discography. Release detail shows tracks/date/price/description.
10. Buy flow opens modal (or external browser fallback), does NOT nuke renderer.
11. Connect Bandcamp populates `following[]` with `bandUrl`, `collection[]` with owned items, `wishlist[]` matching user's actual wishlist.
12. Re-sync button visible and updates `fetchedAt`.
13. All verification screenshots saved to `Dr. Claude/036-phase1c-verification/`.
14. Self-review checklist filled out and committed.
15. All 7 commits pushed to `origin/claude/036-bandcamp-store-phase1`.

---

## 9. Out of Scope (Defer to Future Briefs)

- **Brief 037**: Queue drop-in audit-then-fix (pending, separate work).
- **Tier 2 surfaces**: Label Radar, Vinyl Listings, Bandcamp Live integration.
- **Multi-country pricing display**: currently we show the user's locale price; multi-currency comparison is later.
- **Search result count expansion**: current cap appears low (2 results for "Panic Shack"). Investigate as a Phase 2 follow-up.
- **Track preview player polish**: PreviewPlayer.tsx exists from Phase 1; this brief doesn't change it. Audit/polish later.
- **Bandcamp Friday detection / special pricing**: later.
- **Re-rank of search results by library signals**: This was in original Phase 1 design but is deferred — the search result count is so low currently that re-ranking is moot. Revisit when result count expands.
- **Mobile / iOS Store mirror**: separate brief stream, separate executor (Matt Mobile).

If during this work you discover something in scope but not on the change list, **STOP and ask**. Do not silently expand scope.

---

## 10. Methodological Notes (for the executor)

This brief exists because Phase 1's self-review claimed "BUILT, unrun" for 13 verification tests + 3 early-validations, and most of those tests would have surfaced gaps that owner-validation later caught. The cost of that gap was significant — multiple hours of owner debugging, three rounds of brief drafting, and a near-abandonment of the entire Store initiative.

The verification protocol in this brief is intentionally heavy. Every phase requires artifact production. The self-review is mandatory. **If running the verification feels like overhead, that's the discipline working — the alternative is rework cycles much more expensive than the verification.**

If any premise in pre-flight (§2) doesn't hold, STOP and report. Do not adapt silently.

If any architectural decision (§3) becomes infeasible during execution, STOP and report. Do not pick an alternative without confirmation.

If discovery during execution reveals a tenth gap, finish the current phase cleanly, then STOP and report. Do not roll the new gap into this brief.

---

**End of Brief 036 v3.**
