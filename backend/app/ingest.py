"""Read every file version that has not been read yet: `uv run python -m app.ingest`.

Pass `--all` to read everything again, e.g. after the canonical vocabulary changed.
"""

import logging
import sqlite3
import sys
from pathlib import Path

from app.config import get_settings
from app.db import connect
from app.tabular import IngestResult, TabularIngest

log = logging.getLogger(__name__)


def pending(conn: sqlite3.Connection, everything: bool = False) -> list[sqlite3.Row]:
    unread = "" if everything else (
        "AND NOT EXISTS (SELECT 1 FROM ingest_log l WHERE l.path = f.path AND l.sha256 = f.sha256)")
    return conn.execute(
        f"SELECT f.path, f.sha256 FROM files f WHERE f.removed_at IS NULL {unread} ORDER BY f.path"
    ).fetchall()


def ingest_pending(conn: sqlite3.Connection, data_dir: Path, everything: bool = False) -> list[tuple[str, IngestResult]]:
    tabular, results = TabularIngest(conn), []
    for f in pending(conn, everything):
        if not f["path"].lower().endswith(".csv"):
            continue
        raw = (data_dir / "blobs" / f["sha256"]).read_bytes()
        try:
            results.append((f["path"], tabular.ingest(f["path"], f["sha256"], raw)))
        except Exception as e:
            # One unreadable file must not stop the others; it is retried on the next run.
            log.exception("could not ingest %s", f["path"])
            results.append((f["path"], IngestResult("failed", None, 0, f"{type(e).__name__}: {e}")))
    return results


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    s = get_settings()
    for path, r in ingest_pending(connect(s.db_path), s.data_dir, everything="--all" in sys.argv):
        print(f"{r.status:12} {r.entity or '-':20} {r.rows:>5}  {path}  {r.detail}")
