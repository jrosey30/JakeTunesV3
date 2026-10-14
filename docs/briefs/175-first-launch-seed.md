# Brief 175 — Seed the first library atomically (JakeTunesV3)

- **Problem:** on first launch, load-tracks seeds `library.json` from
  the iPod DB with a direct in-place `writeFile`. If that write is
  interrupted, the file exists but won't parse — and the loader then
  refuses the iPod fallback permanently. Only first launch is
  exposed, and deleting the file by hand recovers it, but a torn seed
  bricks the first run of the app.
- **Evidence:** desktop audit Lens 2, finding 13 —
  `src/main/index.ts:4936`, `:4923-4926` (at 12bb43b).
- **Fix (as implemented):**
  - The seed write goes through the staged partial + rename
    (`library.json.partial.json` → `library.json`). The staging name
    is the recovery sidecar's, so even a crash between write and
    rename self-heals via Brief 167's recovery on the next load.
  - Loader: after the parse retries are exhausted, if a staged
    partial (`.partial.json` or `.new`) exists the loader keeps the
    old behaviour (refuse the fallback, surface
    `library-parse-failed`) — a staged save is in play. If NO partial
    exists, the unparseable file is preserved by renaming it to
    `library.json.unparseable-<timestamp>`, the reseed is logged
    loudly (`console.error`), and the loader falls through to the
    iPod seed exactly once (the seeded file parses on later loads;
    the preserved copy remains on disk for forensics/recovery).
  - **Safety note (implementation's guard on the brief's fix):** the
    audit's "refuses to fall back over an unparseable library"
    property exists to stop a torn LOAD destroying renderer-side
    state. The preserve-first reseed keeps that property recoverable
    rather than destructive: nothing is overwritten — the bad file is
    renamed aside, never deleted, and the partial-exists case still
    refuses outright.
- **Size:** S. **Risk:** low.
