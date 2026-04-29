# Mobile Sync Setup — DS225 + JakeTunes Mobile

End-to-end setup walkthrough for getting the desktop, the NAS, and the
mobile app talking to each other for the first time. Run through these
steps in order; each section is a dependency for the next.

Estimated time: 30–45 minutes including the initial library copy.

---

## What you're wiring up

```
┌────────────────────────────┐    Drive Client    ┌──────────────┐
│  Mac: ~/Library/...        │  ───────────────►  │  DS225       │
│  /JakeTunes/iPod_Control/  │   (file mirror)    │  /music/...  │
└────────────────────────────┘                    └──────────────┘
            │                                            ▲
            │ (snapshot exporter writes here too)        │
            ▼                                            │
   library.json on disk      ──── Drive Client ─────────┘
                                                         │
                                                         ▼
                                                 ┌──────────────┐
                                                 │  iPhone      │
                                                 │  (mobile app)│
                                                 │   reads JSON │
                                                 │   streams    │
                                                 │   audio      │
                                                 └──────────────┘
```

Three flows, one direction each:
1. **Audio files**: Mac → NAS, via Synology Drive Client
2. **library.json**: Mac → NAS, via JakeTunes' built-in snapshot exporter
   (which writes into the same Drive-Client-synced folder)
3. **Mobile reads**: iPhone → NAS, via the mobile app's NAS connection

---

## Phase 1A — Synology Drive Client (audio file sync)

This is what makes "I imported a song; now it's on my phone" work
without any code. JakeTunes does NOT manage the audio file copy
itself; we let Drive Client handle it because file sync is its full-time
job and it's already battle-tested.

### On the DS225

1. Open DSM in a browser → **Package Center**.
2. Install **Drive Server** (not Drive Client — that's the Mac app).
   Wait for it to finish.
3. Open Drive (the new app icon in the DSM main menu).
4. Go to **Settings → Team Folder**, enable a folder for sync. Default
   is `/home`, but a dedicated `/music` shared folder is cleaner:
     - Control Panel → Shared Folder → Create
     - Name: `music`
     - Skip the encryption checkbox (audio doesn't need it; encrypted
       folders have to be unlocked after every reboot)
   Then back in Drive → Team Folder, enable `/music`.

### On the Mac

1. Download **Synology Drive Client** from synology.com/en-global/dsm/feature/drive
   (the user-facing app, distinct from Drive Server on the NAS).
2. Install + launch. On first run it asks for a server.
3. Server: enter the DS225's address. Local-network is fine —
   `synology.local` (Bonjour name) or its LAN IP.
4. Account: your DSM username + password.
5. **Sync Tasks** screen — click "Create" → **Sync Task**:
   - **Local folder**: `~/Library/Application Support/JakeTunes/`
   - **Remote folder**: `/music/jaketunes/` (Drive will create it)
   - **Sync mode**: **Two-way** (so deletes propagate; otherwise the
     NAS accumulates dead audio files when you remove tracks on the Mac)
   - **Filter**: skip nothing. The whole `JakeTunes/` folder gets
     mirrored, including `iPod_Control/Music/`, `library.json`,
     `app-settings.json`, etc.
6. Save the task. Drive Client starts the initial copy. With ~4500
   tracks this is typically 30–60 minutes depending on Wi-Fi.

### Verify

While the initial copy is running, you can already spot-check:

```bash
ls -la ~/Library/Application\ Support/JakeTunes/iPod_Control/Music/F00 | head -5
```

vs. what's appearing on the NAS in **DSM File Station → music → jaketunes →
iPod_Control → Music → F00**. Counts and filenames should be growing
toward parity.

When Drive Client says "Up to date," you have a one-click answer to
"is the audio mirrored": just open Drive on the Mac and look at the
status indicator.

---

## Phase 1B — Library snapshot path

Once Drive Client is running and the JakeTunes folder is mirrored, you
need to point JakeTunes' snapshot exporter at a path inside that
folder so the wire-format JSON ends up on the NAS.

### In the desktop app

1. **File → Library → Export Snapshot for Mobile…**
2. Save dialog opens. Navigate to:
   `~/Library/Application Support/JakeTunes/.jaketunes/`
   (Create the `.jaketunes` subfolder if it doesn't exist — saving
   into it is allowed.)
3. Filename: `library.json`
4. Save.

The desktop logs `[snapshot] wrote N tracks (B B) to /Users/.../library.json`
to its DevTools console. Verify the file appeared:

```bash
jq '{version, exportedAt, trackCount: (.tracks|length), firstPath: .tracks[0].path}' \
  "$HOME/Library/Application Support/JakeTunes/.jaketunes/library.json"
```

Expected: `version` is `1`, `firstPath` looks like
`iPod_Control/Music/F12/ABCD.m4a` (slash-separated, no leading slash).

### What this gives you

- Every subsequent `save-library` (rename a playlist, edit a tag,
  import a track, etc.) auto-writes the snapshot in the background.
  No more menu clicks.
- Drive Client picks up the snapshot file change like any other file
  edit and pushes it to the NAS within seconds.
- Mobile's library fetcher sees the new file the next time it
  refreshes.

The path on the NAS, after Drive Client mirrors it, will be:
`/music/jaketunes/.jaketunes/library.json`

Remember that path — mobile's connection screen will need it.

---

## Phase 1C — DSM accounts and permissions

Mobile authenticates to DSM with a username + password. Best practice:
a dedicated account, not your primary admin user.

1. DSM → **Control Panel → User & Group → Create**
2. Name: `jaketunes-mobile` (or anything; you'll type it once)
3. Strong password (it goes into iOS Keychain, not anywhere else).
4. Permissions:
   - **File Station** (read/write) on the `music` shared folder
   - **WebDAV Server** access (only if you plan to use the WebDAV
     transport — see Phase 1D)
   - **Audio Station** access (only if Audio Station is installed —
     optional in Phase 1)
5. Skip the admin group and 2-step verification on this account for
   now. (2FA is a Phase 2 follow-up; the mobile auth flow currently
   doesn't handle the OTP prompt.)

### HTTPS choice

DSM ships HTTP on port 5000 and HTTPS on port 5001 with a self-signed
cert by default. iOS will refuse self-signed HTTPS connections without
extra entitlements.

**For Phase 1, use HTTP on the local network.** The DS225 + your
phone are on the same Wi-Fi; an attacker on your home LAN reading
your Pink Floyd play counts is not the threat model. We can revisit
HTTPS once a real cert is in place.

---

## Phase 1D — Mobile connection

On the iPhone, after the desktop is mirroring + the snapshot is on the
NAS:

1. Open JakeTunes Mobile.
2. Settings tab → tap "Synology" row.
3. **Server**:
   - Host: the DS225's LAN IP, or `synology.local` if Bonjour resolves
   - Port: `5000` (default DSM HTTP)
   - HTTPS: off (per Phase 1C decision)
4. **Credentials**:
   - Username: `jaketunes-mobile` (the dedicated user)
   - Password: the strong password you set (lands in iOS Keychain)
5. **Library**:
   - Transport: `synology-audio-station` (this uses File Station's
     download endpoint under the hood — see notes below)
   - `library.json path`: `/music/jaketunes/.jaketunes/library.json`
   - Music root: `/music/jaketunes` (the Drive-mirrored root)
6. **Save & connect**.

Watch for:
- Connection status flips from "connecting" to "connected" on the
  Settings row
- Library count stops being 0 after the first refresh

If it doesn't connect, the most likely culprits:
- **Wrong host/port**: try the IP directly, ping it from terminal
- **Wrong credentials**: log into DSM in a browser with that user to
  confirm
- **Firewall**: your router or the DS225's built-in firewall blocking
  port 5000. DSM → Control Panel → Security → Firewall.
- **Path mismatch**: the `library.json path` must include the leading
  `/music/jaketunes/.jaketunes/library.json` — DSM's File Station
  paths are absolute from the share root.

When in doubt, paste the desktop log output (`[snapshot] wrote ...`)
and the mobile error message and we'll debug.

---

## Phase 1E — First track play

With the library loaded:

1. Songs tab → tap any track.
2. Watch the MiniPlayer pop up at the bottom of the screen.
3. First play streams over Wi-Fi from the NAS. Lag of 1–3 seconds
   before audio is normal — Audio Station / File Station ranges have
   to spin up.
4. Open NowPlaying (tap the MiniPlayer) and confirm scrubbing works.

Things to expect that aren't bugs:
- Album art is empty boxes (Phase 1F deferred — not yet wired).
- Skip-detection isn't recorded yet (only natural completions land in
  the override queue).
- No on-device cache — every play is a fresh stream.

Things that ARE bugs (please report):
- Authentication errors after the first connect (sid expiring? we
  don't auto-refresh yet)
- Stuck "Connecting…" forever
- Tracks that stream but won't seek
- Library shows 0 tracks even though `library.json` is on the NAS
  (path config mismatch)

---

## Phase 1F — Override queue round-trip

Once you've played some songs and Settings shows "Plays awaiting
desktop merge: N":

1. Mobile: Settings → tap "Export overrides…"
2. iOS Share Sheet opens with a JSON payload. AirDrop it to your Mac
   (or email/Files — anything that gets the JSON onto your Mac as a
   file).
3. Save the JSON somewhere (Desktop, Downloads — wherever).
4. Desktop: **File → Library → Apply Mobile Overrides…**
5. Pick the JSON file.
6. DevTools console logs `[overrides] applied N/M from device <id>`
   plus any discarded entries with reasons.
7. Verify a played track's `playCount` incremented:
   ```bash
   jq '.tracks[] | select(.title == "<some track you played>") | {title, playCount, lastPlayedAt}' \
     "$HOME/Library/Application Support/JakeTunes/library.json"
   ```
8. Once confirmed, mobile: Settings → "Clear queue (after desktop
   merge)" → tap-to-arm → tap-again. Queue resets to 0.

The next desktop save-library auto-fires the snapshot exporter, so
mobile sees the new play counts on its next refresh. No further
manual action needed.

---

## Troubleshooting layer order

Per CLAUDE.md, when something doesn't add up, inspect layers in this
order:

1. **NAS-hosted `library.json`** — `cat | jq` against the file as
   visible on the NAS. The wire format. If this is wrong, nothing
   downstream can be right.
2. **Mobile in-memory snapshot** — Settings shows track count and
   `lastRefreshedAt`. If 1 looks fine but 2 is stale, force a refresh.
3. **Desktop `library.json` on disk** — the source of truth. If this
   doesn't match the NAS, Drive Client hasn't synced or the snapshot
   exporter isn't pointed at the right path.
4. **TrackPlayer queue / iOS storage** — only after layers 1–3 are
   provably consistent.

A 5-line `jq` query usually finds the problem in <60 seconds.

---

## What's NOT done in Phase 1

These work but ship in a later phase:

- Album art (currently empty placeholders)
- HTTPS with a real cert
- 2FA on the DSM account
- On-device audio cache (every play streams fresh)
- Auto-export of override queue when NAS is online
- Skip-detection (only natural completions are recorded)
- Discovery via Bonjour (you type the IP)

When any of those start to bite, raise it and we'll prioritize.
