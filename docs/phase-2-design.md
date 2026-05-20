# Phase 2 Design — Event-Driven Sync Architecture

> **Status:** design lock-in, pre-implementation. Generated 2026-05-12
> after user committed: *"When I update JakeTunes, BOOM, it's on all
> devices. Metadata change? Changed across the board."*
>
> **Owner:** Jake. Review and approve before any Phase 2 code is written.
> If anything in here is wrong, fix the doc first, then the code follows.

---

## What "seamless" means, in numbers

| Property | Target | Hard limit |
|---|---|---|
| Edit-to-other-client propagation latency | < 100ms LAN | < 500ms worst case |
| Optimistic local write feedback | 0ms (synchronous in UI) | n/a |
| Reconnect catch-up after offline period | < 2s for typical day | n/a |
| Conflict resolution | predictable, no silent data loss | hard rule |
| Server downtime | clients still browse + play locally | degraded but functional |

If we can't hit "< 100ms LAN propagation" it doesn't feel like "Boom."
That's the design north star.

---

## Architectural commitments

These are non-negotiable. Any implementation choice that violates one
of these is the wrong choice.

### 1. Server-authoritative, no client `library.json` drift

Today every JakeTunes install has its own `library.json` that diverges
over time. Post-Phase-2:

- The canonical library lives on the Mini PC API server.
- Clients have a **local cache** mirroring the server, never a separate
  source of truth.
- Cache is rebuildable from the server at any time (cold launch / cache
  corruption / debug).
- Clients NEVER write to their cache directly except as the result of
  a server-confirmed change (or an optimistic-local write that the
  server later confirms — see #3).

### 2. Push, not poll

- WebSocket or Server-Sent Events (SSE). Recommended: **SSE.**
  - Reasons: one-way push fits the model (server → clients); browser-
    native; works through HTTP proxies; reconnect logic is built-in;
    no client→server channel needed on the event stream because writes
    go through normal HTTP POST/PATCH.
  - WebSocket only wins for bidirectional realtime (chat, gaming).
    We're not that.
- Events serialized as line-delimited JSON: `event: track-updated\ndata: {...}\n\n`.
- Client subscribes on app launch, holds the connection open, processes
  every event as it arrives.
- Server keeps a per-client `lastEventId` cursor so disconnected clients
  can resume from where they left off (see #6).

### 3. Optimistic local writes with reconciliation

When client A saves a Get Info edit:

1. **Client A renders the change immediately.** Reducer dispatches
   `UPDATE_TRACKS` synchronously. UI never shows a spinner waiting on
   the server.
2. **POST `/api/tracks/:id` with the field diff + client's etag.**
3. **Server responds with the canonical new state + new etag.**
4. If server accepts → client A confirms (no UI change, just clears
   pending state). Server pushes `track-updated` event to B, C, D.
5. If server rejects (validation, conflict) → client A rolls back the
   reducer to the pre-edit state and shows a notice with the reason.
   *Notice infrastructure already shipped in 4.4.12.*

This is the same pattern Linear, Figma, Notion use. Well-trodden.

### 4. Per-entity version/etag for conflict detection

Each entity (track, playlist, setting, persona-memory entry) carries
a monotonic `version` integer or an opaque `etag` string.

- Client write includes the etag it knew about.
- Server compares to current; if mismatch, server's wins by default
  (last-write-wins-by-timestamp), client gets a `409 Conflict` with
  the new state.
- Field-level granularity (not record-level): client A edits `genre`,
  client B edits `year` on the same track simultaneously, both succeed
  if the fields don't overlap.

---

## Wire format

```
GET    /api/library                  → full snapshot (cold-launch only)
GET    /api/tracks/:id               → single track
PATCH  /api/tracks/:id  + etag       → field update (optimistic)
POST   /api/playlists                → new playlist
DELETE /api/playlists/:id            → tombstone (not hard delete; see below)
POST   /api/import                   → register a file (server reads metadata)
GET    /api/audio/:id                → audio stream (range support)
GET    /api/artwork/:hash            → artwork bytes
GET    /api/events                   → SSE stream of all mutations
                                       (Last-Event-ID header for resume)
```

Plus three event-only endpoints:
```
event: track-updated      data: { id, fields, etag, ts }
event: track-deleted      data: { id, ts }
event: playlist-updated   data: { id, name, trackIds, etag, ts }
event: setting-updated    data: { key, value, ts }
```

---

## Entity catalog

Every entity that flows through this system. If it's not in this list
and it should be, add it before implementation.

| Entity | Lives where today | Sync semantics |
|---|---|---|
| **Tracks** | `library.json` per device | Server-canonical. Optimistic writes. ETag per track. |
| **Playlists** (regular) | `library.json` per device | Server-canonical. Append-only ordering for adds, soft-delete via tombstone. |
| **Playlists** (smart) | `library.json` per device | Same. Smart-playlist rules live in server, evaluated server-side, results pushed. |
| **Settings** (per-user) | `electron-store` per device | Server-canonical per-user. Push on change. |
| **Persona memory** (MM utterances, Cynthia utterances, radio memory) | `userData/*.json` per device | Server-canonical per-user. Append-only (utterance log) — no conflict resolution needed since each device appends its own. |
| **Listener taste profile** | `userData/listener-profile.json` per device | Server-canonical per-user. Plays/skips append from any device, observations regenerate server-side every 20 plays. |
| **Artwork** | `userData/artwork/` per device | Server stores files. Clients cache. Hash-identity (existing convention). |
| **Picks** (MM / Megan / Stephen weekly) | Computed in-app, weekly Friday rotation | Server computes, all clients see same picks. |
| **Audio files** | `~/Music2/JakeTunesLibrary/iPod_Control/Music/Fnn/...` per device | Server stores. Clients stream over `/api/audio/:id` (or mount the NAS share for direct read — TBD per Phase 1). |
| **Recently Added** | Derived view | Server-side query. No sync state. |

---

## Conflict resolution policy

**Default: last-write-wins by server timestamp, field-level.**

- Two clients edit different fields of the same track simultaneously →
  both succeed, server merges.
- Two clients edit the same field simultaneously → server applies the
  one that arrives second (latest timestamp wins). The first client
  gets a push notification with the new value. UI shows a brief notice:
  *"That edit was overridden by another device."*
- For monotonic counters (playCount, skipCount): server-side increment.
  Client request says `+1`, never `set to N`. Avoids the conflict
  entirely.
- For ordered lists (playlist trackIds): operational-transform-lite —
  server tracks insertions/removals as operations, replays them in
  arrival order. Two clients adding tracks simultaneously both succeed,
  final list contains both adds in some defined order.

**Why not full operational transform / CRDTs:** overkill for a music
app. LWW with field-level granularity handles 99% of real cases. The
1% (concurrent playlist reorder of the same range) gets server-side
linearization. If we ever need true CRDT semantics we can swap in
Automerge later — the wire format is forward-compatible.

---

## Event log + offline catch-up

Server maintains an append-only event log: `events.jsonl` (or SQLite
table). Each event has a monotonic `id`. Client tracks the latest
`lastEventId` it has applied.

On reconnect:
1. Client sends `Last-Event-ID: 12847` in the SSE handshake.
2. Server replays events 12848..current as a burst, then enters live mode.
3. Client applies in order to its local cache.

If client has been offline for >N events (configurable, say 10k) →
server returns "snapshot recommended" and client cold-fetches the full
library snapshot via `GET /api/library`. Avoids replaying 6 months
of events on a laptop that's been off.

Event log retention: 90 days. Older events compacted into a baseline
snapshot.

---

## Schema versioning

Every event includes a schema version: `{ schema: 1, ... }`.

When the schema changes (new field on Track, new entity type), server
bumps to `schema: 2`. Older clients see events with the new schema and
log a warning, fall back to a forced full-library refetch.

Single-author project, so we don't need backward compatibility forever —
a client running an old schema for >30 days is a bug we want to surface,
not silently support.

---

## Offline behavior

When a client can't reach the server:

- **Reads:** local cache serves. UI works normally. Banner: *"Offline —
  showing cached library."*
- **Writes:** queued in `pendingMutations.json`. UI still updates
  optimistically. When server reconnects, queue is drained in order.
  If any queued mutation conflicts with server state on drain, user
  gets per-mutation notice.
- **Playback:** music plays from local file paths (NAS mount or cached
  files). No server dependency.
- **AI assistants (MM, Megan, etc.):** require server (TTS, Claude
  API). Gracefully degrade — show *"AI unavailable, reconnect to
  resume."* No silent failures.

---

## Security / multi-listener (forward-looking, Phase 6)

- Per-user auth (Jake, plus future shared-listener accounts).
- All API endpoints require auth except `/api/health`.
- Settings + listener-profile + persona-memory scoped per-user.
- Library + playlists + artwork shared across users by default
  (one household = one music library).
- Token-based auth via Bearer header. Tokens minted on device-pairing
  flow (Phase 5).

---

## Open questions (need decisions before coding)

1. **SSE or WebSocket?** Recommendation: SSE. Lighter, fits the
   one-way push model, browser-native reconnect. Approve / push back.
2. **Server stack: Node + Express, or Python + FastAPI?**
   The existing `core/` code is Python. The renderer is TS. Two
   options:
   - **(a)** New Node + Express server in `core/server/`, calls into
     Python `db_reader.py` via subprocess for legacy paths. TS-typed
     end-to-end.
   - **(b)** Python FastAPI server. Reuses existing Python helpers
     directly. SSE-native. Requires `uvicorn` + a venv on the Mini PC.
   - Recommendation: **(b) FastAPI.** Reuses existing Python investment
     (db_reader, sync, tag_reader, external API proxies). The renderer
     calling JSON-over-HTTP doesn't care about server language.
3. **Database for the canonical library:** stay on JSON files (single-
   writer is fine since server is the only writer) or move to SQLite?
   - Recommendation: **SQLite.** Atomic transactions, easy concurrent
     reads, query support for smart-playlist evaluation, ~10MB for
     5000-track library. JSON load times become noticeable past ~3000
     tracks.
4. **Audio streaming: NAS mount on every client, or HTTP stream from
   server?**
   - NAS mount: zero server CPU, direct file read, requires SMB/AFP
     on every client (works on Mac, sucks on iOS).
   - HTTP stream: server handles range requests, works on every
     platform, costs server CPU for transcode (if needed) and bandwidth.
   - Recommendation: **HTTP stream via `/api/audio/:id`.** Server
     reads from NAS internally, streams to client. Single code path,
     works on iOS, supports future remote access (off-LAN) without
     VPN. Local Macs on same LAN get gigabit speeds anyway.
5. **Migration strategy from `library.json` to server-canonical:**
   one-shot import on first server startup (server reads laptop's
   `library.json` + audio files, populates SQLite + NAS), or
   gradual? Recommendation: **one-shot.** Stop-the-world for ~30 min,
   cleaner than running both side-by-side.

---

## What this doc does NOT decide

- Specific HTTP framework version, library choices beyond stack picks
- UI changes in JakeTunes (Phase 4 covers this — the renderer adopting
  the API client)
- Auth flow specifics (Phase 6 — when we add multi-listener)
- Bandsintown / news / external API proxying (Phase 2 includes them
  but the proxy logic is straightforward, doesn't need design lock-in)

---

## Sign-off

When you've reviewed:

- [ ] Architectural commitments 1-4 match what you want
- [ ] Entity catalog covers everything (or you've told me what's missing)
- [ ] Conflict resolution policy (LWW + field-level) is acceptable
- [ ] Open questions 1-5 have your decision
- [ ] Implementation can proceed

Then we kick off Phase 2 implementation. Estimated: 3-5 days for the
server + 2-3 days for the Phase 4 client cutover.

Until then, the doc is the contract.
