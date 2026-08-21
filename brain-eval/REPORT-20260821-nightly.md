# Nightly brain exercise — 2026-08-21 (homemini)

**Outcome: (c) measurement BLOCKED by infrastructure — the NAS's SMB file
service is down. No eval ran, no score_log entry, brain untouched.** The
outage was diagnosed to its exact NAS-side cause (SMBService package stopped
on ds225), but restarting it needs a credential this box cannot reach
headlessly. One action for Jake unblocks everything (steps below).

## What happened tonight
- **02:00 EDT — brain-trainer FATAL**: `library.json or embeddings.bin
  missing under /Volumes/JakeShared/JakeTunesState — is the NAS mounted?`
  No enrichment ran tonight (it resumes automatically tomorrow; nothing lost,
  just deferred).
- `/Volumes/JakeShared` is not mounted; **no SMB share is mounted at all**
  (Movies / TV Shows home-dir mounts also down). Local pull timestamps show
  the mount was still alive at **00:35–00:45 EDT** (embeddings.bin pulled
  00:35, mixes-cache written 00:45), so the drop happened between ~00:45
  and 02:00.

## Diagnosis (NAS side, via key-auth SSH — read-only)
- ds225 is UP: pings on LAN + tailnet, **uptime 28 days** (no reboot),
  load ~1.0, /volume1 healthy (82%, 660G free).
- `synopkg status SMBService` → **`"status":"stop"`, status_code 263**
  ("failed to get unit status"). The SMB service package itself died.
- Port 445 still accepts TCP (a residual listener), which is why the client
  sees `mount_smbfs: server rejected the connection: Authentication error`
  (exit 77) instead of connection-refused — a red herring; the credential is
  not the problem, the service is.
- Why it stopped is unreadable without root (`/var/log/messages` denied).

## Restoration attempts (all failed; stopped deliberately)
1. `open smb://…` from the live GUI session — never mounted (service down).
2. `mount_smbfs` direct — exit 77, "Authentication error" (service down).
3. `synopkg start SMBService` over SSH — needs root; **no passwordless
   sudo** on the NAS, root key auth denied.
4. `sudo -S` with the keychain SMB credential — **rejected**.
5. One DSM web-API login (`SYNO.API.Auth`) with the same credential —
   **error 400** (bad account/password).
6. **Stopped at 2 failed auth attempts** to stay clear of Synology
   auto-block. No further guessing.

### Credential finding (the actual wall — record for future runs)
The login keychain holds **two** SMB items for `jakerosenbaum@192.168.1.223`:
- **Server-level item** (path NULL, modified 2026-05-14) — the only one
  extractable headlessly. Its password is **STALE**: rejected by both sudo
  and DSM login.
- **Share item** (path `JakeShared`, modified **2026-07-24** — i.e. re-saved,
  likely after a password change) — almost certainly holds the CURRENT
  password (it's what kept mount_smbfs working until tonight), but it is
  **ACL-locked**: reading it pops a SecurityAgent "allow" dialog on the
  console that cannot be answered headlessly. (The stuck query was killed;
  the dialog was dismissed — nothing left on screen.)

Net: **there is no headless path from homemini to restart the NAS's SMB
service.** This is a hard dependency on Jake.

## Impact assessment — the phone is FINE (the local-first design worked)
- Backend (pid since 08-20 08:41) reads `library.json` + `embeddings.bin`
  **local-first** from `~/JakeTunesState/` — current to 00:34/00:35 tonight.
  Browse, playback, mixes, embeddings-RAG all healthy.
- `mood-index.bin` has **no local copy** (mini-nas-pull doesn't carry it);
  mood/vibe queries are serving from the backend's in-RAM cache loaded
  before the drop. **They die if the backend restarts before the NAS is
  back** — do not restart the backend.
- Mobile play/skip logging writes to the NAS state dir; playLog.ts has
  explicit fail-soft handling (`stateDirUsable`/`classifyLoad`), but events
  logged during the outage should be spot-checked once the mount returns.
- Audio fallback (`MUSIC_ROOT_FALLBACK` → NAS) is dead, but primary local
  music root serves everything already pulled.
- Silver lining: with SMB down, the desktop's `autoBackupStateToNas` (the
  identified mood-index clobber writer, see 08-20 report) **cannot fire**.
  The 08-20 repair state on the NAS is frozen untouched.
- The mount-keeper is stuck in a futile 30s loop: `mkdir /Volumes/JakeShared
  → Permission denied` (macOS forbids user mkdir in /Volumes). Harmless now,
  but see proposal 2 — it also means the keeper **cannot** remount JakeShared
  even after SMB returns.

## What Jake needs to do (the one unblock)
1. **Restart SMB on the NAS** — DSM web UI (Package Center → SMB Service →
   Start, or Control Panel → File Services), or via SSH:
   `sudo /usr/syno/bin/synopkg start SMBService`
   Worth a glance at DSM's log center for *why* it stopped (28-day uptime,
   so not a reboot).
2. **Remount JakeShared on homemini** — Finder → `open
   smb://jakerosenbaum@192.168.1.223/JakeShared` (the keeper can't create
   the /Volumes mountpoint itself; one Finder mount fixes it and the keeper
   holds it from there). Movies/TV Shows will self-heal via the keeper.
3. Optional: next time at homemini's screen, click "Always Allow" on a
   `security find-internet-password …JakeShared` prompt if you want nightly
   automation to be able to self-serve the current credential (or drop a
   NOPASSWD sudoers line for `synopkg start SMBService` on the NAS —
   either one turns tonight's hard wall into a self-heal).

## Gated proposals (not applied — infra, and untestable while SMB is down)
1. **mini-nas-pull: also pull `mood-index.bin`** (one more rsync stanza,
   identical to the embeddings.bin one). Closes the only remaining
   NAS-outage hole in the phone brain (mood queries after a backend
   restart). Read-only NAS→local, can never clobber the canonical. ~4 lines,
   but the script is git-tracked in JakeTunesMobile (auto-deploys) — Jake's
   call, and it should land together with the 08-20 clobber fix thinking.
2. **mount-keeper: mount JakeShared via Finder, not mount_smbfs** — the
   `mkdir -p /Volumes/JakeShared` in `~/bin/nowhere-mount-keeper.sh` is
   permission-denied whenever macOS has removed the mountpoint, so the
   keeper can only *keep* a Finder-created mount, never re-create one.
   Fix: for the /Volumes target use
   `osascript -e 'mount volume "smb://jakerosenbaum@192.168.1.223/JakeShared"'`
   (Finder-mediated: creates the mountpoint properly and reads the current
   keychain item). Untestable tonight (service down), so proposed not
   applied.

## Standing items (carried, untouched tonight)
- Mood-index clobber watch (08-20 recurrence): **cannot check tonight**;
  first check after the mount returns should re-fingerprint ret-007/008/
  011/012 before trusting any mood measurement. The escalated
  autoBackupStateToNas proposal remains THE root-cause ask.
- P1 router-aware eval, P2 stripped-artist guard (S2), P3 decade-token,
  taste-weights refresh: all still gated for Jake, unchanged.

## Ledger
- Brain files: **untouched** (no NAS access; local copies untouched too).
- NAS state: untouched (read-only SSH diagnostics only).
- Changed on homemini tonight: none (temp dir `~/nas-tmp-jakeshared` created
  for a mount probe — empty, removed after).
- Auth attempts against ds225: 2 (sudo, DSM API) — both with the stale
  keychain credential, then stopped.
