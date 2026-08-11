"""CLI entry: python -m boom"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="JakeTunes Boom API (Phase 2)")
    parser.add_argument("--host", default=os.environ.get("BOOM_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BOOM_PORT", "3001")))
    parser.add_argument(
        "--db",
        default=os.environ.get("BOOM_DB_PATH"),
        help="SQLite path (default ~/JakeTunesState/boom/library.sqlite)",
    )
    parser.add_argument(
        "--import-library",
        default=os.environ.get("BOOM_IMPORT_LIBRARY"),
        help="One-shot library.json import when DB has no events",
    )
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    if args.db:
        os.environ["BOOM_DB_PATH"] = str(Path(args.db).expanduser())
    if args.import_library:
        os.environ["BOOM_IMPORT_LIBRARY"] = str(Path(args.import_library).expanduser())
    elif "BOOM_IMPORT_LIBRARY" in os.environ and not os.environ["BOOM_IMPORT_LIBRARY"].strip():
        del os.environ["BOOM_IMPORT_LIBRARY"]

    import uvicorn

    uvicorn.run(
        "boom.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
