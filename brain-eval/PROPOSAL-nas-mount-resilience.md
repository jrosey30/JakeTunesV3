# PROPOSAL: NAS-mount resilience for the 2 AM pipeline (Jake-gated)

**Born 2026-09-27**, the night a power blip rebooted BOTH the NAS (22:24) and
homemini (23:23), leaving all three SMB shares unmounted on homemini until
03:08 — so brain-trainer FATAL'd at 02:00 and the whole nightly pipeline
(trainer → eval) only ran because the harness session mounted the shares by
hand and re-ran the trainer manually. Any reboot of homemini reproduces this:
mounts don't survive reboot and the keeper cannot recreate them.

## Observed failure modes (all tonight)
1. `nowhere-mount-keeper.sh` cannot remount after a NAS reboot: its
   `mkdir /Volumes/JakeShared` fallback gets Permission denied (unprivileged
   mkdir in /Volumes), so it loops failing every 30 s. (Its TCC-blind wedge
   probe is a separate, known gap.)
2. `open smb://…` does not complete from a non-Finder context.
3. brain-trainer has no mount pre-check/wait: it FATALs at 02:00:01 and the
   night is lost even if the mount comes back a minute later.

## What provably works headless on this box (used tonight, Aqua session present)
    osascript -e 'mount volume "smb://jakerosenbaum@192.168.1.223/JakeShared"'
Mounted from the keychain in <10 s, no dialog, from a launchd-spawned shell.

## Proposed (small, reversible, both Jake-gated)
1. **Keeper fallback** (~/bin/nowhere-mount-keeper.sh): when NOT-MOUNTED and
   `mount_smbfs` fails (or mkdir does), try the osascript mount-volume form
   before giving up. One `if` block; keeps all existing behavior first.
2. **Trainer mount-wait** (scripts/brain-trainer.mjs): at startup, if STATE_DIR
   is missing, poll for it every 60 s for up to 90 min (2:00→3:30) before the
   existing FATAL. Turns a lost night into a late night. (Alternative: a
   second launchd StartCalendarInterval at 04:30 as a retry — zero code.)

Neither touches the brain, the eval, or any state file. Without these, every
NAS reboot after ~22:00 silently costs a full trainer night + eval night
unless someone is awake to notice.

**2026-10-06 — trainer half SHIPPED (`ecba7d1`, wait up to an hour for the
NAS).** After nine consecutive FATAL nights (09-27..10-05 — the mount never
survived to 02:00), tonight the launchd run completed clean at 06:00–06:01Z
and absorbed the entire nine-night backlog same-night (11,033/11,033, backlog
0). The keeper osascript-fallback half remains open (the mount still has to
exist by 02:00 for a 1-hour wait to win on a truly dead mount night).

**2026-10-07 — THIRD COST CLASS FOUND: permanent listen-event loss.** The
nine-night outage didn't just cost trainer/eval nights — it silently dropped
every mobile listen/skip event (backend `/api/listen` bare-appends to the NAS
path, no local fallback; see listen.ts:27,55 + the 10-07 entry in
PROPOSAL-mobile-failure-skip-cascade). Plays/stars survived (local-first);
the listen log did not: 09-27..10-05 = zero events, unrecoverable. Adds a
backend item to this proposal: local-first append (or queue-and-replay) for
mobile-listening-log.jsonl. Jake-gated (backend code).
