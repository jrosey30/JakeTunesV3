# JakeTunes — Next Level: The Discovery Brain (+ Foundation)

_Planning doc, 2026-06-06. North star for the post-stabilization arc. Edit freely._

## Vision
Turn JakeTunes from a library manager with an AI persona into a **taste-aware
music-discovery curator**: it knows your genres deeply, follows the publications
that matter for *your* taste, tracks the best new music, and surfaces "best new
music for you" — grounded in your actual library, not a generic algorithm. No
streaming app can do this, because no streaming app *is* your library.

## Taste profile (from the library, 2026-06-06 — the brain's starting point)
7,573 tracks · 976 artists · 112 genres · 6,037 plays. Three spines:
- **Rock/alt/punk** — RHCP, Sublime, blink-182, Nirvana, Talking Heads (~2,900 tracks across Classic Rock / Alternative / Punk / Grunge)
- **Hip-hop** — Rap is the #1 genre (945 tracks); Drake, Eminem
- **Electronic/dance** — Daft Punk, LCD Soundsystem, The Orb, Underworld, House, Parallelle

Era skew: **2020s is the largest decade (2,221)** — Jake is an *active new-music
collector*. Discovery automates behavior he already does by hand. Greenpoint, BK
(local-scene relevance: Brooklyn Vegan, local labels).

Taste-matched sources to seed the radar: Pitchfork, Stereogum, Brooklyn Vegan,
Resident Advisor + Bandcamp Daily (dance), Complex / Passion of the Weiss (rap).

## Decisions (locked)
1. **Freshness:** live web-search v1 (Anthropic web search via Music Man), then
   layer scheduled feed-ingestion + caching. (Both, phased.)
2. **Home of discovery:** a dedicated **"New for You"** sidebar feed; Music Man
   is the conversational layer on top; the Listen-to-the-List "suggests" strip
   gets upgraded from lineage-guesses to real current releases.
3. **Sequence:** **Foundation beat first**, then the brain.

---

## Phase 0 — Foundation beat (DO FIRST)
The insurance, earned by 2026-05-29/30. Ship before the moonshot.
- **Backup/restore as a feature.** Promote the manual `.smbdelete`/`.bak`
  rescue into a real capability: scheduled + on-demand verified snapshots of
  `library.json` (+ key state) to a rotating, timestamped local store (and the
  NAS mirror); a **Restore** UI in Settings that lists snapshots (track count +
  date) and restores one with confirmation. Retention = keep N.
- **Data-layer test net.** `npm test` (node --test) coverage for: save-library
  guards (refuse empty / >50% shrink; unlink cap), load-tracks happy + torn-read
  paths, recover-orphans (additive, fingerprint-dedup), and normalize/reco-match
  (Cursor started these — extend). Locks in the safety so refactors can't quietly
  regress it.
- _Follow-up (separate beat): the parked performance pass (Songs list / view
  switch / playback)._

## Phase 1 — Taste model
Persist the taste fingerprint: genres/artists/eras/play-weights + the existing
`embeddings.bin` (per-track vectors) → a queryable profile every discovery query
ranks against. Reuse the library digest + Music Man's existing library awareness.
Output: "given a candidate release, score its fit to Jake's taste + which spine."

## Phase 2 — New-music radar (live-web v1)
Music Man (Anthropic web search) answers "best new music in {genre} right now"
and "new releases this week you'd like," cross-referenced against the taste model
and the owned-library filter (don't suggest what he has). Returns ranked
candidates with a one-line "why you'd like it" + links (preview/Bandcamp/iTunes).
_Phase 2b:_ scheduled feed-ingestion (Pitchfork BNM, RA, Bandcamp Daily RSS/APIs)
+ cache, so the feed is instant + works offline and web-search becomes augmentation.

## Phase 3 — "New for You" feed (the surface)
New sidebar view: ranked new releases in your genres + editorial picks, each with
cover, why-you'd-like-it, preview, and Add-to-Listen-List / Add-to-library inline.
Music Man conversational layer ("what's good in house right now?"). Upgrade the
Listen-to-the-List "suggests" strip to draw from the radar.

## Phase 4 — Genre intelligence
The brain builds deep, current, per-genre knowledge (scenes, sub-genres, key new
artists, labels, publications) for the genres Jake loves, so it gets smarter with
use and genre deep-dives feel authoritative.

---

## Backlog
- ✅ **DONE (4.5.0-120) — Merged Listen-to-the-List + New for You into one
  "Discovery" view.** ONE sidebar entry → two-tab toggle ("New for You" radar /
  "Your List" jots). `DiscoveryView.tsx` renders each existing leaf view
  unchanged (both keep their own module caches + scroll). Old `new-for-you` /
  `listen-to-the-list` view names still resolve to the right tab (back-compat).
- ✅ **DONE (4.5.0-120) — Recolored Discovery teal (`#1f7a8c`).** Sidebar entry
  (compass icon), tab bar, and the New for You accents (refresh / preview / add)
  are all teal now — cool, distinct from the Music Man's warm `#bb4308`.

## Open questions / risks
- **API cost** of live web-search per query → cache aggressively; rate-limit.
- **Feed ToS / scraping** for Phase 2b → prefer official RSS/APIs (Bandcamp, RA),
  avoid brittle scraping.
- **Taste drift** → recompute the fingerprint on library change (cheap).
- **"Best new music" subjectivity** → ground in publications + taste fit, and let
  Music Man cite *why* (never fabricate — the persona rule + the 04-25 postmortem).
