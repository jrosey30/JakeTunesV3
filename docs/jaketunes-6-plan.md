# JakeTunes 6.0 — Planning Notes (started 2026-09-01)

**Status:** brainstorm captured, nothing greenlit. Written the day the iPod
binary-search id-order fix landed (see
`postmortems/2026-09-01-ipod-binary-search-id-order.md`) — the win that
reopened "anything can be built" ambitions. Jake's framing that day: the brain
still needs massive improvement, the back end is "just ok," newer features are
hit or miss (e.g. download). 6.0 should be **one story told completely**, per
the version-numbering doctrine — pillars below are candidates, not commitments.

---

## Four directions worth debating

### 1. The round trip (recommended candidate for the version story)
The iPod is currently write-only: brain picks, Mini plays, everything Jake did
offline evaporates. But the firmware records plays (Play Counts) and On-The-Go
queues — files the activity engine currently just retires. Read them back
before retiring and every unplug-listen-replug becomes taste data: skips,
repeats, what he reached for when no algorithm was watching. Offline listening
is involuntary honesty — the purest taste signal that exists. Feeds the taste
ledger and nightly brain directly. Newly possible now that the device contract
is fully understood.

### 2. Your library, anywhere (finish the streaming client)
Stage 1 proven (homemini:3000/audio/:id). Stages 2–5 open. The story: every
device — laptop, phone, workmini, Mini — is a different-shaped window onto one
brain and one library, each getting exactly what fits its shape. "Exact" is
proven on the hardest device; the rest are software.

### 3. Brain-authored device programming
Exact counts make the picker ambitious: "load me a 250 for the beach weekend,"
scheduled rotations that refresh the Mini on a cadence, mixtape-clock
sequencing on the device itself. We control physical record order — which is
what the Mini's menus present — so we can author the device's presentation
with intent. Nobody has done that deliberately, possibly ever.

### 4. The historian
Year in Review is queued (Dec 17). With the sync ledger + round-trip data,
JakeTunes becomes self-documenting: every sync, verdict, and era of taste,
queryable. Twenty years out, the archive is the product. Rides nearly free on
pillars 1–3.

---

## RAG / brain boost plan (the "huge boost" question)

Core diagnosis: **the brain has never heard the music.** Everything it knows
is text about songs (Gemma descriptor → OpenAI embedding, lyrics meaning,
genre taxonomy). A librarian who read every review but never listened to a
note — great at "songs about loss," blind on "songs that *sound* like this."

Lanes, in build order:

1. **Grow the altimeter first** (~a week, unblocks everything). The
   measure-first doctrine exists; a "huge boost" claim needs a golden set big
   enough to prove it: queries across moods, eras, activities, lyrical themes,
   AND sonic similarity. Recall is the metric (never AUC — standing rule).
   Mine the taste ledger for free ground truth. Without this, boost vs vibe is
   indistinguishable.
2. **Audio embeddings — the marquee feature.** Run every track's actual audio
   through an audio-embedding model (MERT/CLAP class). Too heavy for
   homemini's Ollama ceiling (gemma3:4b, standing rule: don't load bigger) —
   batch on the laptop overnight; one pass, permanent asset alongside
   `embeddings.bin`. Kept as a SECOND vector, not blended: sound-questions
   search the sound index, meaning-questions the meaning index. The playlist
   code already thinks this way (bpm/Camelot handled separately, never mushed
   into one score) — this makes the whole brain that shape.
3. **Rerank instead of trusting raw nearest-neighbor.** Two-step retrieval:
   embeddings cast a wide net (top ~100), then a judge reorders using what
   embeddings can't see — taste-ledger weights, genre locks, era, play
   history, quality floors, round-trip data. Recall gets candidates; reranking
   gets taste. Where "technically similar but obviously wrong" picks die.
4. **Coverage audit** (boring, guaranteed points). What % of the library has
   lyrics / descriptor / genre / embedding? Every hole is a song the brain
   guesses about. One report, then fill holes.

Tie-back: pillar 1 (round trip) is the fuel for lanes 1 and 3 — real offline
listens as eval ground truth and rerank signal. One sentence: better ears
(audio vectors) + better judgment (reranking) + honest report cards (evals fed
by real listening).

Scoping sketch: week one = eval expansion + coverage audit in parallel; audio
embeddings as centerpiece; reranking last (it feeds on everything before it).

---

## UI placement audit ("without destroying the soul")

Jake, 2026-09-01: *"we need to determine if everything on the app is placed in
the best spot possible without destroying the soul of it (the itunes looking
library)."*

- The soul is the iTunes-looking library. It is the constraint, not the
  subject: the audit may move features to better homes; it may not make the
  app stop looking and feeling like 2006 iTunes.
- Method (proposed): inventory every entry point (sidebar, toolbar, menus,
  context menus, modals, hidden shortcuts) → for each: how often used, how
  discoverable, does its placement match its importance → propose moves in a
  single review doc BEFORE touching code. Jake arbitrates each move.
- Standing rules apply: no unrequested UI features; "looks off" = one fix then
  pause; truncation policy; type tokens are px.
- Candidates flagged in conversation as "hit or miss": download flow. Audit
  should start there.

---

## Activity Sync front end (Jake, 2026-09-01)

*"Make it sleeker, easier to use, easier to keep track of sync history…
the core idea of it wont change AT ALL, the look will."*

- **Scope law:** behavior/pipeline untouched — the engine, picker, gates, and
  ledger are proven and stay exactly as they are. This is a LOOK and
  legibility project only.
- **Sync history view:** the backend already records everything —
  `activity-sync-ledger.jsonl` (picks + result per sync: what went on, what
  came off, target vs landed, timestamps). No UI reads it yet. A history
  panel is mostly presentation: list of syncs, each expandable to its on/off
  diff with artist — title (resolve ids against the library), target/landed
  badge. The ledger diffs sync-to-sync (established 8/31).
- **Sleeker sync flow:** clearer phase progress (board → copy → verify →
  catalog → seal already exist as engine progress events), calmer language,
  obvious size picker (100/250/500/1000), and a prominent "landed N of N"
  result that matches what About will say — which we can now actually promise.
- **Caution:** the Activity Sync UI lives in `DeviceView.tsx`, which is on the
  Do-Not-Touch list (and was the vector of the 702-row corruption). This
  section is Jake's explicit ask, but each change set still names what it
  touches there, and pathRewrites handling is off limits.

## Open questions for Jake

1. Which pillar is THE 6.0 story — round trip, or library-anywhere? (Others
  ride along as minor features.)
2. Does the RAG boost ship inside 6.0 or as a rolling build-period before it?
3. UI audit: one big review doc, or room-by-room passes?
