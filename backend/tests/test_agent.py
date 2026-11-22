import json
from datetime import datetime, timezone

import pytest

from app import agent
from app.truth import assess
from tests.test_truth import TODAY, conn, put  # noqa: F401 (conn is a fixture)


def test_document_search_includes_separate_offer_terms_from_the_matching_file(conn):
    offer = "suppliers/offer.pdf"
    put(conn, "doc_fact", offer,
        {"kind": "offer", "statement": "Part X-91 can be prepared in four hours."},
        {"kind": "delay", "statement": "Transport takes six further hours.", "quote": "Six hours after collection."})
    put(conn, "doc_fact", "suppliers/unrelated.pdf",
        {"kind": "delay", "statement": "Transport takes two hours."})

    result = agent.Toolbox(conn, assess(conn, TODAY), []).search_documents([" X-91 "], kinds=["offer"])

    assert result["count"] == 1
    assert result["results"][0]["path"] == offer
    assert result["document_context"] == {
        offer: [{"kind": "delay", "statement": "Transport takes six further hours.", "quote": "Six hours after collection."}],
    }


def test_document_context_does_not_truncate_the_tool_response(conn):
    offer = "suppliers/offer.pdf"
    put(conn, "doc_fact", offer,
        {"kind": "offer", "statement": "Offer for X-91."},
        {"kind": "deadline", "statement": "Loading starts only after approval."},
        *({"kind": "delay", "statement": f"Related condition {i}: " + "text " * 900} for i in range(20)))

    result = agent.Toolbox(conn, assess(conn, TODAY), []).search_documents(["X-91"])

    assert result["results"][0]["statement"] == "Offer for X-91."
    notes = result["document_context"][offer]
    assert notes[0]["statement"] == "Loading starts only after approval."
    assert len(notes) < 20
    assert len(json.dumps(result, ensure_ascii=False)) <= agent.MAX_RESULT_CHARS


def _call(name, args):
    return {"role": "assistant", "tool_calls": [{
        "id": "call", "type": "function", "function": {"name": name, "arguments": json.dumps(args)},
    }]}


def test_case_requires_a_targeted_document_search_but_can_proceed_with_no_matches(conn, monkeypatch):
    option = {"title": "Ask for a quote", "copies_saved": 0}
    decision = {"options": [option], "recommended_option": 0, "actions": []}

    def respond(messages, tools, purpose):
        responses = [json.loads(m["content"]) for m in messages if m["role"] == "tool"]
        if len(responses) in (0, 2, 4):
            if not responses:
                assert "Saturday 21 Nov 2026, 23:30 (Europe/Berlin)" in messages[1]["content"]
            if len(responses) == 4:
                assert responses[-1]["count"] == 0
            return _call("submit_decision", decision)
        assert responses[-1]["received"] is False
        return _call("search_documents", {"keywords": ["  "] if len(responses) == 1 else ["no-such-part"]})

    monkeypatch.setattr(agent.llm, "chat", respond)
    monkeypatch.setattr(agent, "plain_card", lambda *args: {})
    result = agent.run_case(conn, "B", datetime(2026, 11, 21, 22, 30, tzinfo=timezone.utc))

    assert len(result["trace"]) == 5
    assert result["decision"]["options"][0]["title"] == option["title"]
    assert conn.execute("SELECT material_id FROM cases").fetchone()["material_id"] == "B"


def test_failed_document_search_does_not_allow_a_decision_to_be_saved(conn, monkeypatch):
    replies = iter([_call("search_documents", {"keywords": None}),
                    _call("submit_decision", {"options": [{"title": "Guess"}]})])
    monkeypatch.setattr(agent, "MAX_STEPS", 2)
    monkeypatch.setattr(agent.llm, "chat", lambda *args, **kw: next(replies))

    with pytest.raises(RuntimeError, match="did not complete a targeted document search"):
        agent.run_case(conn, "B")

    assert conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0] == 0
