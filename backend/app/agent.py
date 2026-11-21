"""The decision agent: one case per part that can stop a line.

It investigates with tools over the canonical facts, weighs what can still arrive
before the trucks leave, checks who may sign, and hands a human one recommendation
with the messages needed to carry it out. It never sends anything itself.
"""

import hashlib
import json
import logging
import sqlite3
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from app import llm
from app.forecast import simulate
from app.truth import Assessment, Facts, assess, load

log = logging.getLogger(__name__)

LOCAL = ZoneInfo("Europe/Berlin")  # the portal states all times in Europe/Berlin
MAX_STEPS = 14
MAX_RESULT_CHARS = 14_000
POLICY_KINDS = ("approval_rule", "role", "priority", "obligation")

SYSTEM = """You are the decision agent of a procurement team that has hours, not days. A part threatens the \
launch. Your job is to hand the responsible person one recommendation they can approve with a single click.

How you work:
- Establish the facts with the tools before you conclude anything. Never state a number, name, date, price or \
rule that a tool did not give you. If something you need is not in the data, say so under open_questions and make \
asking for it your first action.
- Look for every way the missing quantity could still be on the dock before the deadline: supplier offers and \
notices, stock the supplier holds, open orders and shipments that could be expedited, a second source, a lot that \
could be released. Give each option its cost, the copies it saves and when it arrives.
- Check the approval policy and the organisation chart: who may approve this, and is that position filled? If the \
policy names a role that is vacant, say who decides instead according to the policy.
- List only options that can put parts on the dock in time; name what you ruled out in one line each under ruled_out. Recommend exactly one option and say why in terms of cost against copies saved.
- The case tells you the current time and when the line stops. Parts are needed on the dock before the line stops, not merely before the deadline. Ask for answers within a time that is still ahead and realistic.
- Write dates and times the way a person would ("Sunday 22 Nov, 11:00 CET"), never as ISO strings.
- Draft every message needed to execute it. Write to a supplier in the supplier's preferred language, short and \
specific: order and document numbers, quantities, the time by which you need an answer, and the exact questions. \
Give an English translation. Sign as "Soony Procurement (AI assistant, on behalf of Soony Interactive GmbH)". \
Internal escalations are in English and fit on a phone screen.
- You do not send anything. A human approves each message.

Finish by calling submit_decision."""

TOOLS = [
    {"name": "launch_forecast", "description": "The pack-out forecast until the deadline: per product what will be "
     "short and which part stops the line when; per part need, stock, inbound and gap. Also what the ERP alone would say.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "part_info", "description": "Everything known about one part: where it is used, stock by batch (ERP vs "
     "usable, with reasons), inbound shipments, open orders, and the suppliers who can deliver it with contact, "
     "language, price, lead time and minimum order quantity.",
     "parameters": {"type": "object", "required": ["material_id"], "properties": {"material_id": {"type": "string"}}}},
    {"name": "search_documents", "description": "Search what the documents say (offers, notices, contracts, "
     "confirmations, memos, inspection reports). All keywords must occur. Returns statements with the original wording "
     "and the file they come from.",
     "parameters": {"type": "object", "required": ["keywords"], "properties": {
         "keywords": {"type": "array", "items": {"type": "string"}, "description": "e.g. a part id, a supplier name, 'rush'"},
         "supplier_id": {"type": "string"},
         "kinds": {"type": "array", "items": {"type": "string"}, "description": "Optional: offer, availability, capacity, "
                   "deadline, delay, price, penalty, quality, release, obligation, risk"}}}},
    {"name": "policies", "description": "The approval rules, the launch priorities and who holds which role, each with "
     "its source.", "parameters": {"type": "object", "properties": {}}},
    {"name": "submit_decision", "description": "Hand over the finished recommendation.",
     "parameters": {"type": "object", "required": ["summary", "options", "recommended_option", "why", "approval", "actions", "evidence"],
                    "properties": {
         "summary": {"type": "string", "description": "What is wrong and what it costs if nobody acts, two sentences."},
         "options": {"type": "array", "items": {"type": "object", "required": ["title", "description", "copies_saved"], "properties": {
             "title": {"type": "string"}, "description": {"type": "string"},
             "copies_saved": {"type": "number"}, "cost": {"type": ["number", "null"]}, "currency": {"type": ["string", "null"]},
             "arrives_by": {"type": ["string", "null"], "description": "ISO datetime the goods are on the dock, if known"},
             "risks": {"type": ["string", "null"]}, "evidence": {"type": "array", "items": {"type": "string"}}}}},
         "recommended_option": {"type": "integer", "description": "Index into options, starting at 0"},
         "why": {"type": "string"},
         "approval": {"type": "object", "required": ["required_role", "basis"], "properties": {
             "required_role": {"type": "string"}, "person": {"type": ["string", "null"]},
             "basis": {"type": "string", "description": "The rule this follows from, with its source"},
             "note": {"type": ["string", "null"]}}},
         "actions": {"type": "array", "items": {"type": "object", "required": ["type", "to_name", "subject", "body", "purpose"], "properties": {
             "type": {"type": "string", "enum": ["email_supplier", "internal_escalation"]},
             "to_name": {"type": "string"}, "to_email": {"type": ["string", "null"]},
             "language": {"type": ["string", "null"]}, "subject": {"type": "string"}, "body": {"type": "string"},
             "body_english": {"type": ["string", "null"]}, "purpose": {"type": "string"}}}},
         "ruled_out": {"type": "array", "items": {"type": "string"}},
         "open_questions": {"type": "array", "items": {"type": "string"}},
         "evidence": {"type": "array", "items": {"type": "string"}, "description": "Paths of the files this rests on"}}}},
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def priority_order(conn: sqlite3.Connection) -> dict:
    """Which product comes first when a shared part is short, as the customer's documents state it."""
    statements = [{"statement": f["statement"], "quote": f.get("quote"), "date": f.get("doc_date"), "path": f["_source"]}
                  for f in load(conn, "doc_fact") if f.get("kind") == "priority"]
    products = [{"product_id": p["product_id"], "name": p.get("name")} for p in load(conn, "product")]
    if not statements or not products:
        return {"order": [], "basis": None, "path": None}
    key = "priority:" + hashlib.sha256(json.dumps([statements, products], sort_keys=True).encode()).hexdigest()[:16]
    cached = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if cached:
        return json.loads(cached["value"])
    answer = llm.extract(
        [{"role": "user", "content": "These statements come from a customer's documents. Do they say which product is "
          "packed first when a part is short? Order the product ids from highest priority; give an empty list if they "
          f"do not say.\n\nProducts: {json.dumps(products, ensure_ascii=False)}\n\nStatements: {json.dumps(statements, ensure_ascii=False)}"}],
        "set_priority", "Record the packing priority.",
        {"type": "object", "required": ["order"], "properties": {
            "order": {"type": "array", "items": {"type": "string"}},
            "basis": {"type": ["string", "null"], "description": "The decisive statement, quoted"},
            "path": {"type": ["string", "null"], "description": "The file it comes from"}}})
    known = {p["product_id"] for p in products}
    answer["order"] = [p for p in answer.get("order", []) if p in known]
    conn.execute("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
                 (key, json.dumps(answer, ensure_ascii=False), _now()))
    conn.commit()
    return answer


class Toolbox:
    def __init__(self, conn: sqlite3.Connection, assessment: Assessment, priority: list[str]):
        self.conn, self.assessment, self.priority = conn, assessment, priority
        self.facts = Facts(conn)
        self.suppliers = {s["supplier_id"]: s for s in load(conn, "supplier")}

    def contacts(self) -> set[str]:
        return {s["contact_email"].lower() for s in self.suppliers.values() if s.get("contact_email")}

    def launch_forecast(self) -> dict:
        real = simulate(self.conn, self.assessment, self.priority)
        erp = simulate(self.conn, self.assessment, self.priority, trust_erp=True)
        acted = simulate(self.conn, self.assessment, self.priority, with_actions=True)
        return {"on_the_evidence": real,
                "if_pending_actions_are_taken": {"will_make_it": acted.get("will_make_it"), "products": acted.get("products")},
                "what_the_erp_alone_says": {"will_make_it": erp.get("will_make_it"), "products": erp.get("products")}}

    def part_info(self, material_id: str) -> dict:
        f = self.facts
        forecast = simulate(self.conn, self.assessment, self.priority)
        open_orders = sorted((p for p in f.po_lines if p["material_id"] == material_id
                              and str(p.get("status") or "").lower() not in ("delivered", "cancelled")),
                             key=lambda p: str(p.get("promised_date") or ""))
        suppliers = []
        for sc in f.supplier_components:
            if sc.get("component_id") == material_id:
                profile = self.suppliers.get(sc.get("supplier_id"), {})
                suppliers.append({**{k: v for k, v in sc.items() if not k.startswith("_")},
                                  **{k: profile.get(k) for k in ("name", "country", "city", "contact_name", "contact_email",
                                                                 "preferred_language", "qualification_status", "notes")}})
        return {
            "component": f.components.get(material_id),
            "used_in": [{"product_id": b["parent_id"], "qty_per": b.get("qty_per")} for b in f.bom if b["child_id"] == material_id],
            "forecast": next((c for c in forecast.get("components", []) if c["material_id"] == material_id), None),
            "deadline": forecast.get("deadline"), "as_of": forecast.get("as_of"),
            "stock_batches": [vars(b) for b in self.assessment.batches if b.material_id == material_id],
            "inbound": [vars(i) for i in self.assessment.inbound if i.material_id == material_id],
            "open_orders": [{k: p.get(k) for k in ("po_number", "po_line", "supplier_id", "quantity", "unit_price", "currency",
                                                   "promised_date", "status", "buyer")} for p in open_orders[:12]],
            "suppliers": suppliers,
            "findings": [{"title": x.title, "detail": x.detail, "evidence": [e["path"] for e in x.evidence]}
                         for x in self.assessment.findings if x.material_id == material_id],
        }

    def search_documents(self, keywords: list[str], supplier_id: str | None = None, kinds: list[str] | None = None) -> dict:
        words = [w.casefold() for w in keywords if w.strip()]
        hits = []
        for entity in ("doc_fact", "doc_line", "doc_hold"):
            for row in load(self.conn, entity):
                text = json.dumps(row, ensure_ascii=False).casefold()
                if not all(w in text for w in words):
                    continue
                if supplier_id and row.get("supplier_id") != supplier_id:
                    continue
                if kinds and entity == "doc_fact" and row.get("kind") not in kinds:
                    continue
                hits.append({"path": row["_source"], **{k: v for k, v in row.items()
                                                       if v not in (None, "", []) and not k.startswith("_") and not k.endswith("_text")}})
        hits.sort(key=lambda h: str(h.get("doc_date") or ""), reverse=True)
        return {"count": len(hits), "results": hits[:25]}

    def policies(self) -> dict:
        rows = [f for f in load(self.conn, "doc_fact") if f.get("kind") in POLICY_KINDS
                and f.get("doc_type") in ("policy", "org_chart", "memo", "notes")]
        charts = [f.get("doc_date") or "" for f in rows if f.get("doc_type") == "org_chart"]
        newest = max(charts, default="")
        rows = [f for f in rows if f.get("doc_type") != "org_chart" or (f.get("doc_date") or "") == newest]
        return {"statements": [{"kind": f["kind"], "subject": f.get("subject"), "statement": f["statement"], "amount": f.get("amount"),
                                "currency": f.get("currency"), "valid_from": f.get("valid_from"), "quote": f.get("quote"),
                                "doc_type": f.get("doc_type"), "doc_date": f.get("doc_date"), "path": f["_source"]} for f in rows]}

    def call(self, name: str, args: dict) -> dict:
        try:
            return getattr(self, name)(**args)
        except Exception as e:  # the model sees its mistake and can correct the call
            return {"error": f"{type(e).__name__}: {e}"}


def check_decision(decision: dict, known_paths: set[str], contacts: set[str]) -> list[str]:
    """What a human must know before trusting the recommendation."""
    problems = []
    options = decision.get("options") or []
    if not options:
        problems.append("no options given")
    elif not 0 <= int(decision.get("recommended_option", -1)) < len(options):
        problems.append("recommended option does not exist")
        decision["recommended_option"] = 0
    cited = set(decision.get("evidence") or []) | {p for o in options for p in o.get("evidence") or []}
    unknown = sorted(p for p in cited if p not in known_paths)
    if unknown:
        problems.append(f"cites files that do not exist: {', '.join(unknown)}")
    for action in decision.get("actions") or []:
        if action.get("type") == "email_supplier":
            if (action.get("to_email") or "").lower() not in contacts:
                problems.append(f"{action.get('to_email')!r} is not a supplier contact in the data; this message cannot be sent")
                action["blocked"] = True
    return problems


def run_case(conn: sqlite3.Connection, material_id: str, now: datetime | None = None) -> dict:
    now = (now or datetime.now(LOCAL)).replace(tzinfo=None)
    assessment = assess(conn, now.date())
    priority = priority_order(conn)
    box = Toolbox(conn, assessment, priority["order"])
    forecast = simulate(conn, assessment, priority["order"])
    lines = [{"product_id": p["product_id"], "copies_short_if_nobody_acts": p["short"],
              "line_stops_at": p["first_stop"]["at"] if p["first_stop"] else None,
              "stopped_by": p["first_stop"]["material_id"] if p["first_stop"] else None,
              "spare_hours_before_deadline": round(forecast["hours_available"] - (p["hours_needed"] or 0), 1)}
             for p in forecast.get("products", []) if material_id in
             {c["material_id"] for c in forecast["components"] if p["product_id"] in c["used_in"]}]
    brief = {"part": material_id, "now": now.strftime("%A %d %b %Y, %H:%M") + " (Europe/Berlin)",
             "deadline": forecast.get("deadline"), "lines_using_this_part": lines, "priority_rule": priority,
             "findings": [{"title": f.title, "detail": f.detail} for f in assessment.findings if f.material_id == material_id]}
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Case: {json.dumps(brief, ensure_ascii=False)}"}]
    tools = [{"type": "function", "function": t} for t in TOOLS]
    trace, decision = [], None
    for _ in range(MAX_STEPS):
        reply = llm.chat(messages, tools)
        messages.append(reply)
        calls = reply.get("tool_calls") or []
        if not calls:
            messages.append({"role": "user", "content": "Call submit_decision to hand over your recommendation."})
            continue
        for call in calls:
            name, args = call["function"]["name"], json.loads(call["function"]["arguments"] or "{}")
            if name == "submit_decision":
                decision = args
                result = {"received": True}
            else:
                result = box.call(name, args)
            trace.append({"tool": name, "args": args if name != "submit_decision" else {},
                          "result_chars": len(json.dumps(result, ensure_ascii=False, default=str))})
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "content": json.dumps(result, ensure_ascii=False, default=str)[:MAX_RESULT_CHARS]})
        if decision:
            break
    if not decision:
        raise RuntimeError(f"no decision after {MAX_STEPS} steps")

    known = {r["path"] for r in conn.execute("SELECT path FROM files WHERE removed_at IS NULL")}
    decision["checks"] = check_decision(decision, known, box.contacts())
    stable = {k: v for k, v in brief.items() if k != "now"}
    basis = hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
    key, now = f"part:{material_id}", _now()
    conn.execute(
        """INSERT INTO cases (key, material_id, status, basis, decision, trace, created_at, updated_at)
           VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET status = 'proposed', basis = excluded.basis, decision = excluded.decision,
               trace = excluded.trace, updated_at = excluded.updated_at""",
        (key, material_id, basis, json.dumps(decision, ensure_ascii=False), json.dumps(trace, ensure_ascii=False), now, now))
    conn.execute("DELETE FROM messages WHERE case_key = ? AND status = 'draft'", (key,))
    for action in decision.get("actions") or []:
        conn.execute(
            """INSERT INTO messages (case_key, direction, status, counterpart_name, counterpart_email, language, subject,
                                     body, body_english, purpose, created_at)
               VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (key, "blocked" if action.get("blocked") else ("draft" if action["type"] == "email_supplier" else "internal"),
             action.get("to_name"), action.get("to_email"), action.get("language"), action.get("subject"),
             action.get("body"), action.get("body_english"), action.get("purpose"), now))
    conn.commit()
    return {"key": key, "decision": decision, "trace": trace}
