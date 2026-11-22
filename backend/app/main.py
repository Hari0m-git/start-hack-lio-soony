import asyncio
import hmac
import json
import logging
import os
from urllib.parse import unquote
from contextlib import asynccontextmanager, closing
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app import assistant, durable, llm, views, voice
from app.agent import LOCAL, run_case
from app.config import Settings, get_settings
from app.db import audit, connect
from app.mail import Mailbox, RecipientNotAllowed
from app.outbox import send_draft
from app.pipeline import tick
from app.truth import Facts, assess

log = logging.getLogger("soony")
KEEP_AWAKE_SECONDS = 600
STATIC = Path(__file__).parent / "static"
state = {"last_tick": None, "running": False}


def _mailbox(settings: Settings) -> Mailbox | None:
    return Mailbox.from_env() if settings.mail_configured else None


def _save(settings: Settings) -> None:
    if not settings.agents_on:
        return  # a copy that only shows the desk holds an older picture and must never overwrite the live one
    try:
        durable.save(settings.db_path)
    except Exception:  # losing a backup must not stop the agents
        log.exception("could not save the state")


def _now() -> datetime:
    return datetime.now(LOCAL).replace(tzinfo=None)


async def run_loop(settings: Settings) -> None:
    mailbox = _mailbox(settings)
    while True:
        state["running"] = True
        try:
            report = await asyncio.to_thread(tick, settings, mailbox)
            state["last_tick"] = {"at": _now().isoformat(timespec="seconds"), **report}
            await asyncio.to_thread(_save, settings)
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
    try:
        durable.restore(settings.db_path)  # a wiped disk gets yesterday's knowledge back before anything is paid for again
    except Exception:
        log.exception("could not restore the state; starting from scratch")
    tasks = [asyncio.create_task(run_loop(settings))] if settings.agents_on else []
    if not settings.agents_on:
        log.info("AGENTS is not 'on': serving the desk only, the agents are not running here")
    if settings.public_url:
        tasks.append(asyncio.create_task(keep_awake(settings.public_url)))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Soony launch agents", lifespan=lifespan)


def guard(x_access_key: str | None = Header(None), key: str | None = Query(None)) -> dict:
    """Customer data sits behind this API. Every call says who is asking; the answer is that person's role.

    Each person has their own key (APP_USERS). The shared key still opens the desk: with personal keys set up it
    only lets its holder look, without them it acts as before, as an unnamed administrator."""
    settings = get_settings()
    given = (x_access_key or key or "").encode()
    for user in settings.users:
        if hmac.compare_digest(given, str(user["key"]).encode()):
            return {"name": user["name"], "role": user["role"], "limit_eur": user.get("limit_eur"), "verified": True}
    if not settings.access_key and not settings.users:
        if settings.public_url:
            # Deployed without a key: refuse rather than publish the customer's data.
            raise HTTPException(503, "APP_ACCESS_KEY is not set on this deployment")
        return {"name": None, "role": "admin", "limit_eur": None, "verified": False}
    if settings.access_key and hmac.compare_digest(given, settings.access_key.encode()):
        return {"name": None, "role": "viewer" if settings.users else "admin", "limit_eur": None, "verified": False}
    raise HTTPException(401, "access key required")


def may_approve(user: dict, message, case) -> str | None:
    """Why this person may not release this message; None if they may. The customer's limits decide, not the model."""
    if user["role"] == "viewer":
        return "Your key lets you look, not approve. Sign in with your personal key."
    if user["role"] == "admin" or message["commits"] == "nothing":
        return None
    decision = json.loads(case["decision"]) if case and case["decision"] else {}
    options = decision.get("options") or []
    pick = options[decision.get("recommended_option", 0)] if options else {}
    cost, limit = pick.get("cost"), user.get("limit_eur")
    if limit is None:
        return "No approval limit is set for you."
    if cost is None or (pick.get("currency") or "EUR").upper() != "EUR":
        return "The cost is not known in euros, so this needs someone without a limit."
    if cost >= limit:
        return f"This commits EUR {cost:,.0f}; your limit is EUR {limit:,.0f}."
    return None


def db():
    with closing(connect(get_settings().db_path)) as conn:
        yield conn


class DraftEdit(BaseModel):
    subject: str
    body: str


class ConcessionRecord(BaseModel):
    batch: str = Field(min_length=1, max_length=200)
    quantity: int = Field(strict=True, gt=0)
    case_updated_at: str = Field(min_length=1, max_length=40)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/api/status", dependencies=[Depends(guard)])
def status(conn=Depends(db)) -> dict:
    last = conn.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").fetchone()
    files = conn.execute("SELECT COUNT(*) FROM files WHERE removed_at IS NULL").fetchone()[0]
    drops = conn.execute("SELECT ts, path, kind FROM file_events WHERE baseline = 0 ORDER BY id DESC LIMIT 50").fetchall()
    return {"files": files, "last_sync": dict(last) if last else None, "drops": [dict(d) for d in drops]}


@app.get("/api/whatif")
def whatif(parts: str = Query(""), conn=Depends(db), user: dict = Depends(guard)) -> dict:
    """What the launch would look like if the named parts were solved. Reads only."""
    return views.whatif(conn, datetime.now(LOCAL), {p.strip() for p in parts.split(",") if p.strip()})


@app.get("/api/me")
def me(user: dict = Depends(guard)) -> dict:
    return user


@app.get("/api/overview")
def overview(conn=Depends(db), user: dict = Depends(guard)) -> dict:
    settings = get_settings()
    mail_address = os.environ.get("MAIL_ADDRESS") if settings.mail_configured else None
    return {**views.overview(conn, datetime.now(LOCAL), settings.demo_ready_times),
            "loop": {**state, "agents_on": settings.agents_on}, "me": user,
            "mail_address": mail_address, "voice": voice.capabilities(settings)}


@app.patch("/api/messages/{message_id}", dependencies=[Depends(guard)])
def edit_draft(message_id: int, edit: DraftEdit, conn=Depends(db), user: dict = Depends(guard)) -> dict:
    if user["role"] == "viewer":
        raise HTTPException(403, "Your key lets you look, not change.")
    changed = conn.execute("UPDATE messages SET subject = ?, body = ?, body_english = NULL WHERE id = ? AND status = 'draft'",
                           (edit.subject, edit.body, message_id)).rowcount
    conn.commit()
    if not changed:
        raise HTTPException(409, "only a draft can be edited")
    audit(conn, user["name"] or "shared key", "reworded a draft", None, edit.subject)
    return {"ok": True}


@app.post("/api/messages/{message_id}/send", dependencies=[Depends(guard)])
def approve_and_send(message_id: int, conn=Depends(db), x_approver: str | None = Header(None),
                     user: dict = Depends(guard)) -> dict:
    """The human decision: this is the only place a message leaves the system."""
    if not get_settings().agents_on:
        raise HTTPException(409, "This copy of the desk only shows the data. Approve on the copy where the agents run.")
    mailbox = _mailbox(get_settings())
    if not mailbox:
        raise HTTPException(503, "no mailbox is configured")
    try:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        case = conn.execute("SELECT * FROM cases WHERE key = ?", (row["case_key"],)).fetchone() if row else None
        refusal = may_approve(user, row, case) if row else None
        if refusal:
            audit(conn, user["name"] or "shared key", "approval refused", row["case_key"], refusal)
            raise HTTPException(403, refusal)
        # A personal key proves who approved. With the shared key the typed name is a record, not proof.
        name = user["name"] or (unquote(x_approver or "").strip()[:80] + " (unverified)" if x_approver else None)
        sent = send_draft(conn, mailbox, message_id, approved_by=name)
        audit(conn, name or "shared key", "approved and sent", row["case_key"], f"{row['counterpart_name']}: {row['subject']}")
    except (ValueError, RecipientNotAllowed) as e:
        raise HTTPException(409, str(e)) from e
    _save(get_settings())
    return sent


@app.post("/api/cases/{material_id}/concession-approval", status_code=201)
def record_concession(material_id: str, request: ConcessionRecord, conn=Depends(db), user: dict = Depends(guard)) -> dict:
    """Record a completed external sign-off chain, without releasing stock or sending mail."""
    if not user["verified"] or user["role"] not in ("approver", "admin"):
        raise HTTPException(403, "Sign in with a personal approver or admin key to record a concession.")
    settings = get_settings()
    if settings.public_url and not settings.agents_on:
        raise HTTPException(409, "Record concessions on the live desk where automatic checks are on.")

    key = f"part:{material_id}"
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM cases WHERE key = ?", (key,)).fetchone()
        if not row:
            raise HTTPException(404, "Case not found.")
        if row["updated_at"] != request.case_updated_at:
            raise HTTPException(409, "The case changed. Refresh and review it before recording the approval.")
        findings = assess(conn, datetime.now(LOCAL).date()).findings
        target = views.concession_target(views._case(conn, row, Facts(conn)), findings)
        if not target or target["batch"] != request.batch:
            raise HTTPException(409, "This case no longer has that eligible held lot. Refresh and review it.")
        if request.quantity > target["held_quantity"]:
            raise HTTPException(422, f"Enter at most {target['held_quantity']:,} pieces for this lot.")
        if views.recorded_concession(conn, key, request.batch):
            raise HTTPException(409, "An approval for this lot is already recorded.")

        record = {"batch": request.batch, "quantity": request.quantity, "recorded_by": user["name"],
                  "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        conn.execute(
            """INSERT INTO concession_approvals (case_key, batch, quantity, recorded_by, recorded_at)
               VALUES (?, ?, ?, ?, ?)""",
            (key, record["batch"], record["quantity"], record["recorded_by"], record["recorded_at"]),
        )
        audit(conn, user["name"], "recorded external concession approval", key,
              f"{request.quantity:,} pieces, lot {request.batch}; warehouse release not recorded by this action")
    _save(settings)
    return record


@app.post("/api/cases/{material_id}/rework", dependencies=[Depends(guard)])
async def rework(material_id: str, user: dict = Depends(guard)) -> dict:
    if user["role"] == "viewer":
        raise HTTPException(403, "Your key lets you look, not change.")

    def work() -> None:
        with closing(connect(get_settings().db_path)) as conn:
            audit(conn, user["name"] or "shared key", "asked for the case to be worked again", f"part:{material_id}")
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


def assistant_identity(
    user: dict = Depends(guard), x_access_key: str | None = Header(None),
) -> tuple[str, str]:
    settings = get_settings()
    if not x_access_key or not (settings.access_key or settings.users):
        raise HTTPException(401, "Ask Foredock requires an access key in the request header.")
    return x_access_key, user["name"] if user["verified"] else "shared key"


@app.post("/api/assistant/turn")
async def assistant_turn(request: Request, response: Response, identity=Depends(assistant_identity), conn=Depends(db)) -> dict:
    response.headers["Cache-Control"] = "no-store"
    if not llm.keys():
        raise HTTPException(503, "Ask Foredock needs an OpenAI key.")
    try:
        turn = assistant.Turn.model_validate_json(await _voice_request(request, 20_000))
    except ValueError as exc:
        raise HTTPException(422, "The assistant request is invalid.") from exc
    try:
        return await run_in_threadpool(assistant.ask, conn, turn, *identity)
    except assistant.ConversationError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except llm.BudgetExceeded as exc:
        raise HTTPException(429, str(exc)) from exc
    except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
        raise HTTPException(502, "Ask Foredock could not reach or read its model response.") from exc


async def _voice_request(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "Voice request is too large.")
        body.extend(chunk)
    return bytes(body)


@app.post("/api/voice/transcribe")
async def voice_transcribe(request: Request, language: assistant.Language | None = None,
                           identity=Depends(assistant_identity), conn=Depends(db)) -> Response:
    if not voice.capabilities(get_settings())["transcribe"]:
        raise HTTPException(503, "Voice transcription is unavailable.")
    if request.headers.get("content-type") != "audio/wav":
        raise HTTPException(415, "Upload WAV audio.")
    body = await _voice_request(request, voice.MAX_AUDIO_BYTES)
    try:
        answer = await run_in_threadpool(voice.transcribe, conn, body, language)
    except llm.BudgetExceeded as exc:
        raise HTTPException(429, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, "The recording could not be read.") from exc
    except (httpx.HTTPError, KeyError) as exc:
        raise HTTPException(502, "The transcription provider could not answer.") from exc
    await run_in_threadpool(audit, conn, identity[1], "transcribed a voice clip")
    return Response(json.dumps(answer, ensure_ascii=False), media_type="application/json",
                    headers={"Cache-Control": "no-store"})


@app.post("/api/voice/speak")
async def voice_speak(request: Request, identity=Depends(assistant_identity), conn=Depends(db)) -> Response:
    if not voice.capabilities(get_settings())["speak"]:
        raise HTTPException(503, "Voice playback is unavailable.")
    body = await _voice_request(request, 20_000)
    try:
        speech = voice.Speak.model_validate_json(body)
        text = assistant.answer_for(identity[0], speech.conversation_id, speech.answer_id)
        audio = await run_in_threadpool(voice.speak, conn, text, speech.language)
    except assistant.ConversationError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except llm.BudgetExceeded as exc:
        raise HTTPException(429, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, "The speech request is invalid.") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, "The synthesis provider could not answer.") from exc
    await run_in_threadpool(audit, conn, identity[1], "generated spoken playback")
    return Response(audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="app")
