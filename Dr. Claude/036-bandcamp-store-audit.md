# Brief 036 v2.1 — Audit Findings (Bandcamp Store)

**Status:** Audit complete (read-only). NO implementation. Awaiting Dex/Jake approval.
**Auditor:** Claude Code · **Date:** 2026-05-21 · **Repo:** `/Users/jacobrosenbaum/JakeTunesV3/`

**Two boundaries I'm holding (stated up front so the architecture reflects them):**
1. **Data access: sanctioned/structured-first, polite, non-evasive.** I will not build the risk-register's "user-agent rotation" (deliberately defeating anti-scraping defenses). Recommended path below uses Bandcamp's *own* embedded structured data via Jake's *own* authenticated browser session — the least-intrusive option, not headless evasion.
2. **Auth: Jake logs himself in.** I never handle his Bandcamp credentials or log in as him. Audit items requiring an authenticated session are **designed now, empirically confirmed later with Jake driving the session** — marked ⏸ PENDING-SESSION below.

Note: unlike Brief 035, this feature is **not** gated behind `JAKETUNES_PERSONAL_BUILD` — Bandcamp is a legitimate store, so the Store ships normally. A plain feature flag for staged rollout is still reasonable.

---

## Task 8 — JakeTunes library signals ✅ DONE (real data)
Library: **6,547 tracks · 850 artists · 107 genres.** Field population:

| Field | Coverage | Verdict |
|---|---|---|
| artist/album/title/genre | 100% | ✅ core |
| year | 99% | ✅ era profile |
| contributingArtists | 100% | ✅ collab-aware |
| bpm / camelotKey | **97%** | ✅ **sonic-similarity signal (brief omits this — opportunity)** |
| playCount>0 | 33% (2,181) | ⚠️ partial |
| lastPlayedAt | 5% | ⚠️ sparse |
| skipCount | 1% | ⚠️ sparse |
| **rating** | **0.3% (21)** | ❌ unusable — build no surface on it |
| **label** | **field absent (0%)** | ❌ no library label signal at all |

- **`label` does not exist on `Track`.** Every library-driven label surface ("Discover Labels From Your Library," library half of "Labels You Support") is **impossible without enrichment** (MusicBrainz, ~850 artist lookups — its own sub-project). Decision needed.
- **`rating` is dead.** Engagement must come from plays.
- **The real engine input is `~/Library/Application Support/JakeTunes/listener-profile.json`**, not raw per-track fields: `artistPlays` (292), `albumPlays` (377), `genrePlays` (62, finer taxonomy than library `genre`), `totalPlays` 847, `recentPlays` (200), `recentSkips` (50), 15 NL `observations`. Far better than the 33%-populated `playCount`. Its genre taxonomy differs from the library's → needs a normalization map.

## Task 6 — Existing visual vocabulary ✅ DONE
JakeTunes is **already an iTunes-8 (Sept 2008) recreation** — tokens in `src/renderer/styles/variables.css`:
- Chrome `#d6d6d6→#c4c4c4`; sidebar blue-gray `#c1cad7→#a9b4c2`; selection blue `#5b86dc→#3e6ec7`; cream LCD pill; `--font-family: -apple-system, "Lucida Grande", sans-serif` (**Lucida Grande already canonical**).
- **Brand accent = warm orange `#bb4308`** (sampled from logo), hard rule: *"anything orange routes through these tokens — never a one-off literal,"* all buttons are the orange glossy iTunes-8 gradient.
- **Implication:** the brief's "blue `#2c5aa0` + Lucida Grande" is largely already satisfied — except the brief's specific blue ≠ JakeTunes' iTunes-8 blue. Reuse existing tokens. **One real conflict: Buy-button color** (iTunes Store used blue price buttons; JakeTunes' whole CTA identity is orange). → **DECISION**: brand-orange Buy buttons (recommended — satisfies both "looks iTunes" and "belongs in JakeTunes") vs faithful iTunes blue.
- Reusable vs Store-specific: reuse tokens + button/panel styles; Store-specific = carousel, album grid, store header. Build `itunes-tokens.css` as a thin alias layer over `variables.css`, don't fork the palette.

## Task 7 — iTunes Store 2008-2010 reference 🟡 PARTIAL
- I can't capture live screenshots in this environment → **flag**: Jake to provide 3-5 reference shots, or I'll work to a written spec. Era visual spec is well-characterized: white bg + `#f5f5f5` panels, gridded 120px art, rounded gradient buttons, top carousel ~600×250, left genre rail, blue links.
- **Skip iTunes-Store-specific cruft that doesn't map to Bandcamp:** iTunes LP, Ping, Genius, star ratings on store items, "Complete My Album." Keep: carousel, grids, album/artist detail, charts (repurposed as *personalized* charts).

## Task 1 — Catalog data accessibility 🟡 PARTIAL (live-grounded)
Live fetches today:
- **Bandcamp Daily** (`daily.bandcamp.com`) — clean **server-rendered HTML**: article title, section (FEATURES/ALBUM OF THE DAY/LISTS/…), date, author, artist/album refs, links. Easily parsed. No RSS visible in fetch (Bandcamp historically exposes feeds — verify). → Phase 2 editorial is low-risk.
- **Search** (`/search?q=`) — **JS/XHR-rendered**: a plain HTTP fetch returns *"A required part of this site couldn't load"* (no results in static HTML). **Confirmed.** ⇒ search/discover cannot be scraped by simple HTTP GET; you need either the rendered DOM inside the webview or Bandcamp's internal search/discover JSON XHR endpoints.
- **Album pages** (`<artist>.bandcamp.com/album/<slug>`) — server-render an embedded **`data-tralbum` JSON blob + JSON-LD `MusicAlbum`** (title, artist, track list, prices, art, release date). This is the site's *own* structured data and the cleanest, most stable parse target. ⏸ confirm exact shape on a live album URL during impl.
- Anti-scraping signal: the search shell-error on plain fetch indicates JS/bot gating ⇒ **prefer reading through the webview's real browser context** (renders JS, carries Jake's session, behaves like a normal browser) over headless HTTP. This is both more robust and the most defensible posture.

## Task 2 — Account/profile data ⏸ PENDING-SESSION (designed)
- URLs: `bandcamp.com/<username>/{collection,wishlist,following}`. These historically embed a `data-blob` JSON (initial page of items) and paginate via the **fan collection JSON API** (`/api/fancollection/1/collection_items`, POST `{fan_id, older_than_token, count}`) — i.e., profile data *is* available as JSON once authenticated. ⏸ confirm `fan_id`, token shape, per-item fields (artist, album, item_id, item_url, tags, release date, geo) with Jake logged in.
- Pagination for 1000+ items: token-based, batch ~20-40/req → page politely with delays.
- Cookies: Bandcamp uses `identity` + `session` cookies; webview must persist them (Electron `partition: 'persist:bandcamp'`).
- **I will not log in as Jake to confirm these live.**

## Task 3 — Authentication ⏸ PENDING-SESSION (designed)
- Webview login with a persistent session partition; **Jake enters his own credentials.** Cookies survive restarts via the persist partition.
- 2FA: Bandcamp email-code verification is just a form → should work in-webview; if a provider popup misbehaves, fall back to first-auth in the system browser (flag).
- Session expiry length unknown ⏸ → design for graceful re-auth: detect login-redirect/401, show a "Reconnect Bandcamp" prompt; never silently fail.
- Logout: clear the persist partition + delete the Keychain token.

## Task 4 — Download interception (purchase) ⏸ PENDING-SESSION (designed)
- Post-purchase, files come from the account download page as a GET to a signed URL; **format is user-selectable** (FLAC/ALAC/MP3-320/V0/etc.) per Bandcamp's download UI. Electron `will-download` + `item.setSavePath()` intercepts cleanly.
- **Full-album purchases download as a ZIP** (not per-file) → the filename-parser must handle **zip extraction + per-track routing**, not just single files. The brief assumes per-file; flag this.
- Filename pattern (typical): `Artist - Album - NN Track.ext`; ⏸ confirm on a real purchase.
- Metadata: Bandcamp embeds proper tags + cover art (Vorbis/ID3) → good for library ingestion.

## Task 5 — Personalization schema 🟢 DESIGNED
- `bandcamp-profile.json`: `{ fanId, username, scrapedAt, collection:[{itemId,itemUrl,artist,album,tags[],releaseDate,geo}], wishlist:[…], following:[{artist,artistUrl}], derived:{ tagFreq, labelAffinity, geoClusters, eraBuckets } }`.
- Unified profile (in-memory, recomputed): merges library signals (from `library.json` + `listener-profile.json`) with Bandcamp `derived`. **Schema must not depend on library `label`/`rating`** (absent/dead) — see Task 8.
- Refresh: full on first connect; incremental daily (token-walk only new items); manual button. Recompute derived signals after each scrape.
- Perf: 1000+ item collection ≈ a few MB JSON — fine on disk; lazy per-surface ranking.

## Task 9 — Library↔Bandcamp signal merging 🟢 DESIGNED
- **Tags:** canonicalize library `genre` (107) + `genrePlays` (62) + Bandcamp multi-tags into one tag space via a normalization map; weight **engagement (listener-profile plays) > library presence > Bandcamp tags**.
- **Overlap (Owned badge):** normalized (artist, album) match — reuse the Brief 031 normalization discipline; gate on **identity going forward** by storing Bandcamp `item_id`/`item_url` on tracks bought via the Store (exact future matches), fuzzy-match only legacy library.
- **Label affinity:** library has none → **v1: Bandcamp-only label affinity** (recommended). Optional MusicBrainz enrichment of library labels is a flagged sub-project (~850 artist lookups, rate-limited). → DECISION.
- **Shape normalization:** roll library per-track up to (artist, album) release units for overlap/era; keep per-track for play-weighting.
- **Cold start:** Jake already has a rich library + listener-profile → library-driven surfaces work day one; Bandcamp surfaces show "Connect Bandcamp" until auth.

## Task 10 — Architecture 🟢 DESIGNED
- **Data access (recommended):** read catalog/profile pages **inside the webview's authenticated browser context**, then parse the embedded `data-tralbum`/`data-blob` JSON + JSON-LD (and the fan-collection JSON API for profile pagination). This renders JS (search needs it), carries Jake's session, is polite, and avoids headless evasion. **No UA rotation.** Honor rate limits + cache hard.
- **Caching:** disk cache keyed by album/artist/tag URL; TTL catalog 24h, Daily 6h, profile incremental daily.
- **Sync:** library signals recompute on launch + on `library.json` change (cheap, local); Bandcamp profile incremental daily + manual.
- **Recommendation compute:** eager derive on profile refresh; lazy per-surface ranking with short cache.
- **Component structure:** the brief's directory layout is sound. Add a `zip-extractor` to acquisition (Task 4). `itunes-tokens.css` = alias layer over `variables.css`, not a palette fork.

---

## Risks / unknowns
- Bandcamp changes its embedded JSON-blob/HTML shape → parser breaks (maintenance burden; accept).
- Search/discover JS-gating → must use webview DOM or internal JSON XHR; both undocumented/unstable.
- **Album-ZIP downloads** (Task 4) — real case the brief under-specs.
- **Library `label` absent + `rating` dead** (Task 8) — three brief surfaces depend on data that isn't there.
- Auth/2FA-in-webview, session length — ⏸ unverifiable without Jake's session.
- Even webview-context automated reads are *technically* automated access of Bandcamp; far lower risk than headless evasion, but not zero — Jake should choose it knowingly.
- Visual QA needs reference screenshots I can't capture here.

## Decisions needed before implementation
1. **Data access:** webview-context reads of Bandcamp's own embedded JSON (recommended) — OK?
2. **Buy-button color:** brand-orange (recommended) vs iTunes blue.
3. **Label affinity:** Bandcamp-only for v1 (recommended) vs MusicBrainz library-enrichment now.
4. **Album-ZIP handling:** confirm acquisition must extract zips + route per-track.
5. **Visual refs:** Jake supplies iTunes Store 2008-2010 screenshots, or I work to written spec.

**STOP — awaiting approval. No implementation begun.**
