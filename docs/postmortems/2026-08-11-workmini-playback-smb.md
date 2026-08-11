# Post-Mortem — Workmini Playback Hang (Aug 10–11, 2026)

**Severity:** P0 (music does not play on a daily-use machine)
**Author:** Cursor agent (investigation + fix) + prior Claude session (live diagnosis)
**Status:** Resolved in #14; prevention locks in follow-up.

---

## tl;dr

workmini played music by following **symlinks into a Tailscale SMB mount**.
When that mount wedged, playback hung or silently died. A July 2026 "fix"
had deliberately kept workmini **off** the phone-proven homemini HTTP path
so "NAS playback" would keep working. That was the hang.

---

## What the user saw

- Tracks stuck at **0:00**, silent, any song, at random
- "Works after restart, then doesn't"
- Same track fine one minute, dead the next
- Phone (same library, homemini HTTP) fine all day

---

## Root cause chain

1. **Architecture:** workmini = cache farm. Most files under `musicRoot` are
   symlinks into `~/JakeShareNAS` (Synology over Tailscale SMB).
2. **Environment:** that mount wedges (measured **203s** for one readdir;
   app in uninterruptible state).
3. **Process mistake (July 2026):** a gate kept `streamRoot` machines off
   homemini so NAS playback would "still work." That removed the escape hatch.
4. **Amplifiers (Aug 10):**
   - Howler Web Audio XHR error → silent `_sounds = []` → stuck at 0:00
   - Default libuv **4** threads filled by hung SMB walks → permanent freeze
     until relaunch
   - `streamSource=homemini` set by hand once, never by deploy → easy to lose
   - Same-day thrash of four audio changes → full revert → careful rebuild

The variable was never "the song." It was whether the mount was wedged
*in that instant*.

---

## Fix

- Any machine with `streamRoot` set is a **homemini playback client**
  (even if `streamSource` is unset).
- `ipod-audio://` asks homemini **before any filesystem call**.
- Homemini miss + symlink → **404**, never follow into SMB.
- Deploy pins `streamSource` / `streamRoot` / `musicRoot` every streaming run.
- html5 Howls + `UV_THREADPOOL_SIZE=64` (already in tree from Aug 10).

---

## Prevention (what this follow-up adds)

| Lock | What it catches |
|------|-----------------|
| `stream-playback.ts` decision table + unit tests | Policy regresses (streamRoot off homemini again) |
| `stream-playback-path.test.ts` source-shape lock | Handler order (realpath before homemini), July gate text returning, Howls leaving html5, threadpool unset, deploy unpinning streamSource |
| Boot `probeHomeminiReachability()` | Homemini down → loud main-log warning, not silent 0:00 |
| CI runs `npm test` | Locks fail the PR before a DMG ships |
| CLAUDE.md invariant | Next editor sees the rule before touching the path |

**Hard rule:** On a streaming/cache-farm machine, **never** put SMB /
`streamRoot` / symlink-follow on the playback hot path. If homemini is down,
fail closed (404 / warning) — do not "fix" by reading the NAS.

---

## What still depends on ops

- Homemini (`:3000`) must be up for symlinked tracks
- A `--build` deploy/nightly must ship the build to workmini after merge
- The SMB mount can still wedge **background** walks; threadpool raise
  stops that from freezing the whole app, but does not heal the mount
