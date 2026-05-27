# Brief 037 — Music Man's Record Store

**Status:** Ready for Claude Code
**Priority:** P1 (new feature, JakeTunes 4.6 headline candidate)
**Scope:** Large — 3 phases (foundation, engine, scene). Phase 1 (engine) is where the time goes.
**Branch:** new branch `claude/037-record-store-phase0` off the current main line. Do NOT continue on `claude/036-bandcamp-store-phase1` — Bandcamp work is unrelated and shouldn't be tangled with this.
**Prerequisite:** none from 036. Reuses existing systems (`claudeCall`, weekly picks pipeline, persona prompts, TTS bridge, duck pattern) but does not block on any of them shipping new behavior.

> **The quality bar, from Jake, verbatim:**
> *"make sure the engine is so fucking good that i cry tears of joy."*
>
> Read this twice. Every design decision in this brief flows from it.
> Pretty UI on top of generic recommendations is failure. Ugly UI on
> top of a recommendation engine that knows the user's listening
> relationship cold is success. **Engine before paint.**

---

## 1. Context — Why This Brief Exists

The May 14 plan (`docs/jaketunes-5-plan.md` §3, item U1) **deferred**
"JakeTunes Store" — but that decision was scoped to the dormant
Bandcamp/squid-style embedded webview shell. This brief is a different
feature with the same name reused: a **hand-illustrated, character-led
record store** where Music Man (the existing persona) acts as the
proprietor, curates a daily wall of picks tied to the user's listening
relationship with their own library, and speaks one-liners in his
voice when the user clicks an item.

The store doesn't sell. It **recommends, curates, and stocks.** Clicks
play (library items) or open externally (new releases). It is a
*place*, not a feed — the same contents all day, like a real shop's
"new arrivals" wall.

This is the only feature in JakeTunes whose value is the *taste of the
curator*, not the mechanics of the surface. The existing Music Man
persona is already shaped for this role (`MUSIC_MAN_CORE`,
`src/main/index.ts:5233`: *"an arrogant, opinionated, deeply
knowledgeable record store savant"*). The store gives him a literal
shop to operate.

### Why "Backyard Baseball style"

Jake's aesthetic reference is the late-90s game's hand-drawn,
saturated, character-driven look: thick black outlines, vibrant
primary colors, cartoon proportions, "the place is illustrated, not
designed." This is the Phase 2 (scene) direction and is **out of scope
for Phases 0–1**. The brief locks it as the design north star so
Phase-2 work isn't an open question.

---

## 2. Locked Decisions

Settled with Jake in the Brief 037 design conversation:

| # | Decision | Locked value |
|---|---|---|
| D1 | Refresh cadence | **First-open-of-day.** Shelves generate on the first time the user opens the store on a given local calendar date. Cached for 24h. No background regeneration; the wall is stocked when you walk in. |
| D2 | Persona breadth at v1 | **Music Man only.** All three v1 shelves are curated by MM in his voice. Megan + Stephen Hands "drop off crates" in v1.1 once MM is perfected. |
| D3 | Bin set at v1 | **3 shelves: MM's Picks · New Arrivals · Deep Cuts.** All MM-curated. Megan's Picks + Stephen's Crate land in v1.1. |
| D4 | External (non-library) clicks at v1 | **Open the existing BandcampStore embedded view deep-linked to the album URL.** Scraping Bandcamp data into the store directly is v1.1+. |
| D5 | Audio during MM speech | **Duck the current track to ~15% under speech, fade back up on segment end.** Reuses the Radio Mode 4.2.16 pattern. |
| D6 | LLM-down behavior | **Heuristic shelves with no blurbs, no error UI.** Store never shows "Error." If no cache + no LLM, render shelves from deterministic rules. |
| D7 | Cost ceiling | **Reasonable, not absurd.** The engine quality is the gospel. Concretely: ~1 shelf-gen call/day (Sonnet, ~3K tokens), blurbs lazy + cached forever per `(item, persona)` (Haiku, bounded to ~500 items over time), TTS only on explicit click. |

---

## 3. The Six Pillars of the Engine

These are non-negotiable. The engine is the feature.

### 3.1 — Day-theme model

The shelf generator picks **one coherent musical thread for the day
first**, then populates all three shelves around it. Without this, the
store is a Spotify Daily Mix in a wood frame.

A day-theme is one of:

- An era (e.g. "1971 — the singer-songwriter peak")
- A scene (e.g. "Liverpool late 70s")
- A throughline (e.g. "studio-as-instrument records")
- A mood, only when context suggests it (e.g. "Sunday morning")
- A *personal thread* derived from recent listening (e.g. "the Kraut
  kick you've been on")
- A cultural moment (e.g. "Big Thief plays Brooklyn Steel Friday")

The day-theme generator receives:
- Recent listening (last 30d play counts, last 7d skip patterns, last
  90d "rediscovered" tracks)
- Calendar context (day of week, time of day, season)
- Last 21 days of day-themes (must not repeat)
- MM's persona biases (decades, scenes, weird threads from
  `MUSIC_MAN_CORE`)

It outputs `{ theme, rationale, weightingPerShelf }` — a single
LLM call (Sonnet, ~1K tokens).

### 3.2 — Listening-relationship-aware blurbs

Blurbs are NOT generic album writeups. The blurb prompt receives the
user's **relationship to the item**:

- Play count (total, last 30d, last 7d)
- Last played (timestamp)
- Skip count, per-track (which tracks they skip on this album)
- Fade-out percentage (where they tend to leave)
- Whether the user has the full album or selected tracks
- Whether they've added it to a playlist, and which one
- Time-of-day pattern (morning / commute / late night)

**Target output:** *"You played this 4 times in February then nothing.
The back half lands different now that you've been on the Kraut
kick — track 6 onward."*

This is the line that hits. Generic blurbs do not.

### 3.3 — Library-grounded LLM (no hallucinations)

The shelf-generator LLM call receives a **filtered slice of the actual
library** — the 50 most theme-relevant items with full metadata
(artist, album, year, genre, play count, last played) — and is told to
pick from THAT set. Output is validated against the library by
`albumId` / `trackId` before render. If MM returns an item not in the
library, that item is silently dropped (and logged).

No "MM recommends Pet Sounds" when the user doesn't own it. The store
only contains what's real.

The same rule applies to blurbs: any factual claim about the album
(year, producer, personnel) must either be skipped or sourced from the
existing Wikidata / Discogs / MusicBrainz wiring already in the
codebase. If the engine can't source it, MM speaks about the *sound*
or his *opinion*, not invented facts. (This rule already exists in
`MUSIC_MAN_CORE`; the store inherits it.)

### 3.4 — Anti-repeat math

Without this, day 4 picks from the same 30 albums as day 1.

- **Recency penalty:** item picked in last 14 days gets weighted down
  exponentially.
- **Long-tail boost:** items not played in 90+ days get a
  *rediscover* bonus. These are the "you forgot you owned this" picks
  that make a record store feel alive.
- **Day-theme cooldown:** the same theme does not repeat for 21 days.
- **Curator-diversity:** within a single shelf, no more than 1 item
  per artist; across the day's three shelves, no more than 2 items
  per artist.

This math runs **before** the LLM call, so the LLM sees an already
balanced candidate set. It also runs **after**, as a validation pass,
so the LLM can't undo it.

### 3.5 — World-aware picks

The engine pulls from the existing external feeds (already paid for,
already cached) during shelf-gen:

- **Bandsintown** — venues + dates in Brooklyn / NYC this week
- **Pitchfork** — Best New Music, news feed
- **Last.fm** — what the broader listening world is on right now
- **MusicBrainz** — upcoming releases from artists in the library

The integration is at the *day-theme* stage, not the *pick* stage.
The day-theme picker sees: "Big Thief at Brooklyn Steel Friday →
candidate theme: pre-show listen-throughs." If that wins, the shelves
populate accordingly. Result: *"Big Thief is at Brooklyn Steel Friday.
Play Two Hands once before you go."* That's the line that earns the
"tears of joy" bar.

### 3.6 — Model assignment

Reuses the existing `claudeCall` pipeline in `src/main/index.ts:232`.
No new SDK, no new API keys.

| Call | Model | Reason |
|---|---|---|
| Day-theme picker (1×/day) | `claude-sonnet-4-6` | Taste-heavy, worth the cost. |
| Shelf generator (1×/day, can be 1 call combined with day-theme) | `claude-sonnet-4-6` | Same. |
| Per-item blurbs (lazy, cached forever) | `claude-haiku-4-5` | Fast, cheap, ~500 items max over time. |
| Speech-to-audio (TTS, on click only) | ElevenLabs `eleven_turbo_v2_5`, MM voice ID | Reuses existing TTS bridge. |

Daily ceiling enforcement (`claudeStats.dailyCeiling`) already applies.

---

## 4. Module Layout

```
src/main/record-store/
  index.ts                 # IPC handlers, public exports
  shelf-generator.ts       # day-theme + 3 shelves, single Sonnet call
  blurb-generator.ts       # per-item, persona-aware, cached forever
  cache.ts                 # disk persistence (atomic write, single-flight)
  candidate-pool.ts        # anti-repeat math + library filtering
  external-context.ts      # Bandsintown / Pitchfork / Last.fm / MusicBrainz fetchers
  types.ts                 # Shelf, ShelfItem, Blurb, DayTheme, Persona, etc.
  curators/
    music-man.ts           # MM-specific prompt wrappers
    # megan.ts             # v1.1
    # stephen-hands.ts     # v1.1
    new-arrivals.ts        # reuses Pitchfork "New This Week" feed
    deep-cuts.ts           # library long-tail (low-play, theme-relevant)
    mm-picks.ts            # wraps existing weekly-picks pipeline + day-theme

src/renderer/views/RecordStore/
  index.ts
  RecordStoreView.tsx      # top-level, owns scene FSM
  scene/
    StoreScene.tsx         # wide shot (Phase 2)
    BinScene.tsx           # zoomed bin (Phase 2)
    CounterScene.tsx       # MM at counter, speech bubble (Phase 2)
  components/
    Bin.tsx
    AlbumCard.tsx
    SpeechBubble.tsx
    Proprietor.tsx
  hooks/
    useShelves.ts          # IPC + staleness check
    useProprietorSpeech.ts # blurb fetch + TTS coordination + duck/restore
    useSceneState.ts       # FSM (Phase 2)
  art/                     # SVG/PNG assets, versioned (Phase 2)
  record-store.css
```

### 4.1 — Files this brief MAY touch

- `src/main/record-store/*` — new directory, free rein
- `src/renderer/views/RecordStore/*` — new directory, free rein
- `src/renderer/types.ts` — add `'recordstore'` to `ViewName` union
- `src/renderer/components/MainContent.tsx` — add `case 'recordstore'` route
- `src/renderer/components/sidebar/Sidebar.tsx` — add sidebar entry under STORE section
- `src/preload/index.ts` — expose new IPC channels on `window.electronAPI`
- `src/main/index.ts` — register the new IPC handlers (single registration block, follow existing pattern)
- `docs/CHANGELOG.md` — append the version entry on ship

### 4.2 — Files this brief MUST NOT touch

Per `CLAUDE.md` do-not-touch list:

- `src/renderer/context/PlaybackContext.tsx`
- `src/renderer/context/LibraryContext.tsx`
- `src/renderer/hooks/useAudio.ts`
- `src/renderer/hooks/useVirtualScroll.ts`
- `src/renderer/components/playback/NowPlaying.tsx`
- `src/renderer/views/GenresView.tsx`
- `src/renderer/views/CDImportView.tsx`
- `src/renderer/views/DeviceView.tsx`
- `core/` (Python and Swift)

The Record Store integrates with playback **via the existing CustomEvent
bridge and IPC**, never by editing the do-not-touch files directly.
Speech / duck coordination uses the same `musicman-speaking-start` /
`musicman-speaking-end` events already documented in
`CLAUDE.md#architecture-notes`.

---

## 5. Data Shapes (Contract)

```ts
// src/main/record-store/types.ts

export type Persona = 'music-man' | 'megan' | 'stephen-hands'

export type DayTheme = {
  date: string              // YYYY-MM-DD (local)
  theme: string             // human-readable, displayed under shop sign
  rationale: string         // 1-2 sentences, why this theme today
  source: 'era' | 'scene' | 'throughline' | 'mood' | 'personal' | 'cultural'
  externalAnchor?: {        // present when source === 'cultural'
    kind: 'show' | 'release' | 'feature'
    label: string           // "Big Thief at Brooklyn Steel, Friday"
    url?: string
  }
}

export type ShelfItem = {
  id: string                // stable: `lib:album:<albumId>` | `lib:track:<trackId>` | `ext:bc:<url>` | `crate:<uuid>`
  kind: 'library-album' | 'library-track' | 'external-release' | 'crate'
  coverUrl: string | null
  title: string
  subtitle: string          // artist, or "5 tracks · ~22min" for crates
  placement: string         // shelf-level reason ("for your Saturday")
  payload: {
    albumId?: string
    trackIds?: string[]
    externalUrl?: string    // Bandcamp deep link
  }
}

export type Shelf = {
  id: 'mm-picks' | 'new-arrivals' | 'deep-cuts' | 'megan-picks' | 'stephen-crate'
  curator: Persona | 'house'
  title: string             // "Music Man's Picks"
  tagline: string           // 1 sentence in curator's voice
  items: ShelfItem[]
}

export type ShelfBundle = {
  date: string              // YYYY-MM-DD (local)
  generatedAt: number       // ms epoch
  validUntil: number        // ms epoch (generatedAt + 24h)
  theme: DayTheme
  shelves: Shelf[]
  source: 'llm' | 'heuristic'  // for debugging + UI subtle indicator
}

export type Blurb = {
  itemId: string
  persona: Persona
  text: string              // 1-3 sentences
  generatedAt: number
  source: 'llm' | 'cached'
}
```

---

## 6. IPC Surface

All channels follow the existing naming convention (kebab-case, prefix
by feature).

| Channel | Direction | Payload in | Payload out |
|---|---|---|---|
| `record-store:get-shelves` | renderer → main | `{ forceRefresh?: boolean }` | `ShelfBundle` |
| `record-store:get-blurb` | renderer → main | `{ itemId: string; persona: Persona }` | `Blurb` |
| `record-store:speak-blurb` | renderer → main | `{ blurb: Blurb }` | `{ ok: true; audioId: string }` |
| `record-store:cancel-speech` | renderer → main | `{ audioId: string }` | `{ ok: true }` |
| `record-store:on-shelf-refresh` | main → renderer | event | `ShelfBundle` (for if main regenerates on its own) |

Expose via `window.electronAPI.recordStore.*` in `src/preload/index.ts`,
mirroring the pattern already used for `bandcampMount` /
`squidMount` / etc.

---

## 7. Cache Layout

```
~/Library/Application Support/JakeTunes/record-store/
  shelves/
    2026-05-24.json        # one ShelfBundle per local calendar date
    2026-05-23.json        # keep last 21 days for anti-repeat lookback
    ...
  blurbs/
    music-man/
      lib_album_<albumId>.json
      ext_bc_<urlhash>.json
      ...
  day-themes/
    history.json           # rolling 21-day theme log for cooldown checks
```

- Atomic writes (write to `<file>.tmp`, then rename). Already a
  codebase pattern (`src/main/library-write.ts` etc.).
- Single-flight writer per file (no concurrent writes to the same
  path). Same pattern.
- On read: if today's bundle exists and `validUntil > Date.now()`,
  return it. Otherwise regenerate.

---

## 8. Failure Modes Designed In

These are NOT "TODO: handle later." They are the v1 spec.

| Failure | Behavior |
|---|---|
| LLM unreachable, no cache | Heuristic shelves: MM Picks = top-played artists' less-played albums; New Arrivals = newest by `dateAdded`; Deep Cuts = lowest play-count library albums. **No blurbs.** No error UI. |
| LLM unreachable, cache exists | Serve cache regardless of `validUntil`. Show a subtle "served from yesterday" pill in the corner of the shop sign — not an error. |
| User opens store before library loads | "Music Man is opening up..." copy + spinner. Real spinner, not a stuck screen. Library load is fast in practice; this is rare. |
| User clicks an item whose blurb is still generating | Speech bubble shows typing dots. When ready, audio plays. **Playback of the album does NOT wait on the blurb** — it starts immediately. |
| User leaves the store mid-speech | Cancel TTS via `record-store:cancel-speech`. Restore the ducked track to full volume. Per `CLAUDE.md#react-hook-rules`: every cancel reverses all side effects of the start path. |
| LLM returns an item id not in the library | Drop it silently. Log to `[record-store]` console. If a shelf drops below 3 items after validation, top up from the heuristic pool for that shelf. |
| Cache file corrupt (truncated JSON from a crash) | Catch parse error, delete the file, regenerate. Atomic writes make this rare but the read path is defensive. |
| User changes system date | Cache file is keyed by local calendar date string. Time-travel to a date with no cache → regenerate. Time-travel to a past date with cache → serve it (rare edge case, no special handling). |

---

## 9. Phase Plan

### Phase 0 — Foundation (sized: ~1 day)

Plumbing. Boring on purpose. Goal: the view renders one shelf with
real items from the library, no LLM yet.

- New branch `claude/037-record-store-phase0`
- Module skeleton (`src/main/record-store/` directories, `types.ts`,
  `cache.ts` with atomic write + read, IPC handler stubs that return
  hard-coded ShelfBundle)
- Renderer skeleton (`RecordStoreView.tsx` renders the ShelfBundle as
  plain HTML — flat list of shelves, flat list of items, no scene, no
  art). One CSS file, minimal styling.
- ViewName + sidebar entry + MainContent route
- Preload exposure of the 4 IPC channels
- `useShelves.ts` hook — fetches via IPC, caches in renderer state,
  invalidates on view re-mount
- **Verification:** open the store, see 3 shelves with hard-coded
  titles and 5 real library items each (any items, doesn't matter how
  they're picked). Click an item → it plays. That's Phase 0 done.

### Phase 1 — The Engine (sized: ~3-5 days, this is where the time goes)

The brain. Every section of §3 is implemented here.

Phase 1 ships in this order, each step verifiable on its own:

**1a — Candidate pool builder (`candidate-pool.ts`)**
- Library filtering by metadata (year, genre, tags, artist)
- Anti-repeat math (recency penalty, long-tail boost, day-theme
  cooldown read from `day-themes/history.json`)
- Diversity guard (1 per artist/shelf, 2 per artist/day)
- Output: a ranked candidate set for a given theme + shelf type
- **Verifiable in isolation** via a small Node script in `scripts/`

**1b — External context fetchers (`external-context.ts`)**
- Bandsintown (NYC venues, next 14 days) — reuse existing fetch
  pattern from `src/main/index.ts`
- Pitchfork Best New Music + news — reuse the RSS parsing pattern
- Last.fm trending — new fetcher, ~30 lines
- MusicBrainz upcoming releases for library artists — already wired
  for Home view; expose as a function
- All cached for 6h on disk; fail-soft (any individual feed can be
  down without breaking the rest)

**1c — Day-theme picker (`shelf-generator.ts:pickDayTheme`)**
- Single Sonnet call with: external context, recent listening
  summary, last 21 themes (cooldown), MM persona biases
- Returns DayTheme + rationale + per-shelf weighting
- Heuristic fallback: pick a long-tail artist from the library, theme
  around their decade/scene

**1d — Shelf generator (`shelf-generator.ts:generateShelves`)**
- Single Sonnet call with: DayTheme, candidate pools per shelf (from
  1a), persona context
- Returns 3 shelves of 5-7 items with placement reasons
- Library-grounded validation pass: drop hallucinated items, top up
  from heuristic if shelf drops below 3
- Combined with 1c into ONE Sonnet call when possible (cheaper, more
  coherent)

**1e — Blurb generator (`blurb-generator.ts`)**
- Single Haiku call per `(item, persona)` tuple
- Receives the listening-relationship payload (§3.2)
- Cached forever to disk
- MM speaks in `MUSIC_MAN_CORE` voice (already loaded), with a
  shop-clerk wrapper: *"You are behind the counter of WJLR Records on
  Atlantic Ave. The customer is browsing the {shelf-name} shelf. Speak
  to their relationship with this record. 1-3 sentences. No
  recap — they own it."*

**Phase 1 verification (the "tears of joy" gate):** Jake opens the
store on a Tuesday morning, reads the three shelves and their blurbs
top to bottom, and reports back. If it doesn't hit — iterate on the
prompts, the candidate-pool weights, the day-theme picker. **Do not
move to Phase 2 until this gate is passed.**

### Phase 2 — The Scene (sized: ~2-3 days)

The frame for the painting. Backyard-Baseball aesthetic.

- Scene FSM (`useSceneState.ts`): `idle` → `at-bin` → `at-counter` →
  `leaving`
- Illustrated storefront art (commissioned or AI-generated, locked
  with hex palette + reference)
- Music Man proprietor sprite, idle/speaking states
- Vinyl-bin components with flip-card interactions
- Speech bubble component
- TTS integration via `useProprietorSpeech.ts`, ducking the current
  track per D5
- "Knock to refresh" interaction (the door, or the bell, TBD in Phase
  2 design pass) — calls `record-store:get-shelves` with
  `forceRefresh: true`
- Phase 2 has its own design pass (color palette, layout grid, art
  inventory) before pixel work starts. Locked palette example: sky
  `#a8d8ff`, wood `#b87333`, counter `#5a3a22`, posters in primary
  reds/yellows/blues, "Sandwich"-style headings.

---

## 10. Out of Scope (v1)

- Megan + Stephen Hands as curators (v1.1)
- Bandcamp scraping into native shelves (v1.1+; v1 opens BandcampStore view on external clicks)
- "Wishlist" mechanism for external releases
- Multi-day theme arcs ("this week's wall is wired-up post-punk women")
- Customer NPCs (Giovanni etc. wandering through the shop asking questions — fun, but v2)
- Search inside the store (it's a curated wall, not a directory)
- Buying / payments of any kind
- Mobile parity (this is desktop-only; the Phase 2 sync work is separate)
- Sharing / posting picks to social

---

## 11. Pre-Flight (before starting Phase 0)

Run each. If any unexpected output, **STOP and report**.

### 11.1 — Clean working tree on a fresh branch

```bash
cd ~/JakeTunesV3
git fetch origin
git status                          # current branch has uncommitted Bandcamp work; do NOT discard
git stash push -m "036-bandcamp-wip-pre-037"
git checkout -b claude/037-record-store-phase0
git stash list                      # confirm stash exists
```

The current 036 branch has 10+ uncommitted files. Stash, don't
discard, and don't include them in 037's commits.

### 11.2 — tsc baseline

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Record the baseline. 037 commits must not introduce new tsc errors
beyond this number (and must not introduce *any* new errors in files
037 touches).

### 11.3 — Existing systems we depend on

Confirm these are present and current:

```bash
grep -n "claudeCall\b" src/main/index.ts | head -3              # the LLM wrapper
grep -n "MUSIC_MAN_CORE\b" src/main/index.ts | head -3          # persona prompt
grep -n "musicman-speaking-start\|musicman-speaking-end" src/  # speech-event bridge
grep -n "weeklyPicks\|generatePicks" src/main/index.ts          # picks pipeline
```

All four should return matches. If any is missing, the codebase has
drifted from this brief's assumptions — STOP and report.

### 11.4 — IPC pattern reference

Read `src/preload/index.ts` once end-to-end before writing new
channels. Match the existing exposure pattern exactly. Bandcamp and
squid integration are the closest analogs.

---

## 12. Commit Discipline

Per `CLAUDE.md#commit-rules`:

- Each phase ships as **one commit per sub-step** (1a, 1b, ...) on the
  brief's branch. No mixing foundation work with engine work.
- Polish work and feature work in separate commits.
- No backwards-compat shims, no `_unused` renames, no `// removed`
  comments.
- Twin/sibling sweep before every commit. The names to watch for in
  this brief: `normalize`, `match`, `dedupe`, `compare`, `serialize`,
  `parse` — none should be added without checking for existing twins.

---

## 13. Smoke Tests (per `CLAUDE.md#testing-rules`)

After every Phase-0 / Phase-1 commit, verify:

- Sidebar "Record Store" entry navigates to the view without crash
- The view renders the current ShelfBundle (cached or fresh)
- Clicking a library item starts playback
- Clicking an external item opens the BandcampStore view at the right URL
- The five do-not-touch files are untouched (`git diff <branch>...HEAD --name-only` excludes them)
- No new `window.prompt|alert|confirm` usages (per `CLAUDE.md#platform-rules`)

After Phase 2 ships:

- The duck-on-MM-speech pattern restores volume on cancel (per
  `CLAUDE.md#react-hook-rules` cancel-reverses-start rule)
- The scene FSM has no `if (state && !state2 && !state3)` tangles —
  every transition is named

---

## 14. Versioning

Per `CLAUDE.md#version-numbering`:

- The store is a feature milestone — bump the minor: **4.6.0** on first
  ship (Phase 2 complete, art included). Phase 0 + Phase 1 ship
  iteratively on the same dev dmg as **4.5.x-dev** patches; the version
  string does not advance until Jake says it does.
- Engine-only ship (Phase 1 done, Phase 2 not started) could land as
  **4.5.5** *if* Jake wants to use the text-only store for a few weeks
  while Phase-2 art is in flight. Decide at the time.

---

## 15. The Gospel (one more time)

> *"make sure the engine is so fucking good that i cry tears of joy."*

If the Phase 1 verification gate isn't met, Phase 2 doesn't ship. The
illustrated frame is worthless around a generic recommender. Build the
brain first, polish the brain, then paint the room.

— end of brief 037 —
