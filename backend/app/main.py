import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager, closing
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import views
from app.agent import LOCAL, run_case
from app.config import Settings, get_settings
from app.db import connect
from app.mail import Mailbox, RecipientNotAllowed
from app.outbox import send_draft
from app.pipeline import tick

log = logging.getLogger("soony")
KEEP_AWAKE_SECONDS = 600
STATIC = Path(__file__).parent / "static"
state = {"last_tick": None, "running": False}


def _mailbox(settings: Settings) -> Mailbox | None:
    return Mailbox.from_env() if settings.mail_configured else None


def _now() -> datetime:
    return datetime.now(LOCAL).replace(tzinfo=None)


async def run_loop(settings: Settings) -> None:
    mailbox = _mailbox(settings)
    while True:
        state["running"] = True
        try:
            report = await asyncio.to_thread(tick, settings, mailbox)
            state["last_tick"] = {"at": _now().isoformat(timespec="seconds"), **report}
            if any(report[k] for k in ("drops", "files_read", "replies", "cases_worked", "errors")):
                log.info("tick: %s", report)
        except Exception:
            log.exception("tick failed")
        state["running"] = False
        await asyncio.sleep(settings.poll_seconds)


async def keep_awake(public_url: str) -> None:
    # A free host stops the process, and with it the watcher, after 15 idle minutes.
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            await asyncio.sleep(KEEP_AWAKE_SECONDS)
            try:
                await client.get(f"{public_url}/healthz")
            except httpx.HTTPError as e:
                log.warning("keep-awake ping failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = get_settings()
    tasks = [asyncio.create_task(run_loop(settings))] if settings.agents_on else []
    if not settings.agents_on:
        log.info("AGENTS is not 'on': serving the desk only, the agents are not running here")
    if settings.public_url:
        tasks.append(asyncio.create_task(keep_awake(settings.public_url)))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Soony launch agents", lifespan=lifespan)


def guard(x_access_key: str | None = Header(None), key: str | None = Query(None)) -> None:
    """Customer data sits behind this API. With a key configured, every call must present it."""
    settings = get_settings()
    expected = settings.access_key
    if not expected and settings.public_url:
        # Deployed without a key: refuse rather than publish the customer's data.
        raise HTTPException(503, "APP_ACCESS_KEY is not set on this deployment")
    if expected and not hmac.compare_digest((x_access_key or key or "").encode(), expected.encode()):
        raise HTTPException(401, "access key required")


def db():
    with closing(connect(get_settings().db_path)) as conn:
        yield conn


class DraftEdit(BaseModel):
    subject: str
    body: str


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/api/status", dependencies=[Depends(guard)])
def status(conn=Depends(db)) -> dict:
    last = conn.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").fetchone()
    files = conn.execute("SELECT COUNT(*) FROM files WHERE removed_at IS NULL").fetchone()[0]
    drops = conn.execute("SELECT ts, path, kind FROM file_events WHERE baseline = 0 ORDER BY id DESC LIMIT 50").fetchall()
    return {"files": files, "last_sync": dict(last) if last else None, "drops": [dict(d) for d in drops]}


@app.get("/api/overview", dependencies=[Depends(guard)])
def overview(conn=Depends(db)) -> dict:
    mail_address = os.environ.get("MAIL_ADDRESS") if get_settings().mail_configured else None
    return {**views.overview(conn, datetime.now(LOCAL)), "loop": {**state, "agents_on": get_settings().agents_on},
            "mail_address": mail_address}


@app.patch("/api/messages/{message_id}", dependencies=[Depends(guard)])
def edit_draft(message_id: int, edit: DraftEdit, conn=Depends(db)) -> dict:
    changed = conn.execute("UPDATE messages SET subject = ?, body = ?, body_english = NULL WHERE id = ? AND status = 'draft'",
                           (edit.subject, edit.body, message_id)).rowcount
    conn.commit()
    if not changed:
        raise HTTPException(409, "only a draft can be edited")
    return {"ok": True}


@app.post("/api/messages/{message_id}/send", dependencies=[Depends(guard)])
def approve_and_send(message_id: int, conn=Depends(db)) -> dict:
    """The human decision: this is the only place a message leaves the system."""
    mailbox = _mailbox(get_settings())
    if not mailbox:
        raise HTTPException(503, "no mailbox is configured")
    try:
        return send_draft(conn, mailbox, message_id)
    except (ValueError, RecipientNotAllowed) as e:
        raise HTTPException(409, str(e)) from e


@app.post("/api/cases/{material_id}/rework", dependencies=[Depends(guard)])
async def rework(material_id: str) -> dict:
    def work() -> None:
        with closing(connect(get_settings().db_path)) as conn:
            run_case(conn, material_id)

    await asyncio.to_thread(work)
    return {"ok": True}


@app.get("/api/file", dependencies=[Depends(guard)])
def evidence_file(path: str) -> FileResponse:
    root = (get_settings().data_dir / "portal").resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, "no such file")
    return FileResponse(target, filename=target.name, content_disposition_type="inline")


if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="app")
