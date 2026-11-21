"""One pass of the whole loop: watch, read, reconcile, decide, listen.

    portal drop -> files read -> findings + forecast -> a case per part at risk -> drafts for a human
    supplier reply -> commitments -> forecast -> the case is worked again

Each step is safe to repeat; nothing here sends a message.
"""

import logging
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone

from app.agent import LOCAL, basis_of, build_brief, hand_over, priority_order, run_case
from app.autonomy import send_what_is_safe
from app.config import Settings
from app.db import connect
from app.forecast import simulate
from app.ingest import ingest_pending
from app.mail import Mailbox
from app.outbox import parse_when, sync_mailbox
from app.portal import PortalSync, portal_client
from app.truth import assess

log = logging.getLogger(__name__)
CASE_WORKERS = 4
WAIT = timedelta(minutes=30)       # how long a supplier gets to answer before the case is looked at again
MAX_FAILURES = 2                   # attempts on the same facts before a person takes over
DAILY_BUDGET_USD = float(os.environ.get("DAILY_BUDGET_USD", "25"))
failures: dict[str, int] = {}
# Findings that only inform; they never open a case on their own.
INFORMATIONAL = {"not_stocked_separately", "tracker_out_of_date", "no_news"}


def parts_at_risk(assessment, forecast: dict) -> list[str]:
    """Parts with a gap, or with a finding that needs someone to act, on a line that still has copies to pack."""
    gaps = {c["material_id"] for c in forecast.get("components", []) if c["gap"] > 0 or c["inbound_needing_action"] > 0}
    needed = {c["material_id"] for c in forecast.get("components", [])}
    flagged = {f.material_id for f in assessment.findings
               if f.needs_action and f.kind not in INFORMATIONAL and f.material_id in needed}
    return sorted(gaps | flagged)


def awaiting_reply(conn: sqlite3.Connection, material_id: str, now: datetime) -> bool:
    """We wrote and the supplier has had less than WAIT to answer. Working the case now would only cost money."""
    last = conn.execute("SELECT direction, sent_at FROM messages WHERE case_key = ? AND gmail_id IS NOT NULL ORDER BY id DESC",
                        (f"part:{material_id}",)).fetchone()
    if not last or last["direction"] != "out":
        return False
    sent = parse_when(last["sent_at"])
    return bool(sent) and now.astimezone(timezone.utc) - sent < WAIT


def due_cases(conn: sqlite3.Connection, now: datetime) -> dict[str, str]:
    """Parts whose case has to be worked, with the fingerprint of the facts it will be worked on."""
    assessment = assess(conn, now.date())
    priority = priority_order(conn)
    forecast = simulate(conn, assessment, priority["order"])
    if not forecast.get("ready"):
        return {}
    worked = {r["material_id"]: r["basis"] for r in conn.execute("SELECT material_id, basis FROM cases")}
    due = {}
    for m in parts_at_risk(assessment, forecast):
        basis = basis_of(build_brief(conn, m, assessment, priority, forecast))
        if worked.get(m) != basis and not (m in worked and awaiting_reply(conn, m, now)):
            due[m] = basis
    return due


def spent_today(conn: sqlite3.Connection, now: datetime) -> float:
    start = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")
    return conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage WHERE ts >= ?", (start,)).fetchone()[0]


def tick(settings: Settings, mailbox: Mailbox | None = None, now: datetime | None = None) -> dict:
    now = now or datetime.now(LOCAL)
    report = {"drops": 0, "files_read": 0, "replies": 0, "cases_worked": [], "sent_automatically": [], "handed_over": [],
              "errors": []}
    with closing(connect(settings.db_path)) as conn:
        if spent_today(conn, now) >= DAILY_BUDGET_USD:
            # A runaway loop must not run up a bill: past the budget the agents stop and say so.
            report["errors"].append(f"The daily model budget of ${DAILY_BUDGET_USD:.0f} is used up; the agents are paused.")
            return report
        try:
            with portal_client(settings.portal_url, settings.portal_token) as client:
                report["drops"] = sum(not e.baseline for e in PortalSync(conn, client, settings.data_dir).run())
        except Exception as e:  # the portal being down must not stop the mailbox or the cases
            log.exception("portal sync failed")
            report["errors"].append(f"portal: {e}")
        report["files_read"] = len(ingest_pending(conn, settings.data_dir))
        if mailbox:
            try:
                report["replies"] = len(sync_mailbox(conn, mailbox))
            except Exception as e:
                log.exception("mailbox sync failed")
                report["errors"].append(f"mailbox: {e}")
        due = due_cases(conn, now)

    def work(material_id: str) -> str | None:
        try:
            with closing(connect(settings.db_path)) as own:  # one connection per worker thread
                run_case(own, material_id, now)
            return None
        except Exception as e:
            log.exception("case %s failed", material_id)
            return f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(CASE_WORKERS) as pool:
        outcomes = list(zip(due, pool.map(work, due)))
    with closing(connect(settings.db_path)) as conn:
        for material_id, error in outcomes:
            if not error:
                failures.pop(material_id, None)
                report["cases_worked"].append(material_id)
                continue
            failures[material_id] = failures.get(material_id, 0) + 1
            report["errors"].append(f"case {material_id}: {error}")
            if failures[material_id] >= MAX_FAILURES:
                # It failed again on the same facts: stop retrying and give the case to a person.
                hand_over(conn, material_id, due[material_id],
                          f"The agent could not work this case after {MAX_FAILURES} attempts ({error}). Please take it over.")
                report["handed_over"].append(material_id)
        if mailbox:
            try:
                report["sent_automatically"] = send_what_is_safe(conn, mailbox, now)
            except Exception as e:
                log.exception("automatic sending failed")
                report["errors"].append(f"sending: {e}")
    return report
