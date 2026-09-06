# Desktop placement audit — the download flow (2026-09-06)

Document-only slice. Nothing in this file changes code; every proposal waits
for Jake's arbitration. Companion to
[jaketunes-6-plan.md](jaketunes-6-plan.md) ("UI placement audit — without
destroying the soul") and
[record-shop-structure-and-domain.md](record-shop-structure-and-domain.md)
(the Record Shop map). Later audit passes cover the rest of the app.

## The constraint

The soul is the iTunes-looking library: the 2006 sidebar of LIBRARY / STORE /
PLAYLISTS, the list views, the toolbar. The audit may move features to better
homes; it may not make the app stop looking and feeling like that. Standing
rules apply: no unrequested UI features, "looks off" = one fix then pause,
truncation policy, type tokens in px.

## Method and evidence

For each entry point: where it lives, where it leads, how often it is used,
how discoverable it is, and what it duplicates. Frequency is the weak column —
there is no per-entry telemetry — so it is graded from what exists:

| Evidence | What it says |
|---|---|
| Library `dateAdded` by month, files named `imported_N` (the download pipeline's import path) | Jun 699 · Jul 675 · Aug 1,140 · Sep (6 days) 723. Roughly 25–40 imports a day through the download pipeline. Qobuz and Bandcamp both land as `imported_N`, so the split between them is not visible here. |
| KPI snapshot 2026-09-06 | `newTracks28d` 1,482; `foundShare` 0.93 (new tracks that came in through Found / the pipeline); `discoverAcceptRate` 0.83. Acquisition is the dominant growth path. |
| Hub tombstone file | 998 keys ≈ 500 jots processed off the Listen List over its life (each delete writes an id plus identity keys). The Listen List is the high-throughput door. |
| `main.log` since 2026-08-22 | no direct Bandcamp/link import lines in the retained window; a handful of list adds. The log rotates, so it is a floor, not a count. |
| Session history (this program) | Jake's own descriptions: the Listen List and Get are daily; the Download page's search was "hit or miss"; Music Sources setup is a once-a-quarter task. |

Grades: **daily**, **weekly**, **rare**, **setup-only**, **new** (shipped this
week, no history yet).

## Inventory — every door into the download flow

| # | Entry point | Where | Leads to | Frequency | Discoverability | Duplicates | Status |
|---|---|---|---|---|---|---|---|
| 1 | Sidebar › LIBRARY › **Record Shop** (copper highlight) | sidebar | `discovery` view: For You · Browse · Listen List | daily | high — a highlighted sidebar row | — | completed: literal labels 6351ed7, Browse tab 818e98f |
| 2 | Record Shop › For You › card **+** | rack card | adds a jot to the Listen List | daily | good (on every card) | — | existing |
| 3 | Record Shop › For You › **Preview** / **Not for me** | rack card | preview player / discovery veto | daily | good | — | existing |
| 4 | Record Shop › For You › **Step Inside** | rack header button | `recordstore` view (the room; At the Counter) | new | medium — one button, no sidebar entry (hidden on purpose) | the Counter shares the Listen List's session and commands by design | completed: 22aacec, f316b4e |
| 5 | Record Shop › Listen List › row **Get** / **Tracks** / **Preview** / **✕** | list row | one scheduler job; Tracks → Browse prefilled | daily | good | — | completed: Choose/Tracks now route to Browse d68d2aa |
| 6 | Record Shop › Listen List › **add form** | list header | new jot (hub) | weekly | good | Music Man "suggests 3" lives in the same list | existing |
| 7 | Record Shop › **Browse** › search · Top match · Releases · Songs · Get · See tracks · preview | tab | one scheduler job (exact edition) | new | high — a tab | the legacy Download page (#10) | completed 818e98f |
| 8 | Record Shop › Browse › **Add by link** | button beside search | link download → import pipeline | rare | good | legacy drawer "Paste a link" (#11) | completed 818e98f |
| 9 | **Choose edition / Choose version** (Counter, Listen List, Downloads panel) | verbs on refused verdicts | Browse, prefilled, provenance kept | weekly | good — offered exactly where the refusal is | — | completed d68d2aa |
| 10 | Sidebar › STORE › **Download** (legacy page) | sidebar | page mode: heading, Qobuz/streamrip chips, Setup, search, queue bar | weekly (was the only search until this week) | high — sidebar row | Browse (#7), Downloads panel (#13), Music Sources (#12), Add by link (#8) — four duplications | legacy, kept on purpose |
| 11 | Legacy Download › **Setup** drawer › Paste a link + Music Sources | gear button on the page | link download; Qobuz account + tool status | rare / setup-only | low — behind a gear on one page | #8 and #12 | legacy |
| 12 | Preferences › **Music Sources** (⌘,) | modal tab | Qobuz account, download tool status | setup-only | medium — where settings live in iTunes | #11 | completed 93931e9 |
| 13 | Sidebar › Download row › **door** → **Downloads panel** | sidebar control, any view | right-hand drawer: every job, provenance, edition, counts, verdict, Cancel/Retry/Choose | daily (passive) | medium — a small glyph; the count inside it is the tell | the legacy queue bar (#10) | completed 5643d10 |
| 14 | Sidebar › STORE › **Bandcamp Store** | sidebar | embedded bandcamp.com (own session, login survives), library-status strip, purchases auto-import | weekly–rare (not separable in the evidence) | high — sidebar row | none: purchasing and auto-import exist nowhere else | existing, kept through the transition |
| 15 | File › **Import…** (⌘O) / **Import and Convert…** | app menu | local files → library | weekly | standard iTunes placement | adjacent flow, not a duplicate | existing, out of scope |
| 16 | Home | view | no door into the shop or downloads | — | — | — | gap; see P7 |
| 17 | The Music Man (chat) | view | no Get; suggests jots inside the Listen List only | — | — | — | fine as is |

Hidden and out of scope for this pass: the DJ booth and the old "Record
Store" sidebar entries (both intentionally hidden), CD import, Activity Sync.

## What the inventory says

- The flow now has **one search** (Browse), **one scheduler**, **one activity
  surface** (the panel), **one setup place** (Music Sources), and **one link
  door** (Add by link) — but each still has a twin on the legacy Download page.
  Four of the five duplications in the table are that page.
- The legacy page's remaining unique value is zero: everything it does exists
  elsewhere with parity verified (acceptance tables in
  [record-shop-model-verification.md](record-shop-model-verification.md)).
  What it still has that the replacements lack is **habit** and a **sidebar row**.
- Bandcamp Store is not a duplicate. It is a store with a login and a purchase
  path that imports on its own; Browse resolves on Qobuz and cannot replace it.
- The Downloads door is discoverable only once you know the glyph. It carries
  the app's most-used background activity on a 12 px control.
- Record Shop sits under LIBRARY. In 2006 iTunes the place you get music from
  was the STORE section; the library was what you owned. Today "Record Shop"
  (acquisition) lives beside Songs and Albums (ownership), while STORE holds a
  page that is about to retire.

## Completed this week (not proposals)

| Change | Commit |
|---|---|
| Literal labels: For You (The Racks), Listen List with count, "Record Shop" title | 6351ed7 |
| Music Sources in Preferences; legacy drawer shares the panel | 93931e9 |
| Downloads panel + sidebar door; scheduler snapshot fix | 5643d10 |
| Browse tab (trimmed Download view), Add by link, copy corrections | 818e98f |
| Choose edition/version from Counter, Listen List and panel → Browse | d68d2aa |
| Isolated acceptance harness for list mutations | f17970c |

## Proposals

Each: current → proposed, why, and what must pass before the old route goes.

### P1 — Retire the legacy Download page; the STORE row becomes **Downloads**

- **Current →** Sidebar › STORE › Download opens the legacy page; a small door on
  the same row opens the panel.
- **Proposed →** Sidebar › STORE › **Downloads** — clicking the row opens the
  Downloads panel (the door becomes the row); the page route `download` is
  removed from the sidebar, then from MainContent once nothing links to it.
  The count stays on the row ("3", "1 need attention", "2 done").
- **Why:** removes four duplications at once; gives the activity surface a real
  sidebar door instead of a glyph; keeps the STORE section meaningful.
- **Must pass first:**
  1. Browse parity list, each verified once in Jake's own use (not by me):
     search a song, an album and an artist; preview; See tracks; Get an album;
     Get one song; a refused verdict → Choose → Get another edition; Add by
     link with a real link (Jake picks the material); the failures list after a
     partial link import.
  2. Panel parity: progress with elapsed time, Cancel, Retry, Details, results,
     canceled visibility, refused actions — verified (acceptance tables), plus
     one real in-flight download watched from the panel by Jake.
  3. No remaining code path dispatches `SET_VIEW download` (today: the sidebar
     row only; grep is the gate).
  4. The Qobuz / streamrip **status chips** on the legacy page get a home before
     the page goes: Music Sources already shows both; the open question is
     whether Browse needs a quiet "Qobuz not connected" line when a Get needs
     it. That would be a new UI element — Jake decides (P3).
  5. ui-state and nav history survive: a saved `currentView: 'download'` must
     land somewhere sensible (Record Shop → Browse) rather than a blank view.

### P2 — Retire the Setup drawer with the page; Paste a link becomes Add by link only

- **Current →** legacy page › gear › drawer with Paste a link + Music Sources.
- **Proposed →** Add by link in Browse (done); Music Sources in Preferences
  (done); the drawer disappears with P1.
- **Why:** a gear on one page is the least discoverable spot in the app for
  account setup; a link paste belongs next to the search it complements.
- **Must pass first:** P1 items 1 (Add by link with a real link) and 4.

### P3 — Where a missing Qobuz account shows up (decision, not a build)

- **Current →** chips on the legacy page header; Music Sources shows
  "Connected · <account>" or not.
- **Proposed options:** (a) nothing in Browse; a Get without an account fails
  with the panel's verdict pointing at Preferences → Music Sources; (b) a
  one-line notice under the Browse search only while unconfigured.
- **Why:** the chips are the only thing the legacy page has that Browse
  deliberately dropped.
- **Recommendation:** (a) for now — no unrequested UI; revisit if a real
  failure shows the verdict text is not enough.

### P4 — Move Record Shop to STORE

- **Current →** LIBRARY › Record Shop (copper highlight) between Genres and
  The Music Man.
- **Proposed →** STORE › **Record Shop**, first in the section, highlight kept;
  STORE reads: Record Shop · Bandcamp Store · Downloads.
- **Why:** it is the iTunes sidebar's own grammar — LIBRARY is what you own,
  STORE is where you get more. Acquisition, the store, and its activity then
  sit together, in the journey's order. LIBRARY becomes Home … Genres plus The
  Music Man.
- **Cost:** muscle memory for a row Jake clicks daily; the Listen List (a
  personal list) moves with it. Route id `discovery` and ui-state unchanged —
  it is only a row moving between sections.
- **Must pass first:** Jake's yes. Nothing technical gates it.

### P5 — Bandcamp Store stays in the sidebar

- **Current →** STORE › Bandcamp Store (embedded store, own session, auto-import).
- **Proposed →** unchanged. The plan's "link from Browse, remove sidebar
  duplication later" does not apply: an external link cannot carry the embedded
  session, the library-status strip, or the download interception.
- **Why:** unique capability; already in the right section.
- **Optional later:** a Bandcamp result group inside Browse only if a search
  API exists that respects the session — an audit of its own.

### P6 — Downloads door on the Record Shop row too (only if P1 is refused)

- If the legacy page stays for a longer transition, the panel needs a second
  door where downloads start: a matching glyph on the Record Shop row.
- **Must pass first:** P1 refused or deferred; otherwise not needed.

### P7 — Home does not link into the shop (recorded, not recommended now)

- The plan allows Home to deep-link into the shop without new sections. Nothing
  on Home does today. Not recommended in this pass: the standing rule is no
  unrequested UI, and Home already carries Today's Picks with its own logic.

### P8 — Step Inside stays where it is

- Reached from For You only, by design; no sidebar entry. The hidden "Record
  Store" sidebar code is dead weight but removing it is a feature-removal
  audit item, not placement.

## The coherent final arrangement (recommended)

```text
LIBRARY
  Home · Songs · Artists · Albums · Live Concerts · Genres
  The Music Man
STORE
  Record Shop        For You · Browse · Listen List   (Step Inside from For You)
  Bandcamp Store     embedded store, purchases auto-import
  Downloads          the panel (count on the row); no page
ARCHIVE · ACTIVITY SYNC · MIXTAPES · PLAYLISTS   unchanged
Preferences › Music Sources   accounts, tool status
```

The journey maps onto it without a gap: Discover (For You) → Save (Listen
List) → Inspect edition (Counter / Browse) → Get (one scheduler) → Downloads
(panel) → Library. Every refused verdict has one next step (Choose → Browse);
every door to activity is the same drawer; every account question is one
Preferences tab.

## Decisions for Jake

1. P1 — retire the legacy Download page once the parity list passes in your
   own use, and make the STORE row the Downloads panel's door. Yes / not yet.
2. P4 — move Record Shop from LIBRARY to STORE. Yes / no.
3. P3 — a missing Qobuz account: verdict text only (recommended), or a notice
   line in Browse.
4. P5 — Bandcamp Store stays. Confirm.
5. Order of the parity checks you want to run yourself (P1 item 1), and the
   material for the one real Add by link test.

Until these are answered nothing moves; the legacy route stays exactly as it
is. Activity Sync implementation stays on hold. The Mobile counter caption
remains a separate, uncommitted change.

## Arbitration and status (2026-09-06, later the same day)

Jake approved: **P4** Record Shop under STORE; **P5** Bandcamp Store stays;
**P1** Downloads becomes the panel's full-row entry point with its door
visible when empty; **P3** an actionable notice when an attempted operation
needs Qobuz credentials, linking to Preferences → Music Sources, with
browsing and previews unaffected. The legacy page is retired only after
parity AND Jake's everyday-use acceptance.

### Implemented (this arbitration round)

| Change | Where |
|---|---|
| STORE reads Record Shop · Bandcamp Store · Downloads · *Download page*. Record Shop keeps its view id, highlight and icon; LIBRARY ends with The Music Man. | `Sidebar.tsx` |
| The Downloads row toggles the panel; the glyph door stays when the queue is empty; the count rides inside it; the row lights (not "selected") while the panel is open. | `Sidebar.tsx`, `DownloadsPanel.tsx`, `sidebar.css` |
| The legacy page keeps a quieter row, *Download page*, until retirement. | `Sidebar.tsx`, `sidebar.css` |
| Missing-Qobuz notice: every Get in Browse and on the legacy page passes through one rule (`common/qobuz-notice.ts`); when the account is known-unconfigured a notice appears under the search with **Open Music Sources**, which opens Preferences on that tab. The job still runs (a song may come from Bandcamp/SoundCloud). Search, previews and Add by link never trigger it. | `DownloadView.tsx`, `CredentialNotice.tsx`, `credential-notice-store.ts`, `SettingsModal.tsx`, `App.tsx` |

### Parity run — Jake's order, on the isolated harness (`JT_RECO_FIXTURE`)

| Step | Result | Capture |
|---|---|---|
| 1 Search / preview | Album and song searches return Top match, Releases, Songs; the song hero's preview plays (`playingId dl|q|track|talkingheads|onceinalifetime`, "Once In a Lifetime") and stops on second click. Album results carry no preview control by design (previews are per song, inside See tracks). | `parity-1-search-preview.png` |
| 2 Listen List and Counter handoffs | Listen List "Tracks" → Browse with the album searched; Counter "Choose version" after a refusal → Browse with the song searched. | `parity-2-listenlist-handoff.png`, `parity-4c-counter-choose-browse.png` |
| 3 Exact-edition Get on owned material | Little Creatures Deluxe: done, 0 imported · 12 already owned, collectionId 124906778 · 12 tracks · 2006, provenance entry `fixture-lc-album` "from Alex"; row "1 done". | `parity-3-exact-edition-owned.png` |
| 4 Cancel / retry / refusal | Downloading · 2s → Cancel → Canceled (Retry) → Retry → Needs a choice · Not found (Choose version, Details); Counter row "Not found · attempt 2". | `parity-4a-cancel.png`, `parity-4b-refused.png` |
| 5 Add by link — prepared, not run | Card opens as "Add by link", hint points at Preferences → Music Sources, Download button disabled when empty and armed with a URL; no download attempted. | `parity-5-add-by-link-ready.png` |
| Notice | Rendered through the shared store on a Get with `configured: false`: text, **Open Music Sources** → Preferences opens on Music Sources; search and results stay usable behind it. | `parity-6-qobuz-notice.png`, `parity-7-notice-opens-music-sources.png` |
| Placements | Sidebar with an empty queue; the Downloads row open from Songs (Songs stays the selected view); Record Shop selected under STORE. | `place-1-sidebar-empty.png`, `place-2-downloads-row-open.png`, `place-3-record-shop-under-store.png` |

Isolation held: real `recommendations.json` / outbox checksums identical before
and after; hub list one item; tombstones 998, same tail; no rip process left.

### The real-link test (waiting on Jake's link)

Procedure once the link arrives: Record Shop → Browse → Add by link → paste →
Download. Expected: the job appears in the Downloads panel as "pasted link",
completes with the import count, and the track lands in the library with the
link's title and artist; a partial import shows the failures list under the
card. Checked afterwards: the Downloads row count, the panel's Details, and
the library row. Nothing is acquired before the link is supplied.

### Retirement gate for the legacy page (unchanged)

Parity above, plus Jake's everyday-use acceptance of Browse, the panel and
Add by link. Then: remove the *Download page* row, the `download` route from
MainContent and ui-state (a saved `download` view lands on Record Shop →
Browse), and the page-mode branches of the Download view.
