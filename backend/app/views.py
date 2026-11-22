"""What the interface shows: one page on what can stop a line, and the case behind each item."""

import json
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone

from app.agent import LOCAL, priority_order
from app.forecast import LATEST_COMMITMENTS, simulate
from app.outbox import parse_when
from app.pipeline import DAILY_BUDGET_USD, INFORMATIONAL
from app.truth import Assessment, Facts, Finding, _day, assess


def _messages(conn: sqlite3.Connection, case_key: str) -> list[dict]:
    rows = conn.execute("SELECT * FROM messages WHERE case_key = ? ORDER BY id", (case_key,)).fetchall()
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    rows.sort(key=lambda r: (parse_when(r["sent_at"] or r["created_at"]) or epoch, r["id"]))
    return [{**{k: r[k] for k in ("id", "direction", "status", "counterpart_name", "counterpart_email", "language",
                                  "subject", "body", "body_english", "purpose", "created_at", "sent_at", "commits",
                                  "sent_by", "held_because", "approved_by")},
             "reading": json.loads(r["reading"]) if r["reading"] else None} for r in rows]


def case_state(messages: list[dict], needs_human: str | None = None) -> str:
    """Where a case stands, told from its correspondence rather than stored."""
    mail = [m for m in messages if m["status"] in ("sent", "received") and m["sent_by"] not in ("auto", "other")]
    if needs_human:
        return "needs_human"
    if any(m["status"] == "draft" and (m["commits"] != "nothing" or m["held_because"]) for m in messages):
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
    spend = conn.execute("SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls FROM llm_usage WHERE purpose = ?",
                         (f"case:{row['material_id']}",)).fetchone()
    return {
        "key": row["key"], "material_id": row["material_id"],
        "description": (facts.components.get(row["material_id"]) or {}).get("description"),
        "state": case_state(messages, row["needs_human"]), "needs_human": row["needs_human"],
        "updated_at": row["updated_at"], "cost_usd": round(spend["usd"], 2), "card": decision.get("card"),
        "summary": decision.get("summary"), "why": decision.get("why"),
        "recommended": options[pick] if 0 <= pick < len(options) else None,
        "options": options, "recommended_option": pick, "ruled_out": decision.get("ruled_out") or [],
        "approval": decision.get("approval"), "open_questions": decision.get("open_questions") or [],
        "checks": decision.get("checks") or [], "evidence": decision.get("evidence") or [],
        "trace": json.loads(row["trace"]) if row["trace"] else [], "messages": messages,
    }


def concession_target(case: dict, findings: list[Finding]) -> dict | None:
    """The pilot can record a concession only when there is one unambiguous held lot."""
    required = (case["approval"] or {}).get("required_role")
    if case["needs_human"] or not case["recommended"] or not required or required == "No approval required":
        return None
    statuses = {m["status"] for m in case["messages"]}
    if "internal" not in statuses or statuses & {"draft", "blocked"}:
        return None
    holds = [f for f in findings if f.material_id == case["material_id"] and f.kind == "quality_hold"
             and f.units > 0 and f.data.get("batch")]
    if len(holds) != 1:
        return None
    return {"batch": holds[0].data["batch"], "held_quantity": holds[0].units}


def recorded_concession(conn: sqlite3.Connection, key: str, batch: str | None = None) -> dict | None:
    row = conn.execute(
        """SELECT batch, quantity, recorded_by, recorded_at FROM concession_approvals
           WHERE case_key = ? AND (? IS NULL OR batch = ?) ORDER BY recorded_at DESC LIMIT 1""",
        (key, batch, batch),
    ).fetchone()
    return dict(row) if row else None


def _release_estimate(case: dict, target: dict | None) -> datetime | None:
    approval = case["concession_approval"]
    if not target or not approval or approval["quantity"] > target["held_quantity"]:
        return None
    try:
        estimate = datetime.fromisoformat(case["recommended"]["arrives_by"])
    except (KeyError, TypeError, ValueError):
        return None
    return estimate.astimezone(LOCAL).replace(tzinfo=None) if estimate.tzinfo else estimate


def _late_parts(conn: sqlite3.Connection, assessment: Assessment, forecast: dict, deadline: datetime) -> list[dict]:
    """Find dated receipts that can cover a remaining material gap, not a pack-out or dispatch date."""
    promised = conn.execute(LATEST_COMMITMENTS).fetchall()
    replaced = {(c["material_id"], c["shipment_ref"]) for c in promised if c["shipment_ref"]}
    candidates = {}

    def add(material, day, quantity):
        if day and day > deadline.date() and quantity > 0:
            candidates.setdefault(material, []).append((day, quantity))

    for shipment in assessment.inbound:
        if not shipment.needs_action and not replaced & {
            (shipment.material_id, shipment.shipment_id), (shipment.material_id, shipment.reference),
        }:
            add(shipment.material_id, _day(shipment.dock_date), shipment.credible_qty)
    for commitment in promised:
        if commitment["firm"]:
            add(commitment["material_id"], _day(commitment["dock_at"]), commitment["quantity"])

    return [
        {"material_id": c["material_id"], "description": c["description"] or c["material_id"],
         "expected_date": min(days).isoformat()}
        for c in forecast["components"] if c["gap"] > 0
        if (days := [day for day, qty in candidates.get(c["material_id"], []) if qty >= c["gap"]])
    ]


def _demo_recovery(
    conn: sqlite3.Connection, assessment: Assessment, order: list[str], recovery: dict,
    releases: list[tuple[datetime, str, int]], ready_times: dict[str, datetime],
) -> dict | None:
    """Shift identified arrivals, not quantities. Require an unambiguous match for every demo input."""
    start = datetime.fromisoformat(recovery["as_of"])
    deadline = datetime.fromisoformat(recovery["deadline"])
    components = {c["material_id"]: c for c in recovery["components"]}
    promises = conn.execute(LATEST_COMMITMENTS).fetchall()
    release_times = {}
    commitment_times = {}
    targets = []
    for part, at in ready_times.items():
        if part not in components or not start <= at < deadline:
            return None
        lots = [lot for lot in releases if lot[1] == part]
        expected = [c for c in promises if c["material_id"] == part and c["firm"] and c["quantity"] > 0]
        if len(lots) == 1 and not expected and at < lots[0][0]:
            release_times[part] = at
        elif len(expected) == 1 and not lots:
            try:
                eta = datetime.fromisoformat(expected[0]["dock_at"])
            except (TypeError, ValueError):
                return None
            if not at < eta.replace(tzinfo=None):
                return None
            commitment_times[expected[0]["id"]] = at
        else:
            return None
        targets.append({"material_id": part, "description": components[part]["description"] or part,
                        "ready_at": at.isoformat(timespec="minutes")})
    forecast = simulate(
        conn, assessment, order, with_actions=True, commitment_times=commitment_times,
        planned_releases=tuple((release_times.get(part, at), part, qty) for at, part, qty in releases),
    )
    return {"forecast": forecast, "targets": targets, "late_parts": _late_parts(conn, assessment, forecast, deadline)}


def overview(conn: sqlite3.Connection, now: datetime, demo_ready_times: dict[str, datetime] | None = None) -> dict:
    facts = Facts(conn)
    assessment = assess(conn, now.date())
    priority = priority_order(conn)
    evidence = simulate(conn, assessment, priority["order"])
    erp = simulate(conn, assessment, priority["order"], trust_erp=True)
    acted = simulate(conn, assessment, priority["order"], with_actions=True)
    deadline = datetime.fromisoformat(evidence["deadline"]) if evidence["ready"] else None
    components = {c["material_id"]: c for c in evidence.get("components", [])}
    short = {m for m, c in components.items() if c["gap"] > 0 or c["inbound_needing_action"] > 0}

    findings = []
    for f in assessment.findings:
        level = "info" if f.kind in INFORMATIONAL else "stops_line" if f.material_id in short else "watch"
        findings.append({**asdict(f), "level": level,
                         "description": (facts.components.get(f.material_id) or {}).get("description")})
    findings.sort(key=lambda f: ("stops_line", "watch", "info").index(f["level"]))

    cases = [_case(conn, r, facts) for r in conn.execute("SELECT * FROM cases ORDER BY key")]
    # What each fix is worth on its own. A line needs every part, so fixes do not simply add up.
    base = {p["product_id"]: p["short"] for p in evidence.get("products", [])}
    open_parts = frozenset(c["material_id"] for c in cases)
    releases = []
    recorded_releases = []
    for case in cases:
        target = concession_target(case, assessment.findings)
        case["concession_target"] = None if target is None else {
            **target, "suggested_quantity": min(target["held_quantity"],
                                               int(components.get(case["material_id"], {}).get("gap", 0))),
        }
        case["concession_approval"] = recorded_concession(conn, case["key"], target["batch"] if target else None)
        estimate = _release_estimate(case, target)
        if estimate and deadline and estimate < deadline and case["material_id"] in components:
            approval = case["concession_approval"]
            releases.append((estimate, case["material_id"], approval["quantity"]))
            recorded_releases.append({"case_key": case["key"], "description": case["description"] or case["material_id"],
                                      "quantity": approval["quantity"], "recorded_at": approval["recorded_at"],
                                      "expected_at": estimate.isoformat(timespec="minutes")})
        alone = simulate(conn, assessment, priority["order"], covered=frozenset({case["material_id"]}))
        after = {p["product_id"]: p for p in alone.get("products", [])}
        case["saves_alone"] = sum(base[p] - after[p]["short"] for p in base if p in after)
        blockers = {after[p]["first_stop"]["material_id"] for p in after if after[p]["short"] > 0 and after[p]["first_stop"]}
        case["then_limited_by"] = sorted((facts.components.get(b) or {}).get("description") or b
                                         for b in blockers & (open_parts - {case["material_id"]}))
    solved = simulate(conn, assessment, priority["order"], covered=open_parts)
    plan = {"short_now": sum(base.values()),
            "short_if_all_solved": sum(p["short"] for p in solved.get("products", [])) if solved.get("ready") else None}
    recovery = simulate(conn, assessment, priority["order"], with_actions=True, planned_releases=tuple(releases)) if releases else None
    recovery_comparison = None
    demo_recovery = None
    if recovery and recovery["ready"] and deadline:
        before = simulate(conn, assessment, priority["order"], include_commitments=False) if conn.execute(
            "SELECT 1 FROM commitments LIMIT 1").fetchone() else evidence
        recovery_comparison = {
            "without_supplier_commitments": sum(p["short"] for p in before["products"]),
            "late_parts": _late_parts(conn, assessment, recovery, deadline),
        }
        if demo_ready_times:
            demo_recovery = _demo_recovery(conn, assessment, priority["order"], recovery, releases, demo_ready_times)
    last_sync = conn.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").fetchone()
    drops = conn.execute("SELECT ts, path, kind FROM file_events WHERE baseline = 0 ORDER BY id DESC LIMIT 30").fetchall()
    review = conn.execute(
        """SELECT path, detail FROM ingest_log l WHERE status = 'needs_review'
           AND id = (SELECT MAX(id) FROM ingest_log WHERE path = l.path)""").fetchall()
    return {
        "now": now.isoformat(timespec="minutes"),
        "forecast": evidence, "erp_forecast": erp, "forecast_if_acted": acted, "priority": priority,
        "forecast_with_concessions": recovery, "recorded_releases": recorded_releases,
        "recovery_comparison": recovery_comparison,
        "demo_recovery": demo_recovery,
        "findings": findings, "cases": cases, "plan": plan,
        "drops": [dict(d) for d in drops], "last_sync": dict(last_sync) if last_sync else None,
        "files": conn.execute("SELECT COUNT(*) FROM files WHERE removed_at IS NULL").fetchone()[0],
        "documents_read": conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
        "needs_review": [dict(r) for r in review],
        "spend": spend(conn, now),
        "audit": [dict(r) for r in conn.execute("SELECT ts, actor, action, case_key, detail FROM audit ORDER BY id DESC LIMIT 60")],
        "activity": activity(conn, facts),
        "foreign_mail": [dict(r) for r in conn.execute(
            "SELECT counterpart_name, subject, sent_at FROM messages WHERE direction = 'out' AND sent_by = 'other' ORDER BY id")],
        "agent_work": {
            "sent_by_agents": conn.execute("SELECT COUNT(*) FROM messages WHERE status = 'sent' AND sent_by = 'agent'").fetchone()[0],
            "approved_by_people": conn.execute("SELECT COUNT(*) FROM messages WHERE status = 'sent' AND COALESCE(sent_by, 'human') = 'human'").fetchone()[0],
            "replies": conn.execute("SELECT COUNT(*) FROM messages WHERE status = 'received' AND COALESCE(sent_by, '') != 'auto'").fetchone()[0],
            "findings": sum(f["level"] != "info" for f in findings),
        },
    }


def activity(conn: sqlite3.Connection, facts: Facts, limit: int = 40) -> list[dict]:
    """Recent file, mail, handover and concession approval events, newest first."""
    name = lambda key: (facts.components.get((key or "").removeprefix("part:")) or {}).get("description") or key
    items = []
    for r in conn.execute("SELECT run_id, MIN(ts) AS ts, COUNT(*) AS n, GROUP_CONCAT(path, '|') AS paths FROM file_events "
                          "WHERE baseline = 0 GROUP BY run_id"):
        files = [p.rsplit("/", 1)[-1] for p in r["paths"].split("|")]
        items.append({"at": r["ts"], "kind": "files", "case_key": None,
                      "text": f"{r['n']} new or changed file{'s' if r['n'] > 1 else ''} arrived",
                      "detail": ", ".join(files[:6]) + ("…" if len(files) > 6 else "")})
    for m in conn.execute("SELECT * FROM messages WHERE status IN ('sent', 'received')"):
        if m["status"] == "received":
            reading = json.loads(m["reading"]) if m["reading"] else {}
            said = "sent an automatic reply about" if m["sent_by"] == "auto" else "answered about"
            items.append({"at": m["sent_at"], "kind": "reply", "case_key": m["case_key"],
                          "text": f"{m['counterpart_name']} {said} {name(m['case_key'])}", "detail": reading.get("summary")})
        else:
            who = ("The agent asked" if m["sent_by"] == "agent" else "Something other than the agents wrote to"
                   if m["sent_by"] == "other" else "A person approved a message to"
                   if m["sent_by"] == "human" else "An older desk message (approver not recorded) went to")
            items.append({"at": m["sent_at"], "kind": {"agent": "sent_by_agent", "other": "foreign"}.get(m["sent_by"], "sent_by_human"),
                          "case_key": m["case_key"], "text": f"{who} {m['counterpart_name']} about {name(m['case_key'])}",
                          "detail": m["subject"]})
    for c in conn.execute("SELECT key, needs_human, updated_at FROM cases WHERE needs_human IS NOT NULL"):
        items.append({"at": c["updated_at"], "kind": "handover", "case_key": c["key"],
                      "text": f"The agent handed {name(c['key'])} to a person", "detail": c["needs_human"]})
    for approval in conn.execute("SELECT * FROM concession_approvals"):
        key = approval["case_key"]
        items.append({"at": approval["recorded_at"], "kind": "concession_recorded", "case_key": key,
                      "text": f"{approval['recorded_by']} recorded an external concession approval for {name(key)}",
                      "detail": f"{approval['quantity']:,} pieces, lot {approval['batch']}. This does not confirm warehouse release."})
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    items.sort(key=lambda i: parse_when(i["at"]) or epoch, reverse=True)
    for i in items:
        moment = parse_when(i["at"])
        i["at"] = moment.isoformat(timespec="seconds") if moment else None
    return items[:limit]


def whatif(conn: sqlite3.Connection, now: datetime, parts: set[str]) -> dict:
    """The forecast if the given parts were no longer short. Pure arithmetic: nothing is stored, sent or paid for."""
    assessment = assess(conn, now.date())
    return simulate(conn, assessment, priority_order(conn)["order"], covered=frozenset(parts))


def spend(conn: sqlite3.Connection, now: datetime) -> dict:
    """What the agents have cost today, by kind of work."""
    start = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
    kinds = {"reading files": "purpose IN ('record_document', 'map_columns')", "working cases": "purpose LIKE 'case:%'",
             "assistant": "purpose = 'assistant'", "transcription": "purpose = 'voice:transcribe'",
             "synthesis": "purpose = 'voice:speak'", "reading replies": "purpose = 'reply'", "translations and checks": "purpose IN ('translate', 'guard', 'set_priority')"}
    by_kind = {name: conn.execute(f"SELECT COALESCE(SUM(cost_usd), 0), COUNT(*) FROM llm_usage WHERE ts >= ? AND {where}",
                                  (start,)).fetchone() for name, where in kinds.items()}
    return {"today_usd": round(sum(v[0] for v in by_kind.values()), 2), "budget_usd": DAILY_BUDGET_USD,
            "by_kind": [{"kind": k, "usd": round(v[0], 2), "calls": v[1]} for k, v in by_kind.items()]}
