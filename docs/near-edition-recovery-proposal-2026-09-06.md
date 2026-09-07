# Near-edition recovery — the Chocolate Chords dead end (proposal, 2026-09-06)

Document-only. Nothing here changes code; the flow waits for Jake's review.
Strict edition identity stays: nothing partial and no alternate edition is
ever acquired without an explicit choice, and whatever is acquired is
reported exactly as what it is.

## What happened

Jake pressed Get on **Chocolate Chords — Terry Lee Brown Junior**, the iTunes
edition `96265705` (12 tracks, 1997). The verdict: *Exact edition not found*.
Sources answered; one edition was judged and refused:

> bandcamp: Chocolate Chords — Terry Lee Brown Junior (12 tracks) — track 4
> "Here We Go" runs 8:04; the edition you picked runs 6:50

The panel then offered **Choose edition**, which opens Browse — where iTunes
lists only that one edition. Nothing different to choose: a dead end.

## The evidence (read-only, the real judge)

The Bandcamp page (`terryleebrownjunior.bandcamp.com/album/chocolate-chords`,
released 30 Apr 1997) lists 12 tracks. Run through `verifyAlbumCandidate`
one track at a time against the iTunes tracklist, tolerance 20 s:

| # | Edition you picked (iTunes 96265705) | Bandcamp | Δ | Judge |
|---|---|---|---|---|
| 1 | Straylight 6:40 | Straylight 6:40 | 0 s | exact |
| 2 | The Music 5:47 | The Music 5:47 | 0 s | exact |
| 3 | Mindless Tides 6:49 | Mindless Tides 6:49 | 0 s | exact |
| **4** | **Here We Go 6:50** | **Here We Go 8:03** | **+74 s** | **differs — a longer edit of the same title** |
| 5 | If You Open Up 5:02 | If You Open Up 5:02 | 0 s | exact |
| 6 | Chord Progression 7:10 | Chord Progression 7:10 | 0 s | exact |
| 7 | Looking Beyond 7:03 | Looking Beyond 7:03 | 0 s | exact |
| 8 | Magic Prison 5:54 | Magic Prison 5:54 | 0 s | exact |
| 9 | Back to Reception 5:44 | Back to Reception 5:44 | 0 s | exact |
| 10 | Let's Jazz 5:52 | Let´s Jazz 5:52 | 0 s | exact (punctuation folds) |
| 11 | Dètente 5:10 | Détente 5:10 | 0 s | exact (accent folds) |
| 12 | Nightshift 6:37 | Nightshift 6:37 | 0 s | exact |

Eleven of twelve are the same recordings to the second; track 4 on Bandcamp
is a different edit, 74 seconds longer. The whole-album judge is correct to
refuse — this is not the edition Jake picked — but it stops at the first
mismatch, so the panel could only ever say "track 4"; it never knew the other
eleven match. The recovery flow needs the full per-track comparison.

## Why the current rules produce a dead end

- The album contract says: never import part of another edition. Right, as
  a default — it is what stopped "Little Creatures Deluxe" from importing 9
  of 12 and calling it done.
- "Choose edition" assumes Browse has another edition to offer. When iTunes
  has one edition and the only near match lives on Bandcamp, the choice has
  nowhere to go.
- The verdict throws away the judged tracklist, so nothing downstream can
  show what matched.

## Proposed recovery flow

When an album Get is refused as *exact-not-found* and at least one judged
edition is a **near edition** — same artist, same title, same track count,
refused only on the tracklist — the refused row (Downloads panel, Counter
Details) gains **Compare editions…** next to Choose edition. It opens a sheet:

```text
Chocolate Chords — Terry Lee Brown Junior
Edition you picked: iTunes 96265705 · 12 tracks · 1997
Nearest found:      Bandcamp · 12 tracks · 1997          (terryleebrownjunior.bandcamp.com)

 #  Track                       picked    found     
 1  Straylight                  6:40      6:40   ✓
 …
 4  Here We Go                  6:50      8:03   ✕  a longer edit of the same title
 …
12  Nightshift                  6:37      6:37   ✓
11 of 12 match to the second · 1 differs

[ Get the 11 matching tracks ]      acquires 11 songs as songs, pinned to the picked
                                     edition's runtimes; track 4 is NOT acquired.
                                     Recorded: 11 of 12 of iTunes 96265705 · track 4
                                     missing (only an 8:03 edit was found).
[ Get the Bandcamp edition ]         acquires all 12 as the Bandcamp edition.
                                     Recorded: Bandcamp edition, 12 of 12 · differs
                                     from the edition you picked at track 4 (8:03 vs 6:50).
[ Paste a link to the exact one ]    Browse → Add by link (existing).
[ Not now ]                          leaves the verdict as it is.
```

Each button says, before the click, exactly what it will acquire and how it
will be recorded. Nothing happens on opening the sheet.

### Action A — Get the 11 matching tracks

- Enqueues **eleven song jobs**, one per matching track, each pinned to the
  picked edition's title and runtime (the existing recording contract, ±5 s),
  carrying the album jot's provenance and a `partOf` note: `{ collectionId:
  96265705, of: 12, position: n, missing: [4] }`. The recording judge accepts
  the Bandcamp tracks because they *are* those recordings.
- **Acquires:** 11 files, tagged as the album's tracks 1–3 and 5–12.
- **Reported:** Downloads panel row "11 of 12 · track 4 not acquired (a
  different edit is all that was found)". The Listen List jot is **not**
  released; its ownership reads "11 of 12 in your library · missing: 4 Here
  We Go (6:50)". The Counter's Play Album gate stays closed (completeness
  doctrine) — the record is honestly incomplete. A later exact find of track
  4 completes it.

### Action B — Get the Bandcamp edition

- Enqueues **one album job whose selection is explicitly the Bandcamp
  edition**: a new selection revision (`bandcamp:<album url>`) with *that*
  tracklist as the identity. The judge then verifies the download against the
  Bandcamp tracklist — exact, 12 of 12.
- **Acquires:** 12 files, the Bandcamp edition.
- **Reported:** completion line "Bandcamp edition · 12 tracks · 12 imported ·
  differs from iTunes 96265705 at track 4 (8:03 vs 6:50)". The jot's picked
  edition is **not** claimed as owned: ownership reads "Bandcamp edition on
  your shelf (12 of 12) · the edition you picked differs at track 4". Play
  Album works for the Bandcamp edition (complete for what it is). Releasing
  the jot is Jake's click, not automatic.

### What never happens

- No partial import on the default Get. "Get" keeps meaning the exact edition
  or nothing.
- No silent substitution: A and B exist only behind the sheet, each with its
  acquisition sentence.
- No guessing at unjudged tracks: the sheet shows only what the judge proved;
  if a candidate has no tracklist, the sheet says so and offers only C/D.

## Change sets (for later, in order)

| # | Change | Where | Notes |
|---|---|---|---|
| 1 | `judgeAlbumTracks(req, cand)` — the per-track table (all tracks, not first mismatch) + `nearEditions(alternatives)` + the two acquisition sentences | `src/common/near-edition.ts` + tests | pure; Chocolate Chords becomes the regression fixture (12 rows, one differs) |
| 2 | Keep the judged tracklist: `alternatives[i].tracks` and the candidate URL at judgement time | download engine (`streamrip-store/index.ts`), not the iPod engine | data only; a re-fetch IPC (read-only) for old jobs |
| 3 | Compare editions sheet from the panel row and the Counter's Details | `DownloadsPanel.tsx`, `CounterDesk`, new sheet | renders 1 |
| 4 | Action A: song jobs with `partOf`; ownership and completion lines that count the missing track | queue, `record-shop-live` ownership, panel model | the completeness doctrine untouched |
| 5 | Action B: explicit alternate-edition selection in the album contract | `record-shop.ts` selection revision, resolve, judge | the largest; last |

## Acceptance checks (agreed before coding)

| # | Check |
|---|---|
| N1 | The table for Chocolate Chords shows 11 exact + 1 differs from the real judge (fixture from the Bandcamp tracklist above); punctuation and accent differences fold |
| N2 | Opening the sheet acquires nothing; the queue is unchanged |
| N3 | A enqueues exactly 11 song jobs with runtime pins and `partOf`; none for track 4; the panel row reads "11 of 12 · track 4 not acquired" |
| N4 | After A (harness), the jot's ownership reads 11 of 12 with track 4 named; Play Album stays closed; the jot is not released |
| N5 | B enqueues one album job with an explicit Bandcamp selection; the completion line names the differing track and never claims the iTunes edition |
| N6 | The default Get path is unchanged: exact-not-found still imports nothing |
| N7 | Every acquisition button's sentence matches what the job actually did, checked on the harness before any real acquisition; the first real run is Jake's choice of material (this album is a candidate, his call) |

## Decision for Jake

Approve the sheet and actions A and B as described, or only A (the eleven
matching tracks) first. The legacy Download page, the everyday-use review of
the Record Shop and the Mobile caption stay separate.

## Slice 1 — pure model + read-only sheet (implemented 2026-09-06, later)

Approved: Compare editions with both acquisition choices; model and read-only
sheet first, actions in their own slice.

| Change | Where |
|---|---|
| Judged tracklists ride on refusals: `Alternative` gains `tracks`, `trackCount`, `url`; the download engine attaches them when it refuses an edition (data only, no behaviour change) | `common/acquisition-identity.ts`, `streamrip-store/index.ts` |
| Near-edition detection (same record, same count, refused on the tracklist) | `common/near-edition-detect.ts` |
| Per-track judge (the same `verifyAlbumCandidate`, one row at a time) + summary with exact counts, the differing runtimes and the two acquisition sentences; "runtime mismatch (8:04 found, 6:50 picked)", never a claim about which edit | `main/near-edition.ts`, `common/near-edition-types.ts` |
| Read-only IPC `near-edition:compare`: the picked edition's tracklist from iTunes, the found edition's from the verdict's judged tracklist or the Bandcamp page (public, read-only). Acquires and writes nothing. | `main/ipc/near-edition-ipc.ts` |
| The sheet (portal to the body): both editions, the 12-row table, counts, differing runtimes, the two acquisition choices with their sentences (shown, disabled, "not wired yet"), Paste a link (existing route), Not now | `components/CompareEditionsSheet.tsx`, `styles/compare-editions.css` |
| Downloads panel: **Compare editions…** on a refused album row with a near edition | `downloads-panel-model.ts`, `DownloadsPanel.tsx` |

### Regression results (`near-edition.test.ts`, gate 1,172)

- Chocolate Chords fixture: 12 rows; 11 exact, track 4 "runtime mismatch (8:04
  found, 6:50 picked)", Δ +74 s; punctuation and accent folds; no "longer
  edit" wording.
- Summary: exact counts and the differing runtimes in both sentences; the
  matching sentence names track 4 as not acquired, says already-owned
  recordings are skipped and that the record stays incomplete; the edition
  sentence names the source, says the picked edition is not marked as owned.
- A shorter candidate leaves the tail unknown; nothing invented.
- Detection: same-count tracklist refusals only; count or version refusals
  are not near editions; the panel offers Compare editions only for those.
- Rail: the sheet never references the queue, the Get path, a prefill or the
  download IPC.

### On the dev instance (fixture job, real read-only fetches)

The refused row shows Choose edition · **Compare editions…** · Details. The
sheet fetched iTunes 96265705 and the Bandcamp page and rendered the table
exactly as the test fixture predicts; the queue before and after opening was
identical (N2), no rip process; Not now closes; Paste a link lands on Browse
with "Terry Lee Brown Junior Chocolate Chords" searched and nothing queued.
Captures: `compare-1-panel-row.png`, `compare-2-sheet.png`,
`compare-2b-sheet-actions.png`, `compare-3-paste-link-browse.png`.

Next slice: wire action A (matching-track Gets: recording identity, version
markers, runtimes, verified files, already-owned skipped; the album request
stays incomplete), then action B (explicit Bandcamp selection by source and
tracklist; never fulfils the iTunes edition). Live acquisition only after
Jake picks the material.

## Slice 2 — action A wired: the matching-track Gets (2026-09-06, later)

| Change | Where |
|---|---|
| Ownership in the comparison: each row carries `owned` (the library's recording identity, `matchLibraryOwnership`); the summary counts `owned` and `toAcquire`, and the sentence says how many are skipped | `near-edition.ts`, `near-edition-ipc.ts`, `near-edition-types.ts` |
| The plan (pure): one song request per exact, unowned row — title as picked (version markers intact), runtime as picked (`durationMs`), album as picked; the mismatch row never selected; NO recommendationIds; a `group` naming the refused album job, the position, the skipped-owned count and every track not acquired with its reason | `common/near-edition-actions.ts` |
| The scheduler is unchanged: each job is an ordinary song request through `enqueue` → main's recording judge and post-staging verification. `enqueue`'s key dedupe makes a repeat click harmless: done and in-flight tracks untouched, failed ones re-armed | `downloadQueue.ts` (`QueueOrigin.group` only) |
| The panel folds the children under the refused album row: per-track status with elapsed time and Cancel, a group line "N of 12 in your library · … · track 4 not acquired (runtime mismatch …)" that never says complete, and **Retry the N that failed** which re-arms only failed or canceled children | `downloads-panel-model.ts`, `DownloadsPanel.tsx` |
| The sheet's first button is live; the enqueue happens in the panel behind that click (the sheet still never imports the queue). Zero to acquire → "Nothing to get — all matching tracks are yours", disabled | `CompareEditionsSheet.tsx` |

### Regression results (`near-edition-actions.test.ts`, gate 1,178)

| Case | Result |
|---|---|
| Plan | 12 rows, 2 owned → 9 jobs; track 4 and the owned two never selected; each job pinned (title, album, runtime), no recommendationIds, group position and skipped count carried; the all-owned plan is empty |
| Mixed ownership | the refused album stays refused; ten children fold under it; line "11 of 12 in your library · track 4 not acquired (runtime mismatch …)"; every call to main carried the runtime pin and the album; the album jot still projects onto the refused album job, never a child |
| Cancellation | one child cancelled mid-flight: "10 of 12 · 1 canceled"; Retry re-armed only that track (one call), then 11 landed |
| Partial failure + post-staging verification failure | provider failure on one track, unverifiable file on another: both shown with their verdicts, nine landed; Retry re-armed exactly those two |
| Repeat clicks | the second click added no jobs and re-ran only the failed track |
| Compare acquires nothing | rail: the sheet never references the queue, the Get path or a prefill; the enqueue lives in the panel behind the click |

### On the dev instance (fixtures, nothing acquired)

Chocolate Chords via the read-only fetch path: the button reads **Get the 11
matching tracks**, enabled, with the full sentence; it was not pressed, and
the queue before and after opening was identical (`actionA-1-sheet-enabled.png`).
A Little Creatures Deluxe fixture with an attached near-edition tracklist
(track 3 altered): 11 exact, all already owned → "Nothing to get — all matching
tracks are yours", disabled, the eleven listed as skipped
(`actionA-2-sheet-all-owned.png`). No rip process at any point.

Live acquisition of the real Chocolate Chords tracks waits for Jake's go.
Action B (the Bandcamp edition) is the next slice.

## Slice 3 — action B wired: the source edition (2026-09-07)

| Change | Where |
|---|---|
| The selection: `SourceEdition` = provider + the album's own page URL (stable identity) + the tracklist snapshot taken at comparison, plus what it was chosen instead of and where it differs | `common/source-edition.ts` |
| Verification against the snapshot: the request IS the snapshot (`requestFromSourceEdition`, no collection id, no packaging labels); `verifySourceEdition` runs the same album judge and refuses a changed count, title or runtime with "the bandcamp tracklist is not the one you compared — …" | `main/source-edition-verify.ts` |
| The engine path: an album request carrying `sourceEdition` builds its identity from the snapshot, skips the iTunes lookup and every other provider, stages the selected page directly, judges the staged files against the snapshot, and either imports through the normal `finishAlbum` (completion credits owned recordings) or refuses with "Source edition changed" and imports nothing. Everything else in the engine is untouched | `streamrip-store/index.ts` |
| Pass-through: `QResult.sourceEdition` → preload → main; the job's key is `bandcamp|album|bc|album|<url>`, never the iTunes job's | `downloadQueue.ts`, `preload`, `types.ts` |
| The plan (pure): job + identity line + every runtime difference + the recorded line + the never line ("iTunes 96265705 is not marked as owned by this; the Listen List entry for it is untouched"); no recommendationIds; `chosenInsteadOf` for display | `common/near-edition-actions.ts` |
| The sheet: **Get the Bandcamp edition…** opens a confirmation block showing the identity, the runtime differences and what will be recorded; only **Confirm — get 12 tracks as the Bandcamp edition** hands the plan to the panel, which enqueues. Back cancels. The sheet still never imports the queue | `CompareEditionsSheet.tsx` |
| The panel row: "Bandcamp edition · <url> · 12 tracks · 1997" with the note "chosen instead of iTunes 96265705 · differs at track 4 (8:04 vs 6:50)"; its own row beside the still-refused iTunes request | `downloads-panel-model.ts`, `DownloadsPanel.tsx` |

### Regression results (`source-edition.test.ts`, gate 1,185)

| Case | Result |
|---|---|
| Selection | by URL + 12-track snapshot with the source's own titles and runtimes; key distinct from the iTunes job; no recommendationIds; the runtime difference and the never-line present; no URL → cannot be selected |
| Verification | same tracklist → exact; a changed runtime (track 8 +60 s), a changed title, a shorter count → refused with the snapshot named |
| Mixed ownership | main receives the snapshot and no collection id; completion "12 tracks · 9 imported, 3 already in your library"; its own row beside the refused iTunes row; the jot still projects onto the iTunes job |
| Repeat clicks / cancellation / partial import | a second click while in flight adds nothing; cancel mid-flight → canceled; a partial import comes back as "Album import incomplete" with nothing claimed complete; one call per attempt |
| Source changed between comparison and acquisition | the engine's refusal renders as "Source edition changed · Nothing was imported" |
| A and B distinct | no shared keys, no recommendation ids on either |
| Compare acquires nothing | rail: the sheet never references the queue; the confirm step precedes the delegated enqueue |

### On the dev instance (fixtures, nothing acquired)

The confirm block rendered with the identity ("terryleebrownjunior.bandcamp.com/album/chocolate-chords · 12 tracks · 1997"), the one runtime difference, the recorded line and the never line; Back closed it; the queue was byte-identical throughout (`actionB-1-confirm-step.png`). A landed source-edition fixture row shows the edition line, the note and "9 imported · 3 already in your library" beside the still-refused iTunes row (`actionB-2-panel-row-distinct.png`).

Neither action is live-accepted. Live acquisition (A or B) waits for Jake's choice of material.

## Simplified (2026-09-07, Jake: "too many buttons")

Jake bought Chocolate Chords on Bandcamp rather than use the flow — the
verdict on the sheet. What stands now:

- **One inline action** on the refused album row in the Downloads panel:
  **Get N matching tracks**, where N counts only recordings still missing
  from the library (the read-only comparison, with ownership, is fetched
  once per row when the panel shows it). The omitted track is named on the
  same line: "Not acquired: track 4 “Here We Go” — runtime mismatch (8:04
  found, 6:50 picked)". When nothing is missing the line says so and there
  is no button.
- **The comparison table sits under Details** (`NearEditionTable`, pure,
  never touches the queue), with a "Yours" column.
- **The alternate-edition action and its confirmation are gone** from the
  UI. The source-edition plan and the engine's verify-against-snapshot path
  remain underneath, tested, unreachable from any button.
- The Browse/Download card's refused verb reads "Exact edition not found ·
  Details" and opens the panel.
- Verification is unchanged underneath: each matching-track job is a normal
  song request through the one scheduler (identity, runtime pin,
  post-staging verification).

Ownership check before offering anything: the library now holds all 12
Chocolate Chords tracks from the Bandcamp purchase (auto-import,
`imported_11827…11838`; track 4 is the 8:04 version). On the dev instance the
refused fixture row read "All 11 matching tracks are already in your library.
Not acquired: track 4 “Here We Go” — runtime mismatch (8:04 found, 6:50
picked)." with no button; Details showed the table with 11 ticks
(`simple-1-row-owned.png`, `simple-2-details-table.png`). No live acquisition
was run for this album, and none will be.
