import json
from contextlib import closing

import pytest

from app import main
from app.db import connect
from .test_main import client
from .test_truth import put

URL = "/api/cases/PART/concession-approval"
APPROVER = {"X-Access-Key": "approver-test-key"}
PAYLOAD = {"batch": "HOLD", "quantity": 6, "case_updated_at": "2026-01-01T10:00:00"}


@pytest.fixture
def desk(client, tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ACCESS_KEY", "shared-test-key")
    monkeypatch.setenv("APP_USERS", json.dumps([
        {"name": "A. Recorder", "key": "approver-test-key", "role": "approver"},
        {"name": "Observer", "key": "viewer-test-key", "role": "viewer"},
    ]))
    monkeypatch.setattr(main, "send_draft", lambda *a, **k: pytest.fail("Recording an approval must not send mail"))
    decision = {"options": [{"title": "Request a concession"}], "approval": {"required_role": "Procurement"}}
    with closing(connect(tmp_path / "state.sqlite")) as conn:
        put(conn, "product", "products.csv", {"product_id": "P", "launch_date": "2026-01-01"})
        put(conn, "bom", "bom.csv", {"parent_id": "P", "child_id": "PART", "qty_per": 1})
        put(conn, "stock", "stock.csv",
            {"snapshot_date": "2026-01-01", "material_id": "PART", "batch": "FREE", "quantity": 4},
            {"snapshot_date": "2026-01-01", "material_id": "PART", "batch": "HOLD", "quantity": 8})
        put(conn, "doc_hold", "hold.pdf", {"material_id": "PART", "lot": "HOLD"})
        put(conn, "doc_pack_status", "count.pdf",
            {"as_of": "2026-01-01T10:00", "product_id": "P", "still_to_pack": 10, "rate_per_hour": 10})
        put(conn, "doc_shift", "shifts.pdf", {"day": "2026-01-01", "start": "10:00", "end": "20:00"})
        conn.execute(
            """INSERT INTO cases (key, material_id, status, basis, decision, created_at, updated_at)
               VALUES ('part:PART', 'PART', 'proposed', 'x', ?, 't', ?)""",
            (json.dumps(decision), PAYLOAD["case_updated_at"]),
        )
        conn.execute("INSERT INTO messages (case_key, direction, status, created_at) VALUES ('part:PART', 'out', 'internal', 't')")
        conn.commit()
    return client


def test_recorded_concession_is_audited_but_leaves_forecast_and_mail_unchanged(desk):
    before = desk.get("/api/overview", headers=APPROVER).json()
    assert before["cases"][0]["concession_target"] == {"batch": "HOLD", "held_quantity": 8, "suggested_quantity": 6}
    assert before["cases"][0]["concession_approval"] is None
    response = desk.post(URL, headers=APPROVER, json=PAYLOAD)
    assert response.status_code == 201
    record = response.json()
    assert (record["batch"], record["quantity"], record["recorded_by"]) == ("HOLD", 6, "A. Recorder")
    after = desk.get("/api/overview", headers=APPROVER).json()
    assert after["cases"][0]["concession_approval"] == record
    for field in ("forecast", "forecast_if_acted"):
        assert after[field] == before[field]
    assert after["cases"][0]["messages"] == before["cases"][0]["messages"]
    event = after["activity"][0]
    assert (event["kind"], event["at"], event["case_key"]) == ("concession_recorded", record["recorded_at"], "part:PART")
    assert record["recorded_by"] in event["text"]
    assert "6 pieces" in event["detail"]
    assert after["activity"][1:] == before["activity"]
    assert after["audit"][0]["action"] == "recorded external concession approval"
    assert after["audit"][0]["actor"] == "A. Recorder"
    assert desk.post(URL, headers=APPROVER, json=PAYLOAD).status_code == 409


@pytest.mark.parametrize("estimate,quantity,short", [
    ("2026-01-01T18:24+00:00", 6, 0), ("2026-01-01T19:36", 6, 2), ("2026-01-01T12:00", 2, 4),
    ("2026-01-01T20:00", 6, None), (None, 6, None),
])
def test_signed_concession_forecast_uses_quantity_and_timed_release_without_updating_evidence(
    desk, tmp_path, estimate, quantity, short,
):
    with closing(connect(tmp_path / "state.sqlite")) as conn:
        decision = json.loads(conn.execute("SELECT decision FROM cases").fetchone()[0])
        decision["options"][0]["arrives_by"] = estimate
        conn.execute("UPDATE cases SET decision = ?", (json.dumps(decision),))
        conn.commit()
    before = desk.get("/api/overview", headers=APPROVER).json()
    assert before["forecast_with_concessions"] is None
    assert desk.post(URL, headers=APPROVER, json={**PAYLOAD, "quantity": quantity}).status_code == 201
    after = desk.get("/api/overview", headers=APPROVER).json()
    assert after["forecast"] == before["forecast"]
    assert after["forecast_if_acted"] == before["forecast_if_acted"]
    if short is None:
        assert after["forecast_with_concessions"] is None
    else:
        assert after["forecast_with_concessions"]["products"][0]["short"] == short
        assert after["recorded_releases"][0]["quantity"] == quantity


@pytest.mark.parametrize("key", ["shared-test-key", "viewer-test-key"])
def test_read_only_sign_ins_cannot_record_a_concession(desk, key):
    assert desk.post(URL, headers={"X-Access-Key": key}, json=PAYLOAD).status_code == 403


def test_recovery_comparison_separates_launch_shortfall_from_late_parts(desk, tmp_path):
    with closing(connect(tmp_path / "state.sqlite")) as conn:
        decision = json.loads(conn.execute("SELECT decision FROM cases").fetchone()[0])
        decision["options"][0]["arrives_by"] = "2026-01-01T12:00"
        conn.execute("UPDATE cases SET decision = ?", (json.dumps(decision),))
        for qty, eta, firm in [(1, "2026-01-01T13:00", 1), (2, "2026-01-02T13:00", 1),
                               (10, "2026-01-02T14:00", 0), (10, "2026-01-03T13:00", 1)]:
            message_id = conn.execute(
                "INSERT INTO messages (case_key, direction, status, created_at) VALUES ('other', 'in', 'received', 't')"
            ).lastrowid
            conn.execute(
                """INSERT INTO commitments (message_id, case_key, material_id, quantity, dock_at, firm, created_at)
                   VALUES (?, ?, 'PART', ?, ?, ?, 't')""", (message_id, f"other:{message_id}", qty, eta, firm)
            )
        conn.commit()
    assert desk.post(URL, headers=APPROVER, json={**PAYLOAD, "quantity": 2}).status_code == 201
    result = desk.get("/api/overview", headers=APPROVER).json()
    assert result["forecast"]["products"][0]["short"] == 5
    assert result["forecast_with_concessions"]["products"][0]["short"] == 3
    assert result["recovery_comparison"] == {
        "without_supplier_commitments": 6,
        "late_parts": [{"material_id": "PART", "description": "PART", "expected_date": "2026-01-03"}],
    }


def test_demo_recovery_shifts_only_the_modeled_times(desk, tmp_path, monkeypatch):
    with closing(connect(tmp_path / "state.sqlite")) as conn:
        decision = json.loads(conn.execute("SELECT decision FROM cases").fetchone()[0])
        decision["options"][0]["arrives_by"] = "2026-01-01T19:36"
        conn.execute("UPDATE cases SET decision = ?", (json.dumps(decision),))
        put(conn, "bom", "bom.csv", {"parent_id": "P", "child_id": "BOOK", "qty_per": 1})
        put(conn, "stock", "stock.csv",
            {"snapshot_date": "2026-01-01", "material_id": "BOOK", "batch": "ON-HAND", "quantity": 2})
        message_id = conn.execute(
            """INSERT INTO messages (case_key, direction, status, created_at)
               VALUES ('part:BOOK', 'in', 'received', 't')"""
        ).lastrowid
        conn.execute(
            """INSERT INTO commitments (message_id, case_key, material_id, quantity, dock_at, firm, created_at)
               VALUES (?, 'part:BOOK', 'BOOK', 8, '2026-01-01T19:45', 1, 't')""", (message_id,),
        )
        conn.commit()
    settings = {"PART": "2026-01-01T11:00", "BOOK": "2026-01-01T11:00"}
    monkeypatch.setenv("DEMO_READY_TIMES", json.dumps(settings))
    assert desk.get("/api/overview", headers=APPROVER).json()["demo_recovery"] is None
    assert desk.post(URL, headers=APPROVER, json=PAYLOAD).status_code == 201
    result = desk.get("/api/overview", headers=APPROVER).json()
    assert result["forecast_with_concessions"]["products"][0]["short"] > 0
    demo = result["demo_recovery"]
    assert demo["forecast"]["products"][0]["finished_at"] == "2026-01-01T11:48"
    assert demo["forecast"]["products"][0]["short"] == 0
    assert {x["material_id"]: x["ready_at"] for x in demo["targets"]} == settings
    assert result["recorded_releases"][0]["expected_at"] == "2026-01-01T19:36"

    monkeypatch.setenv("DEMO_READY_TIMES", json.dumps({**settings, "UNMATCHED": "2026-01-01T11:00"}))
    without_demo = desk.get("/api/overview", headers=APPROVER).json()
    assert without_demo["demo_recovery"] is None
    for field in ("forecast", "forecast_if_acted", "forecast_with_concessions", "audit", "cases"):
        assert without_demo[field] == result[field]


@pytest.mark.parametrize("changes,status", [
    ({"case_updated_at": "older"}, 409), ({"batch": "FREE"}, 409),
    ({"quantity": 9}, 422), ({"quantity": 0}, 422), ({"quantity": 1.5}, 422),
])
def test_concession_rejects_a_stale_case_wrong_lot_or_invalid_quantity(desk, changes, status):
    assert desk.post(URL, headers=APPROVER, json={**PAYLOAD, **changes}).status_code == status
    assert desk.get("/api/overview", headers=APPROVER).json()["cases"][0]["concession_approval"] is None
