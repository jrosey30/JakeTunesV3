# Step Inside — the record-digging game

**Authoritative brief · 2026-09-09 · baseline `e39bb8e`**

This document is the single source of direction for Step Inside. Where it
conflicts with any earlier Step Inside proposal, **this supersedes them**:

| Earlier proposal | Status |
|---|---|
| `docs/037-record-store-phase2-art-prompts.md` (illustrated 2D room, Midjourney storefront) | **Superseded** for direction. The art survives as reference for mood, not as the shipping surface. |
| `docs/record-shop-structure-and-domain.md` §"Step Inside" (optional immersive *presentation* of shelves) | **Superseded on presentation only.** Its domain contract, identity rules and command vocabulary remain binding and are the foundation this builds on. |
| The 2D pixel room in `views/RecordStore/RecordStoreView.tsx` | Retired as the route. File retained, unrouted, until the game covers what it did (counter/session presentation). |
| The "walk-or-first-person" options sketch (in-session, 2026-09-09) | **Superseded.** The decision is third-person, PS2-era. |

**Unaffected and preserved:** the Record Shop tabs (For You · Browse · Listen
List), library, playback, downloads, Activity Sync, and every pending review in
`docs/master-plan-checkpoint-2026-09-06.md`. This brief adds one route. It
changes nothing else.

---

## 1. What we are building

One neighbourhood block. You control a character. You walk into a record shop
and dig — physically — through crates. Music you find is real music from the
real catalogue and the real library, acquired through the systems that already
exist.

**Non-goals, stated so they cannot creep in:** no second downloader, player,
queue, catalogue or identity matcher; no city; no game layer over the rest of
the app; no dashboard placed inside a 3D room.

---

## 2. Architecture

### 2.1 Rendering — recommendation: **three.js in the existing renderer**

Audited against Electron integration, input, performance, assets and the app as
it stands.

| Option | Why not |
|---|---|
| Native (Unity/Godot) sidecar process | Two runtimes, IPC for every ownership/playback call, separate build/sign/notarize, and the acquisition contracts would have to be re-expressed across a process boundary. Fails "do not create a second system" before a line is written. |
| Babylon.js | Capable, but a larger runtime and an engine-shaped API for a scene that is one street and one room. Its strengths (physics, WebXR, node materials) are things this brief says not to build. |
| CSS/2.5D | Cannot deliver third-person camera or the parallax of walking into a room. Would become the illustrated room again. |
| **three.js** | **Recommended.** Renders into a canvas inside the existing React tree, so `usePlayback`, `useLibrary` and every shop command are ordinary imports rather than IPC. ~600 KB added to a 1.95 MB bundle. Mature, stable, no build changes. |

**Consequences accepted:** three.js is a library, not an engine — scene graph,
input, collision and the camera are ours. That is why §2.2 puts the felt parts
in pure, tested modules rather than in the render loop.

### 2.2 Module boundaries

```
renderer/views/RecordStore/stepinside/
  playerModel.ts   PURE  momentum, turning, per-axis collision      (tested)
  digModel.ts      PURE  the crate as a stack with ends             (tested)
  world.ts         three  street + shop geometry, blockers
  avatar.ts        three  placeholder figure + distance-driven walk
  crateView.ts     three  sleeves, lean, flip, pull-out
  StepInsideView   glue   loop, input, camera, HUD
main/step-inside/
  listening-ledger.ts   durable coverage per edition
  scoring.ts       PURE  deterministic award rules                  (tested)
  award-ledger.ts       durable, exactly-once awards
```

Rule: **anything that can be judged right or wrong is pure and tested.** The
render loop draws; it never decides whether a point was earned.

### 2.3 The protected-file constraint (load-bearing)

`useAudio.ts` and `PlaybackContext.tsx` are Do-Not-Touch (`tools/pre-commit`).
Scoring must therefore observe playback **from outside**, and the design does:

- A new unprotected renderer module subscribes to `usePlayback()` — which
  already carries `position`, `isPlaying` and the current track at ~10 Hz —
  samples it, and reports coverage to main over a new IPC.
- **Rejected:** parsing `audio-events.log`. It is a rotating diagnostic file
  and its heartbeat carries no track id. Rewards must not depend on a debug log.
- **Rejected:** `play-events.jsonl` as proof of listening. It is written only on
  natural end (`pct: 100`), which is real evidence a track *ended* but not that
  it was *heard* — seek to the last five seconds and it fires. It stays useful
  as corroboration and as history, never as the coverage source.

No protected file is edited. If that ever becomes necessary, it stops and asks.

### 2.4 State separation

Game state (coverage, awards, journal, rank, cosmetics) lives in its own files
under `STATE_DIR/step-inside/`, never inside `library.json`. The library remains
canonical and is only ever **read** by the game. Deleting the game's state loses
progress; it cannot lose music.

Tests and review launches use an isolated state root and mocked externals —
fixtures never write to the hub, the library, listening history or the award
ledger. The existing `JT_RECO_FIXTURE` pattern is the precedent.

---

## 3. Music integration

Built on the contracts in `record-shop-structure-and-domain.md`, unchanged:
`ShopItem`, `ReleaseSelection`, `OwnershipAssessment`, `AcquisitionJob`,
`AcquisitionResult`, and the commands `saveItem` / `inspectSelection` /
`previewItem` / `playOwned` / `getSelection` / `cancelJob` / `retryJob`.

The game is a **presentation and an input surface**. It resolves nothing itself.

### 3.1 How full playback actually works for a new record

This is the question that gates every listening reward, so it is answered
before anything is wired.

**You cannot complete an album you do not own.** Catalogue previews are ~30
second clips. There is no full-stream source in this app. Therefore:

```
dig it up  →  preview at the listening station (30s, clearly labelled)
           →  Get, through the existing acquisition pipeline
           →  it imports into the library
           →  you play it, anywhere in the app
           →  coverage accrues  →  completion awards
```

Consequences, stated plainly:

- **A preview can never complete a release.** Preview audio runs on a separate
  channel from the main player and is excluded from coverage at the source.
- **The dig must remember what it was.** Discovery context is captured when the
  dig starts (§5.1), so an album you found as new still pays the discovery rate
  when you finish it three days later.
- **Order does not matter.** Buy then listen, or listen then buy: both reach the
  same place. Buying alone never pays.
- **If only a preview is available**, the record says so on its back, and the
  listening rewards it could earn are shown as unavailable rather than hidden.

### 3.2 Ownership and edition

Two different identities, deliberately:

- **The measured edition** — the exact `ReleaseSelection` you are listening to.
  Coverage is per edition, because a remaster's track eight is a different
  recording of a different length.
- **The reward identity** — the work, resolved through the existing
  `album-identity` / `exact-recording` verdicts. Awards are keyed to this, so a
  remaster, a duplicate file or an alternate edition cannot farm the same
  discovery reward twice.

Partial ownership is shown honestly: what you own, what is missing, what is left
to hear.

---

## 4. Scoring

Deterministic, configurable, and explained in plain language on every award.
Starting values, to be balanced against simulation (§8), not frozen:

| Award | Value | Cap |
|---|---|---|
| Audition — two actual minutes of a record | +5 | once per album |
| Finish a track for the first time during a dig | +5 | max 12 per release |
| Complete a release | +25 single / +50 EP / +100 album | once per work |
| Rediscover an owned album unplayed for 6 months | +40 | once per album per year |
| Complete a newly discovered release **and** add it | +75 | once |
| First complete album by an artist | +25 | once per artist |
| Fully hear a friend's recommended release | +20 | once per release, any number of senders |
| Shopkeeper's digging challenge | +30–75 | one per challenge |

Worked example — a ten-track album by an unfamiliar artist, auditioned,
completed and kept: `5 + 50 + 100 + 75 + 25 = 255`. *(Note: the brief's example
totals 255 using +50; that term is the twelve-track-bonus pool at ~4 tracks, or
an EP completion. Both readings are modelled in §8 and the balance simulation
decides which the shipped table uses. Flagged rather than silently resolved.)*

### 4.1 Gaps, resolved

| Gap | Rule |
|---|---|
| **Track shorter than the audition window** | The audition is two minutes of *the record*, not of one track. Accrued across tracks in one dig. A release whose entire runtime is under two minutes cannot audition; it can still complete. |
| **Single vs EP vs album** | By track count and runtime, in that order: 1–3 tracks **or** under 10 min = single; 4–6 tracks **or** under 30 min = EP; otherwise album. Catalogue release-type is preferred when present and truthful. |
| **Unknown release type** | Treated as EP (the middle value). Never guessed upward. The receipt says the type was unknown. |
| **Compilations and various-artists** | Complete normally, but the "first album by an artist" bonus does not fire — a compilation is not an artist's album. |
| **Long releases** (>25 tracks, box sets) | Completion still requires every track. The track-bonus pool stays capped at 12. Completion value does not scale with length. |
| **Partially owned albums** | Coverage only accrues on owned tracks; completion requires the whole release, so a partial album shows "9 of 12 heard, 3 not in your library" and pays nothing until they are. |
| **Track-bonus cap vs completion** | The 12-bonus cap limits *points*, never the *requirement*. Completing a 20-track album needs 20 tracks heard. |

---

## 5. Points integrity

### 5.1 Context is frozen when the dig starts

Ownership and discovery category are recorded the moment you pull a record out.
Importing it mid-listen does not retroactively convert a rediscovery into a
discovery, or the reverse.

### 5.2 Coverage, not position

Per track, per edition, a **coverage map** of which seconds were actually
played, held as merged intervals:

- Only advancing playback at roughly 1× adds coverage.
- Seeking forward adds nothing — no seconds elapsed.
- Replaying the first minute three times fills the first minute three times; it
  cannot fill the last minute.
- A track counts as heard at **≥ 95% coverage**, allowing a 5% tolerance for
  lead-in silence, fade-outs, gapless seams and sample-timing drift.
- Pauses, app restarts and days off preserve coverage — it is stored per track
  and merged, not per session.

### 5.3 Exactly once

A durable award ledger keyed by `(rule, reward-identity, period)`. Every write
is idempotent: retries, reloads, repeated events and multiple recommendation
senders collapse to one row. A duplicate is **rejected silently and logged** —
never shown as a failure, never as a penalty.

Deleting and re-importing music does not reset eligibility, because the ledger
is keyed to the work, not the file or the library id.

### 5.4 Absence is not proof

"No listening history" and "never heard" are different states and are stored
differently. Rediscovery requires *evidence* of a last play more than six months
ago. A track with no history at all is unknown, and unknown never pays a
rediscovery bonus.

### 5.5 Never awarded

Buying, clicking Get, flipping quickly through sleeves, and replaying a preview
earn nothing, by construction rather than by threshold.

---

## 6. Challenges

Record-store conversation, from verified facts only:

- "There's a local-label crate in the back." *(label metadata present)*
- "You've not had this off the shelf in a while." *(evidenced last-play date)*
- "He played on this one too." *(verified contributing-artist credit)*
- "Give the staff pick a proper listen." *(a real shelf item)*

No invented relationships. No deadlines, no streaks, no penalty for ignoring
one, and never a nudge toward music you dislike.

---

## 7. Progression and penalties

**Ranks, journal, badges** for different digging styles; cosmetics (clothing,
room decoration, sleeve displays) come *after* the core is reliable. Nothing
musical, accessible or essential is ever locked behind points.

**Penalties** — prototype only tidiness, only for deliberate in-world acts:

- A pulled record left on the floor: **−2**
- A stack abandoned at the listening station: **−5 per stack**

With a clear chance to put them back first, never compounding, never for the
same incident twice. **Exiting the app is not abandoning a stack.** No sleeve
damage in v1. Never any deduction for skipping, disliking, not finishing,
taking a break, quitting, deleting music, failing a challenge, or for any
crash, playback failure, disconnect or control glitch.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Coverage tracking is the whole scoring system's foundation, and it observes a protected module from outside.** | Pure, tested coverage math; an observer that fails closed (no data = no award, never a wrong award). |
| Character art — the failure that killed the 2D room's expansion | Placeholder box avatar ships first, by instruction. Appearance is a later, separable slice. |
| Frame budget while music plays and background jobs run | Measured budgets (§9), low-res render target, no idle rendering when the view is hidden. |
| Scope creep into a city | Implementation order is gated; one shop must feel excellent first. |
| Bundle growth (+600 KB) | Accepted, measured, and loaded only on this route. |
| A points system that feels like homework | No deadlines or streaks; balance by simulation before thresholds are fixed. |

---

## 9. Acceptance checks

Nothing is "done" on a green build or a screenshot. Each stage needs a
**playable run** with results recorded.

**Movement/camera:** walk every direction at 60 and 120 Hz; no wall clipping; no
camera through geometry; recover from a stalled tab without teleporting.
**Digging:** flip to both ends; pull and replace; covers correct against the
library; a record with no artwork shows a blank sleeve, not a gap.
**Playback:** preview and full play are audibly distinct and separately
attributed; the main player's queue is never hijacked.
**Scoring:** coverage survives pause, restart and quit; seeking earns nothing;
duplicate awards rejected across retries and reloads; partial ownership pays
nothing and says why.
**App integrity:** Esc always exits; the Record Shop tabs still work; nothing in
library/playback/downloads/sync changes behaviour.
**Performance budget on Jake's Mac:** ≤ 16.6 ms frame time at 1× while a track
plays; no measurable audio dropouts; zero rendering when the view is unmounted.

---

## 10. Implementation order

| Stage | Deliverable | Gate |
|---|---|---|
| **1** | This brief | Jake's approval |
| **2** | Playable prototype: street, room, third-person movement, camera, enter/exit | Runs smoothly, disturbs nothing |
| **3** | Authentic digging: crate, sleeve inspection, listening station | Feel, readability, controls |
| **4** | Real music: ownership, playback, acquisition via existing systems | Isolated fixtures first; live acquisition only on Jake's chosen material |
| **5** | Listening progress and scoring | Persistence, coverage, partial ownership, exactly-once |
| **6** | Progression, polish, then more shops | Only after shop one is excellent |

**Status at time of writing:** stage 2 is built and committed (`e39bb8e`) with
pure models under test — but it has **not had its playable run**, so it is not
accepted. That run is the immediate next step, before anything in stage 3+.

**Status 2026-09-10:** stage 3's crate is **accepted** — Jake: "excellent.
this looks good" on `b5d1743`. Five passes got it there, and what settled
it was geometry, not rendering tricks: an eye-level camera at the front
rail; every card and sleeve in a slot of its own at the pack pitch (a card
wedged between two sleeves z-fought and the covers bled through); a
two-move pull that clears the tallest thing in the flipped pile — the
divider tabs, not the sleeve tops — before coming forward; index-card
dividers whose tabs print the real filing range of a crate sorted by
artist. Recordings v10–v12 in `~/Desktop/step-inside-run-2026-09-09/`.
Still in stage 3: the listening station is a box with a platter; the wall
racks are flat blocks; the street is bare; shop ambience is not folded
into the game. Stage 4+ remains gated on Jake's word.

**Filing, decided 2026-09-10 (Jake):** the shop is organised the way a shop
is, not one way. Ten bins in three rows facing the door: NEW ARRIVALS
(newest 48 by date added, newest at the front, no cards), then genre bins
alphabetical by artist with letter-range cards — ROCK (Classic Rock + Rock),
ALTERNATIVE / INDIE, PUNK, GRUNGE (each its own — "they're their own
things"), RAP / HIP-HOP, ELECTRONIC / DANCE, SOUL / FUNK / R&B, POP / NEW
WAVE — and one mixed bin (JAZZ · WORLD · METAL · COUNTRY) with a genre card
at each boundary. No dollar bin: "doesn't make sense in this world." The
rules live in `stepinside/shopPlan.ts` and are tested; an album files under
the genre most of its tracks carry, and unknown genres land on an ODDITIES
card rather than vanishing. Shipped `f9e102e`; recording v14 on the Desktop.
Staff picks on the wall (the Music Man's slot) are designed, not built.
