import json

import pytest

from app import agent, llm, main
from .test_main import add_draft, client

PERSONAL = {"X-Access-Key": "alice-key"}
SHARED = {"X-Access-Key": "desk-key"}


@pytest.fixture
def desk(client, monkeypatch):
    monkeypatch.setenv("APP_ACCESS_KEY", "desk-key")
    monkeypatch.setenv("OPENAI_API_KEY", "test-only")
    monkeypatch.setenv("APP_USERS", json.dumps([{"name": "Alice", "key": "alice-key", "role": "admin"}]))
    return client


def test_context_requires_the_same_key(desk, monkeypatch):
    payloads = []

    def respond(conn, messages, tools):
        payloads.append(messages)
        return {"role": "assistant", "content": "Answer"}

    monkeypatch.setattr(llm, "assistant_chat", respond)
    assert desk.post("/api/assistant/turn", json={"message": "Where?"}).status_code == 401
    first = desk.post("/api/assistant/turn", headers=PERSONAL, json={"message": "Where?"})
    assert first.status_code == 200
    payload = {"message": "And when?", "conversation_id": first.json()["conversation_id"], "language": "pl"}
    assert desk.post("/api/assistant/turn", headers=SHARED, json=payload).status_code == 404
    assert desk.post("/api/assistant/turn", headers=PERSONAL, json=payload).status_code == 200
    assert [item["content"] for item in payloads[-1][1:]] == ["Where?", "Answer", "And when?"]


@pytest.mark.parametrize("tool", [
    "approve", "send_draft", "approve_and_send", "edit_draft", "rework", "run_case",
    "submit_decision", "call", "contacts", "POST /api/messages/1/send",
    "PATCH /api/messages/1", "POST /api/cases/X/rework",
])
def test_model_cannot_dispatch_write_operations(desk, monkeypatch, tool):
    def forbid(*args, **kwargs):
        pytest.fail("dispatched a procurement write operation")

    for handler in ("may_approve", "send_draft", "approve_and_send", "edit_draft", "rework", "run_case"):
        monkeypatch.setattr(main, handler, forbid)
    monkeypatch.setattr(agent, "run_case", forbid)
    monkeypatch.setattr(agent.Toolbox, "call", forbid)

    def respond(conn, messages, tools):
        assert {item["function"]["name"] for item in tools} == {
            "launch_forecast", "part_info", "search_documents", "policies", "saved_case",
        }
        if messages[-1]["role"] != "tool":
            return {"role": "assistant", "tool_calls": [
                {"id": "write", "type": "function", "function": {"name": tool, "arguments": "{}"}},
            ]}
        assert "Tool unavailable" in messages[-1]["content"]
        return {"role": "assistant", "content": "Open the case to review."}

    monkeypatch.setattr(llm, "assistant_chat", respond)
    response = desk.post("/api/assistant/turn", headers=PERSONAL, json={"message": "Do it for me"})
    assert response.status_code == 200


def test_shared_key_cannot_use_existing_write_routes_with_personal_users(desk, tmp_path, monkeypatch):
    conn, message_id = add_draft(tmp_path)
    monkeypatch.setenv("AGENTS", "on")
    monkeypatch.setattr(main, "_mailbox", lambda settings: object())
    monkeypatch.setattr(main, "send_draft", lambda *args, **kwargs: pytest.fail("shared key sent a draft"))
    assert desk.post(f"/api/messages/{message_id}/send", headers=SHARED).status_code == 403
    assert desk.patch(f"/api/messages/{message_id}", headers=SHARED, json={"subject": "x", "body": "y"}).status_code == 403
    assert desk.post("/api/cases/X/rework", headers=SHARED).status_code == 403
    assert desk.get("/api/me", headers=SHARED).json()["verified"] is False
    assert tuple(conn.execute("SELECT subject, body, status FROM messages").fetchone()) == ("Old", "Old body", "draft")
    conn.close()


def test_saved_case_evidence_is_validated_and_drafts_are_not_exposed(desk, tmp_path, monkeypatch):
    conn, _ = add_draft(tmp_path)
    conn.execute("INSERT INTO files VALUES ('valid.pdf', 'x', 1, 't0', 't0', NULL)")
    decision = {"summary": "Supply is short", "evidence": ["valid.pdf", "unknown.pdf"]}
    conn.execute(
        "INSERT INTO cases (key, material_id, status, basis, decision, created_at, updated_at) "
        "VALUES ('part:X', 'X', 'proposed', 'basis', ?, 't0', 't0')", (json.dumps(decision),),
    )
    conn.commit()

    def respond(_conn, messages, _tools):
        if messages[-1]["role"] != "tool":
            return {"role": "assistant", "tool_calls": [{
                "id": "read", "type": "function",
                "function": {"name": "saved_case", "arguments": '{"material_id": "X"}'},
            }]}
        assert "Supply is short" in messages[-1]["content"]
        assert "Old body" not in messages[-1]["content"]
        return {"content": "Supply is short."}

    monkeypatch.setattr(llm, "assistant_chat", respond)
    answer = desk.post("/api/assistant/turn", headers=PERSONAL, json={"message": "What is happening with X?"}).json()
    assert answer["cases"] == ["part:X"]
    assert answer["evidence"] == ["valid.pdf"]
    assert tuple(conn.execute("SELECT subject, status FROM messages").fetchone()) == ("Old", "draft")
    conn.close()


def test_timestamps_in_an_answer_get_their_weekday_from_code(desk, monkeypatch):
    monkeypatch.setattr(llm, "assistant_chat", lambda *args: {"content": "The line stops at 2026-11-22T11:16 and at 2026-11-21T21:50:00."})
    answer = desk.post("/api/assistant/turn", headers=PERSONAL, json={"message": "When?"}).json()["answer"]
    assert answer == "The line stops at Sun 11:16 and at Sat 21:50."
