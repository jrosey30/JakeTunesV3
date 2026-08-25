# Nightly brain exercise — 2026-08-25

**Outcome: no experiment, no eval — the night went to a data-integrity emergency.
The live brain lost 1,280 vectors to a torn trainer write at 2:00 AM; it was
restored byte-identically from the trainer's own backup, the root cause was
found and fixed (mount-keeper force-remount churn driven by a TCC-blind probe),
and the reader hole that let a short read become a smaller brain is now a fatal
error. Brain content ends the night exactly where it should be. No score can
move tonight; nothing was applied that needs one.**

## What happened at 2:00 AM (from the trainer log + file forensics)

1. `com.nowhere.mountkeeper` has been **force-unmounting a healthy
   /Volumes/JakeShared every 30 seconds since 2026-08-23** — its wedge probe
   (`ls` with 6s timeout, added after the black-commercials outage) *always*
   fails in its launchd context: TCC denies network-volume reads to that
   context outright (`Operation not permitted`, instant — proven with a
   one-shot launchd probe agent at 03:17). The script conflated "probe
   errored" with "probe hung," so it "repaired" a healthy mount ~2,880
   times/day. Zero "recovered" lines in its entire 21k-line log — the probe
   never once passed. This also retroactively explains the 08-24 trainer
   FATAL ETIMEDOUT (the open watch item): the trainer's I/O lost the timing
   lottery against a 4-second unmount window. 08-22/08-23 runs just got lucky.
2. Tonight the trainer lost the lottery twice, and the second loss was silent
   and dangerous: its startup `readFileSync` of embeddings.bin returned a
   **short buffer — 8,510 of 9,790 records, no error** — during a churn
   window. `readEmb` tolerates truncation (loop bounded by buffer length), so
   the trainer proceeded with an amputated in-memory map and its tempo
   catch-up **wrote the 8,510-vector brain over the live file**.
3. Pure luck stopped it from being accepted: the verify re-read hit the next
   churn window and died on EBADF, and the automatic `.bak` restore died on
   the same dead mount — leaving the amputated file live but *flagged* by a
   FATAL in the log. Had the verify read succeeded (it re-reads the same
   short map size as its baseline), the shrunken brain would have passed.

## Repair (applied — reversible, verified)

- **embeddings.bin restored from embeddings.bin.bak** (the trainer's own
  pre-write byte-copy, made 02:00 tonight): parsed clean — 9,790 vectors,
  dim 1536, 0 NaN / 0 all-zero / 0 duplicate ids; md5
  `9e08aba852d7c3eeec7f2584d11abbaf` verified identical local↔NAS on two
  independent reads, staged to NAS tmp, md5 re-verified, atomic rename over
  the live file, post-swap md5 + header round-trip verified. 9,790 matches
  the 08-24 eval's `vectors: 9790` in score_log.jsonl exactly.
- The amputated file is preserved for forensics as
  `embeddings.bin.short-read-20260825` (NAS) and `~/brain-repair-20260825/`
  (local, with the verified `.bak` copy). **Undo** (not that you'd want to):
  the pre-restore live file is that short-read artifact, md5
  `8683a772b7b94eb3430b0868e6355234`.
- **mood-index.bin was untouched tonight** (trainer died before reaching it;
  mtime still 08-24 03:20 = the REPORT-20260824 repaired state). No day-sync
  write occurred 08-24, so no clobber event to re-repair — first clean night
  since the escalation. (Clobber count stays 5.)

## Root-cause fixes (applied — both verified live)

1. **Mount-keeper churn stopped** (`~/bin/nowhere-mount-keeper.sh`, backup at
   `.pre-20260825`): a probe failure in **< 5s is now treated as an error, not
   a wedge** — only a probe that actually *hangs* past its timeout triggers
   force-remount. Mount-if-unmounted and the Movies/TVShows ensure paths are
   unchanged. Verified: 0 mount drops in 120s post-patch (vs one every 30s
   for two days), one explanatory log line, then silence. NOTE: wedge
   *detection* is now blind (it always was — it never worked); the honest fix
   is granting that context network-volume access, or probing via the nowhere
   engine's own health endpoint — Jake's call.
2. **Trainer reader hardened** (V3 commit `5d3ed34`,
   feat/listen-to-the-list): `readEmb` now **throws if the bytes don't cover
   the header's vector count**, so a short read is a loud startup FATAL
   instead of a smaller brain. Tested against the real backup (9,790 parse —
   pass) and a byte-exact simulation of tonight's short read (throws with
   `header says 9790, bytes cover only 8510`). Jake's in-flight
   redescribe-program WIP on the same file was stashed around the commit and
   restored untouched.

## Gated proposal (new)

- **PROPOSAL-truncated-read-guard.md** — the same silent-truncation tolerance
  exists in the desktop's `parseEmbeddingsBlob` (src/main/ai/embeddings.ts,
  feeds the caches that `autoBackupStateToNas` replays — i.e., desktop-side
  short reads can do the same amputation via day sync) and in the mobile
  backend's `rag.ts` (read-only, lower stakes). Both are now marked with
  ⚠️ TWIN comments; behavioral fixes need caller analysis → Jake's call.

## Why no eval ran

The harness reads the brain over this same mount; the mount was being yanked
every 30s until 03:19, the trainer hadn't completed the night, and there was
no candidate change to measure (all open levers remain gated: mood-clobber
fix ESCALATED, taste-weights refresh, P2 stripped-artist S2, P3 decade-token,
router-aware eval). Measuring nothing against an unstable substrate proves
nothing; per policy, nothing unmeasured was applied to brain *content* —
the only brain write tonight is a byte-identical restore of proven-good state.

## Watch items for 08-26

- Trainer completed a clean catch-up run after the repair (see log tail,
  08-25 ~03:4x EDT) — confirm the 08-26 02:00 launchd run is also clean; any
  new `truncated read` FATAL means the mount is flapping again from a *new*
  cause (the churn fix should have removed the old one).
- Keeper log should stay quiet. If WEDGED lines return, the probe hung for
  real — that's a genuine NAS wedge, handle per the 08-21 playbook.
- Mood-index: next desktop import day is still the live test of clobber
  event #6 — pre-check orphans/dups before any paid measurement (healthy
  fingerprint ≈ 0 orphans / ≤2 benign dup groups).
