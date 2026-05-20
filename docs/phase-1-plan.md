# Phase 1 Plan — Get Both Macs Pointed at the NAS-Hosted Library

> **Status:** plan written 2026-05-12, revised after Plex query
> confirmed the NAS already hosts the music. Pre-execution. No live
> changes made yet.
>
> **Goal:** both laptop and homemini's JakeTunes read from the same
> NAS-hosted `JakeTunesLibrary/` tree. After Phase 1 the file-transport
> problem is solved. Library.json sync between machines is still
> per-device until Phase 2 (the event-driven API).

---

## Updated current state (2026-05-12, after Plex query)

| Path | What it is |
|---|---|
| `/volume1/Music/JakeTunesLibrary` | **The canonical files, on the NAS.** Plex section #2 scans this. iPod-style folder layout (`iPod_Control/Music/Fnn/`). |
| `/Volumes/Music/JakeTunesLibrary` | **NAS mount on the Mac via SMB.** Same files as above, accessed over the network. |
| `~/Music2/JakeTunesLibrary` | **What JakeTunes currently reads.** User reports "all three point to the same file tree once mounted." |

The user's earlier `mount | grep Music2` returned empty, so `~/Music2`
is NOT currently an SMB mount. Two possibilities for why all three
paths read the same content:

- **(P1) `~/Music2/JakeTunesLibrary` is a symlink** to
  `/Volumes/Music/JakeTunesLibrary` (or has equivalent automount).
  Files are NOT duplicated; everything resolves to the NAS.
- **(P2) `~/Music2/JakeTunesLibrary` is a local copy** that has the
  same content as the NAS (manual rsync? cloud sync?), 68GB
  duplicated.

We disambiguate with one command (see Step 0 below). The path forward
branches from there.

---

## Step 0: Disambiguate local-vs-mount

Run on the laptop:

```bash
# Check if ~/Music2 is a symlink
ls -la ~/ | grep Music2

# Check if ~/Music2 or its contents point at the NAS
readlink ~/Music2 2>/dev/null
readlink ~/Music2/JakeTunesLibrary 2>/dev/null

# Compare inodes — if same device + inode, they're the same physical
# file. If different devices, they're separate copies.
stat -f '%d %i %z' ~/Music2/JakeTunesLibrary/iPod_Control/Music/F00 2>/dev/null
stat -f '%d %i %z' /Volumes/Music/JakeTunesLibrary/iPod_Control/Music/F00 2>/dev/null

# Sizes
du -sh ~/Music2/JakeTunesLibrary/ /Volumes/Music/JakeTunesLibrary/ 2>/dev/null
```

**If the readlink shows a `->` arrow, or the inodes match: P1.** Skip
to "Path P1" below. Phase 1 on the laptop is already done; just need
the homemini.

**If the readlink is empty AND the laptop has 68GB at `~/Music2`
AND `/Volumes/Music/JakeTunesLibrary` also has 68GB AND it's a
separate filesystem (different `%d` from `stat`): P2.** Skip to
"Path P2" below.

---

## Path P1: laptop already on NAS, just configure homemini

Cheapest path. The 68GB on the laptop is the NAS via mount/symlink,
not a duplicate. Phase 1 reduces to making the homemini do the same.

### On the homemini:

1. **Quit JakeTunes** (whatever's running).
2. **Move the homemini's stale local Music2 out of the way:**
   ```bash
   mv ~/Music2 ~/Music2.stale-backup-$(date +%Y%m%d) 2>/dev/null || true
   ```
3. **Mount the NAS share at `/Volumes/Music`** (or wherever the laptop
   has it):
   - Finder → Connect to Server → `smb://192.168.1.50/Music`
   - Check "Remember this password" so it auto-reconnects
4. **Match whatever the laptop has at `~/Music2`:**
   - If laptop has symlink: `ln -s /Volumes/Music/JakeTunesLibrary ~/Music2/JakeTunesLibrary`
     (after creating the `~/Music2` parent if needed)
   - If laptop has the mount itself at `~/Music2`: arrange the same on
     homemini (e.g., mount `smb://192.168.1.50/Music` at `~/Music2`
     directly via the `mount_smbfs` command instead of `/Volumes`)
5. **Verify:**
   ```bash
   ls ~/Music2/JakeTunesLibrary/iPod_Control/Music/ | head -3
   # Should show F00, F01, F02 ...
   ```
6. **Set the mount to auto-reconnect on login:** System Settings →
   General → Login Items → drag the mounted volume in.
7. **Launch JakeTunes on homemini.** Library.json is stale, so it
   only knows about old tracks, but the files are now there. Either:
   - Run "Rescan Library" if such a command exists
   - OR `rsync ~/Library/Application\ Support/JakeTunes/library.json`
     from laptop to homemini once, then never again until Phase 2 ships

That's it for P1. The next thing you wanted ("Boom") is Phase 2.

---

## Path P2: laptop has a 68GB local duplicate

Less cheap, but still tractable. The laptop has 68GB of audio that
duplicates the NAS copy. We retire the local copy and switch the
laptop to the NAS mount.

### Pre-flight: confirm the NAS copy is current

```bash
# File counts should match
find ~/Music2/JakeTunesLibrary/ -type f | wc -l
find /Volumes/Music/JakeTunesLibrary/ -type f | wc -l

# Sizes should match within ~1MB
du -sh ~/Music2/JakeTunesLibrary/
du -sh /Volumes/Music/JakeTunesLibrary/
```

If counts and sizes match: the NAS copy is current. Proceed.

If the laptop has MORE files than the NAS: there are newer tracks on
the laptop that haven't been uploaded. `rsync` the deltas up first:

```bash
rsync -avh --progress --ignore-existing \
  ~/Music2/JakeTunesLibrary/ \
  /Volumes/Music/JakeTunesLibrary/
```

`--ignore-existing` is safe — it only adds files the NAS doesn't have,
never overwrites.

### Migration

1. **Quit JakeTunes on both machines.**

2. **Move the laptop's local copy out of the way (don't delete yet):**
   ```bash
   mv ~/Music2 ~/Music2.local-backup-$(date +%Y%m%d)
   ```

3. **Create the same path structure pointing at the NAS:**
   ```bash
   mkdir -p ~/Music2
   ln -s /Volumes/Music/JakeTunesLibrary ~/Music2/JakeTunesLibrary
   ```
   The symlink approach is reversible — just `rm ~/Music2/JakeTunesLibrary`
   to revert.

4. **Verify the laptop's JakeTunes still sees its library:**
   ```bash
   ls ~/Music2/JakeTunesLibrary/iPod_Control/Music/ | head -3
   ```
   Should show F00, F01, F02 ...

5. **Launch JakeTunes on the laptop.** It should look identical to
   before — same tracks, same library.json, same playback. The only
   difference is reads now go over SMB to the NAS instead of local
   disk. Slight first-play latency increase on LAN (negligible at
   gigabit).

6. **Configure the homemini exactly the same way** (Path P1 step 3
   onward — mount + symlink + sync library.json once).

7. **Soak for 48 hours.** If anything's wrong (playback hiccups, NAS
   reconnect failures, etc.), `rm ~/Music2/JakeTunesLibrary && mv
   ~/Music2.local-backup-* ~/Music2/JakeTunesLibrary` restores the
   pre-migration state.

8. **Delete the local backup:** `rm -rf ~/Music2.local-backup-*`. Reclaim
   68GB on the laptop.

---

## Common follow-ups (either path)

- **NAS auto-reconnect.** macOS sometimes drops SMB mounts on sleep.
  Fix: add the mount to Login Items so it re-mounts on wake. If issues
  persist, install autofs.
- **library.json sync between machines (Phase 2 problem).** Until
  Phase 2: one-shot `rsync` from laptop to homemini after each batch
  of laptop edits. Crude. Phase 2 replaces this with the event-driven
  API.
- **The `inbox-watcher.ts` file** the other Claude session is
  building: probably the right helper for "drop a file in a watched
  folder, JakeTunes auto-imports." Useful regardless of where the
  watched folder lives (NAS or local). Investigate when you push that
  branch.

---

## What this plan does NOT do

- Library.json sync (Phase 2)
- File structure change away from iPod_Control (deferred)
- Plex's separate music copy retirement (deferred — they're the same
  files now per the new info, but Plex's library config doesn't need
  to change)
- Off-LAN access (Phase 5+ via Tailscale)

After Phase 1: same JakeTunes behavior, files in one canonical place,
no per-machine drift in the audio tree. After Phase 2: BOOM.

---

## Sign-off

Walk through Step 0 first. Based on the readlink/inode output, follow
P1 or P2. Each path has its own checklist.

- [ ] Step 0 ran, P1 or P2 chosen
- [ ] All P-path steps complete on the laptop
- [ ] All P-path steps complete on the homemini
- [ ] 48-hour soak passed without remount issues
- [ ] Local backup deleted (if P2)

Then Phase 1 is done.
