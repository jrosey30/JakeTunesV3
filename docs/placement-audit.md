# Placement Audit — JakeTunes 6.0 (2026-09-02)

**For Jake to react to. Nothing here moves until you point at it.**

The soul is the iTunes-looking library. It is the constraint, not the subject:
the audit may move features to better homes; it may not make the app stop
looking and feeling like 2006 iTunes. Standing rules apply: no unrequested UI
features, "looks off" = one fix then pause, names never clip, type tokens are px.

Grades: **KEEP** · **MOVE** · **MERGE** · **DEMOTE** · **PROMOTE** · **VERIFY**
(I could not tell from the code how often you use it — you decide).

---

## Part A — Desktop

### A1. Inventory, as installed today (build 45e12ff)

**Sidebar**
- LIBRARY: Home · Songs · Artists · Albums · Live Concerts · Genres · **Record Shop** (orange) · **The Music Man** (orange)
- STORE: Bandcamp Store · Download · Beck v. Prupis
- ACTIVITY SYNC: iPod Pool — only while the pool has songs
- MIXTAPES: New Mixtape… · every tape
- SYNCED SETS: only when a saved activity set exists
- PLAYLISTS: pinned (max 3) · smart lists · user lists A–Z
- DEVICES: only with an iPod or CD mounted
- Hidden on purpose: DJ booth (shelved 8/4, route intact) · the old Record Store view (Record Shop replaced it)

**Routes with no sidebar door** (reached from Home, the Shop, or context): Discovery · Listen to the List · New for You · SCOTUS archive · CD import (device-gated) · mix detail · concert detail

**Toolbar**: transport · now-playing pill · repeat/shuffle · three round persona controls (mic, voice, record) · volume · Visualizer (⌘T) · AirPlay · Up Next · Search

**Home** (11 bands, in order): featured album · Made for You (mixes + "Make me a vibe") · Listening Memory · Rediscover · Recently Added · Top Artists · Live Near You · At Your Venues · On the Horizon · New This Week · Music News

**Device page**: Activity Sync · Full Sync · On This iPod… · Sync History · Eject. Activity sheet: Who picks (Music Man / My iPod Pool) · size · activity · fine-tune.

**Settings tabs**: Playback · EQ · Library · Sync · Audio · AI

**Song context menu** (13): Play · Play Next · Add to Up Next · Add to Playlist ▸ · Add to iPod Pool · Go to Artist · Go to Album · Star/Unstar · Get Info · Add Artwork… · Fetch Artwork from Internet · Cynthia!! · Delete Song

### A2. Verdicts

**Download flow** (you flagged it first — "hit or miss")
- Today there are four ways to get music: Record Shop (Get on a card), Bandcamp Store, the Download page (queue + manual search), Discovery cards. Two of those live under STORE, one under LIBRARY, one has no door.
- **MOVE (recommended, cheap): give "Download" a live count badge** the way iPod Pool has one — active downloads visible from anywhere without opening the page. The badge component exists now; this is a few lines.
- **MERGE (bigger, your call): fold the Download page into the Record Shop as its counter** — one place to find, get, and watch music arrive. STORE would then be Bandcamp only. This is a real relayout; only if the split annoys you.
- **VERIFY**: the Enter key in the top-right Search box started playing a song today ("Hooked" — Hello Sailor) instead of showing results. If that's by design, fine; if not, it's a P2.

**Record Shop and The Music Man in LIBRARY, painted orange**
- **KEEP.** They aren't library views, but they are the app's two personalities, and the color says exactly that. Moving them into their own section would make the sidebar longer for no gain.

**Beck v. Prupis under STORE**
- **MOVE.** It's a private archive (never a track, never public), not a store. Proposal: last row of LIBRARY, or its own one-row "ARCHIVE" section. Zero risk either way.

**Genres**
- **VERIFY.** Last in LIBRARY already. If you never click it, DEMOTE to a View-menu item; if you do, KEEP.

**Live Concerts**
- **KEEP.** Earned its place in LIBRARY; concerts are a first-class thing you own.

**Home page — 11 bands**
- **MERGE: Live Near You + At Your Venues + On the Horizon → one "Shows" band** with three rows. Three headings for one idea is the longest stretch of the page.
- **VERIFY the order.** Made for You and Recently Added are the two you hit daily; Listening Memory and Rediscover are the brain's best surfaces. If News is never read, DEMOTE it to the bottom (it is already) or behind a disclosure.
- Everything else KEEP.

**Mixtapes / Playlists / Synced Sets**
- **KEEP.** The conditional sections (Synced Sets, Devices, Activity Sync) are right: they appear when they mean something and vanish when they don't. That's the iTunes way.

**Routes without a door** (Discovery, Listen to the List, New for You)
- **KEEP them doorless.** The sidebar is library + playlists; these are Home/Shop destinations. Only ask: does each have a visible link on the page it belongs to? Discovery and New for You do (Home/Shop). Listen to the List — VERIFY it's reachable from the Shop's list wall.

**Toolbar**
- **KEEP.** Nothing here is misplaced. The three persona buttons are the one cluster a new user wouldn't decode, but this app has one user.

**Device page + Activity sheet**
- **KEEP** as of today's build. The pool joined the sheet instead of the sidebar; history is a sheet; Full Sync is a separate, confirmed button. Done right.

**Settings**
- **KEEP** the six tabs. Sync now shows the "waiting on the NAS" state honestly instead of red.

**Context menu**
- **KEEP.** Thirteen is long but every item is used; "Add to iPod Pool" sits under "Add to Playlist" where a hand expects it.

**DJ booth**
- **KEEP shelved** until you ask. The route works; the sidebar row is a one-line restore.

### A3. If you approve everything marked MOVE/MERGE, the work is:
1. Download count badge — DONE 9/2 (ef989ee): live count of jobs in flight on the sidebar row.
2. Beck v. Prupis → ARCHIVE — DONE 9/2 (ef989ee): its own one-row section under STORE.
3. Shows band merge on Home — DONE 9/2 (ef989ee): one "Shows" band, three sub-headed rows.
4. Download → Record Shop counter — half a day, and only if you want it. (Not asked for; open.)

---

## Part B — Mobile: the ironclad sync audit

Your rule, stated 9/2: **mobile gets nothing iPod — but desktop and mobile must
be in ironclad sync with JakeTunes.** So this is not "does mobile have every
desktop feature." It is: for every piece of state the two share, is the pipe
real, in which direction, how fast, and where can it silently drift.

### B1. Every shared state surface

| State | Direction | Pipe | Cadence | Weak point |
|---|---|---|---|---|
| Library metadata (library.json) | desktop → homemini | orchestrator: scp + backend restart; NAS mirror | on import/edit/playlist change, debounced; 6 h safety net | **Remote mode runs quick passes only; a full pass is owed until you're home.** Breaker deferrals are now silent for automatic runs (fixed today). |
| Audio files | desktop → NAS → homemini serves | rsync, no `--delete` | with the library sync | SMB mtime churn; remote mode waits for home; pass-through eviction depends on this having landed. |
| Playlists | both ways | hub converge on homemini, newest stamp wins, tombstones | debounced on every save | Stamps compare as strings — every writer must use `toISOString`. Hand edits bit us yesterday. |
| Mixtapes + voice intros | both ways | mixtape hub converge + immutable audio heal | on save | same stamp rule |
| Stars, plays, phone playlists, phone edits, phone downloads | phone → desktop | HTTP-first mirror (NAS fallback), then absorb | boot + every 5 min | Was NAS-only and nine days stale once; HTTP-first since 8/30. |
| Desktop metadata edits | desktop → NAS → homemini | metadata-overrides.json in the mirror list | with the library sync | separate file from phone edits by design (each device owns its own) |
| Lyrics | laptop → NAS → homemini trainer | mirror list | with the library sync | laptop is the single fetcher |
| Artwork | desktop → homemini | rsync + trigger | on change | — |
| Brain: text embeddings + mood index | homemini owns; desktop reads | nightly trainer on homemini | nightly | desktop never pushes embeddings.bin (would clobber the enriched brain) |
| Brain: CLAP audio index | **desktop only** | laptop batch | manual | **homemini has no CLAP text tower → fusion is desktop-only** (the one real twin gap from 6.0) |
| Taste ledger (verdict stream) | desktop local | not mirrored — and doesn't need to be | nightly (laptop launchd `taste-learn`) | Resolved on inspection: the weight learner runs on the laptop against the local ledger; phone verdicts (stars) reach it through the mobile-stars mirror. No gap. |
| Made for You mixes (daily + vibe) | homemini generates for both | shared endpoint | daily / on request | generation has no skit/intro gate — see B2 |
| iPod sync, Round Trip, pool, sync history | desktop only | — | — | **by design** (your rule) |

### B2. Twin parity — what desktop got this week vs mobile

| 6.0 change | Desktop | Mobile | Gap |
|---|---|---|---|
| 3c lexical reranker | ✓ | ✓ 158854d | — |
| Subgenre lexicon (yacht rock) | ✓ | ✓ 3579773 live | — |
| Serving-side fd leak fix | — | ✓ cc3c66f | — |
| AUC drift alarm | — | ✓ | — |
| Audio fusion (mood ⊕ CLAP) | ✓ on by default | ✗ | **CLAP text tower on homemini** (CPU is fine for text queries), then port the fusion scorer |
| Intro only as track 1 / skits, sub-minute fragments barred | ✓ mixtape builder + pool + picker | ✗ mixes.ts / djSet.ts have no gate | A 37-second "Intro" can land in a phone vibe mix today |
| Zero-byte download stub refused | ✓ 64 KB floor | ✗ streamrip.ts has no size check | A phone download that serves 0 bytes becomes a ghost row |
| Deezer preview refreshed at play time | ✓ | ✗ iOS caches `previewUrl` | Discovery previews on the phone will 403 after the URL expires |
| Sync notices: breaker deferrals silent | ✓ | n/a | — |

### B3. Proposed mobile order (cheapest, highest-fidelity first)
1. **Skit/intro gate in mix generation** (mixes.ts, djSet.ts) — twin of `isSkitOrIntro` + the "intro only at track 1" rule. ~1 hr, backend only, auto-deploys.
2. **Zero-byte floor in streamrip.ts** — same 64 KB rule as desktop. ~30 min, backend only.
3. **Parity probe**: one script that compares track count + newest `dateAdded` + playlist count on desktop vs homemini and prints a one-line verdict; run it from the Sunday KPI snapshot so drift is caught weekly, not by you. ~1 hr.
4. ~~Taste ledger reach~~ — checked: the learner is a laptop job reading the local ledger. Nothing to do.
5. **Preview refresh on iOS** — resolve the Deezer URL at play time like desktop. ~2 hr; needs an iOS build and a phone install.
6. **CLAP text tower on homemini + fusion twin** — closes the last brain gap. Half a day; the audio index (9,804 vectors) already exists, it just needs to be served from homemini.

Items 1–4 need no phone build. Say which of A and B you want, in what order.
