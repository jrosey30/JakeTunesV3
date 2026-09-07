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
