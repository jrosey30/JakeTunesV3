# JakeTunes Boom API (Phase 2)

Server-authoritative library + SSE push — the “BOOM, it’s on every device”
architecture from `docs/phase-2-design.md`.

## Decisions (locked)

| Question | Choice |
|----------|--------|
| Transport | **SSE** (`GET /api/events`) |
| Stack | **Python FastAPI** + uvicorn |
| Store | **SQLite** (WAL) |
| Audio | **HTTP Range** `/api/audio/:id` |
| Migration | **One-shot** import from `library.json` |

## Run locally

```bash
cd server/boom
pip install -r requirements.txt
PYTHONPATH=. python -m boom --port 3001 \
  --import-library ~/path/to/library.json   # only when DB empty
```

Health: `curl http://127.0.0.1:3001/healthz`

## Deploy on homemini

```bash
# from MacBook after this lands on main:
ssh jakerosenbaumnas@homemini 'cd ~/JakeTunesV3 && git pull && ./server/boom/deploy/install-on-mini.sh'
```

Default listen: `0.0.0.0:3001` (alongside mobile backend `:3000`).

Env:

| Variable | Meaning |
|----------|---------|
| `BOOM_PORT` | default `3001` |
| `BOOM_DB_PATH` | `~/JakeTunesState/boom/library.sqlite` |
| `BOOM_MUSIC_ROOT` | `~/Music/JakeTunesLibrary` |
| `BOOM_IMPORT_LIBRARY` | one-shot `library.json` when DB has no events |

## Desktop client (opt-in)

In JakeTunes `app-settings.json`:

```json
{
  "library": {
    "boomUrl": "http://homemini:3001"
  }
}
```

Or set env `BOOM_URL`. When unset, Boom is fully dormant — today’s rsync
orchestrator is unchanged.

With Boom enabled, the main process:

1. Dual-writes imports / metadata patches / playlists to the API
2. Subscribes to SSE and merges remote changes into local `library.json`
   (existing `library-external-change` hot-reload)
3. If the server is empty on first connect, seeds it from local library
   (one-shot migration)

## API surface

```
GET    /healthz
GET    /api/library
GET    /api/tracks/:id
POST   /api/tracks
PATCH  /api/tracks/:id   (+ optional etag, increment)
DELETE /api/tracks/:id
POST   /api/playlists
DELETE /api/playlists/:id
POST   /api/import
GET    /api/events       (SSE)
GET    /api/audio/:id    (Range)
```

## Tests

```bash
cd server/boom && PYTHONPATH=. python -m unittest tests.test_api -v
# from repo root:
npm test   # includes src/main/__tests__/boom.test.ts
```

## Not in this slice

- Full renderer cutover away from local SoT (`LibraryContext` still owns UI state)
- Auth / multi-listener
- Retiring the rsync homemini sync script (runs in parallel until cutover)
- Mobile app speaking Boom natively
