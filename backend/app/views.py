"""What the interface shows: one page on what can stop a line, and the case behind each item."""

import json
import sqlite3
from dataclasses import asdict
from datetime import datetime

from app.agent import priority_order
from app.forecast import simulate
from app.pipeline import INFORMATIONAL
from app.truth import Facts, assess


def _messages(conn: sqlite3.Connection, case_key: str) -> list[dict]:
    rows = conn.execute("SELECT * FROM messages WHERE case_key = ? ORDER BY COALESCE(sent_at, created_at), id", (case_key,))
    return [{**{k: r[k] for k in ("id", "direction", "status", "counterpart_name", "counterpart_email", "language",
                                  "subject", "body", "body_english", "purpose", "created_at", "sent_at")},
             "reading": json.loads(r["reading"]) if r["reading"] else None} for r in rows]


def case_state(messages: list[dict]) -> str:
    """Where a case stands, told from its correspondence rather than stored."""
    mail = [m for m in messages if m["status"] in ("sent", "received")]
    if any(m["status"] == "draft" for m in messages):
        return "needs_approval"
    if mail and mail[-1]["direction"] == "in":
        return "supplier_answered"
    if mail:
        return "waiting_for_supplier"
    return "proposed"


def _case(conn: sqlite3.Connection, row: sqlite3.Row, facts: Facts) -> dict:
    decision = json.loads(row["decision"]) if row["decision"] else {}
    messages = _messages(conn, row["key"])
    options = decision.get("options") or []
    pick = decision.get("recommended_option", 0)
    return {
        "key": row["key"], "material_id": row["material_id"],
        "description": (facts.components.get(row["material_id"]) or {}).get("description"),
        "state": case_state(messages), "updated_at": row["updated_at"],
        "summary": decision.get("summary"), "why": decision.get("why"),
        "recommended": options[pick] if 0 <= pick < len(options) else None,
        "options": options, "recommended_option": pick, "ruled_out": decision.get("ruled_out") or [],
        "approval": decision.get("approval"), "open_questions": decision.get("open_questions") or [],
        "checks": decision.get("checks") or [], "evidence": decision.get("evidence") or [],
        "trace": json.loads(row["trace"]) if row["trace"] else [], "messages": messages,
    }


def overview(conn: sqlite3.Connection, now: datetime) -> dict:
    facts = Facts(conn)
    assessment = assess(conn, now.date())
    priority = priority_order(conn)
    evidence = simulate(conn, assessment, priority["order"])
    erp = simulate(conn, assessment, priority["order"], trust_erp=True)
    acted = simulate(conn, assessment, priority["order"], with_actions=True)
    short = {c["material_id"] for c in evidence.get("components", []) if c["gap"] > 0 or c["inbound_needing_action"] > 0}

    findings = []
    for f in assessment.findings:
        level = "info" if f.kind in INFORMATIONAL else "stops_line" if f.material_id in short else "watch"
        findings.append({**asdict(f), "level": level,
                         "description": (facts.components.get(f.material_id) or {}).get("description")})
    findings.sort(key=lambda f: ("stops_line", "watch", "info").index(f["level"]))

    cases = [_case(conn, r, facts) for r in conn.execute("SELECT * FROM cases ORDER BY key")]
    last_sync = conn.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").fetchone()
    drops = conn.execute("SELECT ts, path, kind FROM file_events WHERE baseline = 0 ORDER BY id DESC LIMIT 30").fetchall()
    review = conn.execute(
        """SELECT path, detail FROM ingest_log l WHERE status = 'needs_review'
           AND id = (SELECT MAX(id) FROM ingest_log WHERE path = l.path)""").fetchall()
    return {
        "now": now.isoformat(timespec="minutes"),
        "forecast": evidence, "erp_forecast": erp, "forecast_if_acted": acted, "priority": priority,
        "findings": findings, "cases": cases,
        "drops": [dict(d) for d in drops], "last_sync": dict(last_sync) if last_sync else None,
        "files": conn.execute("SELECT COUNT(*) FROM files WHERE removed_at IS NULL").fetchone()[0],
        "documents_read": conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
        "needs_review": [dict(r) for r in review],
    }
