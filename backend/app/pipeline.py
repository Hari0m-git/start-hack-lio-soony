"""One pass of the whole loop: watch, read, reconcile, decide, listen.

    portal drop -> files read -> findings + forecast -> a case per part at risk -> drafts for a human
    supplier reply -> commitments -> forecast -> the case is worked again

Each step is safe to repeat; nothing here sends a message.
"""

import logging
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime

from app.agent import LOCAL, basis_of, build_brief, priority_order, run_case
from app.config import Settings
from app.db import connect
from app.forecast import simulate
from app.ingest import ingest_pending
from app.mail import Mailbox
from app.outbox import sync_mailbox
from app.portal import PortalSync, portal_client
from app.truth import assess

log = logging.getLogger(__name__)
CASE_WORKERS = 4
# Findings that only inform; they never open a case on their own.
INFORMATIONAL = {"not_stocked_separately", "tracker_out_of_date", "no_news"}


def parts_at_risk(assessment, forecast: dict) -> list[str]:
    """Parts with a gap, or with a finding that needs someone to act, on a line that still has copies to pack."""
    gaps = {c["material_id"] for c in forecast.get("components", []) if c["gap"] > 0 or c["inbound_needing_action"] > 0}
    needed = {c["material_id"] for c in forecast.get("components", [])}
    flagged = {f.material_id for f in assessment.findings
               if f.needs_action and f.kind not in INFORMATIONAL and f.material_id in needed}
    return sorted(gaps | flagged)


def due_cases(conn: sqlite3.Connection, now: datetime) -> list[str]:
    assessment = assess(conn, now.date())
    priority = priority_order(conn)
    forecast = simulate(conn, assessment, priority["order"])
    if not forecast.get("ready"):
        return []
    worked = {r["material_id"]: r["basis"] for r in conn.execute("SELECT material_id, basis FROM cases")}
    return [m for m in parts_at_risk(assessment, forecast)
            if worked.get(m) != basis_of(build_brief(conn, m, assessment, priority, forecast))]


def tick(settings: Settings, mailbox: Mailbox | None = None, now: datetime | None = None) -> dict:
    now = (now or datetime.now(LOCAL)).replace(tzinfo=None)
    report = {"drops": 0, "files_read": 0, "replies": 0, "cases_worked": [], "errors": []}
    with closing(connect(settings.db_path)) as conn:
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
            return f"case {material_id}: {e}"

    with ThreadPoolExecutor(CASE_WORKERS) as pool:
        for material_id, error in zip(due, pool.map(work, due)):
            if error:
                report["errors"].append(error)
            else:
                report["cases_worked"].append(material_id)
    return report
