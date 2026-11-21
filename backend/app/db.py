import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    first_seen TEXT NOT NULL,
    last_changed TEXT NOT NULL,
    removed_at TEXT
);
CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    listed INTEGER NOT NULL,
    new INTEGER NOT NULL,
    changed INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    failed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES sync_runs(id),
    ts TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('new', 'changed', 'removed')),
    old_sha256 TEXT,
    new_sha256 TEXT,
    baseline INTEGER NOT NULL DEFAULT 0,
    processed_at TEXT
);
CREATE INDEX IF NOT EXISTS file_events_unprocessed ON file_events (processed_at, id);
CREATE TABLE IF NOT EXISTS mappings (
    signature TEXT PRIMARY KEY,
    example_path TEXT NOT NULL,
    mapping TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    row_no INTEGER NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_entity ON records (entity);
CREATE INDEX IF NOT EXISTS records_source ON records (source_path);
CREATE TABLE IF NOT EXISTS ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'needs_review', 'failed')),
    entity TEXT,
    rows INTEGER NOT NULL DEFAULT 0,
    detail TEXT
);
"""


def connect(db_path: Path | str) -> sqlite3.Connection:
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn
