# JakeTunes 5 — Planning Document

> **Status:** research + synthesis, 2026-05-14. Written autonomously
> overnight at Jake's request: *"figure out what we still have to do in
> our greater plan... jaketunes mobile is ready... start thinking of
> things for this big jaketunes update. this will be jaketunes 5."*
>
> **Nothing in here is built yet.** This is the map. Jake reviews,
> steers, then we sequence. Open decisions are flagged **⚑ DECISION**.

---

## TL;DR

JakeTunes 5's headline is **mobile goes live** — there's a real React
Native iOS app on `origin/claude/begin-mobile-development-4Hv2P`, fully
scaffolded through Phase 0 + Phase 1 infrastructure. But that branch
**diverged 93 commits ago** and built a *different* sync architecture
than the main line did. So 5.0 isn't "write new code" — it's **merge,
reconcile the two sync models into one, and validate mobile against the
live DS225.** That's a real, shippable, "soon"-sized version.

After 5.0: two big tracks compete for the 5.x headline — **DJ Mode
Camelot mixing** (the long-promised "next big feature," currently
blocked on a disabled audio-analysis worker) and the **Phase 2
event-driven sync API** (the real "Boom" architecture). Plus a long
tail of deferred polish (Phases B/C/D), original-4.0-scope leftovers
(Airfoil, iTunes 8 visual respec), and an open iPod-diagnostics thread.

---

## 1. Status reconciliation — the handoff doc is stale

`docs/handoff-2026-05-13.md` is the most recent planning doc, but it
predates this whole session's work. Several things it lists as
"Pending" or "Blocked" are actually **done**:

| Handoff says | Reality (2026-05-14) |
|---|---|
| **Phase E** (Home/Dashboard) — "Pending, Jake specifically asked for this" | **DONE.** Shipped across 4.4.19–4.4.34: Home view with Recently Added, Top Artists, Listening Stats strip, Featured Album hero, Music News (70/30 personalized + gossip filter), New This Week, "Coming to a Stage Near You" (Bandsintown tour dates), "On the Horizon" (MusicBrainz upcoming releases). |
| **Phase 1** (NAS provisioning + library upload) — "Blocked tonight" | **Effectively done** via a different path than the handoff imagined. `~/bin/jaketunes-homemini-sync.sh` rsyncs `~/Music2/JakeTunesLibrary/` → `/Volumes/JakeShared/` (Synology SMB) → homemini, with a Plex scan auto-wired in (this session). Music propagates laptop → NAS → homemini → Plex/mobile. |
| Latest tag 4.4.17 | Now **4.4.44.** 27 versions shipped since the handoff: Artists view overhaul + real artist photos, app splash screen, now-playing fixes, visualizer removal, Music Man skip-awareness, import-queue robustness, pill centering. |

**What the handoff doc got right and is still true:** the phase plan's
*spirit* (A→B→C→D→E→F then 1→7), the Phase 2 design-doc as the
architecture contract, and Jake's north star: *"When I update
JakeTunes — BOOM. It's on all devices."*

---

## 2. ⚑ THE CRITICAL FINDING — two divergent sync architectures

This is the single most important thing in this document.

There are **two branches**, each with a **different, incompatible sync
model**, and they need to be reconciled before anything else in
JakeTunes 5 can proceed cleanly.

### Branch A — `claude/jaketunes-synology-setup-7m2xy` (main line, current)

- **Music lives at:** `~/Music2/JakeTunesLibrary/iPod_Control/Music/`
- **Sync mechanism:** `~/bin/jaketunes-homemini-sync.sh` — rsync from
  laptop → `/Volumes/JakeShared/JakeTunesLibrary/` (Synology SMB mount)
  → homemini reads from JakeShared. JSON state (`library.json`,
  `metadata-overrides.json`, `playlists.json`) rsync'd to homemini over
  Tailscale ssh. Plex scan fired on DS225 after each music change.
- **Triggered by:** JakeTunes' `sync-orchestrator.ts` on every
  import/edit/playlist save (`--quick` mode) + a 10-min safety-net tick.
- **Status:** working today. Desktop + homemini + Plex/mobile all current.

### Branch B — `origin/claude/begin-mobile-development-4Hv2P` (the mobile branch)

- **Music expected at:** `~/Library/Application Support/JakeTunes/`
  (per `docs/mobile-sync-setup.md`)
- **Sync mechanism:** Synology **Drive Client** does two-way file
  mirroring of the JakeTunes data folder → NAS `/music/jaketunes/`. A
  new desktop module `src/main/library-snapshot.ts` exports a
  wire-format `library.json` snapshot (colon-paths → slash-relative)
  into the same Drive-synced folder. Mobile reads that snapshot + streams
  audio over Audio Station / WebDAV / File Station HTTP.
- **Plus a reverse channel:** `src/main/library-overrides.ts` drains a
  `MobileTrackOverrides` queue (mobile-recorded play counts) back into
  the desktop library, fingerprint-gated.
- **Status:** Phase 0 complete, Phase 1 infrastructure complete,
  **un-validated against a live DS225.**

### Why this matters

These two models **disagree on the two most basic facts**: where the
music files live, and how they get to the NAS. Branch B was built
before Branch A's current reality existed (B branched from `d48b4c8`,
a 4.0.x-era commit; A has 93 commits on top of that).

**The merge itself is tractable** — `git merge-tree` shows only **2
content-conflict files** (`src/main/index.ts`, `src/renderer/types.ts`);
everything else (the entire `mobile/` dir, `library-snapshot.ts`,
`library-overrides.ts`, the new `src/main/__tests__/` suite) comes in
clean. The *architecture* reconciliation is the real work.

### ⚑ DECISION 1 — pick the one canonical sync model

Three options:

- **(a) Standardize on Synology Drive Client for everything.** Retire
  the bespoke `jaketunes-homemini-sync.sh`. Laptop's JakeTunes data
  folder two-way-syncs to the NAS via Drive Client; homemini and mobile
  both read from the NAS. Pro: battle-tested file sync, one mechanism,
  it's what mobile was built for. Con: homemini loses the
  Tailscale-direct path; everything routes through the NAS; the Plex
  scan trigger needs re-homing.
- **(b) Keep the rsync script, point mobile at it.** Mobile's snapshot
  exporter writes into `~/Music2/JakeTunesLibrary/` (where the music
  *actually* is); the rsync script already pushes that to JakeShared;
  mobile reads from JakeShared. Pro: keeps the working homemini+Plex
  path untouched, smallest change. Con: the rsync script becomes
  load-bearing for a third consumer; no two-way (mobile→desktop
  override queue still needs a path back).
- **(c) Skip straight to the Phase 2 event-driven API.** Both file-sync
  approaches become moot — the Mini-PC API server is the canonical
  library, all clients (desktop, homemini, mobile) are caches. Pro: the
  real "Boom" answer, designed already in `phase-2-design.md`. Con:
  "multi-week infrastructure investment" — this is not a "soon"-sized
  5.0.

**My recommendation:** **(b) for 5.0** (smallest reconciliation, ships
mobile fast), with **(c) explicitly scheduled as the 5.x or 6.0
headline.** Treat (a) as a non-goal — adding Drive Client is just a
third stopgap when (c) is the real destination. The one change (b)
needs: fix `docs/mobile-sync-setup.md` and the snapshot-export default
path to target `~/Music2/JakeTunesLibrary/` instead of
`~/Library/Application Support/JakeTunes/`.

---

## 3. The JakeTunes 5 roadmap — tiered by dependency

### TIER 0 — Reconciliation (gates everything else)

| ID | Task | Notes |
|---|---|---|
| **R1** | Merge `origin/claude/begin-mobile-development-4Hv2P` into the main line | 2 conflict files (`src/main/index.ts`, `src/renderer/types.ts`). Brings in `mobile/`, `library-snapshot.ts`, `library-overrides.ts`, **and a real `src/main/__tests__/` suite** (509 lines — this is the test infra postmortem follow-up C1 said didn't exist). |
| **R2** | Reconcile to one sync model per **⚑ DECISION 1** | The architecture call. Until this is made, mobile + desktop disagree on where music lives. |
| **R3** | Re-point the snapshot exporter + `mobile-sync-setup.md` at the real music location | `~/Music2/JakeTunesLibrary/`, not `~/Library/Application Support/JakeTunes/`. |

### TIER 1 — Mobile goes live (the 5.0 headline)

| ID | Task | Notes |
|---|---|---|
| **M1** | Validate mobile against the live DS225 — the 4 unchecked boxes in `mobile/README.md`: first login, library snapshot loads + renders, first track plays end-to-end, override-queue round-trip | Needs a Mac with Xcode 16+; the `ios/` native project isn't committed (generated on first setup). |
| **M2** | Generate `ios/`, `pod install`, build to a physical device | `Info.plist` additions documented in the README (`UIBackgroundModes: audio`, ATS for local NAS, `NSLocalNetworkUsageDescription`). |
| **M3** | Mobile Phase 2 deferred set | Album art (Audio Station `cover.cgi` → `react-native-fs` cache), on-device audio cache + LRU eviction, background `library.json` sync on foreground, auto-export override queue when NAS online, **skip-detection** (only natural completions recorded today), Genres tab parity, HTTPS + 2FA on the DSM auth flow. |

### TIER 2 — The "Boom" architecture (Phase 2 — 5.x or 6.0 headline)

The real answer to multi-device sync. Fully designed in
`docs/phase-2-design.md`. Supersedes *both* current file-sync
approaches.

| ID | Task | Notes |
|---|---|---|
| **B1** | Answer the 5 open questions in `phase-2-design.md` | Recommendations already in the doc: **SSE** (not WebSocket), **Python FastAPI** (reuses `core/`), **SQLite** (not JSON files), **HTTP audio stream** (not NAS mount — works on iOS), **one-shot migration**. ⚑ DECISION 2. |
| **B2** | Build the Mini-PC API server | Event-driven, push-based, server-authoritative. Optimistic local writes + reconciliation, per-entity etags, field-level LWW conflict resolution, SSE event log with offline catch-up. 3–5 days per the design doc's estimate. |
| **B3** | Phase 4 — Mac client cutover to the API | Renderer adopts the API client; `library.json` becomes a rebuildable cache, not a source of truth. 2–3 days. |
| **B4** | Mobile cutover to the same API | Mobile drops the snapshot-file model, becomes a first-class API client. This is *why* B-tier supersedes the file-sync stopgaps. |

### TIER 3 — DJ Mode Camelot mixing (the long-promised "next big feature" — Phase F)

The CHANGELOG says it verbatim: *"Real BPM/key-aware crossfading is the
next big feature."* Stephen Hands the persona, the vinyl button, and
set generation are all wired — only the actual beatmatched harmonic
transitions are placeholder.

| ID | Task | Notes |
|---|---|---|
| **D1** | **Re-architect the librosa audio-analysis worker so it doesn't starve playback** | **This is the blocker.** `enqueueAudioAnalysis` has been a no-op since 4.2.12 — it raced the playback decoder. Needs a real worker thread or strict yield discipline (the 4.0.10 "playback wins resource fights" pattern). Until this runs, there is **no BPM/key/Camelot data for any track in the library.** |
| **D2** | Backfill BPM + key + Camelot across the library | Once D1 lands. Background queue, yields to playback, writes `audioAnalysisAt` sentinel so it runs once per track. |
| **D3** | Build the beatmatched harmonic transition engine | Camelot-wheel adjacency for key compatibility, BPM-match crossfade timing. The actual headline feature. |

### TIER 4 — Deferred foundation & polish (Phases B, C, D from the handoff)

| ID | Task | Source |
|---|---|---|
| **P-B** | **Phase B** — foundation audits: twin-function sweep, destructive-op gates, leak audit, sleep/wake behavior | handoff doc |
| **P-C1** | **Phase C** — cross-launch scroll-position persistence (4.4.13 shipped in-session only) | CHANGELOG 4.4.13 |
| **P-C2** | **Phase C** — cross-launch persistence of preferred audio output device (4.4.15 in-session only) | CHANGELOG 4.4.15 |
| **P-C3** | Settings toggle to disable auto-reconnect ("defer, build feature first" — 4.4.15) | CHANGELOG 4.4.15 |
| **P-D** | **Phase D** — smart metadata autofill in Get Info | handoff doc |
| **P-E1** | GenresView inner-scroll-container persistence (known no-op since 4.4.13, re-confirmed 4.4.22) | CHANGELOG 4.4.13, 4.4.22 |
| **P-E2** | Home → drill into a *specific* album (expanded) — `drillIn.ts` already scaffolds `'album'` targets; only artist drill-in is wired | CHANGELOG 4.4.19, 4.4.27 |
| **P-E3** | Get Info drag-select contingency — 4.4.11 fixed the Name-field clobber; "user reports drag broken on ALL fields" was an open contingency | CHANGELOG 4.4.11, `phase-a-verification.md` |
| **P-E4** | Dead-code cleanup: `useElasticOverscroll` (unwired since 4.4.27), `MiniVisualizer` (unwired since 4.4.41), `db_reader.py:738-772` dbid-collision scaffolding | CHANGELOG; postmortem `duplicates-wrong-layer.md` |

### TIER 5 — Original 4.0-scope leftovers

The 4.0 vision had seven lanes (`memory/project_4_0_direction.md`).
Most shipped. These didn't:

| ID | Task | Source |
|---|---|---|
| **L1** | **Airfoil integration** — the §6.6 device-picker feature. Airfoil only ever appeared as a *source of bugs* (rattle/disconnect fixes in 4.0.6, 4.1.5, 4.4.6, 4.4.8, 4.4.15) — never got its dedicated integration ship. Needs the `com.apple.security.automation.apple-events` entitlement verified in a codesigned build. | 4.0-scope §6.6; `project_4_0_direction.md` lane 6 |
| **L2** | **iTunes 8 visual respec** — the §3 UI Enhancement lane. Target locked (`memory/project_4_0_ui_target.md`: unified gray gradient, colored sidebar icons, matte charcoal progress bars, `#c1cad7→#a9b4c2` sidebar). Reference image in `docs/4.0-ui-references/itunes-8-main.png`. 4.4.x UI work was Home/Artists polish — *not* this systematic respec. Multi-session lane; pilot order: sidebar → toolbar → now-playing pill. | 4.0-scope §3; `project_4_0_ui_target.md` |
| **L3** | **MBID-based album identity + backfill scan** — RGID-based ownership dedup deferred to a separate brief (`docs/4.0-mbid-backfill.md`); only the smart-text matcher shipped as fallback | 4.0-scope §2.2 |
| **L4** | **Music Man v2 "skip recovery"** — when the user skips MM's pick, the next pick acknowledges it. The other three v2 upgrades (cross-session memory, news integration, skip-awareness) all shipped; this sub-feature has no clear ship entry | 4.0-scope §6.1 |
| **L5** | **Per-track EQ preset override write path** — EQ itself shipped (`eq.ts`, 10-band biquad chain); the per-track override was a "stretch goal" | 4.0-scope §6.5 |

### TIER 6 — Open iPod-diagnostics thread

> **Scope note (per DECISION 5, resolved 2026-05-14):** the iPod stays
> a **first-class sync target — but personal-scope, Jake-only.** This
> tier stays live (iPod isn't retired) but it is the **lowest-priority
> tier** — it never blocks a product release and never shapes the
> mobile/desktop/NAS architecture. Do it when convenient.

From `docs/postmortems/2026-04-26-ipod-songcount-counter.md`. Three
iTunesDB writer fixes shipped end-of-day 2026-04-26 but were "derived
from inspection, not measurement" and **never verified against a live
iPod re-sync.**

| ID | Task |
|---|---|
| **I1** | Execute the next-session iPod diagnostic plan: sync once, capture copied/skipped counts, fingerprint-diff `library.json` vs on-disk iTunesDB, check the About panel |
| **I2** | If the count is still short: investigate the candidate "4th firmware filter field" (`hashAB`/firewire-ID hash, mhit 0x18 codec marker, mhit 0x60, Play Counts/Play State files) |
| **I3** | The separate 10-track on-disk gap (Library 4,556 vs iPod 4,546) observed end-of-day 2026-04-26 |
| **I4** | Extend `core/tests/test_db_roundtrip.py` to diff library.json vs on-disk iTunesDB by fingerprint ("one well-named function away") |

### Unknowns to define

| ID | Task |
|---|---|
| ~~**U1**~~ | ~~**JakeTunes Store**~~ — **DEFERRED 2026-05-14.** Out of JakeTunes 5 scope per Jake. The `'store'` ViewName / `musicmanStoreReview` IPC / `ICON_STORE_BLUE` scaffold from the parallel session can stay dormant; revisit after 5.0. |
| **U2** | **Workmini deploy** — Jake's third Mac (work Mac mini, on Tailscale as `workmini`). Blocked on Jake enabling Remote Login + providing the username. Once unblocked: wire it into whatever sync model **⚑ DECISION 1** picks. |

---

## 4. Recommended sequencing

```
JakeTunes 5.0  ──  "Mobile is real"
  TIER 0  R1 merge → R2 reconcile (DECISION 1) → R3 re-point paths
  TIER 1  M1 validate vs DS225 → M2 iOS build → (M3 deferred to 5.1)
  + the test suite that comes in free with the merge (postmortem C1 closed)

JakeTunes 5.1  ──  "Mobile is good"
  TIER 1  M3 — album art, on-device cache, skip-detection, Genres parity, HTTPS/2FA
  TIER 4  the Phase C cross-launch-persistence items (small, high quality-of-life)
  TIER 4  P-E4 dead-code cleanup (cheap, do it while in the files)

JakeTunes 5.x  ──  pick ONE headline (⚑ DECISION 3):
  Track A:  TIER 3  DJ Mode Camelot  (D1 unblock analysis → D2 backfill → D3 engine)
  Track B:  TIER 2  the "Boom" API   (B1 decisions → B2 server → B3/B4 cutover)

JakeTunes 6.0  ──  whichever of Track A / B didn't go in 5.x, plus:
  TIER 5  Airfoil (L1), iTunes 8 respec (L2) — both multi-session lanes
  TIER 6  the iPod-diagnostics thread (I1–I4) if the iPod is still in the workflow
```

### ⚑ DECISION 3 — what's the 5.x headline, DJ Mode or the Boom API?

- **DJ Mode Camelot (Track A)** is the *named* "next big feature" and
  it's the most *JakeTunes-soul* feature — it's why Stephen Hands
  exists. But D1 (unblocking audio analysis) is real, uncertain work
  before D3 (the actual feature) can even start.
- **The Boom API (Track B)** is the bigger architectural win and the
  thing Jake's north-star quote is *about*. It also makes mobile
  genuinely first-class (B4) instead of snapshot-file-fed. But it's the
  "multi-week investment" — less "soon."

My lean: **Track B (the API) as 5.x**, because it retires *two*
stopgap sync mechanisms and makes mobile real-real, then **Track A (DJ
Mode) as 6.0** with audio-analysis-unblocking as its opening move. But
this is genuinely Jake's call — Track A is more *fun*.

---

## 5. Decisions Jake needs to make

1. **⚑ DECISION 1 — the canonical sync model.** (a) Drive Client
   everywhere, (b) keep the rsync script + point mobile at it, or (c)
   skip to the Phase 2 API. *My rec: (b) for 5.0, (c) scheduled as 5.x.*
2. **⚑ DECISION 2 — the 5 Phase-2-design open questions.** SSE vs WS,
   FastAPI vs Node, SQLite vs JSON, HTTP-stream vs NAS-mount, one-shot
   vs gradual migration. *Recommendations already in `phase-2-design.md`;
   just needs sign-off.*
3. **⚑ DECISION 3 — the 5.x headline.** DJ Mode Camelot, or the Boom API.
4. ~~**JakeTunes Store (U1)**~~ — **DEFERRED 2026-05-14** ("forget
   jaketunes store for now"). Not part of JakeTunes 5 scope. The
   in-flight `'store'` ViewName scaffold from the parallel session can
   sit; revisit post-5.0.
5. ~~**iPod's place in the JakeTunes 5 world**~~ — **RESOLVED 2026-05-14.**
   Jake: *"the ipod is a first class sync target for me and me only but
   its going to be a mobile + desktop + nas program mainly."*
   Interpretation:
   - **iPod stays first-class** — NOT retired. The handoff doc's "Phase
     7 — retire iPod sync as primary" is amended: iPod isn't retired,
     it's *de-prioritized from the product story* but kept fully
     working as Jake's personal sync target.
   - **iPod is personal-scope, not product-scope.** It must never
     *shape* the mobile/desktop/NAS architecture or gate a release. It
     rides along; it doesn't steer.
   - **The product spine is confirmed: mobile + desktop + NAS.** This
     is exactly the Phase 2 event-driven-API vision (TIER 2) — the NAS
     as canonical store, desktop + mobile as first-class clients. DJ
     Mode, Music Man, etc. are desktop-first features layered on top.
   - **Effect on TIER 6:** does NOT evaporate — the iPod-diagnostics
     thread (I1–I4) stays live because iPod stays first-class *for
     Jake*. But it's now explicitly lowest-priority / personal-
     maintenance, sequenced after everything product-facing. Verify the
     unverified iTunesDB writer fixes when convenient; don't let them
     block 5.0/5.x.

---

## 6. What ships for free with the merge

Worth calling out: merging the mobile branch (R1) **closes a standing
postmortem follow-up at zero extra cost.** The mobile branch added
`src/main/__tests__/` — `library-snapshot.test.ts`,
`library-overrides.test.ts`, `twin-invariants.test.ts` (509 lines). The
verify-repair postmortem's action item C1 — "regression tests for
`normalize()`, the test infrastructure isn't set up yet, this is a P1
follow-up" — has been quietly addressed on that branch. The merge
brings JakeTunes its first real main-process test suite.

---

*End of plan. Jake: review §5 (the 5 decisions) first — everything else
sequences off those. Then we pick the 5.0 scope and go.*
