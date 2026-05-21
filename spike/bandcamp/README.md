# Bandcamp Phase 0 Spike (throwaway)

Brief 036 v2.2. This is **not** part of the app — it's a disposable harness to
verify the four Bandcamp unknowns on **Jake's Mac** before any Phase 1 code is
written. Claude Code couldn't run it from its cloud container: that environment
gets **HTTP 403 from bandcamp.com** (datacenter IP block, confirmed even with a
browser User-Agent), has no Bandcamp credentials, and no interactive display.

Delete the whole `spike/` directory once the go/no-go decision is made.

## Prerequisites
- Run on Jake's Mac (real Chromium + residential IP + his Bandcamp login).
- Project deps installed: `npm install` (Electron 30 is a devDependency; the
  spike uses `WebContentsView` + `music-metadata`, both already present).

## Run
From the repo root:
```bash
npx electron spike/bandcamp/main.js
```
A window opens: a control strip on the left, the live Bandcamp site on the right
(running on the `persist:bandcamp` partition, with **no** preload / no
`electronAPI` exposed — same isolation the real feature will use).

Outputs are written to `spike/bandcamp/out/` (gitignored — it holds Jake's
personal collection data; delete when done).

## The four goals → what to do

**Goal 1 — auth + cookie persistence (+2FA).**
1. Click **Open Login**, sign in (complete 2FA if prompted).
2. Click **Check session** → expect `✅ logged in — fan_id=…`.
3. **Quit the app and run it again.** On launch it auto-checks the session.
   - **PASS** = it says *LOGGED IN* on relaunch with no re-login.
   - Note in your report whether 2FA appeared and whether it completed inside
     the embedded view (if it didn't, that's the "fall back to external
     browser" risk from the brief — record it).

**Goal 2 — profile endpoints.**
1. While logged in, click **Dump collection / wishlist / following**.
2. Check `out/`: `collection_items.json`, `wishlist_items.json`,
   `following_bands.json`, plus `profile_pagedata.json` and
   `collection_summary.json`.
   - **PASS** = ≥20 real items per endpoint (or fewer only if Jake genuinely
     has fewer). Any `__httpError`/`__fetchError` in a file = investigate.

**Goal 3 — purchase download interception (passive).**
1. In the Bandcamp page on the right, buy a **free or cheap** item (a free
   Bandcamp Friday download or a $1 single — Jake's choice) and click its
   **download** link (pick a format like MP3 320 or FLAC).
2. Watch the log: `will-download` fires, the file saves to `out/`, and the
   harness reads back the embedded tags (unzipping album ZIPs first).
   - **PASS** = artist / album / title / track# are correct on every track and
     `art=yes`. Those tags are exactly what `importOneFile()` (`src/main/index.ts:2173`)
     consumes, so correct tags here means routing into the library will work.
   - This spike intentionally does **not** write into the real `library.json`.

**Goal 4 — catalog `data-tralbum`.**
1. Paste a Bandcamp **album URL** (e.g. one from Jake's wishlist) into the box,
   click **Parse**.
2. Check `out/tralbum.json`.
   - **PASS** = log shows `✅ tralbum parsed: N tracks` with `purchasable`,
     `price`, and `preview[0]=present`.

## What to send back to Claude Code
For each goal: **PASS / FAIL**, plus:
- Goal 1: did 2FA appear? did the session persist on relaunch?
- Goal 2: item counts per endpoint; paste a 1-item sample from each file
  (redact anything you'd rather not share — the field *shape* is what matters).
- Goal 3: the logged tag lines; whether it was a single file or an album ZIP.
- Goal 4: the `✅ tralbum parsed…` line; note any missing field.

That report is the go/no-go gate for Phase 1.
