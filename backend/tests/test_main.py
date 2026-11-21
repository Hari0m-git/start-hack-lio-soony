import pytest
from fastapi.testclient import TestClient

from app.db import connect
from app.main import app


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SOONY_PORTAL_URL", "http://portal")
    monkeypatch.setenv("SOONY_API_TOKEN", "t")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DB_PATH", raising=False)
    return TestClient(app)  # not entered as a context manager, so the watcher does not start


def test_healthz(client):
    assert client.get("/healthz").json() == {"ok": True}


def test_status_before_first_sync(client):
    assert client.get("/api/status").json() == {"files": 0, "last_sync": None, "drops": []}


def test_status_lists_drops_but_not_the_baseline(client, tmp_path):
    conn = connect(tmp_path / "state.sqlite")
    conn.execute("INSERT INTO sync_runs (started_at, listed, new, changed, removed, failed) VALUES ('t0', 2, 2, 0, 0, 0)")
    conn.execute("INSERT INTO files VALUES ('a.csv', 'x', 1, 't0', 't0', NULL)")
    conn.execute("INSERT INTO file_events (run_id, ts, path, kind, baseline) VALUES (1, 't0', 'a.csv', 'new', 1)")
    conn.execute("INSERT INTO file_events (run_id, ts, path, kind, baseline) VALUES (1, 't1', 'b.pdf', 'new', 0)")
    conn.commit()
    body = client.get("/api/status").json()
    assert body["files"] == 1
    assert body["last_sync"]["listed"] == 2
    assert body["drops"] == [{"ts": "t1", "path": "b.pdf", "kind": "new"}]
