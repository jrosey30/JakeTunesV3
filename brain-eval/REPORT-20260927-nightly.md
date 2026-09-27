# Nightly brain exercise — 2026-09-27 (homemini)

## THE NIGHT'S HEADLINE: NAS reboot → mount wall → stale library.json REPLAY caught and repaired

Not a brain night — an infrastructure night. Full chain, in order:

1. **NAS rebooted 22:24 EDT (09-26), and homemini itself rebooted 23:23** (kern.boottime;
   likely one power blip took both). All three SMB shares (JakeShared, Movies, TV Shows)
   were gone after the reboots and never came back: the mount-keeper's remount path loops on
   `mkdir /Volumes/JakeShared: Permission denied` (unprivileged mkdir in /Volumes — the
   documented keeper gap), and `open smb://` doesn't complete from this context.
2. **brain-trainer FATAL 02:00** ("library.json or embeddings.bin missing — is the NAS
   mounted?"). No retry exists; the night's enrichment simply didn't run.
3. **03:08 — mounted all three shares** via `osascript -e 'mount volume "smb://…"'`
   (keychain, Aqua session present). This WORKS headless-at-3am on this box — keeper
   fallback proposal filed (PROPOSAL-nas-mount-resilience.md).
4. **03:09 — sixty seconds after the mount returned, a STALE library.json landed on the
   NAS**: live file went 10,988 tracks / 41 playlists (01:15 EDT save, Jake was importing
   until ~01:14) → **10,263 tracks / 36 playlists with max dateAdded 2026-09-04** — a
   three-week-old snapshot. Two Synology-recycle events 16 s apart (library_020928/020944)
   show a fresh save landing first and the stale one stomping it. This is the
   **autoBackupStateToNas replay writer** (PROPOSAL-mood-import-clobber, fixes 4/5,
   "durability is luck") — first time observed hitting **library.json** instead of the
   mood-index. Diagnosis before repair: diffed stale vs 01:15 recycle copy — the 743
   missing ids ALL have dateAdded ≥ 09-04, the 18 stale-only ids are all tracks Jake
   deleted since 09-04, spot staples (Who Shot Ya id 10248, Eruption id 9080) present in
   both. NOT a deletion, NOT data loss — a stale mirror replay. Desktop local copy is the
   source of truth and was never touched.
5. **03:10 — ran the trainer manually** (launchd env verbatim, exit 0) — unknowingly on the
   stale library: +12 enriched, 4 tempo re-embeds, mood 10,972. Damage from the stale view:
   **one** new orphan vector (id 12071) + it never saw last evening's ~34 imports
   (backlog 35, self-heals tomorrow). Both prune guards held — mood prune correctly
   REFUSED ("709 orphaned = a short library read looks exactly like this").
6. **03:30 — REPAIRED the mirror** per the trust-the-NEWEST-save doctrine: restored the
   01:15 10,988-track save (pulled from NAS #recycle, content-verified) to
   `/Volumes/JakeShared/JakeTunesState/library.json` via temp + atomic rename, verified
   re-parse (10,988 / 41), and fixed homemini's local fallback `~/JakeTunesState/library.json`
   (mini-nas-pull had already propagated the stale copy at 03:25).
   **Evidence + revert path: `~/library-incident-20260927/`** — the good save, the stale
   file as it was live, and missing-tracks.txt (743 titles). Revert = copy the stale file
   back (don't).

## Situation at measurement (03:40 ET)
- Trainer manual run exit 0 (see above). Library restored to 10,988 (+34 vs 09-26; import
  night). Enrichment 10,953/10,988, **backlog 35** = the imports the trainer never saw —
  expect ~0 tomorrow night.
- **NAS brain shas ×3-verified stable**: embeddings.bin c7aebfe9fc3d (68,279,700 B, 03:16),
  mood-index.bin e69f496f5e68 (67,455,868 B, 03:17). Both CHANGED from 09-26 (trainer
  wrote) → A/A zero-tolerance rule does not bind; churn expected.
- Frozen snapshot /tmp/brain-snap-20260927 (shas verified after copy).

## Clobber pre-check (import night ⇒ mandatory)
precheck_20260927.py on the frozen snapshot vs the RESTORED library: mood 10,972 vec /
**19 orphans** (the same benign 18 a 13th night + id 12071 from tonight's stale-view
trainer write) / **0 dup groups** — nothing like the ~125/60 replay signature. Embeddings
11,106 vec / 153 orphans (152 steady + 12071). **23rd consecutive day with no BINARY
clobber — but library.json WAS clobbered tonight**, so the replay writer struck; it just
hit a different file than the one this check watches. Clobber tally by file family now
matters: the writer replays whatever state file it holds stale.

## Measurements (keys probed 1-token first: OpenAI 200, Anthropic 200)

| metric | 09-26 | tonight | read |
|---|---|---|---|
| run_eval retrieval | 0.733 | **0.736** | back at band center; per-probe all documented shapes (ret-014 0.13, ret-015 0.47, ret-011 0.44, ret-012 0.35) |
| grounding | 1.000 | **1.000** (10/10 incl. 4 traps) | clean |
| overall | 0.867 | **0.868** | in-band |
| router-truth | 0.819 | **0.832** | healthy-high; +34 real imports entered the pools |
| orphan component | +0.016 | **+0.003** (S0 0.832 → S1 0.835) | NINETEENTH point, smallest ever — orphan slot occupancy collapsed 9 → 1 (ret-008 only) because the restored +34 imports displaced orphans from top-k; composition churn, not a fix |
| S1 / S2 | 0.835 / 0.835 | **0.835 / 0.835** | S1==S2, zero residual (0.832+0.003=0.835), prune still strictly non-harmful (worst per-probe +0.00) |

## Standing guards
- **Taste-W premise guard (content-change night): PASS** — all three copies byte-identical
  to the v4 line (V3 tasteScore.ts, Mobile src, Mobile dist).
- **Skip bursts: 0 new** mobile skips since the 09-26 count (mobile-listening-log checked
  through tonight). Cascade proposal unchanged at 14 sessions / 2,237.

## Experiment verdict — outcome (b) for the brain, plus one out-of-band repair
Nothing beat baseline; **nothing applied to the brain** (embeddings c7aebfe9fc3d, mood
e69f496f5e68 — re-verify after measurement below). The one write of the night was the
**library.json mirror restore** (newest-save doctrine; backed up; revert path above) —
a repair of tonight's replay damage, not an experiment.

Open levers, all still Jake-gated, tonight's reprioritization:
1. **PROPOSAL-mood-import-clobber fixes 4/5 — now the TOP ask, upgraded by tonight**: the
   replay writer stomped library.json itself (the file every consumer reads), not just the
   mood-index. Tonight was caught at 3 AM by luck of scheduling; a daytime replay would
   feed the phone a three-week-old library until someone noticed.
2. **NEW: PROPOSAL-nas-mount-resilience** — keeper osascript fallback + trainer mount-wait/
   retry (tonight: FATAL at 02:00, mount fixable at 03:08 by one command).
3. Trainer-side mood orphan prune — nineteen-point-proven, +0.003–0.016 depending on
   composition, never harmful.
4. PROPOSAL-tempo-catchup-queue-order — evidence complete (19 pts).
5. Taste-drift monthly re-run due ~10-13.

## Watch for 09-28
- **Backlog 35 → ~0** (trainer reads the restored library; if backlog persists, the mirror
  got re-stomped — check library.json max dateAdded FIRST).
- **Verify the laptop's daytime sync pushes a FRESH library** (mtime advancing, count ≥
  10,988). If the stale replay recurs on reconnect, that's the writer's reconnect path.
- Orphan component may re-inflate toward +0.016 as import churn settles — expected, not news.
- Snapshot hygiene: /tmp was wiped by the 23:23 homemini reboot (0924–0926 snaps gone);
  only /tmp/brain-snap-20260927 exists. Nothing to prune.
