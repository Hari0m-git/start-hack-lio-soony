import asyncio
import logging
from contextlib import asynccontextmanager, closing

import httpx
from fastapi import FastAPI

from app.config import Settings, get_settings
from app.db import connect
from app.portal import PortalSync, portal_client

log = logging.getLogger("soony")
KEEP_AWAKE_SECONDS = 600


def sync_once(settings: Settings) -> int:
    with closing(connect(settings.db_path)) as conn, portal_client(settings.portal_url, settings.portal_token) as client:
        return len(PortalSync(conn, client, settings.data_dir).run())


async def watch_portal(settings: Settings) -> None:
    while True:
        try:
            n = await asyncio.to_thread(sync_once, settings)
            if n:
                log.info("portal sync: %d events", n)
        except Exception:
            log.exception("portal sync failed")
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
    tasks = [asyncio.create_task(watch_portal(settings))]
    if settings.public_url:
        tasks.append(asyncio.create_task(keep_awake(settings.public_url)))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Soony launch agents", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/api/status")
def status() -> dict:
    with closing(connect(get_settings().db_path)) as conn:
        last = conn.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").fetchone()
        files = conn.execute("SELECT COUNT(*) FROM files WHERE removed_at IS NULL").fetchone()[0]
        drops = conn.execute(
            "SELECT ts, path, kind FROM file_events WHERE baseline = 0 ORDER BY id DESC LIMIT 50"
        ).fetchall()
    return {"files": files, "last_sync": dict(last) if last else None, "drops": [dict(d) for d in drops]}
