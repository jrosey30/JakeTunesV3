# Activity Sync front end — audit and proposal (2026-09-06)

Document-only. Nothing here changes code; the proposal waits for Jake's
review. Companion to the "Activity Sync front end" section of
[jaketunes-6-plan.md](jaketunes-6-plan.md) (Jake, 2026-09-01: *"make it
sleeker, easier to use, easier to keep track of sync history… the core idea
of it wont change AT ALL, the look will"*).

## Scope law

- The engine, picker, brain, gates, catalog order and ledgers are proven and
  stay exactly as they are: `ipod-activity-engine.ts`, `workout-sync*.ts`,
  `activity-pool*.ts`, `ipod-catalog-order.ts`, `platform.ts` are not touched.
  This is a look-and-legibility project.
- `DeviceView.tsx` is on the Do-Not-Touch list (and was the vector of the
  702-row corruption). Every change set names what it touches there; the
  state machine, the sync handlers and `pathRewrites` handling are off limits.
- No device action without Jake present. The acceptance checks below that
  need the Mini are run with him, never alone.

## Inventory — the sync surfaces as they are

| # | Surface | Where | What it shows / does |
|---|---|---|---|
| 1 | Sidebar › **DEVICES** › the iPod (its name) | appears only while an iPod is mounted (detection debounced: three misses before it drops) | opens the device page |
| 2 | Sidebar › **ACTIVITY SYNC** › **iPod Pool** (count badge) | appears only while the pool has songs | the hand-built set; drop target for playlists, artists, albums, songs; right-click "Add to iPod Pool" |
| 3 | **Device page** header | `DeviceView.tsx` | iTunes silhouette: icon, name, Capacity, Format, Software Version, Songs |
| 4 | Device page › **Options** + Apply | `DeviceView.tsx` | Open JakeTunes when connected · Manually manage music · Sync only checked songs · Convert higher bit rate songs to 128/192/256 · Enable disk use. Only the convert setting reaches a sync; the others persist but drive nothing. Apply gates Sync ("Click Apply first"). |
| 5 | Device page › **status strip** | `DeviceView.tsx` | "✓ Sync complete — N songs synced to iPod at time" or "✗ Sync failed — message"; a saved-set notice with **Save as playlist**. The error auto-clears after 8 seconds. |
| 6 | Device page › **capacity bar** + actions | `DeviceView.tsx` | audio / other / free; buttons **On This iPod…**, **Sync History**, **Eject**, **Apply**, **Full Sync** (mirror the whole library, wipes first), **Activity Sync**, **Cancel** (stops after the file in flight) |
| 7 | **Activity sheet** | `ActivitySheet.tsx` | Activity (Bopping Around, Run, Ski, Lift, Bike, Hike, Walk, Other) · Intensity · How many (100 / 250 / 500 / 1,000, default 1,000) · Where · Steer the vibe; saved profiles; mode brain or pool, optional brain top-up for the pool |
| 8 | **Review sheet** | `SyncReviewSheet.tsx` | every proposed track; remove rows; add substitutions with a duplicate guard; **Confirm & Sync** / Cancel; nothing touches the iPod until confirm |
| 9 | **Sync History** sheet | `SyncHistorySheet.tsx` + `sync-history-ipc.ts` | reads `activity-sync-ledger.jsonl` and `ipod-roundtrip-ledger.jsonl`; rows "Activity Sync · N songs" (went on / came off / same set) and "Round Trip" (plays that came home), expandable. Shipped 2026-09-01 (f7939ec); the plan's "no UI reads it yet" is stale. |
| 10 | **On This iPod** modal | `IpodLibraryModal.tsx` | reads the card's iTunesDB; on-iPod vs local counts; drift detection; add iPod-only tracks to the library |
| 11 | **iPod Pool** page | `ActivityPoolView.tsx` | table of the pool; remove; **Sync this pool…** (opens the sheet in pool mode); Clear pool |
| 12 | **Toolbar LCD** | `App.tsx` sync-progress listener → `activity.setSync` → Toolbar / NowPlaying | the live line while syncing: "Verifying N/N audio files…", "Copying N/N to iPod — title", the seal line, or the failure line |
| 13 | Preferences › **Sync** | `SettingsModal.tsx` | two options both labelled "(retired)" — dead surface |
| 14 | Notices | `platform.ts` eject | "Eject failed: reason" (the reason was missing until 2026-08-25) |

Two sync flows share the engine: **Activity Sync** (sheet → build → review →
engine, wipes and rebuilds to exactly the set) and **Full Sync** (mirror the
library). The pool is a third way to arrive at the same engine.

## Actual states

What the engine emits (`host.sendProgress`), what the UI holds, and where
each is visible today.

| Engine phase | Emitted as | Shown where | Legible? |
|---|---|---|---|
| preflight (audio files verified, TSA) | `preflight` current/total | LCD: "Verifying N/N audio files…" | yes |
| wipe | `copy` 0/1 "Wiping the iPod for a clean rebuild…" | LCD | reads as a copy step |
| copy | `copy` N/target + title | LCD: "Copying N/N to iPod — title" | yes |
| verify (cold remount, up to 16 tries) | `verify` 1/16 … | LCD only if the listener maps it; the page shows nothing until the end | weak |
| catalog (iTunesDB write, conform, contiguous) | `db` 0/1 → 1/1 | LCD "Writing iTunesDB…" | weak |
| seal (second remount, count proof) | `verify` 1/1 | LCD | weak |
| cancelled | `cancelled` | page: "Sync cancelled (N files copied before stop)" | yes |
| result | `{ landed, target, shortfall, verifyAttempts, sealedOk, copied, copyErrors }` | page: done or error strip; LCD: "Synced N to the iPod — all verified on the card…" | yes, then the error vanishes after 8 s |

UI state machine (`SyncStatus`): idle · syncing(step) · done(copied, total,
time) · error(message). The page never shows the phase; the LCD does, but the
LCD is a one-line ticker at the top of the window, away from the button that
started the sync.

Device states the sidebar knows: mounted / not mounted (debounced), plus the
"card dropping writes" outcome that only the result can reveal. There is no
"last verified N at time" fact on the page between syncs; the ledger has it.

## Available controls and their guards

| Control | Guard / behaviour |
|---|---|
| Activity Sync | needs a mounted iPod ("No iPod detected — plug it in and try again."); opens the sheet; builds; opens the review; engine runs on Confirm |
| Sync this pool… | same path in pool mode; refuses a pool over the target ("Your pool has N songs — N over the target. Remove…") |
| Full Sync | confirmation with the convert setting spelled out; mirrors the whole library |
| Cancel | stops after the file in flight; the engine re-wipes and writes no catalog ("Sync cancelled by user") |
| Apply | required after any Options change before a sync ("Click Apply first to save your setting changes") |
| Eject | unmount with escalation (simulator shutdown → service kill → "unplug and replug"); failure shows the reason |
| On This iPod… / Sync History | read-only sheets |
| Save as playlist | after a sync, keeps the committed set |

## Failure messages — the catalogue (verbatim, by stage)

Every string the engine or the IPC can put in front of Jake today. The
engine's strings stay; the proposal maps them, it does not rewrite them.

**Before anything is wiped (nothing changed on the iPod)**
- No verified iPod mount detected · iPod is not mounted
- Activity TSA boarded N for a T-song set. Nothing was wiped.
- Activity TSA: N song(s) have no dest path. Nothing was wiped.
- Activity TSA: N dest path(s) would collide on the Mini. Nothing was wiped. Examples: …
- Library is empty — nothing to sync. · Could not build an activity set from this library. · Nothing to commit — empty track list. · api-failed · io-failed
- Your pool has N songs — N over the T target. Remove …

**Wipe**
- Activity wipe could not empty the iPod (N leftover files). Reseat the cable and …
- Activity wipe failed (reason). Nothing was copied.

**Copy**
- Only N of T songs confirmed on the card after copy. Not writing a catalog — that is how Songs became …
- Sync cancelled by user

**Verify (remount)**
- Activity Sync can only prove the card on macOS (cold remount). Nothing was sealed.
- Could not verify the iPod (remount failed after writing). The mount cache lies on this card — sync again without unplugging …
- Only N of T songs held across two remounts. Not writing a catalog (N means N). Sync again.
- N song(s) Mini 1.4.1 will not list. Not writing a catalog. …

**Catalog**
- The catalog could not be conformed to firmware id order (reason). Previous catalog is untouched. Sync again.
- The catalog was written but could not be laid down as one piece (reason). Previous catalog is untouched. Sync …
- The catalog file never made it onto the card — remount failed (reason). The Mini does not have T songs …
- The T-song catalog never committed to the card. Mac cache is not the Mini — that is how Songs became 450. Not …

**Result (page)**
- Only N of T songs actually stuck on the iPod after K tries — the card keeps dropping writes …
- Eject failed: reason

Observations: the messages are honest and specific (good — they were earned),
but they speak engine ("TSA boarded", "dest path", "mhit order", "N means N"),
they arrive with three different prefixes ("✗ Sync failed —", "Build failed
—", "iPod: N/T verified on device —"), and the page version disappears after
eight seconds while the LCD keeps a different sentence. The most important
fact for Jake — *was anything changed on the iPod?* — is present in most
strings but not in a fixed place.

## Proposal — the look

Keep the iTunes device page silhouette (header, capacity bar, the button
row). Re-arrange what sits between them into three zones and one voice.

```text
┌ iPod name ───────────────────────────────── Capacity · Format · Version ┐
│ On the iPod now: 1,000 songs · verified Sun 9:41 AM (last Activity Sync) │
├ SYNC ───────────────────────────────────────────────────────────────────┤
│ [ Activity Sync ▾ ]  size  100 · 250 · 500 · (1,000)   profile: Run     │
│ [ Sync the Pool (137) ]                       Full Sync… · Options ▸    │
│                                                                          │
│ while running:  Prepare ✓  Wipe ✓  Copy 412/1,000  Verify  Catalog  Seal│
│                 Copying — "Once in a Lifetime"           2:14   [Cancel] │
│ after:          Landed 1,000 of 1,000 — verified on the card, 9:41 AM    │
│          or:    Stopped at Verify — 998 of 1,000 held across two remounts│
│                 Nothing was written to the catalog; the previous one     │
│                 stands. Sync again without unplugging.        [Details]  │
├ RECENT SYNCS ───────────────────────────────────────────────────────────┤
│ Sun 9:41   Activity · 1,000   landed 1,000   +38 on / −38 off    ▸      │
│ Thu 7:12   Activity · 500     landed 500     same set            ▸      │
│ Wed 6:30   Round Trip         12 plays came home                 ▸      │
│                                                    See all (Sync History)│
├ capacity bar ────────────────────────────────────────────────────────────┤
│ [On This iPod…] [Sync History] [Eject]                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

1. **One primary action.** Activity Sync is the button; the size chips sit on
   the card so the most-changed choice is visible before the sheet opens
   (the sheet keeps them too). Sync the Pool appears only while the pool has
   songs, with its count. Full Sync becomes a quiet text button with its
   existing confirmation — it is the clean-slate tool, not the daily one.
2. **Phase strip.** Six named steps — Prepare · Wipe · Copy · Verify ·
   Catalog · Seal — driven by the engine's existing phases (`preflight`,
   `copy` with the wipe title, `copy`, `verify`, `db`, final `verify`), with
   counts, the current title, elapsed time, and Cancel in the strip. The
   LCD keeps its line (no change there).
3. **The result line, persistent.** "Landed N of T — verified on the card,
   time", from `result.landed` only, which is what About will say. A failure
   names the step it stopped at, says in one fixed sentence whether the iPod
   was changed ("Nothing was wiped." / "The previous catalog stands." / "The
   card holds N; no catalog was written."), and gives the next step. Stays
   until dismissed; Details shows the engine's full text verbatim.
4. **Recent syncs inline.** The last five ledger entries through the same
   reader the Sync History sheet uses, expandable to the on/off diff and
   plays that came home; See all opens the sheet. Between syncs the header
   line reads the last result ("On the iPod now: N · verified at …").
5. **Options behind a disclosure**, collapsed by default, Apply gate
   unchanged. The two retired Preferences › Sync options are removed (a
   decision for Jake below).
6. **Language.** One voice, calm, iPod-Classic-plain. A pure mapping table
   turns each engine string into (what happened · was the iPod changed ·
   what to do); the engine's text is never edited and always available.

### What each change set touches

| Change set | Files | Off limits |
|---|---|---|
| A. Pure models + tests | new `src/common/sync-progress-model.ts` (phase → step, percent, label), `src/common/sync-failure-copy.ts` (engine string → what happened / iPod changed? / next step) | — |
| B. Progress plumbing | `App.tsx` sync-progress listener: pass every phase through (verify/db/seal today collapse) into the activity store | engine, IPC |
| C. Device page render | `DeviceView.tsx` render section only: zones, strip, result line, recent syncs, options disclosure; the 8-second auto-clear removed | state machine, handlers, `pathRewrites`, everything in `src/main` |
| D. History | `SyncHistorySheet.tsx`: target/landed badge and result per entry | ledger writers |
| E. Style | `device.css` (or its current home) | — |

## Acceptance checks (agreed before coding)

| # | Check | How it is verified |
|---|---|---|
| A1 | Engine untouched | `git diff --stat` for the change sets shows nothing under `src/main/ipod-activity-engine.ts`, `workout-sync*`, `activity-pool*`, `ipod-catalog-order.ts`, `platform.ts`; the semantic gate and catalog tests unchanged and green |
| A2 | Progress fidelity | a synthetic event stream using the engine's real phase names (preflight → copy-wipe → copy → verify → db → verify → result) replays through the model: steps light in order, counts and percent correct; a `cancelled` event lands on the cancelled state. Unit test. |
| A3 | Result equals About | the result line renders from `landed` only; synthetic results with `landed < target` or `sealedOk: false` never render as done. Unit test. |
| A4 | Failures stay and map | no auto-clear timer remains; every `error:` literal in the engine and IPC has a mapping (test walks the source for the literals) or falls to the generic mapping with the raw text preserved and shown in Details |
| A5 | History parity | the inline recent list equals the first five entries of the sheet's reader; expand shows the same on/off diff; Round Trip rows present |
| A6 | Silhouette | before/after captures at the normal width and at 700 px; header, capacity bar and button row keep their positions; no new controls beyond those listed |
| A7 | On the Mini, with Jake | one Activity Sync at 100: the strip walks the phases, the result line matches About on the device; one Cancel mid-copy: the cancelled state and the re-wipe line; one Eject: success, and the reason line on a forced failure (simulator booted) |
| A8 | Options | Apply gate unchanged; the convert setting still reaches the sync (the confirmation text names it) |

## Decisions for Jake

1. Full Sync demoted to a text button with its confirmation. Yes / keep as is.
2. Recent syncs inline: five entries, or three.
3. Options collapsed by default behind a disclosure. Yes / no.
4. Remove the two retired Preferences › Sync options. Yes / label only.
5. Failure voice: the three-part shape (what happened · was the iPod changed ·
   next step) with Details holding the engine text. Approve, or send a
   sample sentence you want it to sound like.
6. A small state dot on the sidebar device row (mounted / syncing /
   verified). Yes / no — not recommended unless you want it.

Nothing moves until these are answered. Record Shop stays under everyday-use
review with the legacy Download page in place; the real Add by link test
waits on the URL; the Mobile caption remains separate.
