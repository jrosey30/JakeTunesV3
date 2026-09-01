# Post-Mortem — The 819 Saga: iPod Mini Binary-Search ID Order (acute phase Aug 28 – Sep 1, 2026)

**Severity:** P0 (acute: device showed wrong library for four days, ~25 theories
burned — but the mild form of the disease produced unexplained shortfalls for
months before that; see Archaeology. This was a months-long war that ended Sep 1.)
**Author:** Claude (the agent that introduced the bug and eventually found it)
**Status:** CLOSED — `conformCatalogIdOrder` shipped (2fc09ad); locked by
semantic gate + synthetic-catalog unit tests. On-device gauntlet complete
2026-09-01: engine-path syncs at **100, 250, 500, and 1000 all showed the
exact count in About**. First time in the project's history a 500 or 1000
sync ever came back right.

---

## tl;dr

Activity Sync wrote iTunesDB catalogs the Mini 1.4.1 firmware could not fully
read: About showed 897, 862, 908, 462-of-500, then a deterministic 819-of-1000
across every content-level fix we tried. The root cause was a single ordering
invariant no document states but every working sync in history had kept by
accident: **the firmware locates songs by binary search over the mhit array,
keyed on the 32-bit track id at mhit+0x10 — records must be stored in ascending
id order.** 2004 iTunes appended records in id-mint order, so the invariant held
for free. JakeTunes v1's full sync wrote insertion order — same accident, same
result. On Aug 28, commit d6672fe made Activity Sync sort mhit records by artist
*after* ids were minted (so the Artists menu would read A-Z on a firmware with
no type-52 sort tables). That produced the first catalogs in the format's
twenty-year history where file order ≠ id order. Binary search over a 94%-sorted
array still finds ~82% of targets — and deterministically loses the records
trapped in inverted subtrees. Hence: always close, never right, always the same
victims, immune to every fix that changed content instead of order.

The fix re-mints ids ascending in final record order after the artist sort and
remaps every playlist mhip reference — keeping both the A-Z menu and the
firmware's search contract. It runs on every sync, at every size.

---

## The invariant (write this on the wall)

> **An iPod mini 1.4.1 iTunesDB is only valid if mhit records ascend by their
> 32-bit id in file order.** Sorting, inserting, or splicing mhit records is
> only legal if ids are re-minted (and all mhip refs remapped) afterward.

No spec we found states this. It was reverse-engineered from device behavior.
The enforcement now lives in code: `conformCatalogIdOrder`
(`src/main/ipod-catalog-order.ts`) runs after `orderForIpodCatalog` and before
the contiguity/md5 proof in `ipod-activity-engine.ts`, and the semantic gate
(`ipod-sync-semantic-gate.test.ts`) locks that ordering.

---

## Why it took ~25 theories

Every symptom was consistent with a dozen other explanations:

- The count was **deterministic and reproducible** (908 twice in a row), which
  pointed away from flaky hardware — but the *number changed* across syncs
  (897/862/908/819), which pointed away from a fixed data defect. In truth both
  were faces of one cause: the count is a pure function of record order, and
  each sync produced a slightly different order.
- Every **content-level surgery** (dbids, strings, codec fields, moov atoms,
  fragmentation, FAT mirrors, contiguous rewrites) changed bytes the firmware
  reads *after* it has already found a record. Records it never finds can't be
  fixed by improving their contents. All those theories died at About showing
  the same number — which read as "fake changes" but was really "wrong layer."
- The card, the filesystem, and the reader tooling were each convicted and
  exonerated in turn. The forensic tools (raw FAT walks, snapshot diffs, mirror
  compares) were not wasted: they *eliminated* the entire storage layer, which
  is what finally forced attention onto the catalog structure itself.

## What actually cracked it

1. **Reorder experiments as an oracle.** Rewriting the *same 1000 records* in
   four different orders and booting each produced: engine order → 819,
   reversed → 1, plain-uppercase sort → 415, boarding order → 7. Four numbers,
   one variable (order). That proved the firmware discards records as a
   function of ordering — mechanism first, model later.
2. **Model fitting against all four points at once.** Comparator models
   (cursor running-max, pairwise, grouping parsers over artist/album/title
   keys) all failed — best fits were 51–56 vs 819. The winning move was Jake's
   redirect: *"find out exactly how syncing worked in 2004… it worked then and
   in JakeTunes v1, so either you are overthinking this or Activity Sync was
   not built right from the very first line."* Asking "what did every working
   sync have in common?" led straight to id order, and the binary-search model
   predicted **824 / 412 / 1 / 7** against measured **819 / 415 / 1 / 7** with
   zero tuning. (The ±5 residual suggests the firmware's real lookup differs
   slightly from a textbook bisect, but with fully-sorted ids every variant
   finds every record, so the fix is exact even where the model is ~99.4%.)
3. **One-boot falsifiable confirmation.** Renumbering the ids on the card
   (surgery only — same records, same order, ids 10000..10999 ascending, 2658
   mhip refs remapped) took About from 819 to **1000**.

## Archaeology — the disease predates Activity Sync

After the fix, Jake asked whether the old full-sync era's chronic "always ~8
songs off" was the same thing. Running the binary-search model on surviving
catalogs from **before** the Aug 28 artist sort (backups, Aug 15–16):

| Catalog (card backup)        | Tracks | id-inversions | Model predicts |
|------------------------------|--------|---------------|----------------|
| iTunesDB.frag9 (Aug 15)      | 500    | 8             | 464            |
| pre-semantic-fix (Aug 15)    | 500    | 8             | 449            |
| iTunesDB.prefrag (Aug 16)    | 500    | 8             | 462            |

Every pre-artist-sort catalog carries exactly **8 id-inversions** — the old
writer emitted near-insertion order, but re-downloaded/replaced tracks kept
their position while carrying newer ids. So the full-sync era's stubborn
small shortfalls were **the same disease in mild form**, stacked on top of the
two genuine labeling bugs that were separately found and fixed (July's U+2019
strings, August's ALAC-as-MP3 markers). One old catalog predicts exactly 462
— a number the device actually displayed. The conform pass retroactively
eliminates the entire class: zero inversions by construction, at any size.

## Timeline

- **Aug 28** — d6672fe ships the artist-sorted catalog (a real feature: A-Z
  Artists menu). Undercounts begin the same day and are initially attributed to
  content defects, per the two prior *count* incidents that genuinely were
  (U+2019 strings in July; ALAC-as-MP3 codec markers in August).
- **Aug 29–31** — theory burn-down: card hardware, FSKit, dialect/version
  fields, sort tables, dbids, moov order, fragmentation, FAT mirrors, boundary
  straddles, per-field ranges… all exonerated. Forensic tooling built
  (fatwalk 1–5). Sync ledger built so picks are auditable. Firmware proven to
  read iTunesDB fresh every boot (0-song wipe test).
- **Aug 31 (night)** — reorder experiments produce the four-point oracle.
  Comparator fitting fails. Jake issues the 2004 directive.
- **Sep 1** — binary-search-by-id model fits all four points; card surgery
  boots 1000/1000; `conformCatalogIdOrder` shipped, gated, tested; on-device
  gauntlet begins (100 ✓, 250 ✓ as of this writing).

## Lessons

1. **When a fix changes nothing, you are on the wrong layer.** Five surgeries
   with byte-identical outcomes (819, five times) was the loudest possible
   signal that content was innocent. Escalate *layers* (content → structure →
   order), not effort within a layer.
2. **"It worked before" is a dataset, not an anecdote.** The decisive question
   was not "what is wrong now" but "what invariant did every working writer in
   twenty years keep without knowing it?" When a consumer is undocumented,
   diff the *producers* that satisfied it.
3. **Vary one structural variable and let the device vote.** The four-point
   oracle cost four boots and constrained the search space more than three days
   of forensics. Falsifiable both-ways predictions (a number, written down
   before boot) are the only currency after credibility is spent.
4. **Order is data.** A record array with a hidden ordering contract must have
   that contract enforced *in code where the order is changed* — not in the
   writer (core/ is Do-Not-Touch), not in prose. The conform pass lives at the
   exact seam that broke the invariant, and the semantic gate pins it there.
5. **Feature commits that touch serialization order deserve suspicion out of
   proportion to their diff size.** d6672fe was small, correct-looking, and
   user-requested — and it violated an invariant nobody knew existed. The tell
   was temporal: undercounts started the same day. First question for any
   "device shows fewer than we wrote" bug from now on: *what changed about
   record order?*

## Artifacts

- Fix: `src/main/ipod-catalog-order.ts` (`conformCatalogIdOrder`), wired in
  `src/main/ipod-activity-engine.ts` (commit 2fc09ad).
- Locks: `ipod-sync-semantic-gate.test.ts` (ordering: sort → conform → proof),
  `ipod-catalog-order.test.ts` (synthetic-catalog byte surgery, unknown-ref
  refusal, non-DB refusal).
- Records: `activity-sync-ledger.jsonl` in app state (picks + result per sync).
- Prior related incidents: `2026-04-26-ipod-songcount-counter.md` (a *counter*
  bug, not a firmware discard), July's U+2019 fix, August's codec-marker fix —
  both genuinely content-layer, which is why content was the first suspect here.
